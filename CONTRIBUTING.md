# Contributing to Conjure

Thanks for your interest. Conjure is maintained by its creator, Donne Berberabe, and this page explains how contributions work without ceremony.

## The short version

- **Bug reports are welcome.** Open an issue with what you did, what you expected, what happened, your OS and Node version, and the relevant lines from `~/.conjure/logs` or `pnpm doctor`. Strip anything private before pasting.
- **Useful improvements are welcome.** Small, focused pull requests that fix a real problem or make an existing behavior clearer are the easiest to accept.
- **Forks are welcome.** The Apache 2.0 license lets you modify Conjure, keep your changes private, use it inside a company, or ship your own product on top of it. You do not need permission, and you do not need to send changes back.
- **The maintainer decides what lands upstream.** Conjure has a deliberate shape and a direction of its own. Not every clever feature belongs in canonical Conjure, and a declined pull request is not a judgment of its quality. If you are unsure whether something fits, open an issue before writing a lot of code.

There are no response-time promises. This is one person's project.

## Before you open a pull request

1. Read `docs/SOURCE.md` to understand what form the code is in. Engine and desktop changes are made against the JavaScript in `core/dist` and `app/dist`. Web UI changes cannot currently be merged as bundle edits; discuss them in an issue.
2. Run `pnpm check` and make sure it still passes. If your change alters behavior the checks cover, update the checks.
3. Start the desktop (`pnpm desktop`) and exercise the surface you touched.
4. Keep the diff focused. Formatting-only changes, renames for taste, and drive-by refactors make review harder and are usually declined.
5. Describe why in the pull request, not just what.

## Ground rules that will not change

- The gateway stays loopback-only and keeps its session and origin checks.
- Nothing closes work on a model's word alone.
- No telemetry, analytics or phone-home behavior.
- The operator's private thinking (Idea Room) never reaches the organization without an explicit hand-over.

## License of contributions

By submitting a contribution you agree that it is licensed under the Apache License 2.0, the same license as the project, and that you have the right to contribute it.

## Conduct

Be decent. See `CODE_OF_CONDUCT.md`.
