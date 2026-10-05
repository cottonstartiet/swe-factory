use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: &str = "1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommand {
    pub id: String,
    pub protocol_version: String,
    #[serde(rename = "type")]
    pub message_type: String,
    pub expected_revision: Option<i64>,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommandResult {
    pub id: String,
    pub ok: bool,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub revision: Option<i64>,
    pub payload: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEvent {
    pub protocol_version: String,
    #[serde(rename = "type")]
    pub message_type: String,
    pub sequence: u64,
    pub revision: Option<i64>,
    pub payload: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_fixture_matches_rust_contract() {
        let command: RemoteCommand = serde_json::from_str(include_str!(
            "../../contracts/remote-control/v1/fixtures/command.json"
        ))
        .unwrap();
        assert_eq!(command.protocol_version, PROTOCOL_VERSION);
        assert_eq!(command.message_type, "sessions.prompt");
        assert_eq!(command.expected_revision, Some(7));
    }

    #[test]
    fn event_fixture_matches_rust_contract() {
        let event: RemoteEvent = serde_json::from_str(include_str!(
            "../../contracts/remote-control/v1/fixtures/event.json"
        ))
        .unwrap();
        assert_eq!(event.protocol_version, PROTOCOL_VERSION);
        assert_eq!(event.sequence, 42);
    }
}
