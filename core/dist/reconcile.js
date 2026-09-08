// The one reconciler. Runs on every durable transition (debounced) and on a slow fallback timer.
// It allocates cognition only when a cause exists. Unchanged state purchases nothing.
//
// Shape: `decide` is pure cold software - it reads durable state and says what is owed for one obligation.
// `act` is the only place that writes. Network shows `decide`'s answer verbatim, so the picture the operator
// sees is the reconciler's own next move, not a re-implementation of it.
import fs from "node:fs";
import path from "node:path";
import { resolveExecutable, execProvider, classifyProbe, redact } from "./provider-exec.js";
import { id, now, fingerprint } from "./ids.js";
import { append, bus } from "./events.js";
import { activeRevision } from "./org.js";
import { providerRegistry } from "./providers.js";
import { parseReceipt } from "./receipt.js";
import { renderBrief } from "./brief.js";
import { captureContract, saveContract, contractStatus } from "./contracts.js";
import { grantsFor } from "./tools.js";
import { paths } from "./home.js";
import { q, setHold, clearHold, closeDone, addEvidence, askJudgment, commission } from "./work.js";
export function createRuntime(db, log) {
    return { db, bootId: id("boot"), providers: providerRegistry(), handles: new Map(), log,
        attemptTimeoutMs: Number(process.env.CONJURE_ATTEMPT_TIMEOUT_MS ?? 20 * 60_000), fallbackMs: Number(process.env.CONJURE_FALLBACK_MS ?? 60_000),
        probeMs: Number(process.env.CONJURE_PROBE_MS ?? 120_000), stopped: false, probed: false, ticks: 0, lastTickAt: null, lastTickMs: 0, lastWake: "boot", container: null };
}
// --- process truth --------------------------------------------------------------------------------
export function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === "EPERM";
    }
}
/** On boot: attempts this gateway is not holding a handle for cannot report a result. That is interrupted, not success. */
export function reconcileProcessesOnBoot(rt) {
    const { db } = rt;
    for (const a of q.runningAttempts(db)) {
        if (rt.handles.has(a.id))
            continue;
        if (a.pid && pidAlive(a.pid)) {
            try {
                process.kill(a.pid);
            }
            catch { /* already gone */ }
        }
        settleAttempt(rt, a.id, { status: "interrupted", text: "", providerSession: null, costUsd: null, error: "gateway restarted while this attempt was running" });
    }
    // Conversation turns are awaited in-process; a turn still 'running' at boot lost its owner. Truth: failed, not pending.
    db.prepare("UPDATE turns SET status='failed', error='gateway restarted while this turn was running' WHERE status='running'").run();
    db.prepare("DELETE FROM processes WHERE gateway_boot <> ?").run(rt.bootId);
    db.prepare("DELETE FROM leases WHERE attempt_id NOT IN (SELECT id FROM attempts WHERE status='running')").run();
}
// --- provider availability and capacity -----------------------------------------------------------
export async function probeProviders(rt) {
    const results = await Promise.all([...rt.providers.values()].map(async (p) => {
        try {
            return { name: p.name, ...(await p.probe()) };
        }
        catch (e) {
            return { name: p.name, state: "error", available: false, detail: e.message };
        }
    }));
    // One transaction: a reader never sees a half-probed table.
    rt.db.transaction(() => {
        for (const res of results) {
            const prev = rt.db.prepare("SELECT available, state FROM providers WHERE name=?").get(res.name);
            rt.db.prepare("INSERT INTO providers(name,available,detail,observed_at,state) VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET available=excluded.available, detail=excluded.detail, observed_at=excluded.observed_at, state=excluded.state")
                .run(res.name, res.available ? 1 : 0, res.detail, now(), res.state);
            // A change of state is a fact worth recording even when availability itself did not change
            // (installed-but-signed-out becoming not-installed is news to the operator).
            if (!prev || Boolean(prev.available) !== res.available || prev.state !== res.state) {
                append(rt.db, "provider", res.name, res.available ? "available" : "unavailable", { state: res.state, detail: res.detail });
            }
        }
    })();
    rt.probed = true;
}
export function providerAvailable(rt, name) {
    const r = rt.db.prepare("SELECT available FROM providers WHERE name=?").get(name);
    return !!r && r.available === 1;
}
/** Cognition in flight on one provider: organizational attempts plus the operator's own conversation turns. */
export function providerSlots(rt, name) {
    const p = rt.providers.get(name);
    const attempts = rt.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status='running' AND provider=?").get(name).n;
    const turns = rt.db.prepare("SELECT COUNT(*) AS n FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.status='running' AND c.provider=?").get(name).n;
    return { slots: p?.capabilities.slots ?? 0, attempts, turns };
}
export function worldOf(rt, rev) {
    // An experimental provider is known to windows at once but to the organization only once promoted: allocation treats it as absent.
    const allocatable = (p) => { const pr = rt.providers.get(p); return !!pr && !(pr.capabilities.experimental && !pr.capabilities.promoted); };
    return { db: rt.db, rev, probed: rt.probed, known: allocatable, available: (p) => providerAvailable(rt, p), slots: (p) => providerSlots(rt, p), workspaceOk: (root) => fs.existsSync(root), unpromoted: (p) => { const pr = rt.providers.get(p); return !!pr?.capabilities.experimental && !pr.capabilities.promoted; } };
}
export function modeOf(d) {
    if (d.kind === "executing" || d.kind === "allocate")
        return "cognition";
    if (d.kind === "ask")
        return "human";
    if (d.kind === "hold" && (d.reason === "judgment" || d.reason === "review-ceiling" || d.reason === "recovery-exhausted"))
        return "human";
    if (d.kind === "hold" && d.reason === "external")
        return "external";
    return "cold";
}
/** Open waits on a person for this work. Placed just before allocation: a result already produced is still reviewed and
 *  closed; only the *next* purchase of cognition waits for the human. Waiting costs no lane and no process. */
