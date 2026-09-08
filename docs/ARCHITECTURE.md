# Architecture

This page is for people who want to understand how Conjure works or change it. It describes what is in this repository, not plans.

## Shape

```
 Desktop container (app/, Electron)          or   your browser
   windows · tray · notifications · lifecycle       via `conjure browser-url`
        │  trusted local client; same credentials as the CLI
        ▼
 ┌──────────────── gateway (one Node process, 127.0.0.1 only) ────────────────┐
 │ api.js           routes: commands + projections + one SSE change stream    │
 │ projections.js   everything a surface shows, computed from the tables      │
 │ reconcile.js     THE mover: decide() is pure, act() is the only writer     │
 │ work.js          obligations · attempts · holds · evidence · returns ·     │
 │                  judgments                                                 │
 │ contracts.js     the immutable context receipt recorded before each run    │
 │ org.js           immutable organization revisions + one ACTIVE pointer     │
 │ ideas.js         notes · folders · seeds · private windows · hand-over     │
 │ collab.js        meetings · people · outside waits                         │
 │ brief.js / receipt.js   what cognition is told · what it returns           │
 │ providers*.js    claude · codex · experimental · fake                      │
 │ tools.js         programs a seat may be granted                            │
 │ editions.js / self.js   editions, build identity, skew detection           │
 │ http-security.js sessions, tickets, Host/Origin checks                     │
 │ db.js            one SQLite file, forward-only migrations (schema v7)      │
 └────────────┬───────────────────────────────────────────┬───────────────────┘
              │ spawn per attempt / per turn               │ started and probed by
              ▼                                            ▼
     provider child process                        supervisor (separate process)
     gets a brief, a workspace, a tool policy      starts / restarts / replaces the gateway
     returns text ending in a receipt block        never migrates, builds or repairs
```

## The objects that matter

| Object | Durable meaning | Never |
| --- | --- | --- |
| **Seat** | Holds responsibility: charter, role, provider preferences, workspace root, lanes, reporting line. | A process. A model. |
| **Obligation** (work) | Something Conjure has accepted responsibility for: brief, acceptance, responsible seat, parent, source. Status is only open, done or cancelled; everything else is derived. | Closed on a model's word. |
| **Attempt** | One execution on behalf of an obligation: provider, model, pid, the contract it was given, its receipt and terminal status. | Successful without a normal exit and a parseable receipt. |
| **Lease** | The only basis for "this attempt occupies that seat's lane". | Held by nobody. |
| **Contract** | The exact prompt, semantic input snapshot, seat and revision recorded transactionally before a provider is invoked. | Rewritten. |
| **Hold** | Why open work is not executing: a reason, what clears it, and a fingerprint so unchanged blockers do not re-spend cognition. | A spinner. |
| **Return** | A usable outcome delivered to you. | Attention-demanding. |
| **Judgment** | A decision genuinely owed to a human, with options and a recommendation. Answering it is what Homework is for. | Answered by a model. |
| **Revision** | An immutable snapshot of the organization. Editing creates a new one; rollback moves the pointer. | Mutated in place. |
| **Note / window / seed** | Your private thinking. Reaches the organization only through an explicit hand-over. | Read by a seat. |
| **Meeting / person / outside wait** | Human dependencies with recorded agendas, outcomes and returned facts. | Auto-acted on. |

## How work moves

1. You commission work (from a directive, or by handing over a note). Conjure records the obligation and the acceptance criteria.
2. The reconciler's pure `decide()` runs over every open obligation and returns exactly one next move: execute, hold (with reason), close, ask (a judgment), commission children (from a plan), or allocate (seat, role, provider). There is no queue table; open work ordered by priority minus holds is the queue.
3. Allocation records the contract, takes a lease, and spawns the provider with the seat's brief, the workspace and the role's tool policy.
4. The attempt ends with a receipt. A worker's `done` becomes a review attempt when the routing names a reviewer; only a passing verdict or your judgment closes the work.
5. Changes to the brief, acceptance, responsibility, charter, workspace, granted tools, source material, applicable decisions or outside returns mark prior results stale. A reviewer cannot make obsolete output current.
6. Bounded retries, then a human: provider failures retry up to a limit, review rounds up to a limit, and past each bound a technical judgment is owed with a recommendation.

Cognition is allocated only when a cause exists: new work, a decided judgment, a finished dependency, an amended brief, a provider returning, or a bounded retry. Unchanged state buys nothing.

## Surfaces

| Surface | What it answers |
| --- | --- |
| **Universe** | Where everything is. Domains (private thought, organization, outside), the responsibility boundary, seats, obligations, attempts, evidence. Semantic zoom; deterministic local layouts; camera per focus. |
| **Rendezvous** | What needs you, what changed, what returned, what waits outside. |
| **Homework** | The judgments owed to you, with the consequences of each answer, and an ignition receipt that says exactly what your answer caused. |
| **Idea Room** | Notes, folders, seeds and private thinking windows. Context is connected explicitly; hand-over is deliberate. |
| **Commission** | Clarify intent with an intake conversation, then accept responsibility. Older work can be loaded explicitly. |
| **Organization** | Seats, routing, workflow design (designed versus compiled versus live), tools, providers, editions. |
| **Conjure itself** | Build identity, schema, skew between code on disk and code running, editions. |

## Processes and ownership

| Process | Started by | Owns | Never does |
| --- | --- | --- | --- |
| supervisor | `conjure start` (the CLI or the desktop) | start, restart with backoff, replace the gateway; health probes | build, migrate, touch the database |
| gateway | supervisor | API, projections, reconciler, its child processes | restart itself |
| provider child | gateway, per attempt or turn | one brief in one working directory | anything durable |
| desktop container | you | windows, tray, notifications, quitting; adopts a running gateway or starts one | replace the gateway |

Boot does nothing before `listen()`: open the database, migrate forward, listen, then reconcile processes against the OS and probe providers. A restart marks every attempt the new gateway holds no handle for as interrupted, never as success.

## Security boundary

Loopback only; Host and Origin checked; a per-boot control secret in `~/.conjure/gateway.json`; single-use short-lived tickets exchanged for HttpOnly session cookies; navigation confined to the gateway; external links go to your own browser. See `SECURITY.md` for what this does and does not guarantee.

## Checks

`pnpm check` runs `core/dist/check/run.js`: real gateways on temporary state folders with the fake provider, driven over HTTP. Scenarios cover fault injection, restart, provider outage, latency under load, the privacy boundary, contract freshness, judgments and returns, asynchronous authority, historical records, HTTP security primitives and integration, provider process handling, and the self and edition surfaces. It never touches `~/.conjure` and uses no test framework.

## Files on disk

| Path | Contents |
| --- | --- |
| `~/.conjure/conjure.db` | Everything durable. |
| `~/.conjure/gateway.json`, `supervisor.json` | Process records, including the control secret (keep private). |
| `~/.conjure/logs/` | Supervisor, gateway and desktop logs; raw provider output per attempt. |
| `~/.conjure/private/<window>/` | Repo-blind working directories for private windows. |
| `~/.conjure/providers/<name>.json` | Experimental provider specs. |
| `~/.conjure/editions/` | Installed editions, when you use that feature. |
| `<workspace>/.conjure/work/<workId>/` | Per-obligation git worktree. |
