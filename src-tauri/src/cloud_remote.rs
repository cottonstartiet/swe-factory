use std::{
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use keyring::Entry;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Listener, Manager};

use crate::{
    copilot_acp_sessions::{self, Target},
    db::DbState,
    error::{AppError, AppResult},
    remote_control::{RemoteCommand, RemoteCommandResult, RemoteEvent, PROTOCOL_VERSION},
    local_web, repositories, session_interactions::InteractionAnswer,
    signalr_transport::SignalRMessage, tasks, terminal_sessions, worktrees,
};

const LINK_SETTING: &str = "remote_control_link";
const PENDING_SETTING: &str = "remote_control_pending";
const PENDING_ACCEPT_SETTING: &str = "remote_control_pending_accept";
const KEYRING_SERVICE: &str = "SWE Factory Remote Control";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedLink {
    server_url: String,
    host_id: String,
    host_name: String,
    owner_subject: String,
    owner_display_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingLink {
    server_url: String,
    host_id: String,
    host_name: String,
    code: String,
    link_url: String,
    expires_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateChallengeResponse {
    code: String,
    link_url: String,
    expires_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteChallengeResponse {
    host_id: String,
    host_token: String,
    owner_subject: String,
    owner_display_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlStatus {
    linked: bool,
    connection: String,
    server_url: Option<String>,
    host_id: Option<String>,
    host_name: Option<String>,
    owner_display_name: Option<String>,
    link_url: Option<String>,
    link_expires_at: Option<String>,
    error: Option<String>,
}

impl RemoteControlStatus {
    fn unlinked(pending: Option<PendingLink>) -> Self {
        Self {
            linked: false,
            connection: if pending.is_some() {
                "linking".into()
            } else {
                "unlinked".into()
            },
            server_url: pending.as_ref().map(|value| value.server_url.clone()),
            host_id: pending.as_ref().map(|value| value.host_id.clone()),
            host_name: pending.as_ref().map(|value| value.host_name.clone()),
            owner_display_name: None,
            link_url: pending.as_ref().map(|value| value.link_url.clone()),
            link_expires_at: pending.map(|value| value.expires_at),
            error: None,
        }
    }

    fn awaiting_acceptance(link: SavedLink) -> Self {
        Self {
            linked: false,
            connection: "confirming".into(),
            server_url: Some(link.server_url),
            host_id: Some(link.host_id),
            host_name: Some(link.host_name),
            owner_display_name: Some(link.owner_display_name),
            link_url: None,
            link_expires_at: None,
            error: None,
        }
    }
}

#[derive(Default)]
struct RuntimeStatus {
    connection: String,
    error: Option<String>,
}

#[derive(Default)]
pub struct CloudRemoteState {
    runtime: Mutex<RuntimeStatus>,
    connector: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

enum CloudChange {
    Snapshot,
    Native(Value),
}

struct CloudEventListeners {
    app: AppHandle,
    ids: Vec<tauri::EventId>,
}

impl Drop for CloudEventListeners {
    fn drop(&mut self) {
        for id in self.ids.drain(..) {
            self.app.unlisten(id);
        }
    }
}

fn cloud_event_stream(
    app: &AppHandle,
) -> (
    CloudEventListeners,
    tokio::sync::mpsc::Receiver<CloudChange>,
) {
    let (sender, receiver) = tokio::sync::mpsc::channel(64);
    let mut ids = Vec::with_capacity(3);

    for event_name in [tasks::EVENT_CHANGED, terminal_sessions::EVENT_UPDATE] {
        let sender = sender.clone();
        ids.push(app.listen(event_name, move |_| {
            let _ = sender.try_send(CloudChange::Snapshot);
        }));
    }

    ids.push(app.listen("native-sessions:update", move |event| {
        if let Ok(payload) = serde_json::from_str(event.payload()) {
            let _ = sender.try_send(CloudChange::Native(payload));
        }
    }));

    (
        CloudEventListeners {
            app: app.clone(),
            ids,
        },
        receiver,
    )
}

impl CloudRemoteState {
    fn update(&self, connection: &str, error: Option<String>) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.connection = connection.into();
            runtime.error = error;
        }
    }

    fn stop(&self) {
        if let Ok(mut connector) = self.connector.lock() {
            if let Some(task) = connector.take() {
                task.abort();
            }
        }
        self.update("offline", None);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryWorktreesPayload {
    repository_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionTargetPayload {
    session_id: String,
    generation: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRespondPayload {
    session_id: String,
    generation: String,
    interaction_id: String,
    answer: InteractionAnswer,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPromptPayload {
    session_id: String,
    generation: String,
    id: String,
    prompt: Vec<Value>,
    #[serde(default)]
    literal: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPlanPayload {
    session_id: String,
    generation: String,
    action: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionHistoryPayload {
    session_id: String,
    #[serde(default)]
    cursor: usize,
    #[serde(default = "default_history_page_size")]
    limit: usize,
}

fn default_history_page_size() -> usize {
    10
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

fn normalize_server_url(value: &str) -> AppResult<String> {
    let mut url = url::Url::parse(value.trim())
        .map_err(|error| AppError::msg(format!("Invalid remote server URL: {error}")))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(AppError::msg("Remote server URL must use HTTPS."));
    }
    if url.scheme() == "http"
        && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
    {
        return Err(AppError::msg(
            "Remote server URL must use HTTPS except for local development.",
        ));
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn read_setting<T: for<'de> Deserialize<'de>>(app: &AppHandle, key: &str) -> AppResult<Option<T>> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Settings database is unavailable."))?;
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    value
        .map(|json| serde_json::from_str(&json).map_err(AppError::from))
        .transpose()
}

fn write_setting<T: Serialize>(app: &AppHandle, key: &str, value: &T) -> AppResult<()> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Settings database is unavailable."))?;
    let json = serde_json::to_string(value)?;
    db.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, json],
    )?;
    Ok(())
}

fn delete_setting(app: &AppHandle, key: &str) -> AppResult<()> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Settings database is unavailable."))?;
    db.execute("DELETE FROM app_settings WHERE key = ?1", [key])?;
    Ok(())
}

fn credential(host_id: &str) -> AppResult<Entry> {
    Entry::new(KEYRING_SERVICE, host_id)
        .map_err(|error| AppError::msg(format!("Credential storage is unavailable: {error}")))
}

fn load_host_token(host_id: &str) -> AppResult<String> {
    credential(host_id)?
        .get_password()
        .map_err(|error| AppError::msg(format!("Remote host credential is unavailable: {error}")))
}

fn save_host_token(host_id: &str, token: &str) -> AppResult<()> {
    credential(host_id)?
        .set_password(token)
        .map_err(|error| AppError::msg(format!("Could not protect the remote host credential: {error}")))
}

fn delete_host_token(host_id: &str) -> AppResult<()> {
    match credential(host_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(AppError::msg(format!(
            "Could not remove the remote host credential: {error}"
        ))),
    }
}

pub fn initialize(app: &AppHandle) {
    let Ok(Some(link)) = read_setting::<SavedLink>(app, LINK_SETTING) else {
        return;
    };
    start_connector(app.clone(), link);
}

fn start_connector(app: AppHandle, link: SavedLink) {
    let state = app.state::<CloudRemoteState>();
    state.stop();
    let app_for_task = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        connector_loop(app_for_task, link).await;
    });
    if let Ok(mut connector) = state.connector.lock() {
        *connector = Some(task);
    };
}

async fn connector_loop(app: AppHandle, link: SavedLink) {
    let mut attempt = 0u32;
    loop {
        let token = match load_host_token(&link.host_id) {
            Ok(token) => token,
            Err(error) => {
                app.state::<CloudRemoteState>()
                    .update("error", Some(error.to_string()));
                return;
            }
        };
        app.state::<CloudRemoteState>()
            .update("connecting", None);
        match crate::signalr_transport::SignalRConnection::connect(&link.server_url, &token).await {
            Ok(mut connection) => {
                attempt = 0;
                app.state::<CloudRemoteState>().update("online", None);
                if let Err(error) = connected_loop(&app, &link, &mut connection).await {
                    app.state::<CloudRemoteState>()
                        .update("reconnecting", Some(error.to_string()));
                }
            }
            Err(error) => {
                app.state::<CloudRemoteState>()
                    .update("reconnecting", Some(error.to_string()));
            }
        }
        attempt = attempt.saturating_add(1);
        let delay = (2u64.saturating_pow(attempt.min(5))).min(30);
        let jitter = rand::random_range(0..=1000);
        tokio::time::sleep(Duration::from_millis(delay * 1000 + jitter)).await;
    }
}

async fn connected_loop(
    app: &AppHandle,
    link: &SavedLink,
    connection: &mut crate::signalr_transport::SignalRConnection,
) -> AppResult<()> {
    let mut viewers = 0i64;
    let mut sequence = 0u64;
    let mut last_snapshot = String::new();
    let (_listeners, mut changes) = cloud_event_stream(app);
    loop {
        tokio::select! {
            message = connection.next() => {
                match message? {
                    SignalRMessage::Invocation { invocation_id, target, arguments } => {
                        match target.as_str() {
                            "ViewerSubscriptionChanged" => {
                                viewers = arguments.first().and_then(Value::as_i64).unwrap_or(0);
                                if viewers > 0 {
                                    publish_snapshot(app, connection, &mut sequence, &mut last_snapshot).await?;
                                }
                            }
                            "ExecuteCommand" => {
                                let Some(invocation_id) = invocation_id else {
                                    continue;
                                };
                                let result = match arguments.first().cloned() {
                                    Some(value) => match serde_json::from_value::<RemoteCommand>(value) {
                                        Ok(command) => execute_command(app, command).await,
                                        Err(error) => RemoteCommandResult {
                                            id: "invalid".into(),
                                            ok: false,
                                            error_code: Some("invalid-command".into()),
                                            error_message: Some(error.to_string()),
                                            revision: None,
                                            payload: None,
                                        },
                                    },
                                    None => RemoteCommandResult {
                                        id: "invalid".into(),
                                        ok: false,
                                        error_code: Some("invalid-command".into()),
                                        error_message: Some("Remote command payload is missing.".into()),
                                        revision: None,
                                        payload: None,
                                    },
                                };
                                connection.complete(&invocation_id, &serde_json::to_value(result)?).await?;
                            }
                            "LinkRevoked" => {
                                delete_host_token(&link.host_id)?;
                                delete_setting(app, LINK_SETTING)?;
                                app.state::<CloudRemoteState>().update("revoked", None);
                                return Ok(());
                            }
                            _ => {}
                        }
                    }
                    SignalRMessage::Ping => {}
                    SignalRMessage::Close { error, allow_reconnect } => {
                        return Err(AppError::msg(error.unwrap_or_else(|| {
                            if allow_reconnect {
                                "Remote server requested reconnect.".into()
                            } else {
                                "Remote server closed the connection.".into()
                            }
                        })));
                    }
                    SignalRMessage::Completion { .. } | SignalRMessage::Other(_) => {}
                }
            }
            change = changes.recv() => {
                match change {
                    Some(CloudChange::Snapshot) if viewers > 0 => {
                        publish_snapshot(app, connection, &mut sequence, &mut last_snapshot).await?;
                    }
                    Some(CloudChange::Native(payload)) if viewers > 0 => {
                        publish_event(connection, &mut sequence, "sessions.native", payload).await?;
                    }
                    Some(_) => {}
                    None => return Err(AppError::msg("Remote event stream closed.")),
                }
            }
        }
    }
}

async fn publish_snapshot(
    app: &AppHandle,
    connection: &mut crate::signalr_transport::SignalRConnection,
    sequence: &mut u64,
    last_snapshot: &mut String,
) -> AppResult<()> {
    let payload = snapshot(app).await?;
    let encoded = serde_json::to_string(&payload)?;
    if encoded == *last_snapshot {
        return Ok(());
    }
    *last_snapshot = encoded;
    publish_event(connection, sequence, "snapshot", payload).await
}

async fn publish_event(
    connection: &mut crate::signalr_transport::SignalRConnection,
    sequence: &mut u64,
    message_type: &str,
    payload: Value,
) -> AppResult<()> {
    *sequence = sequence.saturating_add(1);
    let event = RemoteEvent {
        protocol_version: PROTOCOL_VERSION.into(),
        message_type: message_type.into(),
        sequence: *sequence,
        revision: Some(now_ms().min(i64::MAX as u128) as i64),
        payload,
    };
    connection
        .invoke("PublishEvent", vec![serde_json::to_value(event)?])
        .await
}

async fn snapshot(app: &AppHandle) -> AppResult<Value> {
    let tasks = tasks::tasks_list(app.state()).await?;
    let sessions = terminal_sessions::terminal_sessions_list(app.clone()).await?;
    Ok(json!({ "tasks": tasks, "sessions": sessions }))
}

async fn execute_command(app: &AppHandle, command: RemoteCommand) -> RemoteCommandResult {
    let result = execute_command_inner(app, &command).await;
    match result {
        Ok(payload) => RemoteCommandResult {
            id: command.id,
            ok: true,
            error_code: None,
            error_message: None,
            revision: Some(now_ms().min(i64::MAX as u128) as i64),
            payload: Some(payload),
        },
        Err(error) => RemoteCommandResult {
            id: command.id,
            ok: false,
            error_code: Some("command-failed".into()),
            error_message: Some(error.to_string()),
            revision: None,
            payload: None,
        },
    }
}

async fn execute_command_inner(app: &AppHandle, command: &RemoteCommand) -> AppResult<Value> {
    if command.protocol_version != PROTOCOL_VERSION {
        return Err(AppError::msg("The remote protocol version is unsupported."));
    }
    match command.message_type.as_str() {
        "snapshot.get" => snapshot(app).await,
        "repositories.list" => Ok(serde_json::to_value(
            repositories::repositories_list(app.clone()).await?,
        )?),
        "worktrees.list" => {
            let payload: RepositoryWorktreesPayload =
                serde_json::from_value(command.payload.clone())?;
            let repositories = repositories::repositories_list(app.clone()).await?;
            let repository = repositories
                .into_iter()
                .find(|value| value.id == payload.repository_id)
                .ok_or_else(|| AppError::msg("Repository not found."))?;
            Ok(serde_json::to_value(
                worktrees::list_worktrees(&repository.path)
                    .await
                    .map_err(|error| AppError::msg(error.message))?,
            )?)
        }
        "tasks.create" | "tasks.update" | "tasks.move" | "tasks.delete" | "tasks.start" => {
            local_web::execute_task_command(
                app.clone(),
                &command.message_type,
                command.payload.clone(),
            )
            .await
        }
        "sessions.history" => {
            let payload: SessionHistoryPayload = serde_json::from_value(command.payload.clone())?;
            let history =
                terminal_sessions::terminal_sessions_history(app.clone(), payload.session_id).await?;
            let limit = payload.limit.clamp(1, 25);
            let entries = history
                .iter()
                .skip(payload.cursor)
                .take(limit)
                .cloned()
                .collect::<Vec<_>>();
            let next_cursor = (payload.cursor + entries.len() < history.len())
                .then_some(payload.cursor + entries.len());
            Ok(json!({ "entries": entries, "nextCursor": next_cursor }))
        }
        "sessions.snapshot" => {
            let payload: SessionTargetPayload = serde_json::from_value(command.payload.clone())?;
            Ok(serde_json::to_value(
                copilot_acp_sessions::native_session_snapshot(
                    app.clone(),
                    Target {
                        id: payload.session_id,
                        generation: payload.generation,
                    },
                )
                .await?,
            )?)
        }
        "sessions.respond" => {
            let payload: SessionRespondPayload = serde_json::from_value(command.payload.clone())?;
            Ok(serde_json::to_value(
                copilot_acp_sessions::native_session_respond(
                    app.clone(),
                    Target {
                        id: payload.session_id,
                        generation: payload.generation,
                    },
                    payload.interaction_id,
                    payload.answer,
                )?,
            )?)
        }
        "sessions.prompt" => {
            let payload: SessionPromptPayload = serde_json::from_value(command.payload.clone())?;
            Ok(serde_json::to_value(
                copilot_acp_sessions::acp_session_enqueue(
                    app.clone(),
                    Target {
                        id: payload.session_id,
                        generation: payload.generation,
                    },
                    payload.id,
                    payload.prompt,
                    payload.literal,
                )?,
            )?)
        }
        "sessions.plan" => {
            let payload: SessionPlanPayload = serde_json::from_value(command.payload.clone())?;
            Ok(serde_json::to_value(
                copilot_acp_sessions::acp_session_plan_transition(
                    app.clone(),
                    Target {
                        id: payload.session_id,
                        generation: payload.generation,
                    },
                    payload.action,
                )
                .await?,
            )?)
        }
        "sessions.plan.reopen" => {
            let payload: SessionTargetPayload = serde_json::from_value(command.payload.clone())?;
            Ok(serde_json::to_value(
                copilot_acp_sessions::acp_session_reopen_plan_transition(
                    app.clone(),
                    Target {
                        id: payload.session_id,
                        generation: payload.generation,
                    },
                )?,
            )?)
        }
        "sessions.cancel" => {
            let payload: SessionTargetPayload = serde_json::from_value(command.payload.clone())?;
            copilot_acp_sessions::native_session_cancel(
                app.clone(),
                Target {
                    id: payload.session_id,
                    generation: payload.generation,
                },
            )
            .await?;
            Ok(json!({ "ok": true }))
        }
        "sessions.end" => {
            let payload: SessionTargetPayload = serde_json::from_value(command.payload.clone())?;
            copilot_acp_sessions::native_session_end(
                app.clone(),
                Target {
                    id: payload.session_id,
                    generation: payload.generation,
                },
            )
            .await?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(AppError::msg(format!(
            "Remote command type '{}' is not supported yet.",
            command.message_type
        ))),
    }
}

#[tauri::command]
pub async fn remote_control_begin_link(
    app: AppHandle,
    server_url: String,
) -> AppResult<RemoteControlStatus> {
    let server_url = normalize_server_url(&server_url)?;
    let existing = read_setting::<SavedLink>(&app, LINK_SETTING)?;
    let host_id = existing
        .as_ref()
        .map(|value| value.host_id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let host_name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "SWE Factory host".into());
    let response = reqwest::Client::new()
        .post(format!("{server_url}/api/link/challenges"))
        .json(&json!({
            "hostId": host_id,
            "hostName": host_name,
            "protocolVersion": PROTOCOL_VERSION
        }))
        .send()
        .await
        .map_err(|error| AppError::msg(format!("Could not start remote linking: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::msg(format!(
            "Remote linking was rejected ({})",
            response.status()
        )));
    }
    let challenge: CreateChallengeResponse = response
        .json()
        .await
        .map_err(|error| AppError::msg(format!("Invalid remote linking response: {error}")))?;
    let pending = PendingLink {
        server_url,
        host_id,
        host_name,
        code: challenge.code,
        link_url: challenge.link_url,
        expires_at: challenge.expires_at,
    };
    write_setting(&app, PENDING_SETTING, &pending)?;
    Ok(RemoteControlStatus::unlinked(Some(pending)))
}

#[tauri::command]
pub async fn remote_control_complete_link(app: AppHandle) -> AppResult<RemoteControlStatus> {
    let pending = read_setting::<PendingLink>(&app, PENDING_SETTING)?
        .ok_or_else(|| AppError::msg("No remote link is pending."))?;
    let response = reqwest::Client::new()
        .post(format!(
            "{}/api/link/challenges/{}/complete",
            pending.server_url,
            urlencoding::encode(&pending.code)
        ))
        .json(&json!({ "hostId": pending.host_id }))
        .send()
        .await
        .map_err(|error| AppError::msg(format!("Could not complete remote linking: {error}")))?;
    if response.status() == reqwest::StatusCode::ACCEPTED {
        return Ok(RemoteControlStatus::unlinked(Some(pending)));
    }
    if !response.status().is_success() {
        return Err(AppError::msg(format!(
            "Remote linking was rejected ({})",
            response.status()
        )));
    }
    let completed: CompleteChallengeResponse = response
        .json()
        .await
        .map_err(|error| AppError::msg(format!("Invalid remote credential response: {error}")))?;
    if completed.host_id != pending.host_id {
        return Err(AppError::msg("The remote server returned the wrong host identity."));
    }
    save_host_token(&pending.host_id, &completed.host_token)?;
    let link = SavedLink {
        server_url: pending.server_url,
        host_id: pending.host_id,
        host_name: pending.host_name,
        owner_subject: completed.owner_subject,
        owner_display_name: completed.owner_display_name,
    };
    write_setting(&app, PENDING_ACCEPT_SETTING, &link)?;
    delete_setting(&app, PENDING_SETTING)?;
    Ok(RemoteControlStatus::awaiting_acceptance(link))
}

#[tauri::command]
pub fn remote_control_accept_link(app: AppHandle) -> AppResult<RemoteControlStatus> {
    let link = read_setting::<SavedLink>(&app, PENDING_ACCEPT_SETTING)?
        .ok_or_else(|| AppError::msg("No confirmed remote link is waiting for acceptance."))?;
    write_setting(&app, LINK_SETTING, &link)?;
    delete_setting(&app, PENDING_ACCEPT_SETTING)?;
    start_connector(app.clone(), link);
    remote_control_status(app)
}

#[tauri::command]
pub fn remote_control_status(app: AppHandle) -> AppResult<RemoteControlStatus> {
    let Some(link) = read_setting::<SavedLink>(&app, LINK_SETTING)? else {
        if let Some(link) = read_setting::<SavedLink>(&app, PENDING_ACCEPT_SETTING)? {
            return Ok(RemoteControlStatus::awaiting_acceptance(link));
        }
        return Ok(RemoteControlStatus::unlinked(read_setting::<PendingLink>(
            &app,
            PENDING_SETTING,
        )?));
    };
    let state = app.state::<CloudRemoteState>();
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| AppError::msg("Remote connection state is unavailable."))?;
    Ok(RemoteControlStatus {
        linked: true,
        connection: if runtime.connection.is_empty() {
            "offline".into()
        } else {
            runtime.connection.clone()
        },
        server_url: Some(link.server_url),
        host_id: Some(link.host_id),
        host_name: Some(link.host_name),
        owner_display_name: Some(link.owner_display_name),
        link_url: None,
        link_expires_at: None,
        error: runtime.error.clone(),
    })
}

#[tauri::command]
pub fn remote_control_unlink(app: AppHandle) -> AppResult<RemoteControlStatus> {
    let linked = read_setting::<SavedLink>(&app, LINK_SETTING)?;
    let pending_accept = read_setting::<SavedLink>(&app, PENDING_ACCEPT_SETTING)?;
    if let Some(link) = linked.or(pending_accept) {
        delete_host_token(&link.host_id)?;
    }
    app.state::<CloudRemoteState>().stop();
    delete_setting(&app, LINK_SETTING)?;
    delete_setting(&app, PENDING_SETTING)?;
    delete_setting(&app, PENDING_ACCEPT_SETTING)?;
    Ok(RemoteControlStatus::unlinked(None))
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<CloudRemoteState>() {
        state.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_remote_server_origin() {
        assert_eq!(
            normalize_server_url("https://remote.example/path?q=1").unwrap(),
            "https://remote.example"
        );
        assert!(normalize_server_url("file:///remote").is_err());
    }
}
