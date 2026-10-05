use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{header, HeaderMap, HeaderValue, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use qrcode::{render::svg, QrCode};
use rand::{distr::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Manager};
use tokio::{net::TcpListener, sync::oneshot};
use tower_http::{limit::RequestBodyLimitLayer, services::ServeDir};

use crate::{
    copilot_acp_sessions::{self, Target},
    error::AppError,
    repositories,
    session_interactions::InteractionAnswer,
    tasks,
    terminal_sessions::{self, StartTerminalSessionRequest},
    worktrees,
};

const CSRF_HEADER: &str = "x-swe-factory-lan";
const COOKIE_NAME: &str = "swe_factory_lan";

#[derive(Default)]
pub struct LocalWebState(Mutex<Option<RunningServer>>);

struct RunningServer {
    runtime: Arc<ServerRuntime>,
    shutdown: Option<oneshot::Sender<()>>,
}

struct ServerRuntime {
    app: AppHandle,
    host: String,
    origin: String,
    pairing_secret: String,
    session_secret: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWebStatus {
    running: bool,
    url: Option<String>,
    qr_svg: Option<String>,
    address: Option<String>,
    port: Option<u16>,
    error: Option<String>,
}

impl LocalWebStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            url: None,
            qr_svg: None,
            address: None,
            port: None,
            error: None,
        }
    }
}

