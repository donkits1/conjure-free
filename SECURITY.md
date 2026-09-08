# Security policy

Conjure runs on your machine, starts AI provider programs as child processes, lets those programs read and write files inside workspaces you authorize, and keeps a local HTTP gateway. Please read what it does and does not guarantee before relying on it, and please report problems privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: **Security, then Report a vulnerability** on https://github.com/donkits1/conjure-free. That creates a private advisory only the maintainer can see.

If that option is not visible to you, open a regular issue that says only "security: please contact me" without details, and the maintainer will arrange a private channel.

Please do not post exploit details, credentials or affected file contents in public issues. There is no bug bounty and no guaranteed response time, but reports are read and taken seriously.

## Supported versions

Only the latest release on the `main` branch receives fixes.

## What the current software does

- **Loopback only.** The gateway listens on `127.0.0.1` and refuses requests whose `Host` or `Origin` do not match it. Browser sessions are created from a single-use, short-lived ticket minted with a per-boot control secret that lives in `~/.conjure/gateway.json`; sessions are HttpOnly cookies that expire after 24 hours.
- **Providers run with their own credentials.** Conjure stores no API keys. It runs `claude`, `codex` or the program you register and inherits your environment. Anything those programs can do with your credentials, they can do when Conjure runs them.
- **Worker seats can change files**, but only inside the workspace you authorized for that seat, in a per-obligation git worktree, and only through the tool allowlist Conjure passes to the provider (for Claude Code: file tools plus a bounded set of `git`, `pnpm`, `npm`, `node`, `ls` and `cat` commands, plus any tool you explicitly grant). Reviewer and thinking-window runs are given read-only policies where the provider supports them.
- **Experimental providers have no enforced sandbox.** A program you register through a provider spec runs in a private directory with the prompt and the notes you connected; Conjure cannot impose a tool or write policy on a program it does not know. The UI says so wherever such a provider appears.
- **Provider output is redacted before storage** for common credential shapes (bearer tokens, `token=`, `password=`, `api_key=`), as a last line of defense, not a guarantee. Raw provider output is still written to `~/.conjure/logs/attempt-*.txt`; treat that folder as sensitive.
- **Private thinking stays private by design.** Idea Room windows run repo-blind in an empty private directory and see only the conversation and the notes you connect. Notes reach the organization only through an explicit hand-over. Previously disclosed text in saved conversation history remains disclosed.
- **No telemetry.** Conjure makes no network requests except to your own loopback gateway; provider programs make their own.

## What it does not guarantee

- It is not a sandbox for untrusted models or untrusted code. A provider program with your credentials and write access to a workspace can do harm if it is instructed to or misbehaves. Authorize workspaces deliberately and keep backups or version control.
- It does not protect against other software running as your user, which can read `~/.conjure` (including the control secret and the database).
- The Windows build is unsigned. Verify the SHA-256 published with each release before running it.
- This is an early release by a single maintainer. It has an automated check suite covering the gateway's authentication, origin and host boundaries, but it has not had an independent security audit.