function externalHold(db, work) {
    const open = db.prepare("SELECT w.id, w.kind, w.description, w.due_at, p.name FROM waits w JOIN people p ON p.id = w.person_id WHERE w.status='waiting' AND w.subject_type='work' AND w.subject_id=? ORDER BY w.since").all(work.id);
    if (!open.length)
        return null;
    const detail = open.map((x) => `${x.name}: ${x.kind}${x.description ? ` (${x.description})` : ""}`).join("; ");
    return { kind: "hold", reason: "external", detail: `waiting on ${detail}`, clearsWhen: `${open.map((x) => x.name).join(" and ")} return${open.length === 1 ? "s" : ""} (marked returned by the operator, or by evidence from the tool that knows)`, fingerprint: fingerprint("external", open.map((x) => x.id)) };
}
/** A settled attempt whose receipt is the right shape for its role. Anything else is a failure to produce a result. */
function usable(a) {
    if (a.status !== "succeeded" || !a.receipt)
        return false;
    return a.role === "reviewer" ? a.receipt.outcome === "verdict" : a.receipt.outcome !== "verdict";
}
export function decide(w, work) {
    const { db, rev } = w;
    const attempts = q.attempts(db, work.id);
    const running = attempts.find((a) => a.status === "running");
    if (running)
        return { kind: "executing", attemptId: running.id, role: running.role, provider: running.provider, model: running.model, since: running.startedAt };
    const hold = q.hold(db, work.id);
    // A judgment owed on this work: quiet. Nothing is bought until a human decides. A more specific hold (ceiling, exhausted) keeps its name.
    const owed = q.openJudgmentFor(db, "work", work.id);
    if (owed)
        return hold ? { kind: "hold", reason: hold.reason, detail: hold.detail, clearsWhen: hold.clearsWhen, fingerprint: hold.fingerprint } : { kind: "hold", reason: "judgment", detail: owed.question, clearsWhen: `judgment ${owed.id} decided`, fingerprint: fingerprint("judgment", owed.id) };
    // Children: a parent with open children waits; when all children close, the parent closes as delivered.
    const kids = q.children(db, work.id);
    if (kids.length) {
        const open = kids.filter((k) => k.status === "open");
        if (open.length)
            return { kind: "hold", reason: "dependency", detail: `${open.length} of ${kids.length} child work item(s) still open`, clearsWhen: `children ${open.map((k) => k.id).join(",")} close`, fingerprint: fingerprint("children", open.map((k) => k.id)) };
        if (!kids.every((k) => k.status === "done"))
            return { kind: "ask", judgment: { kind: "technical", ask: { question: `Some parts of "${work.title}" were cancelled. What should happen to the whole?`, options: ["accept as is", "cancel"], recommended: "cancel", context: kids.map((k) => `${k.id} ${k.status}: ${k.title}`).join("\n") } } };
        const plan = [...attempts].reverse().find((a) => a.receipt?.outcome === "plan");
        if (plan && contractStatus(db, plan.id).stale)
            return { kind: "ask", judgment: { kind: "technical", ask: { question: `The contract for "${work.title}" changed after its parts were commissioned. Do the delivered parts satisfy the current intent?`, options: ["accept as is", "cancel"], recommended: "cancel", context: "The original allocation and the current contract differ. Inspect the delivered context before accepting the whole." } } };
        return { kind: "close", attemptId: null, summary: `All ${kids.length} parts delivered: ${kids.map((k) => k.title).join("; ")}` };
    }
    const seat = rev.seats.find((s) => s.id === work.seat) ?? null;
    if (!seat)
        return { kind: "hold", reason: "no-processor", detail: `seat '${work.seat}' is not in ${rev.id}`, clearsWhen: "the organization names this seat again" };
    // A judgment decided after the newest usable receipt means a human acted on it: the receipt is consumed and fresh cognition is owed.
    const lastDecision = db.prepare("SELECT decided_at FROM judgments WHERE subject_type='work' AND subject_id=? AND status='decided' ORDER BY decided_at DESC LIMIT 1").get(work.id)?.decided_at ?? null;
    let lastUsable = null;
    for (let i = attempts.length - 1; i >= 0; i--) {
        const a = attempts[i];
        if (usable(a)) {
            lastUsable = a;
            break;
        }
    }
    const lastSuccessAt = lastUsable ? lastUsable.endedAt ?? lastUsable.startedAt : null;
    if (lastUsable && lastDecision && lastDecision > (lastUsable.endedAt ?? lastUsable.startedAt))
        lastUsable = null;
    const ownContract = lastUsable ? contractStatus(db, lastUsable.id) : null;
    const reviewedResult = lastUsable?.receipt?.outcome === "verdict" && lastUsable.receipt.pass
        ? [...attempts].reverse().find(a => a.role !== "reviewer" && a.receipt?.outcome === "done" && a.round === lastUsable.round) : null;
    const resultContract = reviewedResult ? contractStatus(db, reviewedResult.id) : null;
    const obsolete = ownContract?.stale ? ownContract : resultContract?.stale ? resultContract : ownContract;
    if (obsolete?.stale)
        lastUsable = null;
    // Failures since the last usable result (or since the last decision) are one streak; the usable result itself still stands.
    const cutoff = [lastSuccessAt, lastDecision].filter((t) => !!t).sort().at(-1) ?? null;
    const failures = attempts.filter((a) => a.status !== "running" && !usable(a) && (!cutoff || (a.endedAt ?? a.startedAt) > cutoff));
    if (failures.length) {
        const newest = failures[failures.length - 1];
        const streak = failures.length;
        if (streak > rev.routing.retryLimit) {
            const fp = fingerprint("exhausted", work.id, streak);
            return { kind: "ask", judgment: { kind: "technical", ask: { question: `${streak} attempt(s) on "${work.title}" ended without a result (last: ${(newest.error ?? "no usable receipt").slice(0, 120)}). What now?`, options: ["retry", "cancel"], recommended: "retry", context: failures.slice(-3).map((a) => `${a.id} ${a.provider}/${a.model} ${a.status}: ${a.error ?? ""}`).join("\n") } },
                hold: { reason: "recovery-exhausted", detail: newest.error ?? "attempts keep ending without a result", clearsWhen: "operator judgment", fingerprint: fp } };
        }
        const backoffMs = Math.min(60_000, 5_000 * 2 ** (streak - 1));
        const since = Date.parse(newest.endedAt ?? newest.startedAt);
        if (Date.now() - since < backoffMs)
            return { kind: "hold", reason: "backoff", detail: `retry ${streak}/${rev.routing.retryLimit} after ${backoffMs / 1000}s`, clearsWhen: new Date(since + backoffMs).toISOString(), wakeAt: since + backoffMs };
    }
    // What the newest usable receipt says is owed. The worker's role is the seat's role; review is a different role on the reviewer seat.
    let role = seat.role;
    let allocSeat = seat;
    let round = work.rounds;
    let why = obsolete?.stale ? `contract changed: ${obsolete.changes.join(", ")}; the previous result cannot settle this obligation` : lastUsable ? "fresh cognition is owed" : attempts.length ? "earlier attempts ended without a result; retrying" : "new obligation";
    if (lastUsable) {
        const r = lastUsable.receipt;
        switch (r.outcome) {
            case "done": {
                if (!rev.routing.reviewer || seat.role !== "worker")
                    return { kind: "close", attemptId: lastUsable.id, summary: r.summary };
                const reviewer = rev.seats.find((s) => s.id === rev.routing.reviewer);
                if (!reviewer)
                    return { kind: "hold", reason: "no-processor", detail: `reviewer seat '${rev.routing.reviewer}' is not in ${rev.id}`, clearsWhen: "the organization names a reviewer" };
                allocSeat = reviewer;
                role = "reviewer";
                round = lastUsable.round;
                why = "a result awaits review";
                break;
            }
            case "verdict": {
                if (r.pass) {
                    const result = [...attempts].reverse().find((a) => a.role !== "reviewer" && a.receipt?.outcome === "done" && a.round === lastUsable.round);
                    return { kind: "close", attemptId: result?.id ?? lastUsable.id, summary: result?.receipt?.outcome === "done" ? `${result.receipt.summary}\n\nReview: ${r.summary}` : r.summary };
                }
                const nextRound = lastUsable.round + 1;
                if (nextRound >= rev.routing.maxRounds) {
                    return { kind: "ask", judgment: { kind: "technical", ask: { question: `"${work.title}" failed review ${nextRound} time(s). How should Conjure proceed?`, options: ["allow another round", "accept as is", "cancel"], recommended: "allow another round", context: `Latest reviewer verdict: ${r.summary}`, priority: 2 } },
                        hold: { reason: "review-ceiling", detail: r.summary, clearsWhen: "operator judgment", fingerprint: fingerprint("ceiling", work.id, nextRound) } };
                }
                round = nextRound;
                why = `review rejected round ${lastUsable.round}; rework`;
                break;
            }
            case "judgment":
                return { kind: "ask", judgment: { kind: r.judgment.kind ?? "product", ask: { ...r.judgment, priority: work.priority } } };
            case "blocked": {
                const fp = fingerprint("blocked", r.reason, r.clearsWhen ?? "");
                const attemptsSince = attempts.filter((a) => a.receipt?.outcome === "blocked" && fingerprint("blocked", a.receipt.reason, a.receipt.clearsWhen ?? "") === fp).length;
                if (hold?.reason === "blocked" && hold.fingerprint === fp) {
                    // Unchanged blocker. Retry only if something durable changed on the work since the hold; otherwise stay quiet.
                    if (work.updatedAt <= hold.since)
                        return { kind: "hold", reason: hold.reason, detail: hold.detail, clearsWhen: hold.clearsWhen, fingerprint: hold.fingerprint };
                    if (attemptsSince >= 2)
                        return { kind: "ask", judgment: { kind: "technical", ask: { question: `"${work.title}" is still blocked: ${r.reason}. ${r.clearsWhen ? `It clears when: ${r.clearsWhen}.` : ""} What now?`, options: ["retry", "cancel"], recommended: "retry", context: r.summary } } };
                    why = "the operator changed the work after it was blocked; one retry";
                    break;
                }
                return { kind: "hold", reason: "blocked", detail: `${r.reason}: ${r.summary}`, clearsWhen: r.clearsWhen ?? "the operator amends the work or decides", fingerprint: fp };
            }
            case "plan":
                return { kind: "commission", children: r.children, attemptId: lastUsable.id, by: `plan by ${lastUsable.seat}` };
        }
    }
    // A real person outside Conjure is owed first: their return is context the next attempt must not run without.
    // Review of a result already produced is not gated on them (the receipt logic above returned before reaching here).
    if (role !== "reviewer") {
        const ext = externalHold(db, work);
        if (ext)
            return ext;
    }
    // Allocation: capacity is the seat's lanes and the provider's slots; the lease is the only basis for occupancy.
    const held = db.prepare("SELECT COUNT(*) AS n FROM leases WHERE seat=?").get(allocSeat.id).n;
    if (held >= allocSeat.lanes)
        return { kind: "hold", reason: "capacity", detail: `${allocSeat.name} has ${allocSeat.lanes} lane(s), all occupied`, clearsWhen: "a lease on this seat releases" };
    if (!w.probed)
        return { kind: "hold", reason: "no-processor", detail: "providers not yet probed since boot", clearsWhen: "the first provider probe completes" };
    const candidates = allocSeat.processors.filter((p) => w.known(p.provider) && w.available(p.provider));
    if (!candidates.length) {
        const unpromoted = allocSeat.processors.filter((p) => w.unpromoted?.(p.provider)).map((p) => p.provider);
        return { kind: "hold", reason: "no-processor", detail: `none of [${allocSeat.processors.map((p) => p.provider).join(", ")}] is available${unpromoted.length ? ` (${unpromoted.join(", ")}: experimental, not promoted to organizational work)` : ""}`, clearsWhen: unpromoted.length ? "a provider becomes available, or the operator promotes the experimental one" : "a provider becomes available" };
    }
    const proc = candidates.find((p) => { const s = w.slots(p.provider); return s.attempts + s.turns < s.slots; });
    if (!proc)
        return { kind: "hold", reason: "capacity", detail: candidates.map((p) => { const s = w.slots(p.provider); return `provider ${p.provider}: ${s.attempts + s.turns}/${s.slots} slots in use${s.turns ? ` (${s.turns} by conversations)` : ""}`; }).join("; "), clearsWhen: "a cognition slot on an available provider frees" };
    if ((role === "worker" || role === "reviewer") && (!allocSeat.workspaceRoot || !w.workspaceOk(allocSeat.workspaceRoot)))
        return { kind: "hold", reason: "no-workspace", detail: `${allocSeat.name} has no usable workspace root`, clearsWhen: "the seat is configured with an existing workspaceRoot" };
    return { kind: "allocate", seat: allocSeat, role, round, processor: proc, why };
}
// --- the tick -------------------------------------------------------------------------------------
let scheduled = null;
let running = false;
let rerun = false;
export function requestReconcile(rt, delayMs = 25, cause = "request") {
    if (rt.stopped)
        return;
    rt.lastWake = cause;
    if (scheduled)
        return;
    scheduled = setTimeout(() => { scheduled = null; void runReconcile(rt); }, delayMs);
}
export async function runReconcile(rt) {
    if (running) {
        rerun = true;
        return;
    }
    running = true;
    try {
        do {
            rerun = false;
            await tick(rt);
        } while (rerun && !rt.stopped);
    }
    catch (e) {
        rt.log(`[reconcile] error: ${e.stack ?? e}`);
    }
    finally {
        running = false;
    }
}
async function tick(rt) {
    const { db } = rt;
    const rev = activeRevision(db);
    if (!rev)
        return;
    const t0 = Date.now();
    // 1. running attempts with a dead process and no in-memory handle: interrupted.
    for (const a of q.runningAttempts(db)) {
        if (!rt.handles.has(a.id))
            settleAttempt(rt, a.id, { status: "interrupted", text: "", providerSession: null, costUsd: null, error: "no owner for this attempt (process lost)" });
    }
    // 2. each open piece of work, in priority order: decide (pure), then act (the only writes).
    for (const candidate of q.openWork(db)) {
        // Preparing another worktree can yield to operator edits. The iteration order is a snapshot;
        // the authority to act on each obligation must come from its current durable record.
        if (rt.stopped)
            break;
        const work = q.work(db, candidate.id), currentRev = activeRevision(db);
        if (!work || work.status !== "open" || !currentRev)
            continue;
        try {
            await act(rt, currentRev, work, decide(worldOf(rt, currentRev), work));
        }
        catch (e) {
            rt.log(`[reconcile] ${work.id}: ${e.message}`);
        }
    }
    const dt = Date.now() - t0;
    rt.ticks++;
    rt.lastTickAt = now();
    rt.lastTickMs = dt;
    if (dt > 250)
        rt.log(`[reconcile] slow tick ${dt}ms`);
}
async function act(rt, rev, work, d) {
    const { db } = rt;
    switch (d.kind) {
        case "executing": return;
        case "hold":
            setHold(db, work.id, d.reason, d.detail, d.clearsWhen, d.fingerprint);
            if (d.wakeAt)
                setTimeout(() => requestReconcile(rt, 25, "backoff elapsed"), Math.max(0, d.wakeAt - Date.now()) + 50).unref();
            return;
        case "close":
            closeDone(db, work.id, d.attemptId, d.summary);
            return;
        case "ask":
            askJudgment(db, d.judgment.kind, "work", work.id, d.judgment.ask);
            if (d.hold)
                setHold(db, work.id, d.hold.reason, d.hold.detail, d.hold.clearsWhen, d.hold.fingerprint);
            return; // the next tick sees the open judgment and holds quietly
        case "commission":
            for (const c of d.children)
                commission(db, { title: c.title, brief: c.brief, acceptance: c.acceptance, seat: c.seat && rev.seats.some((s) => s.id === c.seat) ? c.seat : rev.routing.intake, parentId: work.id, priority: work.priority }, d.by);
            append(db, "work", work.id, "planned", { children: d.children.length, attemptId: d.attemptId });
            return; // next tick handles the dependency hold
        case "allocate":
            if (work.rounds < d.round) {
                db.prepare("UPDATE work SET rounds=?, updated_at=? WHERE id=?").run(d.round, now(), work.id);
                append(db, "work", work.id, "rework", { round: d.round });
            }
            await spawnAttempt(rt, rev, work, d.seat, d.role, d.round, d.processor);
            return;
    }
}
// --- allocation and spawn ------------------------------------------------------------------------
async function spawnAttempt(rt, rev, work, seat, role, round, proc) {
    const { db } = rt;
    let cwd;
    let allowWrites = false;
    if (role === "worker" || role === "reviewer") {
        cwd = await allocateWorkspace(rt, seat.workspaceRoot, work.id);
        allowWrites = role === "worker";
    }
    else {
        cwd = paths.workspaceDir(`plan-${work.id}`);
        fs.mkdirSync(cwd, { recursive: true });
    }
    // Workspace preparation yielded. Cancellation, judgment, waits, revision or capacity may have changed meanwhile.
    const current = q.work(db, work.id), currentRev = activeRevision(db);
    if (!current || current.status !== "open" || !currentRev || rt.stopped)
        return;
    const fresh = decide(worldOf(rt, currentRev), current);
    if (fresh.kind !== "allocate" || fresh.seat.id !== seat.id || fresh.role !== role || fresh.processor.provider !== proc.provider || fresh.processor.model !== proc.model || fresh.seat.workspaceRoot !== seat.workspaceRoot)
        return;
    work = current;
    rev = currentRev;
    seat = fresh.seat;
    round = fresh.round;
    clearHold(db, work.id, "allocating");
    const attemptId = id("a");
    const scope = `${work.id}`;
    const t = now();
    const attempts = q.attempts(db, work.id);
    const prompt = renderBrief({ db, rev, seat, work, role, attempts });
    const contract = captureContract({ db, rev, seat, work, role, attempts }, prompt);
    db.transaction(() => {
        db.prepare("INSERT INTO attempts(id,work_id,seat,role,provider,model,workspace,status,started_at,round) VALUES(?,?,?,?,?,?,?,'running',?,?)")
            .run(attemptId, work.id, seat.id, role, proc.provider, proc.model, cwd, t, round);
        db.prepare("INSERT INTO leases(seat,scope,attempt_id,acquired_at) VALUES(?,?,?,?)").run(seat.id, scope, attemptId, t);
        saveContract(db, attemptId, contract);
        append(db, "attempt", attemptId, "started", { workId: work.id, seat: seat.id, role, provider: proc.provider, model: proc.model, round, why: fresh.why, revisionId: rev.id, promptHash: contract.promptHash, decisionIds: contract.inputs.decisions.map((j) => j.id), returnIds: contract.inputs.returns.map((r) => r.id) });
    })();
    const provider = rt.providers.get(proc.provider);
    const toolGrants = role === "worker" ? grantsFor(db, seat.tools) : [];
    const handle = provider.run({ prompt, cwd, model: proc.model, effort: null, resume: null, allowWrites, exposeDirs: [], tools: toolGrants.map((g) => ({ exe: g.exe, dir: g.dir })), timeoutMs: rt.attemptTimeoutMs });
    rt.handles.set(attemptId, handle);
    if (handle.pid) {
        db.prepare("UPDATE attempts SET pid=? WHERE id=?").run(handle.pid, attemptId);
        db.prepare("INSERT OR REPLACE INTO processes(pid,kind,owner_id,started_at,last_seen,gateway_boot) VALUES(?,?,?,?,?,?)").run(handle.pid, "attempt", attemptId, t, t, rt.bootId);
    }
    rt.log(`[allocate] ${attemptId} ${role}@${seat.id} ${proc.provider}/${proc.model} for ${work.id} "${work.title}" round ${round}`);
    void handle.done.then((res) => { rt.handles.delete(attemptId); settleAttempt(rt, attemptId, res); });
}
export function settleAttempt(rt, attemptId, res) {
    const { db } = rt;
    const a = q.attempt(db, attemptId);
    if (!a || a.status !== "running")
        return;
    let status = res.status;
    let error = res.error;
    let receiptJson = null;
    if (res.status === "succeeded") {
        const parsed = parseReceipt(res.text);
        if (parsed.receipt)
            receiptJson = JSON.stringify(parsed.receipt);
        else {
            status = "failed";
            error = `turn ended without a usable receipt: ${parsed.error}`;
        }
    }
    db.transaction(() => {
        db.prepare("UPDATE attempts SET status=?, ended_at=?, provider_session=?, cost_usd=?, receipt=?, error=? WHERE id=?")
            .run(status, now(), res.providerSession, res.costUsd, receiptJson, error, attemptId);
        db.prepare("DELETE FROM leases WHERE attempt_id=?").run(attemptId);
        if (a.pid)
            db.prepare("DELETE FROM processes WHERE pid=?").run(a.pid);
        if (receiptJson) {
            const r = JSON.parse(receiptJson);
            if (r.outcome === "done" && r.evidence?.length)
                addEvidence(db, a.workId, attemptId, r.evidence);
        }
        fs.appendFileSync(paths.log(`attempt-${attemptId}.txt`), res.text || (error ?? ""));
        append(db, "attempt", attemptId, status, { workId: a.workId, seat: a.seat, role: a.role, outcome: receiptJson ? JSON.parse(receiptJson).outcome : null, error, costUsd: res.costUsd });
    })();
    rt.log(`[settle] ${attemptId} ${status}${error ? ` (${error.slice(0, 120)})` : ""}`);
}
export function stopAttempt(rt, attemptId) {
    const h = rt.handles.get(attemptId);
    if (!h)
        return false;
    h.kill();
    return true;
}
/** Per-work git worktree when the root is a repository; otherwise the root itself. Async: never blocks the loop. */
async function allocateWorkspace(rt, root, workId) {
    if (!fs.existsSync(path.join(root, ".git")))
        return root;
    const dir = path.join(root, ".conjure", "work", workId);
    if (fs.existsSync(dir))
        return dir;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // Same hazard as a provider CLI: on Windows `git` may be a shim, and "on PATH" is not "runnable".
    // Routed through the one helper so it fails with a reason instead of a bare ENOENT.
    const git = resolveExecutable("git");
    if (!git.found) {
        rt.log(`[workspace] no usable git (${classifyProbe(git, null).detail}); using root for ${workId}`);
        return root;
    }
    const out = await execProvider(git, ["worktree", "add", "-B", `conjure/${workId}`, dir], { cwd: root, timeoutMs: 60_000 });
    if (out.code !== 0 || out.error)
        rt.log(`[workspace] worktree for ${workId} failed: ${redact((out.error ?? out.stderr).slice(0, 200))}; using root`);
    return fs.existsSync(dir) ? dir : root;
}
// --- wiring ---------------------------------------------------------------------------------------
export function startReconciler(rt) {
    const onEvent = (ev) => {
        // Every durable transition that can change what is owed wakes the reconciler. Turn text and telemetry do not.
        if (["work", "attempt", "judgment", "revision", "provider", "wait"].includes(ev.entityType))
            requestReconcile(rt, 25, `${ev.entityType}.${ev.kind}`);
        // A finished conversation turn frees a provider slot the organization may be waiting for.
        else if (ev.entityType === "conversation" && (ev.kind === "turn-done" || ev.kind === "turn-failed"))
            requestReconcile(rt, 25, "conversation slot freed");
    };
    bus.on("event", onEvent);
    const fallback = setInterval(() => requestReconcile(rt, 25, "fallback timer"), rt.fallbackMs);
    const probe = setInterval(() => { void probeProviders(rt).then(() => requestReconcile(rt, 25, "provider probe")); }, rt.probeMs);
    return () => { rt.stopped = true; bus.off("event", onEvent); clearInterval(fallback); clearInterval(probe); for (const h of rt.handles.values())
        h.kill(); };
}
//# sourceMappingURL=reconcile.js.map