#[derive(Deserialize)]
struct PairRequest {
    secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTaskBody {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    intent: Option<String>,
    repository_id: String,
    worktree_path: String,
    #[serde(default)]
    pending_worktree_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTaskBody {
    title: String,
    #[serde(default)]
    description: String,
    repository_id: String,
    repository_name: String,
    repository_path: String,
    worktree_path: String,
    #[serde(default)]
    worktree_branch: Option<String>,
    #[serde(default)]
    pending_worktree_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveTaskBody {
    status: String,
    #[serde(default)]
    before_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTargetBody {
    generation: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeRespondBody {
    generation: String,
    interaction_id: String,
    answer: InteractionAnswer,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePromptBody {
    generation: String,
    id: String,
    prompt: Vec<Value>,
    #[serde(default)]
    literal: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanBody {
    generation: String,
    action: PlanTransitionAction,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum PlanTransitionAction {
    Interactive,
    Autopilot,
    AutopilotFleet,
    ExitOnly,
}

impl PlanTransitionAction {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::Autopilot => "autopilot",
            Self::AutopilotFleet => "autopilot_fleet",
            Self::ExitOnly => "exit_only",
        }
    }
}

fn random_secret(length: usize) -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn is_private(ip: Ipv4Addr) -> bool {
    ip.is_private() && !ip.is_loopback() && !ip.is_link_local()
}

fn lan_address() -> Result<Ipv4Addr, AppError> {
    if_addrs::get_if_addrs()
        .map_err(|error| AppError::msg(format!("Could not inspect network adapters: {error}")))?
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if is_private(ip) => Some(ip),
            _ => None,
        })
        .next()
        .ok_or_else(|| AppError::msg("No private IPv4 network adapter is available."))
}

fn assets_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| AppError::msg(error.to_string()))?
        .join("dist-remote");
    if bundled.is_dir() {
        return Ok(bundled);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("dist-remote");
    if development.is_dir() {
        return Ok(development);
    }
    Err(AppError::msg(
        "Remote web assets are missing. Run `yarn build:remote` and restart SWE Factory.",
    ))
}

fn status(runtime: &ServerRuntime) -> LocalWebStatus {
    let base = format!("http://{}", runtime.host);
    let url = format!("{base}/#{}", runtime.pairing_secret);
    let qr_svg = QrCode::new(url.as_bytes()).ok().map(|code| {
        code.render::<svg::Color>()
            .min_dimensions(256, 256)
            .dark_color(svg::Color("#111827"))
            .light_color(svg::Color("#ffffff"))
            .build()
    });
    let (address, port) = runtime
        .host
        .rsplit_once(':')
        .map(|(address, port)| (Some(address.to_string()), port.parse().ok()))
        .unwrap_or((None, None));
    LocalWebStatus {
        running: true,
        url: Some(url),
        qr_svg,
        address,
        port,
        error: None,
    }
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    header_text(headers, header::COOKIE.as_str())?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then(|| value.to_string()))
}

fn constant_eq(left: &str, right: &str) -> bool {
    left.as_bytes().ct_eq(right.as_bytes()).into()
}

async fn guard(
    State(runtime): State<Arc<ServerRuntime>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let headers = request.headers();
    if header_text(headers, header::HOST.as_str()) != Some(runtime.host.as_str()) {
        return (StatusCode::BAD_REQUEST, "Invalid host.").into_response();
    }
    let path = request.uri().path();
    if path.starts_with("/api/") && path != "/api/pair" {
        let valid_cookie = cookie(headers, COOKIE_NAME)
            .is_some_and(|value| constant_eq(&value, &runtime.session_secret));
        if !valid_cookie {
            return (
                StatusCode::UNAUTHORIZED,
                "Pairing expired. Scan the QR code again.",
            )
                .into_response();
        }
        if request.method() != axum::http::Method::GET {
            if header_text(headers, header::ORIGIN.as_str()) != Some(runtime.origin.as_str())
                || header_text(headers, CSRF_HEADER) != Some("1")
            {
                return (StatusCode::FORBIDDEN, "Request origin was rejected.").into_response();
            }
        }
    }
    next.run(request).await
}

async fn pair(
    State(runtime): State<Arc<ServerRuntime>>,
    headers: HeaderMap,
    Json(body): Json<PairRequest>,
) -> Response {
    if header_text(&headers, header::HOST.as_str()) != Some(runtime.host.as_str())
        || header_text(&headers, header::ORIGIN.as_str()) != Some(runtime.origin.as_str())
        || !constant_eq(&body.secret, &runtime.pairing_secret)
    {
        return (StatusCode::UNAUTHORIZED, "Invalid pairing code.").into_response();
    }
    let value = format!(
        "{COOKIE_NAME}={}; HttpOnly; SameSite=Strict; Path=/",
        runtime.session_secret
    );
    let mut response = Json(json!({ "ok": true })).into_response();
    if let Ok(value) = HeaderValue::from_str(&value) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

async fn list_tasks(State(runtime): State<Arc<ServerRuntime>>) -> Response {
    match tasks::tasks_list(runtime.app.state()).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => server_error(error),
    }
}

async fn list_repositories(State(runtime): State<Arc<ServerRuntime>>) -> Response {
    match repositories::repositories_list(runtime.app.clone()).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => server_error(error),
    }
}

async fn list_repository_worktrees(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
) -> Response {
    let repositories = match repositories::repositories_list(runtime.app.clone()).await {
        Ok(value) => value,
        Err(error) => return server_error(error),
    };
    let Some(repository) = repositories
        .into_iter()
        .find(|repository| repository.id == id)
    else {
        return (StatusCode::NOT_FOUND, "Repository not found.").into_response();
    };
    match worktrees::list_worktrees(&repository.path).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not load worktrees: {}", error.message),
        )
            .into_response(),
    }
}

