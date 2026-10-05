<div align="center">
  <img src="src/renderer/src/assets/icon.png" alt="SWE Factory app icon" width="112" />

  <h1>SWE Factory</h1>

  <p><strong>The developer cockpit for parallel, AI-assisted work.</strong></p>

  <p>
    Manage repositories and git worktrees, run task-focused Copilot sessions, review
    pull requests, and jump back into your real tools without losing context.
  </p>

  <p>
    <a href="https://github.com/cottonstartiet/swe-factory/releases/latest"><strong>Download the latest Windows release</strong></a>
    ·
    <a href="#build-from-source">Build from source</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square" alt="Platform: Windows" />
    <img src="https://img.shields.io/badge/desktop-Tauri_2-24C8DB?style=flat-square" alt="Desktop: Tauri 2" />
    <img src="https://img.shields.io/badge/frontend-React_19-149ECA?style=flat-square" alt="Frontend: React 19" />
    <img src="https://img.shields.io/badge/backend-Rust-000000?style=flat-square" alt="Backend: Rust" />
  </p>

</div>

<!--
Product screenshot slot.
Capture the Dashboard with repositories, active sessions, PRs, and analytics visible.
Save it as docs/images/swe-factory-dashboard.png, then replace this comment with:

![SWE Factory dashboard showing repositories, active Copilot sessions, pull requests, and local analytics](docs/images/swe-factory-dashboard.png)
-->

SWE Factory is a Windows desktop control center for developers working across multiple
branches, worktrees, pull requests, and AI sessions at once. It keeps the state that
matters in one fast, keyboard-friendly workspace, then launches VS Code, Windows
Terminal, GitHub Copilot CLI, or the relevant pull request when it is time to work.

It is a native desktop application built with Tauri and an embedded React/WebView2
renderer. The embedded renderer communicates directly with the Rust backend through
Tauri commands and events. Optional Remote surfaces expose only the scoped remote-control
contract: Local Web runs an explicit LAN server, while hosted Remote Control uses an
outbound SignalR connection to the configured Azure service.

## Why SWE Factory?

Parallel development creates a coordination problem: every task has a repository,
branch, worktree, pull request, terminal, and AI conversation attached to it. Switching
between them usually means reconstructing that context by hand.

SWE Factory turns those moving parts into one workflow:

1. Add the repositories you actively work in.
2. Create or select a worktree for each stream of work.
3. Organize tasks on the board and launch them manually or through Factory mode.
4. Work with Copilot in native chat, an embedded terminal, or Windows Terminal.
5. Inspect repository state and review GitHub or Azure DevOps pull requests in app.
6. Resume prior sessions and understand local Copilot usage without leaving the desktop.

The goal is simple: move between parallel tasks in seconds while always seeing the real
git, pull-request, and session state.

## Features

### Repository and worktree control

- Manage multiple local repositories from one collapsible sidebar.
- Discover, create, open, and remove git worktrees.
- See branch, dirty-working-tree, commit, and pull-request context.
- Launch a worktree directly in VS Code, Windows Terminal, or Copilot.
- Work with both GitHub and Azure DevOps remotes.

### Task factory

- Track work on a drag-and-drop task board.
- Target the main working copy, an existing worktree, or a worktree created when the
  task starts.
- Link tasks to their active Copilot sessions and execution state.
- Run tasks deliberately in manual mode or let Factory mode advance queued work.
- Surface running, queued, completed, and failed work without hiding errors.

### Copilot as a first-class workspace

- Use **In-app chat** through the GitHub Copilot CLI ACP integration.
- Run Copilot or plain PowerShell in an **embedded terminal** backed by ConPTY.
- Launch **External Copilot terminal** sessions in Windows Terminal.
- Send immediately or queue follow-up instructions while a turn is running.
- Review tool calls, diffs, plans, rich output, permissions, and elicitation in the
  native session timeline when the connected agent provides them.
- Resume saved conversations and keep task/session context connected.

> [!NOTE]
> Native chat uses ACP v1 and is currently a public-preview integration. Available
> commands and capabilities follow the installed Copilot CLI; SWE Factory does not
> invent unsupported terminal operations or silently switch session modes.

### Pull-request workflow

