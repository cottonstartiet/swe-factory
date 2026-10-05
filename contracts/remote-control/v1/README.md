# Remote control protocol v1

The hosted remote-control transport uses JSON envelopes over ASP.NET Core SignalR.
The server routes envelopes but does not persist their payloads.

## Invariants

- `protocolVersion` is required and currently equals `1`.
- Command IDs are unique per browser command and are used for idempotency.
- Event `sequence` values increase monotonically per host connection generation.
- Consumers request a full `snapshot` after reconnect or a sequence gap.
- A single envelope must remain below 256 KiB. Timeline/history content is paged.
- Payloads may contain sensitive developer data and must never be logged.

## Initial message types

Commands:

- `snapshot.get`
- `repositories.list`
- `worktrees.list`
- `tasks.create`
- `tasks.update`
- `tasks.move`
- `tasks.delete`
- `tasks.start`
- `sessions.history`
- `sessions.snapshot`
- `sessions.respond`
- `sessions.prompt`
- `sessions.plan`
- `sessions.plan.reopen`
- `sessions.cancel`
- `sessions.end`

Events:

- `snapshot`
- `tasks.changed`
- `sessions.changed`
- `sessions.native`
- `host.error`

Unknown message types must fail visibly with `unsupported-message`.