async fn create_task(
    State(runtime): State<Arc<ServerRuntime>>,
    Json(body): Json<CreateTaskBody>,
) -> Response {
    let repositories = match repositories::repositories_list(runtime.app.clone()).await {
        Ok(value) => value,
        Err(error) => return server_error(error),
    };
    let Some(repository) = repositories
        .into_iter()
        .find(|repository| repository.id == body.repository_id)
    else {
        return (StatusCode::NOT_FOUND, "Repository not found.").into_response();
    };
    let (worktree_path, worktree_branch, pending_worktree_name) = if let Some(name) =
        body.pending_worktree_name
    {
        if !worktrees::valid_worktree_name(&name) {
            return (
                    StatusCode::BAD_REQUEST,
                    "Worktree names may contain only letters, digits, dot, underscore, and hyphen, up to 64 characters.",
                )
                    .into_response();
        }
        (repository.path.clone(), None, Some(name.trim().to_string()))
    } else if body.worktree_path == repository.path {
        (repository.path.clone(), None, None)
    } else {
        let available = match worktrees::list_worktrees(&repository.path).await {
            Ok(value) => value,
            Err(error) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Could not validate the worktree: {}", error.message),
                )
                    .into_response()
            }
        };
        let Some(worktree) = available
            .into_iter()
            .find(|worktree| !worktree.is_main && worktree.path == body.worktree_path)
        else {
            return (StatusCode::BAD_REQUEST, "Select an available worktree.").into_response();
        };
        (worktree.path, worktree.branch, None)
    };
    match tasks::tasks_create(
        runtime.app.clone(),
        runtime.app.state(),
        body.title,
        body.description,
        body.intent,
        repository.id,
        repository.name,
        repository.path,
        worktree_path,
        worktree_branch,
        pending_worktree_name,
        uuid::Uuid::new_v4().to_string(),
        Vec::new(),
    )
    .await
    {
        Ok(value) => {
            if value.ok {
                tasks::emit_changed(&runtime.app);
            }
            Json(value).into_response()
        }
        Err(error) => server_error(error),
    }
}

async fn update_task(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateTaskBody>,
) -> Response {
    let all = match tasks::tasks_list(runtime.app.state()).await {
        Ok(value) => value,
        Err(error) => return server_error(error),
    };
    let Some(existing) = all.into_iter().find(|task| task.id == id) else {
        return (StatusCode::NOT_FOUND, "Task not found.").into_response();
    };
    let attachments = task_attachment_selections(&existing);
    match tasks::tasks_update(
        runtime.app.clone(),
        runtime.app.state(),
        id,
        body.title,
        body.description,
        body.repository_id,
        body.repository_name,
        body.repository_path,
        body.worktree_path,
        body.worktree_branch,
        body.pending_worktree_name,
        uuid::Uuid::new_v4().to_string(),
        attachments,
    )
    .await
    {
        Ok(value) => {
            if value.ok {
                tasks::emit_changed(&runtime.app);
            }
            Json(value).into_response()
        }
        Err(error) => server_error(error),
    }
}

async fn move_task(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
    Json(body): Json<MoveTaskBody>,
) -> Response {
    let all = match tasks::tasks_list(runtime.app.state()).await {
        Ok(value) => value,
        Err(error) => return server_error(error),
    };
    let Some(task) = all.into_iter().find(|task| task.id == id) else {
        return (StatusCode::NOT_FOUND, "Task not found.").into_response();
    };
    if matches!(body.status.as_str(), "review" | "done") {
        let Some(session_id) = task.copilot_session_id.as_ref() else {
            if task.queue_status == "running" {
                return (
                    StatusCode::CONFLICT,
                    "Wait for the task session to finish starting before changing its status.",
                )
                    .into_response();
            }
            return match tasks::tasks_move(runtime.app.state(), id, body.status, body.before_id)
                .await
            {
                Ok(value) => {
                    if value.ok {
                        tasks::emit_changed(&runtime.app);
                    }
                    Json(value).into_response()
                }
                Err(error) => server_error(error),
            };
        };
        let running = match terminal_sessions::terminal_sessions_is_running(
            runtime.app.clone(),
            session_id.clone(),
        ) {
            Ok(value) => value,
            Err(error) => return server_error(error),
        };
        if body.status == "review" && running {
            return (
                StatusCode::CONFLICT,
                "End the task session before moving it to Review.",
            )
                .into_response();
        }
        if body.status == "done" && running {
            if let Err(error) =
                terminal_sessions::terminal_sessions_forget(runtime.app.clone(), session_id.clone())
                    .await
            {
                return server_error(error);
            }
        }
    }
    match tasks::tasks_move(runtime.app.state(), id, body.status, body.before_id).await {
        Ok(value) => {
            if value.ok {
                tasks::emit_changed(&runtime.app);
            }
            Json(value).into_response()
        }
        Err(error) => server_error(error),
    }
}