- Browse pull requests assigned to you and recent review candidates.
- Review GitHub and Azure DevOps diffs, files, threads, comments, and votes in app.
- Open the pull request in its provider when needed.
- Start a Copilot code-review session or address review comments from the matching
  source worktree.
- Keep authored pull requests and pending review attention visible on the Dashboard.

<!--
Pull-request screenshot slot.
Capture the in-app review workspace with the file tree, diff, and discussion visible.
Save it as docs/images/swe-factory-pr-review.png, then replace this comment with:

![SWE Factory pull-request review workspace with file tree, diff, and review threads](docs/images/swe-factory-pr-review.png)
-->

### Local history and analytics

- Search and resume GitHub Copilot CLI history by repository, host, and time range.
- Explore 7-, 30-, and 90-day activity with overview, flow, and practices views.
- Inspect token mix, model usage, cost records, latency, cadence, and repository trends
  when those fields exist in local history.
- Expand prompt examples only when needed; excerpts are not shown by default.
- Calculate reports locally without uploading prompts or calling an LLM.

### Desktop-native by design

- Stay in a focused desktop window with compact Chalk and Enterprise themes.
- Keep managed sessions active while navigating between product areas.
- Store repositories, tasks, queues, and bounded transcripts in local SQLite.
- Receive signed updates through GitHub Releases after explicitly accepting the update.
- Use the real developer tools already installed on your machine.

### Remote control

- Link one or more SWE Factory laptops to the hosted Remote web app with a short-lived
  browser confirmation code.
- Select an online host and use the existing remote Dashboard, Tasks, and Copilot
  Sessions surfaces from another browser.
- Keep inbound ports closed: the desktop maintains an authenticated outbound SignalR
  connection and remains the source of truth.
- Store only account, linked-host, and credential metadata in Azure. Task and session
  content is relayed while the laptop is online rather than persisted by the service.
- Keep the existing Local Web QR flow available as a local-network fallback.

> [!WARNING]
> Hosted Remote Control currently uses replaceable demo authentication and is not ready
> for a public production deployment. TLS terminates at the relay, so live session
> content is not end-to-end encrypted even though it is not stored by the service.

## Install

SWE Factory currently ships as a signed **Windows x64 NSIS installer**.

