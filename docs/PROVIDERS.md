# Providers

A provider is a program Conjure runs to do the thinking. Conjure hands it a brief, a working directory and a model choice, waits for its answer, and records the exact exchange. Providers are never organizational identity: seats keep responsibility, providers come and go.

Conjure stores no API keys. Every provider uses its own login.

## Built-in providers

| Provider | Program | Models offered | How it runs |
| --- | --- | --- | --- |
| Claude | `claude` (Claude Code) | `sonnet`, `opus`, `haiku` | Headless `claude -p` with a tool allowlist that depends on the role: workers get file tools and a bounded set of shell commands inside their workspace; reviewers and private windows are read-only. |
| Codex | `codex` (OpenAI Codex CLI) | `gpt-5.6-terra`, `gpt-5.5` | `codex exec` settled on Codex's own completion event; the process tree is cleaned up afterwards. |

Conjure probes both at boot and periodically, and shows the truth: not installed, not runnable, not signed in, or usable. `pnpm doctor` prints the same in plain language with a fix hint.

Overrides:

- `CONJURE_CLAUDE_BIN`, `CONJURE_CODEX_BIN`: use a specific program path.
- `CONJURE_CLAUDE_SLOTS`, `CONJURE_CODEX_SLOTS`: concurrent runs allowed (defaults 4 and 2).

Seats name their providers in preference order. Allocation takes the first one currently available, and the attempt records which provider and model actually ran.

## Bringing your own program (experimental providers)

Any CLI that accepts a prompt and prints an answer can be registered without Conjure shipping an adapter for it. Register it from the **Experimental providers** surface, or drop a JSON file into `~/.conjure/providers/<name>.json`:

```json
{
  "name": "my-model",
  "label": "My local model",
  "command": "C:\\tools\\my-model.exe",
  "args": ["--prompt", "{prompt}"],
  "probeArgs": ["--version"],
  "models": [{ "id": "default", "label": "Default" }],
  "defaultModel": "default",
  "output": "text",
  "slots": 1,
  "note": "Runs entirely offline."
}
```

Fields:

- `name` (required): lowercase letters, digits and dashes; not `claude`, `codex` or `fake`.
- `command` (required): the program. Resolved on PATH or as a full path.
- `args`: arguments. If any contains `{prompt}` it is substituted; otherwise the prompt is written to the program's stdin.
- `probeArgs`: arguments for a quick availability check (for example `--version`).
- `models`, `defaultModel`, `efforts`, `defaultEffort`: what the UI offers.
- `output`: `text` (the whole stdout is the answer) or `json-last-line:<field>` (parse the last stdout line as JSON and take that field).
- `slots`: concurrent runs; `CONJURE_<NAME>_SLOTS` overrides it.
- `promoted`: `true` once you allow seats to use it (see below).

What happens next:

1. The provider is probed and appears immediately in **Idea Room** windows, where it runs in the window's private directory with the prompt and the notes you connected. Nothing else.
2. It is **not** allocated to organizational work until you promote it. A seat that names an unpromoted provider holds visibly with a "no processor" reason.
3. Promotion is a single flag on the spec. Discarding the spec removes the provider; work and windows survive.

**Boundary, stated plainly:** Conjure cannot impose a tool or write policy on a program it does not know. An experimental provider runs with your user's permissions. The UI shows this wherever the provider appears. Use programs you trust.

## The fake provider

`CONJURE_FAKE_PROVIDER=1` registers a deterministic fake used by the check suite. It answers with canned receipts and exists so the engine's behavior can be verified without spending money. Do not use it for real work.