async fn delete_task(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
) -> Response {
    match tasks::tasks_delete(runtime.app.clone(), runtime.app.state(), id).await {
        Ok(value) => {
            if value.ok {
                tasks::emit_changed(&runtime.app);
            }
            Json(value).into_response()
        }
        Err(error) => server_error(error),
    }
}

fn worktree_label(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

fn task_attachment_selections(task: &tasks::Task) -> Vec<tasks::TaskAttachmentSelection> {
    task.attachments
        .iter()
        .map(|attachment| tasks::TaskAttachmentSelection {
            id: attachment.id.clone(),
            name: attachment.name.clone(),
            mime_type: attachment.mime_type.clone(),
            size_bytes: attachment.size_bytes,
            staged: false,
        })
        .collect()
}

async fn materialize_task_worktree(
    runtime: &Arc<ServerRuntime>,
    task: tasks::Task,
) -> Result<tasks::Task, Response> {
    let Some(name) = task.pending_worktree_name.as_deref() else {
        return Ok(task);
    };
    let repositories = repositories::repositories_list(runtime.app.clone())
        .await
        .map_err(server_error)?;
    let repository = repositories
        .into_iter()
        .find(|repository| repository.id == task.repository_id)
        .ok_or_else(|| {
            (
                StatusCode::CONFLICT,
                "The repository for this task is unavailable.",
            )
                .into_response()
        })?;
    let mut worktree = worktrees::list_worktrees(&repository.path)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Could not inspect worktrees: {}", error.message),
            )
                .into_response()
        })?
        .into_iter()
        .find(|candidate| !candidate.is_main && worktree_label(&candidate.path) == name);
    if worktree.is_none() {
        let created = worktrees::create_worktree(&repository.path, name).await;
        if created.ok {
            worktree = created.worktree;
        } else if created.error.as_deref() == Some("already-exists") {
            worktree = worktrees::list_worktrees(&repository.path)
                .await
                .map_err(|error| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Could not resolve the existing worktree: {}", error.message),
                    )
                        .into_response()
                })?
                .into_iter()
                .find(|candidate| !candidate.is_main && worktree_label(&candidate.path) == name);
        } else {
            return Err((
                StatusCode::CONFLICT,
                created
                    .message
                    .unwrap_or_else(|| "Could not create the task worktree.".to_string()),
            )
                .into_response());
        }
    }
    let worktree = worktree.ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "The worktree was created but could not be resolved.",
        )
            .into_response()
    })?;
    let attachments = task_attachment_selections(&task);
    let updated = tasks::tasks_update(
        runtime.app.clone(),
        runtime.app.state(),
        task.id,
        task.title,
        task.description,
        repository.id,
        repository.name,
        repository.path,
        worktree.path,
        worktree.branch,
        None,
        uuid::Uuid::new_v4().to_string(),
        attachments,
    )
    .await
    .map_err(server_error)?;
    updated.task.ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            updated
                .message
                .unwrap_or_else(|| "Could not update the task worktree.".to_string()),
        )
            .into_response()
    })
}