1. Open the [latest GitHub Release](https://github.com/cottonstartiet/swe-factory/releases/latest).
2. Download the Windows x64 `setup.exe` asset.
3. Run the installer and launch **SWE Factory**.

WebView2 is required and is preinstalled on current Windows versions.

### Tool prerequisites

Install only the tools required for the workflows you use:

| Workflow                                 | Required tools                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository and worktree management       | [Git](https://git-scm.com/download/win)                                                                                                        |
| GitHub pull requests                     | [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login`                                                                       |
| Azure DevOps pull requests               | [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli-windows) with the Azure DevOps extension and an authenticated organization |
| Copilot sessions, history, and analytics | [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/set-up/install-copilot-cli) installed and authenticated                           |
| Source builds                            | Node.js 22, Yarn 1.22.22 through Corepack, Rust 1.94+, and MSVC build tools                                                                    |

Missing or incompatible tools produce an explicit error; SWE Factory does not
automatically install CLIs, change authentication, or fall back to a different Copilot
session mode.

### First run

1. Add a local repository from the sidebar.
2. Select its main working copy or create a worktree.
3. Open **Settings → Copilot sessions** and choose In-app chat, Embedded terminal, or
   External Copilot terminal.
4. Add a task, open a pull request, or launch Copilot directly from the repository.

New installations default to native ACP chat. Changing the setting affects new and
resumed sessions; it never moves a runtime that is already active.

## How it works

```text
React 19 + TypeScript renderer (WebView2)
                  │
          Tauri commands/events
                  │
Rust backend ─ SQLite ─ Git / gh / az / Copilot CLI / Windows tools
      │
      └── outbound SignalR ─ ASP.NET Core Remote server ─ hosted React Remote UI
```

- **Renderer:** React, TypeScript, Vite, Tailwind CSS, and shadcn/ui in
  `src/renderer/`.
- **Backend:** Tauri 2 and Rust commands in `src-tauri/`.
- **Shared contracts:** TypeScript request/response types in `src/shared/`.
- **Persistence:** Bundled SQLite through `rusqlite`.
- **Copilot:** ACP over stdio for native chat, ConPTY for embedded terminals, or an
  external Windows Terminal process.
- **Updates:** Signed Tauri updater artifacts published by GitHub Actions.
- **Hosted Remote:** ASP.NET Core 8, self-hosted SignalR, and a React client deployed as
  a single-replica Azure Container App.

Repository operations are isolated by path, and slow CLI work runs outside the
renderer. Timeouts are reported as errors rather than presented as successful
rollbacks, so remote or repository state should be checked before retrying a write.

## Data and privacy

SWE Factory keeps its own application data in:

```text
%APPDATA%\com.ritekode.swefactory\swe-factory.db
```

That database stores configured repositories, tasks, terminal-session metadata,
durable ACP queues, and bounded ACP transcripts. Queued file attachments can include
copied file contents and remain in the app data directory; SWE Factory does not encrypt
that database.

Repositories, worktrees, CLI authentication, and Copilot's own saved history remain
independent of the app database. Analytics reads `~/.copilot/session-store.db`
read-only, computes reports locally, and does not write analytics reports to disk or
send prompts to an LLM.

When hosted Remote Control is linked, the desktop stores the host credential in the
Windows credential store. The Azure service persists link/account metadata but not
tasks, repository paths, prompts, transcripts, or session history. Live relay payloads
are visible to the server process in memory and must not be emitted to logs or telemetry.

## Build from source

### Prerequisites

- Windows with WebView2 and the MSVC build tools
- [Rust](https://rustup.rs/) 1.94 or newer
- Node.js 22
- Corepack, using the repository-pinned Yarn 1.22.22

### Run the desktop app

```powershell
corepack enable
yarn install --frozen-lockfile
yarn dev
```

`yarn dev` starts the complete Tauri application with renderer hot reload.
`yarn dev:web` serves only the internal renderer used by Tauri; it is not a standalone
browser product.

### Useful commands

| Command                                                 | Purpose                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `yarn dev`                                              | Run the complete desktop app in development                                     |
| `yarn typecheck`                                        | Type-check the renderer                                                         |
| `yarn lint`                                             | Run ESLint                                                                      |
| `yarn build:web`                                        | Build the embedded desktop renderer                                             |
| `yarn build:remote`                                     | Build the LAN companion renderer bundled with the desktop app                   |
| `yarn build`                                            | Build the signed NSIS/updater artifacts when signing credentials are configured |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | Run Rust library tests                                                          |
| `cargo clippy --manifest-path src-tauri/Cargo.toml`     | Lint the Rust backend                                                           |

Focused regression contracts live in `scripts/*.test.mjs`. The release workflow runs
the renderer typecheck, selected Node contract tests, and Rust library tests before
publishing.

## Project structure

```text
src/
├─ renderer/
│  ├─ index.html
│  └─ src/
│     ├─ components/    # app shell, sessions, reviews, analytics, UI primitives
│     ├─ contexts/      # task, dashboard, repository, and session state
│     ├─ hooks/         # backend-backed feature hooks
│     ├─ lib/           # Tauri API facade and workflow helpers
│     └─ pages/         # Dashboard, Tasks, Reviews, Sessions, History, Analytics
├─ remote/              # companion renderer bundled as a Tauri resource
└─ shared/              # renderer/backend request and response contracts

src-tauri/
├─ src/                 # Rust commands, persistence, Git/PR/Copilot integration
├─ capabilities/        # Tauri window permissions
└─ tauri.conf.json      # desktop bundle, deep-link, and updater configuration
```

## Releases and updates

Pushing a version to `main` that is newer than every existing `v*` tag triggers the
Windows release workflow. It validates the application, builds and signs the installer,
generates the Tauri updater manifest, and publishes the assets as the latest GitHub
Release.

The desktop app checks that release channel on launch. Download and installation begin
only after the user accepts **Restart & update**.

## Current scope

- Windows desktop and Windows x64 installers
- GitHub and Azure DevOps pull-request integrations
- GitHub Copilot CLI history and ACP v1 native sessions
- Local, single-user application state

SWE Factory is intentionally a focused developer utility—not an IDE, hosted project
management platform, or replacement for Git, your code editor, or your pull-request
provider.
