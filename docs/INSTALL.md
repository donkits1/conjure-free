# Installing and running Conjure

This is the long version of the README's install section: prerequisites, both ways to run Conjure, every environment variable that matters, and the first-run failures people actually hit.

## Prerequisites

- **Node.js 24 or newer.** Check with `node --version`. The engine's SQLite module (`better-sqlite3`) is compiled against the Node 24 ABI; Node 22 and older will not load it.
- **pnpm 11** (recommended). `corepack enable` then `corepack prepare pnpm@11.20.0 --activate`, or install it any way you like. npm also works (`npm install`), but the lockfile in this repo is pnpm's.
- **Git** on your PATH. Worker seats run inside per-obligation git worktrees, so the workspace you authorize should be a git repository.
- **A provider CLI, signed in.** At least one of:
  - `claude` (Claude Code). Sign in once with `claude` in a terminal.
  - `codex` (OpenAI Codex CLI). Sign in once with `codex`.

  Conjure never asks for API keys; it runs these programs as child processes and they use their own credentials.
- **Windows 10/11 x64** for the desktop container and the portable build. The engine and browser UI are plain Node and web code and are expected to work on macOS and Linux, but that has not been exercised for this release.

## Option A: portable Windows build

1. Download `Conjure-win-x64-portable.zip` from the [releases page](https://github.com/donkits1/conjure-free/releases).
2. Unzip it somewhere permanent (for example `C:\Conjure`). Keep the folder together; the app, a bundled Node runtime and the engine live side by side inside it.
3. Double-click `Conjure.exe`. The build is not code-signed, so SmartScreen will show "Windows protected your PC" the first time: choose *More info* and then *Run anyway*.
4. Conjure opens full screen. Press **F11** or use the **Window** button at the top right for a normal window. Closing the window keeps the organization running in the tray; use the tray's **Stop the organization and quit** to stop it.

The portable build keeps its state in `%USERPROFILE%\.conjure`.

## Option B: from the repository

```bash
git clone https://github.com/donkits1/conjure-free.git
cd conjure-free
pnpm install
```

`pnpm install` installs the engine's two runtime dependencies (`better-sqlite3`, `yaml`) and Electron 44. A `postinstall` step makes sure the Electron binary was actually downloaded (some package-manager configurations skip Electron's own download step). If it reports a failure, check your network and run `node scripts/ensure-electron.mjs` again.

Then either:

```bash
pnpm desktop               # the desktop app; use "pnpm desktop:windowed" to start as a normal window
```

or, without Electron:

```bash
pnpm start                          # supervisor + gateway on http://127.0.0.1:7790
node core/dist/cli.js browser-url   # prints a single-use login URL for your browser
pnpm status                         # what is running
pnpm doctor                         # provider detection and health, in plain language
pnpm stop
```

The desktop app and the CLI share the same engine, state folder and port. Starting the desktop when a gateway is already running simply attaches to it.

## Where things live

| What | Where | Override |
| --- | --- | --- |
| State (SQLite database, logs, private windows, provider specs) | `~/.conjure` | `CONJURE_HOME` |
| Gateway port (loopback only) | `7790` | `CONJURE_PORT` |
| Initial seat workspace | none until you Browse to one | `CONJURE_WORKSPACE_ROOT` |
| Per-obligation working copies | `<workspace>/.conjure/work/<workId>` | none |
| Raw provider output per attempt | `~/.conjure/logs/attempt-*.txt` | none |

Environment variables the engine and desktop read:

| Variable | Meaning |
| --- | --- |
| `CONJURE_HOME` | State folder. Default `~/.conjure`. |
| `CONJURE_PORT` | Gateway port. Default `7790`. The gateway binds `127.0.0.1` only. |
| `CONJURE_WORKSPACE_ROOT` | Seeds the default seats' workspace on first boot. |
| `CONJURE_CLAUDE_BIN`, `CONJURE_CODEX_BIN` | Path to the provider program. Point at a nonexistent path to simulate an outage. |
| `CONJURE_CLAUDE_SLOTS`, `CONJURE_CODEX_SLOTS`, `CONJURE_<NAME>_SLOTS` | How many attempts or turns a provider may run at once (defaults: Claude 4, Codex 2, experimental 1). |
| `CONJURE_ATTEMPT_TIMEOUT_MS` | Upper bound on a single attempt. |
| `CONJURE_BROWSER` | Program used to open the UI in your browser from the CLI. |
| `CONJURE_FAKE_PROVIDER=1` | Registers the deterministic fake provider used by the check suite. Not for real work. |
| `CONJURE_CORE`, `CONJURE_NODE` | Desktop only: where the engine and the Node runtime are, when not beside `app/`. |

## Running the built-in checks

```bash
pnpm check
```

This boots real gateways on temporary state folders with the fake provider and drives them over HTTP: restarts, outages, load, the privacy boundary, stale-context invalidation, security headers and more. It takes a few minutes and prints one `PASS` or `FAIL` line per check. It never touches `~/.conjure`.

## Troubleshooting first runs

**"Conjure needs Node 24 or newer" or `better_sqlite3.node` failed to load.** Your `node` on PATH is too old, or `pnpm install` ran under a different Node than the one you start Conjure with. Install Node 24+, delete `node_modules` and `core/node_modules`, and run `pnpm install` again.

**The desktop shows "Port 7790 is held by another program".** Something else is listening on 7790. Set `CONJURE_PORT` to a free port and start again, or stop the other program.

**`pnpm desktop` says Electron failed to install or `electron.exe` is missing.** Run `node scripts/ensure-electron.mjs`. Behind a proxy, set `HTTPS_PROXY`; Electron downloads its binary from GitHub releases.

**Doctor says a provider is installed but not signed in.** Run the provider once by hand (`claude` or `codex`) and complete its login, then `pnpm restart`.

**Doctor cannot find `claude` or `codex` although they work in your terminal.** Conjure resolves them on the PATH of the process that started it. Start Conjure from a terminal where they resolve, or set `CONJURE_CLAUDE_BIN` or `CONJURE_CODEX_BIN` to the full path.

**Work is commissioned but nothing runs.** Open **Organization**, click the seat, and check that it has an authorized workspace and a provider that is *Usable now*. Work held for lack of a provider stays visibly held; it is not lost.

**The window closed but Conjure is still running.** That is by design: the organization lives in the tray. Use the tray menu to stop it, or `pnpm stop`.

**Everything is stuck and you want a clean slate.** Stop Conjure, then move or delete `~/.conjure` (or whatever `CONJURE_HOME` points at). This discards your organization, notes and history.

**Logs.** `~/.conjure/logs/` holds the supervisor, gateway and desktop logs plus raw provider output per attempt. `pnpm doctor --json` prints a machine-readable report that contains no credentials.