async fn start_task(State(runtime): State<Arc<ServerRuntime>>, Path(id): Path<String>) -> Response {
    let all = match tasks::tasks_list(runtime.app.state()).await {
        Ok(value) => value,
        Err(error) => return server_error(error),
    };
    let Some(task) = all.into_iter().find(|task| task.id == id) else {
        return (StatusCode::NOT_FOUND, "Task not found.").into_response();
    };
    if task.status != "todo" && task.status != "review" {
        return (
            StatusCode::CONFLICT,
            "Only To Do and Review tasks can be started.",
        )
            .into_response();
    }
    let mode = match crate::settings::settings_session_launch_mode(runtime.app.clone()) {
        Ok(crate::settings::SessionLaunchMode::Acp) => {
            if task.status == "review" {
                Some(terminal_sessions::CopilotSessionMode::Autopilot)
            } else {
                Some(terminal_sessions::CopilotSessionMode::Plan)
            }
        }
        Ok(
            crate::settings::SessionLaunchMode::External
            | crate::settings::SessionLaunchMode::Embedded,
        ) => {
            return (
                StatusCode::CONFLICT,
                "Remote task start requires In-app Copilot in SWE Factory Settings.",
            )
                .into_response()
        }
        Err(error) => return server_error(error),
    };
    let task = match materialize_task_worktree(&runtime, task).await {
        Ok(task) => task,
        Err(response) => return response,
    };
    let was_todo = task.status == "todo";
    let claim = match tasks::tasks_claim_run(runtime.app.state(), task.id.clone()).await {
        Ok(value) => value,
        Err(error) => return server_error(error),
    };
    if !claim.ok {
        return (
            StatusCode::CONFLICT,
            claim
                .message
                .unwrap_or_else(|| "This task cannot start on its current worktree.".to_string()),
        )
            .into_response();
    }
    let Some(claim_id) = claim.claim_id else {
        return server_error(AppError::msg(
            "The task run claim did not return an identity.",
        ));
    };
    tasks::emit_changed(&runtime.app);
    if was_todo {
        match tasks::tasks_move(
            runtime.app.state(),
            task.id.clone(),
            "in_progress".to_string(),
            None,
        )
        .await
        {
            Ok(result) if result.ok => tasks::emit_changed(&runtime.app),
            Ok(result) => {
                let _ = tasks::tasks_release_run(
                    runtime.app.state(),
                    task.id.clone(),
                    claim_id.clone(),
                    "failed".to_string(),
                )
                .await;
                tasks::emit_changed(&runtime.app);
                return (
                    StatusCode::CONFLICT,
                    result
                        .message
                        .unwrap_or_else(|| "Could not move the task to In Progress.".to_string()),
                )
                    .into_response();
            }
            Err(error) => {
                let _ = tasks::tasks_release_run(
                    runtime.app.state(),
                    task.id.clone(),
                    claim_id.clone(),
                    "failed".to_string(),
                )
                .await;
                tasks::emit_changed(&runtime.app);
                return server_error(error);
            }
        }
    }
    let prompt = if task.description.trim().is_empty() {
        task.title.clone()
    } else {
        format!("{}\n\n{}", task.title, task.description)
    };
    let result = terminal_sessions::terminal_sessions_start(
        runtime.app.clone(),
        StartTerminalSessionRequest {
            folder_path: task.worktree_path,
            label: task.title,
            prompt: Some(prompt),
            attachments: task.attachments,
            resume_session_id: None,
            initial_mode: mode,
            permission_profile: None,
            task_id: Some(task.id.clone()),
            repository: Some(task.repository_name),
            branch: task.worktree_branch,
            prepared_attachments: Vec::new(),
        },
    )
    .await;
    match result {
        Ok(value) if value.ok => {
            let Some(session) = value.session.as_ref() else {
                let _ = tasks::tasks_release_run(
                    runtime.app.state(),
                    task.id.clone(),
                    claim_id,
                    "failed".to_string(),
                )
                .await;
                tasks::emit_changed(&runtime.app);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Copilot started without returning a session.",
                )
                    .into_response();
            };
            let linked = tasks::tasks_set_copilot_session(
                runtime.app.state(),
                task.id.clone(),
                session.id.clone(),
                claim_id.clone(),
            )
            .await;
            if !matches!(linked, Ok(ref result) if result.ok) {
                let _ = terminal_sessions::terminal_sessions_forget(
                    runtime.app.clone(),
                    session.id.clone(),
                )
                .await;
                let _ = tasks::tasks_release_run(
                    runtime.app.state(),
                    task.id,
                    claim_id,
                    "failed".to_string(),
                )
                .await;
                tasks::emit_changed(&runtime.app);
                return (
                    StatusCode::CONFLICT,
                    "Could not link the Copilot session to the current task run.",
                )
                    .into_response();
            }
            tasks::emit_changed(&runtime.app);
            Json(value).into_response()
        }
        Ok(value) => {
            if was_todo {
                let _ = tasks::tasks_move(
                    runtime.app.state(),
                    task.id.clone(),
                    "todo".to_string(),
                    None,
                )
                .await;
            }
            let _ = tasks::tasks_release_run(
                runtime.app.state(),
                task.id,
                claim_id,
                "failed".to_string(),
            )
            .await;
            tasks::emit_changed(&runtime.app);
            Json(value).into_response()
        }
        Err(error) => {
            if was_todo {
                let _ = tasks::tasks_move(
                    runtime.app.state(),
                    task.id.clone(),
                    "todo".to_string(),
                    None,
                )
                .await;
            }
            let _ = tasks::tasks_release_run(
                runtime.app.state(),
                task.id,
                claim_id,
                "failed".to_string(),
            )
            .await;
            tasks::emit_changed(&runtime.app);
            server_error(error)
        }
    }
}

