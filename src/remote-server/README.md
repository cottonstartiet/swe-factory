# SWE Factory Remote server

The Remote server hosts the existing React remote UI and relays commands between an
authenticated browser and a linked SWE Factory desktop host over ASP.NET Core SignalR.

## Security and privacy boundary

- The desktop creates only an outbound TLS connection; it does not expose a public port.
- Task, terminal-session, and native ACP changes are pushed while at least one browser
  is subscribed. Reconnects and detected sequence gaps trigger authoritative resyncs.
- Azure persists users, linked-host metadata, one-time link challenges, and hashed host
  credentials. Tasks, repository paths, prompts, transcripts, and session state are
  relayed only while a host is online.
- TLS terminates at the server, so relayed content is visible to the server process in
  memory. Version 1 is **not end-to-end encrypted**.
- Hub payloads and command arguments must never be logged. Log only identifiers,
  message types, sizes, timings, and result codes.
- Demo authentication is intentionally replaceable and is not suitable for a public
  production deployment. It still requires a secret-backed username and password hash.

## Local development

Build the remote frontend first:

```powershell
yarn build:remote
```

Configure demo credentials. `DemoAuth__PasswordSha256` is a lowercase SHA-256 hash:

```powershell
$password = 'choose-a-local-password'
$env:DemoAuth__UserName = 'demo'
$env:DemoAuth__PasswordSha256 = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($password)
  )
).ToLowerInvariant()
$env:DemoAuth__Subject = 'demo-user'
$env:DemoAuth__DisplayName = 'Demo User'
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$env:ASPNETCORE_URLS = 'http://127.0.0.1:5088'
dotnet run --project src\remote-server\SweFactory.Remote.Server.csproj --no-launch-profile
```

Then open `http://127.0.0.1:5088`. In the desktop app, open **Remote**, enter the same
origin, and complete the browser confirmation.

## Azure deployment

`infra/remote-control/main.bicep` creates:

- one Azure Container App with external HTTPS ingress;
- exactly one always-on replica;
- a Container Apps environment and Log Analytics workspace;
- an Azure Files volume for the small SQLite metadata database.

Self-hosted SignalR routing is held in memory. Do not increase `maxReplicas` or enable
scale-to-zero until the architecture adds managed Azure SignalR Service or a tested
backplane and affinity design.

Build the frontend and image before provisioning:

```powershell
yarn build:remote
docker build -f src\remote-server\Dockerfile -t <registry>/swe-factory-remote:<tag> .
az deployment group create `
  --resource-group <resource-group> `
  --template-file infra\remote-control\main.bicep `
  --parameters containerImage=<registry>/swe-factory-remote:<tag> `
               publicOrigin=https://<remote-host> `
               demoUserName=<user> `
               demoPasswordSha256=<sha256>
```

The deployment command is illustrative; supply secrets through a protected deployment
mechanism rather than shell history in a shared environment.
