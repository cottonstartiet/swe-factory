use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::header, Message},
    MaybeTlsStream, WebSocketStream,
};
use url::Url;

use crate::error::{AppError, AppResult};

const RECORD_SEPARATOR: char = '\u{001e}';

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NegotiateResponse {
    connection_token: String,
}

#[derive(Debug, PartialEq)]
pub enum SignalRMessage {
    Invocation {
        invocation_id: Option<String>,
        target: String,
        arguments: Vec<Value>,
    },
    Completion {
        invocation_id: String,
        result: Option<Value>,
        error: Option<String>,
    },
    Ping,
    Close {
        error: Option<String>,
        allow_reconnect: bool,
    },
    Other(Value),
}

pub struct SignalRConnection {
    socket: Socket,
    pending: String,
}

impl SignalRConnection {
    pub async fn connect(server_url: &str, host_token: &str) -> AppResult<Self> {
        let hub_url = hub_url(server_url)?;
        let negotiate_url = format!("{hub_url}/negotiate?negotiateVersion=1");
        let response = reqwest::Client::new()
            .post(negotiate_url)
            .bearer_auth(host_token)
            .send()
            .await
            .map_err(|error| AppError::msg(format!("SignalR negotiation failed: {error}")))?;
        if !response.status().is_success() {
            return Err(AppError::msg(format!(
                "SignalR negotiation was rejected ({})",
                response.status()
            )));
        }
        let negotiated: NegotiateResponse = response
            .json()
            .await
            .map_err(|error| AppError::msg(format!("Invalid SignalR negotiation response: {error}")))?;

        let mut websocket_url = Url::parse(&hub_url)
            .map_err(|error| AppError::msg(format!("Invalid remote server URL: {error}")))?;
        websocket_url
            .set_scheme(match websocket_url.scheme() {
                "https" => "wss",
                "http" => "ws",
                scheme => {
                    return Err(AppError::msg(format!(
                        "Unsupported remote server URL scheme: {scheme}"
                    )))
                }
            })
            .map_err(|_| AppError::msg("Could not construct the SignalR WebSocket URL."))?;
        websocket_url
            .query_pairs_mut()
            .append_pair("id", &negotiated.connection_token)
            .append_pair("access_token", host_token);

        let mut request = websocket_url
            .as_str()
            .into_client_request()
            .map_err(|error| AppError::msg(format!("Could not create SignalR request: {error}")))?;
        request.headers_mut().insert(
            header::ORIGIN,
            server_url
                .parse()
                .map_err(|error| AppError::msg(format!("Invalid SignalR origin: {error}")))?,
        );
        let (mut socket, _) = connect_async(request)
            .await
            .map_err(|error| AppError::msg(format!("SignalR WebSocket connection failed: {error}")))?;
        socket
            .send(Message::Text(
                format!(r#"{{"protocol":"json","version":1}}{RECORD_SEPARATOR}"#).into(),
            ))
            .await
            .map_err(|error| AppError::msg(format!("SignalR handshake failed: {error}")))?;

        let mut connection = Self {
            socket,
            pending: String::new(),
        };
        let handshake = connection.next_raw().await?;
        if !handshake.trim().is_empty() && handshake.trim() != "{}" {
            let value: Value = serde_json::from_str(&handshake)
                .map_err(|error| AppError::msg(format!("Invalid SignalR handshake: {error}")))?;
            if let Some(error) = value.get("error").and_then(Value::as_str) {
                return Err(AppError::msg(format!("SignalR handshake was rejected: {error}")));
            }
        }
        Ok(connection)
    }

    pub async fn next(&mut self) -> AppResult<SignalRMessage> {
        let raw = self.next_raw().await?;
        parse_message(&raw)
    }

    pub async fn complete(
        &mut self,
        invocation_id: &str,
        result: &Value,
    ) -> AppResult<()> {
        self.send_json(&json!({
            "type": 3,
            "invocationId": invocation_id,
            "result": result
        }))
        .await
    }

    pub async fn invoke(&mut self, target: &str, arguments: Vec<Value>) -> AppResult<()> {
        self.send_json(&json!({
            "type": 1,
            "target": target,
            "arguments": arguments
        }))
        .await
    }

    #[cfg(test)]
    pub async fn close(&mut self) -> AppResult<()> {
        self.socket
            .close(None)
            .await
            .map_err(|error| AppError::msg(format!("Could not close SignalR connection: {error}")))
    }

    async fn send_json(&mut self, value: &Value) -> AppResult<()> {
        let payload = serde_json::to_string(value)
            .map_err(|error| AppError::msg(format!("Could not encode SignalR message: {error}")))?;
        self.socket
            .send(Message::Text(format!("{payload}{RECORD_SEPARATOR}").into()))
            .await
            .map_err(|error| AppError::msg(format!("Could not send SignalR message: {error}")))
    }

    async fn next_raw(&mut self) -> AppResult<String> {
        loop {
            if let Some(index) = self.pending.find(RECORD_SEPARATOR) {
                let value = self.pending[..index].to_string();
                self.pending.drain(..=index);
                return Ok(value);
            }

            let message = self
                .socket
                .next()
                .await
                .ok_or_else(|| AppError::msg("SignalR connection closed."))?
                .map_err(|error| AppError::msg(format!("SignalR receive failed: {error}")))?;
            match message {
                Message::Text(text) => self.pending.push_str(&text),
                Message::Binary(_) => {
                    return Err(AppError::msg(
                        "SignalR server sent binary data to a JSON protocol client.",
                    ))
                }
                Message::Ping(value) => {
                    self.socket
                        .send(Message::Pong(value))
                        .await
                        .map_err(|error| AppError::msg(format!("SignalR pong failed: {error}")))?;
                }
                Message::Close(frame) => {
                    return Err(AppError::msg(
                        frame
                            .map(|value| format!("SignalR connection closed: {}", value.reason))
                            .unwrap_or_else(|| "SignalR connection closed.".into()),
                    ))
                }
                Message::Pong(_) | Message::Frame(_) => {}
            }
        }
    }
}

fn hub_url(server_url: &str) -> AppResult<String> {
    let mut url = Url::parse(server_url)
        .map_err(|error| AppError::msg(format!("Invalid remote server URL: {error}")))?;
    url.set_path("/hubs/remote");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn parse_message(raw: &str) -> AppResult<SignalRMessage> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| AppError::msg(format!("Invalid SignalR message: {error}")))?;
    match value.get("type").and_then(Value::as_u64) {
        Some(1) => Ok(SignalRMessage::Invocation {
            invocation_id: value
                .get("invocationId")
                .and_then(Value::as_str)
                .map(str::to_string),
            target: value
                .get("target")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::msg("SignalR invocation has no target."))?
                .to_string(),
            arguments: value
                .get("arguments")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }),
        Some(3) => Ok(SignalRMessage::Completion {
            invocation_id: value
                .get("invocationId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::msg("SignalR completion has no invocation id."))?
                .to_string(),
            result: value.get("result").cloned(),
            error: value.get("error").and_then(Value::as_str).map(str::to_string),
        }),
        Some(6) => Ok(SignalRMessage::Ping),
        Some(7) => Ok(SignalRMessage::Close {
            error: value.get("error").and_then(Value::as_str).map(str::to_string),
            allow_reconnect: value
                .get("allowReconnect")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        _ => Ok(SignalRMessage::Other(value)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_hub_url_without_existing_path_or_query() {
        assert_eq!(
            hub_url("https://remote.example/base?ignored=1").unwrap(),
            "https://remote.example/hubs/remote"
        );
    }

    #[test]
    fn parses_invocation_and_completion_messages() {
        let invocation =
            parse_message(r#"{"type":1,"invocationId":"1","target":"ExecuteCommand","arguments":[{"id":"a"}]}"#)
                .unwrap();
        assert_eq!(
            invocation,
            SignalRMessage::Invocation {
                invocation_id: Some("1".into()),
                target: "ExecuteCommand".into(),
                arguments: vec![json!({ "id": "a" })]
            }
        );
        let completion =
            parse_message(r#"{"type":3,"invocationId":"1","result":{"ok":true}}"#).unwrap();
        assert_eq!(
            completion,
            SignalRMessage::Completion {
                invocation_id: "1".into(),
                result: Some(json!({ "ok": true })),
                error: None
            }
        );
    }

    #[tokio::test]
    #[ignore = "requires a running remote server and linked host token"]
    async fn connects_to_aspnet_signalr_server() {
        let server_url = std::env::var("SWE_FACTORY_SIGNALR_TEST_URL").unwrap();
        let host_token = std::env::var("SWE_FACTORY_SIGNALR_TEST_TOKEN").unwrap();
        let mut connection = SignalRConnection::connect(&server_url, &host_token)
            .await
            .unwrap();
        connection.close().await.unwrap();
    }
}