async fn list_sessions(State(runtime): State<Arc<ServerRuntime>>) -> Response {
    match terminal_sessions::terminal_sessions_list(runtime.app.clone()).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => server_error(error),
    }
}

async fn session_history(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
) -> Response {
    match terminal_sessions::terminal_sessions_history(runtime.app.clone(), id).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => server_error(error),
    }
}

async fn native_snapshot(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
    Json(body): Json<NativeTargetBody>,
) -> Response {
    match copilot_acp_sessions::native_session_snapshot(
        runtime.app.clone(),
        Target {
            id,
            generation: body.generation,
        },
    )
    .await
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => server_error(error),
    }
}

async fn native_respond(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
    Json(body): Json<NativeRespondBody>,
) -> Response {
    match copilot_acp_sessions::native_session_respond(
        runtime.app.clone(),
        Target {
            id,
            generation: body.generation,
        },
        body.interaction_id,
        body.answer,
    ) {
        Ok(value) => Json(value).into_response(),
        Err(error) => server_error(error),
    }
}

async fn native_prompt(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
    Json(body): Json<NativePromptBody>,
) -> Response {
    match copilot_acp_sessions::acp_session_enqueue(
        runtime.app.clone(),
        Target {
            id,
            generation: body.generation,
        },
        body.id,
        body.prompt,
        body.literal,
    ) {
        Ok(value) => Json(value).into_response(),
        Err(error) => server_error(error),
    }
}

async fn native_plan(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
    Json(body): Json<PlanBody>,
) -> Response {
    match copilot_acp_sessions::acp_session_plan_transition(
        runtime.app.clone(),
        Target {
            id,
            generation: body.generation,
        },
        body.action.as_str().to_string(),
    )
    .await
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => server_error(error),
    }
}

async fn native_reopen_plan(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
    Json(body): Json<NativeTargetBody>,
) -> Response {
    match copilot_acp_sessions::acp_session_reopen_plan_transition(
        runtime.app.clone(),
        Target {
            id,
            generation: body.generation,
        },
    ) {
        Ok(value) => Json(value).into_response(),
        Err(error) => server_error(error),
    }
}

async fn native_cancel(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
    Json(body): Json<NativeTargetBody>,
) -> Response {
    match copilot_acp_sessions::native_session_cancel(
        runtime.app.clone(),
        Target {
            id,
            generation: body.generation,
        },
    )
    .await
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => server_error(error),
    }
}

async fn native_end(
    State(runtime): State<Arc<ServerRuntime>>,
    Path(id): Path<String>,
    Json(body): Json<NativeTargetBody>,
) -> Response {
    match copilot_acp_sessions::native_session_end(
        runtime.app.clone(),
        Target {
            id,
            generation: body.generation,
        },
    )
    .await
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => server_error(error),
    }
}

async fn websocket(
    State(runtime): State<Arc<ServerRuntime>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if header_text(&headers, header::ORIGIN.as_str()) != Some(runtime.origin.as_str()) {
        return (StatusCode::FORBIDDEN, "WebSocket origin was rejected.").into_response();
    }
    upgrade.on_upgrade(move |socket| websocket_loop(socket, runtime))
}

async fn websocket_loop(mut socket: WebSocket, runtime: Arc<ServerRuntime>) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop {
        interval.tick().await;
        let tasks = tasks::tasks_list(runtime.app.state()).await;
        let sessions = terminal_sessions::terminal_sessions_list(runtime.app.clone()).await;
        let payload = match (tasks, sessions) {
            (Ok(tasks), Ok(sessions)) => json!({
                "type": "snapshot",
                "tasks": tasks,
                "sessions": sessions
            }),
            (Err(error), _) | (_, Err(error)) => {
                json!({ "type": "error", "message": error.to_string() })
            }
        };
        if socket
            .send(Message::Text(payload.to_string().into()))
            .await
            .is_err()
        {
            break;
        }
    }
}

fn server_error(error: AppError) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": error.to_string() })),
    )
        .into_response()
}

pub(crate) async fn execute_task_command(
    app: AppHandle,
    message_type: &str,
    payload: Value,
) -> Result<Value, AppError> {
    let runtime = Arc::new(ServerRuntime {
        app,
        host: String::new(),
        origin: String::new(),
        pairing_secret: String::new(),
        session_secret: String::new(),
    });
    let task_id = payload
        .get("taskId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let response = match message_type {
        "tasks.create" => {
            let body = serde_json::from_value::<CreateTaskBody>(payload)?;
            create_task(State(runtime), Json(body)).await
        }
        "tasks.update" => {
            let id = task_id.ok_or_else(|| AppError::msg("Task id is required."))?;
            let body = serde_json::from_value::<UpdateTaskBody>(payload)?;
            update_task(State(runtime), Path(id), Json(body)).await
        }
        "tasks.move" => {
            let id = task_id.ok_or_else(|| AppError::msg("Task id is required."))?;
            let body = serde_json::from_value::<MoveTaskBody>(payload)?;
            move_task(State(runtime), Path(id), Json(body)).await
        }
        "tasks.delete" => {
            let id = task_id.ok_or_else(|| AppError::msg("Task id is required."))?;
            delete_task(State(runtime), Path(id)).await
        }
        "tasks.start" => {
            let id = task_id.ok_or_else(|| AppError::msg("Task id is required."))?;
            start_task(State(runtime), Path(id)).await
        }
        _ => {
            return Err(AppError::msg(format!(
                "Unsupported remote task command: {message_type}"
            )))
        }
    };
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .map_err(|error| AppError::msg(format!("Could not read remote task response: {error}")))?;
    let text = String::from_utf8_lossy(&bytes);
    if !status.is_success() {
        return Err(AppError::msg(if text.trim().is_empty() {
            format!("Remote task command failed ({status}).")
        } else {
            text.into_owned()
        }));
    }
    serde_json::from_slice(&bytes).map_err(AppError::from)
}

fn router(runtime: Arc<ServerRuntime>, assets: PathBuf) -> Router {
    Router::new()
        .route("/api/pair", post(pair))
        .route("/api/repositories", get(list_repositories))
        .route(
            "/api/repositories/{id}/worktrees",
            get(list_repository_worktrees),
        )
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/{id}", put(update_task).delete(delete_task))
        .route("/api/tasks/{id}/move", post(move_task))
        .route("/api/tasks/{id}/start", post(start_task))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{id}/history", get(session_history))
        .route("/api/sessions/{id}/snapshot", post(native_snapshot))
        .route("/api/sessions/{id}/respond", post(native_respond))
        .route("/api/sessions/{id}/prompt", post(native_prompt))
        .route("/api/sessions/{id}/plan", post(native_plan))
        .route("/api/sessions/{id}/plan/reopen", post(native_reopen_plan))
        .route("/api/sessions/{id}/cancel", post(native_cancel))
        .route("/api/sessions/{id}/end", post(native_end))
        .route("/api/events", get(websocket))
        .fallback_service(ServeDir::new(assets).append_index_html_on_directories(true))
        .layer(RequestBodyLimitLayer::new(1024 * 1024))
        .layer(middleware::from_fn_with_state(runtime.clone(), guard))
        .with_state(runtime)
}

#[tauri::command]
pub async fn local_web_start(
    app: AppHandle,
    state: tauri::State<'_, LocalWebState>,
) -> Result<LocalWebStatus, String> {
    {
        let guard = state.0.lock().map_err(|_| "Server state is unavailable.")?;
        if let Some(running) = guard.as_ref() {
            return Ok(status(&running.runtime));
        }
    }

    let address = lan_address().map_err(|error| error.to_string())?;
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0))
        .await
        .map_err(|error| format!("Could not start the local server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let host = format!("{address}:{port}");
    let runtime = Arc::new(ServerRuntime {
        app: app.clone(),
        origin: format!("http://{host}"),
        host,
        pairing_secret: random_secret(48),
        session_secret: random_secret(48),
    });
    let assets = assets_dir(&app).map_err(|error| error.to_string())?;
    let app_router = router(runtime.clone(), assets);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, app_router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
        {
            eprintln!("local web server stopped unexpectedly: {error}");
        }
    });

    let result = status(&runtime);
    *state.0.lock().map_err(|_| "Server state is unavailable.")? = Some(RunningServer {
        runtime,
        shutdown: Some(shutdown_tx),
    });
    Ok(result)
}

#[tauri::command]
pub fn local_web_status(state: tauri::State<'_, LocalWebState>) -> Result<LocalWebStatus, String> {
    let guard = state.0.lock().map_err(|_| "Server state is unavailable.")?;
    Ok(guard
        .as_ref()
        .map(|running| status(&running.runtime))
        .unwrap_or_else(LocalWebStatus::stopped))
}

#[tauri::command]
pub fn local_web_stop(state: tauri::State<'_, LocalWebState>) -> Result<LocalWebStatus, String> {
    let mut running = state.0.lock().map_err(|_| "Server state is unavailable.")?;
    if let Some(mut server) = running.take() {
        if let Some(shutdown) = server.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    Ok(LocalWebStatus::stopped())
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<LocalWebState>() {
        if let Ok(mut running) = state.0.lock() {
            if let Some(mut server) = running.take() {
                if let Some(shutdown) = server.shutdown.take() {
                    let _ = shutdown.send(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_random_and_fixed_length() {
        let first = random_secret(48);
        let second = random_secret(48);
        assert_eq!(first.len(), 48);
        assert_eq!(second.len(), 48);
        assert_ne!(first, second);
        assert!(constant_eq(&first, &first));
        assert!(!constant_eq(&first, &second));
    }

    #[test]
    fn only_private_non_local_ipv4_addresses_are_eligible() {
        assert!(is_private(Ipv4Addr::new(192, 168, 1, 10)));
        assert!(is_private(Ipv4Addr::new(10, 0, 0, 5)));
        assert!(!is_private(Ipv4Addr::LOCALHOST));
        assert!(!is_private(Ipv4Addr::new(169, 254, 1, 1)));
        assert!(!is_private(Ipv4Addr::new(8, 8, 8, 8)));
    }

    #[test]
    fn plan_transition_actions_are_explicitly_typed() {
        for (value, expected) in [
            ("\"interactive\"", "interactive"),
            ("\"autopilot\"", "autopilot"),
            ("\"autopilot_fleet\"", "autopilot_fleet"),
            ("\"exit_only\"", "exit_only"),
        ] {
            let action: PlanTransitionAction = serde_json::from_str(value).unwrap();
            assert_eq!(action.as_str(), expected);
        }
        assert!(serde_json::from_str::<PlanTransitionAction>("\"unsupported\"").is_err());
    }
}
