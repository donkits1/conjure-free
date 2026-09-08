import { getSetting } from "./db.js";
import { eventsSince, rowToEvent } from "./events.js";
import { activeRevision, CAPABILITIES, listRevisions, workflowOf, compileWorkflow } from "./org.js";
import { runningLabel, selfBriefing, selfView, skewNow } from "./self.js";
import { readRegistry, runningEditionId } from "./editions.js";
import { q } from "./work.js";
import { pidAlive, decide, modeOf, worldOf, providerSlots } from "./reconcile.js";
import { ideas, contextOf } from "./ideas.js";
import { collab } from "./collab.js";
import { tools as toolTable } from "./tools.js";
import { readContract } from "./contracts.js";
export function phaseOf(w, attempts, hold, judgment) {
    if (w.status === "done")
        return "delivered";
    if (w.status === "cancelled")
        return "stopped";
    const running = attempts.find((a) => a.status === "running");
    if (running)
        return running.role === "reviewer" ? "in-review" : "executing";
    if (judgment)
        return "awaiting-judgment";
    if (hold && (hold.reason === "blocked" || hold.reason === "recovery-exhausted" || hold.reason === "review-ceiling" || hold.reason === "no-workspace"))
        return "blocked";
    return "waiting";
}
export function workView(db, w) {
    const attempts = q.attempts(db, w.id);
    const hold = q.hold(db, w.id);
    const j = q.openJudgmentFor(db, "work", w.id);
    const running = attempts.find((a) => a.status === "running");
    const last = [...attempts].reverse().find((a) => a.status !== "running");
    return {
        id: w.id, title: w.title, seat: w.seat, status: w.status, phase: phaseOf(w, attempts, hold, j), priority: w.priority, rounds: w.rounds,
        parentId: w.parentId, createdAt: w.createdAt, updatedAt: w.updatedAt, closedAt: w.closedAt, hold,
        running: running ? { attemptId: running.id, seat: running.seat, role: running.role, provider: running.provider, model: running.model, since: running.startedAt } : null,
        attempts: attempts.length, lastOutcome: last ? (last.receipt?.outcome ?? last.status) : null, judgmentId: j?.id ?? null,
    };
}
export function workDetail(db, workId) {
    const w = q.work(db, workId);
    if (!w)
        return null;
    return {
        ...workView(db, w), brief: w.brief, acceptance: w.acceptance, sourceKind: w.sourceKind, sourceRef: w.sourceRef, revisionId: w.revisionId,
        waits: collab.waitsFor(db, "work", w.id).map((x) => ({ ...x, person: collab.person(db, x.personId)?.name ?? "?" })),
        meetings: collab.meetings(db).filter((m) => m.subjectType === "work" && m.subjectId === w.id && m.status !== "cancelled").map((m) => ({ id: m.id, title: m.title, startsAt: m.startsAt, status: m.status })),
        attemptList: q.attempts(db, w.id).map((a) => ({ ...a, alive: a.status === "running" && a.pid ? pidAlive(a.pid) : null })),
        evidence: q.evidence(db, w.id), children: q.children(db, w.id).map((c) => workView(db, c)),
        judgments: db.prepare("SELECT id FROM judgments WHERE subject_type='work' AND subject_id=? ORDER BY created_at").all(w.id).map((r) => q.judgment(db, r.id)),
        returns: db.prepare("SELECT * FROM returns WHERE work_id=? ORDER BY created_at").all(w.id).map(r => ({ id: r.id, workId: r.work_id, attemptId: r.attempt_id, outcome: r.outcome, summary: r.summary, createdAt: r.created_at, seenAt: r.seen_at })),
        events: db.prepare("SELECT * FROM events WHERE (entity_type='work' AND entity_id=?) OR (entity_type='attempt' AND entity_id IN (SELECT id FROM attempts WHERE work_id=?)) ORDER BY seq").all(w.id, w.id).map((r) => ({ seq: r.seq, at: r.at, kind: r.kind, entityType: r.entity_type, entityId: r.entity_id, detail: JSON.parse(r.detail) })),
    };
}
export function controlBriefing(db, boot = { bootId: "", startedAt: "" }) {
    const sv = selfView(db, boot.bootId, boot.startedAt, boot.container ?? null);
    const self = {
        running: sv.running.label, accepted: sv.running.accepted, editionId: sv.running.editionId, capabilities: sv.running.capabilities.map((c) => c.name),
        ready: sv.ready.map((e) => ({ id: e.id, subject: e.subject, adds: e.adds, removes: e.removes, checks: e.checks ? { passed: e.checks.passed, total: e.checks.total } : null, note: e.note, builtAt: e.builtAt })),
        previous: sv.previous ? { id: sv.previous.id, subject: sv.previous.subject } : null, skew: sv.skew, pending: sv.pending, lines: selfBriefing(sv),
    };
    const since = getSetting(db, "last_rendezvous_at");
    const evs = eventsSince(db, since, 1000).filter((e) => !["conversation", "note", "folder", "directive"].includes(e.entityType) || ["handed-to-conjure", "accepted"].includes(e.kind));
    const counts = new Map();
    for (const e of evs)
        counts.set(`${e.entityType}.${e.kind}`, (counts.get(`${e.entityType}.${e.kind}`) ?? 0) + 1);
    const open = q.openWork(db).map((w) => workView(db, w));
    const judgments = q.openJudgments(db);
    const providers = db.prepare("SELECT * FROM providers ORDER BY name").all()
        .map((p) => ({ name: p.name, available: p.available === 1, detail: p.detail, observedAt: p.observed_at }));
    const degraded = [];
    for (const p of providers)
        if (!p.available && !providers.some(candidate => candidate.available))
            degraded.push(`provider ${p.name} unavailable: ${p.detail}`);
    for (const w of open)
        if (w.hold?.reason === "no-processor")
            degraded.push(`"${w.title}" cannot be staffed: ${w.hold.detail}`);
    for (const w of open)
        if (w.running && !db.prepare("SELECT pid FROM attempts WHERE id=?").get(w.running.attemptId)?.pid)
            degraded.push(`attempt ${w.running.attemptId} has no process yet`);
    const cameBack = q.unseenReturns(db).map((r) => ({ ...r, title: q.work(db, r.workId)?.title ?? r.workId }));
    const product = judgments.filter((j) => j.kind === "product");
    const technical = judgments.filter((j) => j.kind === "technical");
    const handled = open.filter((w) => w.phase === "executing" || w.phase === "in-review" || (w.phase === "waiting" && w.hold?.reason === "dependency"));
    const blocked = open.filter((w) => w.phase === "blocked");
    const waiting = open.filter((w) => w.phase === "waiting" && w.hold?.reason !== "dependency");
    const highlights = highlightEvents(db, evs);
    const waitingOnPeople = collab.waits(db, "waiting").map((w) => waitRow(db, w));
    const upcomingMeetings = collab.meetings(db).filter((m) => m.status === "scheduled" && m.startsAt && Date.parse(m.startsAt) > Date.now() - 60 * 60_000).slice(0, 5)
        .map((m) => ({ id: m.id, title: m.title, startsAt: m.startsAt, with: collab.meetingPeople(db, m.id).map((p) => p.name) }));
    let recommendation;
    if (judgments.length >= 2)
        recommendation = `${judgments.length} questions wait for you. Answer them as one sheet in Homework, then watch the machine take them.`;
    else if (judgments.length) {
        const top = judgments[0];
        recommendation = `Decide "${top.question}"${top.recommended ? ` (recommended: ${top.recommended})` : ""}.`;
    }
    else if (degraded.length)
        recommendation = `Nothing needs your judgment. Restore: ${degraded[0]}.`;
    else if (self.skew.length)
        recommendation = `Nothing needs your judgment, but Conjure's own truth is skewed: ${self.skew[0]}`;
    else if (self.editionId && !self.accepted)
        recommendation = `Nothing needs your judgment. You are trying the edition "${self.running}"; keep it or go back from the "Conjure itself" panel.`;
    else if (self.ready.length)
        recommendation = `Nothing needs your judgment. A new edition of Conjure is ready to try: "${self.ready[0].subject}" ${self.ready[0].adds.length ? `adds ${self.ready[0].adds.join(", ")}` : "(no new capability)"}. Switch to it from the "Conjure itself" panel; your data stays and you can go back.`;
    else if (cameBack.length)
        recommendation = `Nothing needs your judgment. ${cameBack.length} result(s) came back; review them when convenient.`;
    else if (waitingOnPeople.length && !handled.length)
        recommendation = `Nothing needs you. ${waitingOnPeople.length} thing(s) wait on other people (${[...new Set(waitingOnPeople.map((w) => w.person))].join(", ")}); nothing here can hurry them.`;
    else if (handled.length)
        recommendation = `Nothing needs you. ${handled.length} piece(s) of work are being handled.`;
    else if (open.length)
        recommendation = `Nothing needs you right now; ${open.length} open item(s) are waiting on capacity or providers.`;
    else
        recommendation = "Nothing is open. Give a Directive, or hand a note to Conjure from the Idea Room.";
    return {
        now: new Date().toISOString(), lastRendezvousAt: since, activeRevision: getSetting(db, "active_revision"), providers, degraded,
        changed: { since, events: evs.length, summary: [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count), highlights },
        cameBack, handled, blocked, waiting, judgments: { product, technical }, waitingOnPeople, upcomingMeetings, recommendation,
        counts: { open: open.length, executing: open.filter((w) => w.phase === "executing" || w.phase === "in-review").length, blocked: blocked.length, judgmentsOwed: judgments.length, unseenReturns: cameBack.length, editionsReady: self.ready.length, waitingOnPeople: waitingOnPeople.length },
        self,
    };
}
function waitRow(db, w) {
    const person = collab.person(db, w.personId);
    const subjectTitle = w.subjectType === "work" && w.subjectId ? q.work(db, w.subjectId)?.title ?? null : w.subjectType === "meeting" && w.subjectId ? collab.meeting(db, w.subjectId)?.title ?? null : null;
    return { waitId: w.id, personId: w.personId, person: person?.name ?? "?", kind: w.kind, description: w.description, subjectType: w.subjectType, subjectId: w.subjectId, subjectTitle, since: w.since, dueAt: w.dueAt, status: w.status, returnedAt: w.returnedAt, returnedSummary: w.returnedSummary, sourceKind: w.sourceKind, sourceRef: w.sourceRef };
}
export function homeworkView(rt) {
    const db = rt.db;
    const rev = activeRevision(db);
    const world = rev ? worldOf(rt, rev) : null;
    const nowMs = Date.now();
    const descendants = (wid, acc = [], d = 0) => { if (d > 20)
        return acc; for (const k of q.children(db, wid)) {
        if (k.status === "open") {
            acc.push(k);
            descendants(k.id, acc, d + 1);
        }
    } return acc; };
    const ancestors = (w, acc = [], d = 0) => { if (!w.parentId || d > 20)
        return acc; const p = q.work(db, w.parentId); if (p && p.status === "open") {
        acc.push(p);
        ancestors(p, acc, d + 1);
    } return acc; };
    const items = q.openJudgments(db).map((j) => {
        const w = j.subjectType === "work" ? q.work(db, j.subjectId) : null;
        const unblocks = w ? [w, ...ancestors(w)].map((x) => ({ id: x.id, title: x.title })) : [];
        const ageMin = Math.max(0, Math.round((nowMs - Date.parse(j.createdAt)) / 60_000));
        const score = unblocks.length * 10 + Math.min(ageMin / 60, 48) + (j.kind === "product" ? 2 : 0) + (j.priority <= 1 ? 5 : 0);
        const why = [unblocks.length ? `${unblocks.length} obligation(s) affected` : "no work linked", ageMin >= 60 ? `waiting ${Math.round(ageMin / 60)}h` : `waiting ${ageMin}m`, j.recommended ? `Recommended: "${j.recommended}"` : ""].filter(Boolean).join(" · ");
        return { ...j, subjectTitle: w?.title ?? (j.subjectType === "meeting" ? collab.meeting(db, j.subjectId)?.title ?? j.subjectId : j.subjectId), seat: w?.seat ?? null, ageMin, unblocks, score, why, openQuestion: j.options.length === 0 };
    }).sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt));
    const lastSubmittedAt = getSetting(db, "last_homework_at");
    let ignition = null;
    if (lastSubmittedAt) {
        const ids = JSON.parse(getSetting(db, "last_homework_ids") ?? "[]");
        const answered = ids.map((jid) => q.judgment(db, jid)).filter((j) => !!j).map((j) => {
            const w = j.subjectType === "work" ? q.work(db, j.subjectId) : null;
            const d = w && w.status === "open" && world ? decide(world, w) : null;
            const view = w ? workView(db, w) : null;
            const received = w ? [...q.attempts(db, w.id)].reverse().find((a) => {
                const snap = readContract(db, a.id);
                return snap?.inputs.decisions?.some((q) => q.id === j.id);
            }) : null;
            const stage = w?.status === "done" ? "Return recorded" : w?.status === "cancelled" ? "Work stopped" : received?.status === "failed" ? "Attempt failed · answer retained" : received?.status === "succeeded" ? "Attempt returned with this context" : received?.pid ? "Attempt started with answer" : received ? "Context prepared for attempt" : d?.kind === "allocate" ? "Ready for allocation" : d?.kind === "hold" ? `Answer recorded · waiting: ${d.reason}` : "Answer recorded";
            return { judgmentId: j.id, question: j.question, decision: j.decision ?? "", workId: w?.id ?? null, title: w?.title ?? j.subjectId, phase: view?.phase ?? null, status: w?.status ?? null, next: d ? { mode: modeOf(d), text: describe(d) } : null, stage, attemptId: received?.id ?? null };
        });
        const related = new Set(answered.flatMap((a) => a.workId ? [a.workId, ...descendants(a.workId).map((w) => w.id)] : []));
        const followUps = q.openJudgments(db).filter((j) => j.createdAt > lastSubmittedAt && j.subjectType === "work" && related.has(j.subjectId));
        // Settled: nothing the batch touched is waiting on the operator any more (it may be executing, waiting cold, or delivered).
        const settled = answered.every((a) => !a.next || a.next.mode !== "human") && followUps.length === 0;
        ignition = { submittedAt: lastSubmittedAt, answered, followUps, settled };
    }
    return {
        now: new Date().toISOString(), items,
        counts: { total: items.length, product: items.filter((i) => i.kind === "product").length, technical: items.filter((i) => i.kind === "technical").length, openQuestions: items.filter((i) => i.openQuestion).length, unblocks: new Set(items.flatMap((i) => i.unblocks.map((u) => u.id))).size },
        waitingOnPeople: collab.waits(db, "waiting").map((w) => waitRow(db, w)), lastSubmittedAt, ignition,
    };
}
function highlightEvents(db, evs) {
    const out = [];
    const titleOf = (id) => q.work(db, id)?.title ?? id;
    for (const e of evs) {
        if (e.entityType === "work" && e.kind === "done")
            out.push(`Delivered: ${titleOf(e.entityId)}`);
        else if (e.entityType === "work" && e.kind === "commissioned")
            out.push(`Commissioned: ${String(e.detail.title)}`);
        else if (e.entityType === "work" && e.kind === "cancelled")
            out.push(`Cancelled: ${titleOf(e.entityId)}`);
        else if (e.entityType === "judgment" && e.kind === "asked")
            out.push(`Judgment asked: ${String(e.detail.question)}`);
        else if (e.entityType === "judgment" && e.kind === "decided")
            out.push(`Judgment decided: ${String(e.detail.decision)}`);
        else if (e.entityType === "provider")
            out.push(`Provider ${e.entityId} ${e.kind}`);
        else if (e.entityType === "attempt" && (e.kind === "failed" || e.kind === "interrupted"))
            out.push(`Attempt ${e.kind} on ${titleOf(String(e.detail.workId))}${e.detail.error ? `: ${String(e.detail.error).slice(0, 80)}` : ""}`);
        else if (e.entityType === "revision")
            out.push(`Organization revision ${e.entityId} activated: ${String(e.detail.note)}`);
        else if (e.entityType === "edition")
            out.push(`Conjure edition ${e.entityId} ${e.kind.replace("-", " ")}${e.detail.subject ? `: ${String(e.detail.subject)}` : ""}`);
        else if ((e.entityType === "note" && e.kind === "handed-to-conjure") || (e.entityType === "directive" && e.kind === "accepted"))
            out.push(`Conjure accepted responsibility: work ${String(e.detail.workId)}`);
        else if (e.entityType === "wait" && e.kind === "returned")
            out.push(`${String(e.detail.person)} returned (${String(e.detail.kind)})${e.detail.subjectId ? ` on ${titleOf(String(e.detail.subjectId))}` : ""}`);
        else if (e.entityType === "wait" && e.kind === "created")
            out.push(`Now waiting on ${String(e.detail.person)} for ${String(e.detail.kind)}`);
        else if (e.entityType === "homework" && e.kind === "submitted")
            out.push(`Homework submitted: ${String(e.detail.decided)} answer(s)`);
        else if (e.entityType === "meeting" && (e.kind === "scheduled" || e.kind === "held"))
            out.push(`Meeting ${e.kind}: ${e.entityId}`);
        if (out.length >= 30)
            break;
    }
    return out;
}
function describe(d) {
    switch (d.kind) {
        case "executing": return `${d.role} cognition on ${d.provider}/${d.model} is occupying this obligation`;
        case "hold": return `waits: ${d.reason}. ${d.detail}. Clears when ${d.clearsWhen}.`;
        case "close": return "cold software closes it as delivered on the next tick";
        case "ask": return `a ${d.judgment.kind} judgment is owed to the operator: ${d.judgment.ask.question}`;
        case "commission": return `cold software commissions ${d.children.length} child obligation(s) from the plan`;
        case "allocate": return `summon ${d.role} cognition at ${d.seat.name} on ${d.processor.provider}/${d.processor.model} (${d.why})`;
    }
}
export function networkView(rt) {
    const db = rt.db;
    const rev = activeRevision(db);
    const asOf = new Date().toISOString();
    const providers = [...rt.providers.values()].map((p) => {
        const row = db.prepare("SELECT available, detail, observed_at FROM providers WHERE name=?").get(p.name);
        const s = providerSlots(rt, p.name);
        return { name: p.name, label: p.capabilities.label, available: !!row && row.available === 1, detail: row?.detail ?? "not probed yet", observedAt: row?.observed_at ?? null, slots: s.slots, attempts: s.attempts, turns: s.turns, experimental: p.capabilities.experimental === true, promoted: p.capabilities.promoted === true, boundary: p.capabilities.boundary ?? null };
    });
    const revForTools = activeRevision(db);
    const toolRows = toolTable.all(db).map((t) => ({ id: t.id, name: t.name, kind: t.kind, command: t.command, status: t.status, available: t.available, state: t.state, detail: t.detail, version: t.version, observedAt: t.observedAt, grantedTo: (revForTools?.seats ?? []).filter((s) => (s.tools ?? []).includes(t.id)).map((s) => s.id) }));
    const machine = { reconciler: { ticks: rt.ticks, lastTickAt: rt.lastTickAt, lastTickMs: rt.lastTickMs, lastWake: rt.lastWake, fallbackMs: rt.fallbackMs, probeMs: rt.probeMs, wakesOn: ["work.*", "attempt.*", "judgment.*", "revision.*", "provider.*", "wait.*", "conversation turn settles", "backoff elapsed", "fallback timer", "provider probe"] }, providers, tools: toolRows, gateway: (() => { const reg = readRegistry(); const id = runningEditionId(reg); return { bootId: rt.bootId, probed: rt.probed, edition: runningLabel(reg), editionId: id, accepted: !!reg.editions.find((e) => e.id === id)?.acceptedAt, skew: skewNow(reg).length, ready: reg.editions.filter((e) => e.status === "proposed").length, container: rt.container ? `${rt.container.kind} ${rt.container.version}` : null }; })() };
    const edges = [];
    // --- private plane ---
    const convs = ideas.list(db);
    const runningTurn = new Map();
    for (const t of db.prepare("SELECT id, conversation_id, at FROM turns WHERE status='running'").all())
        runningTurn.set(t.conversation_id, { id: t.id, at: t.at });
    const turnCounts = new Map();
    for (const r of db.prepare("SELECT conversation_id AS c, COUNT(*) AS n FROM turns GROUP BY conversation_id").all())
        turnCounts.set(r.c, r.n);
    const windows = convs.map((c) => {
        const ctx = c.role === "control" ? [] : contextOf(db, c.id);
        const live = runningTurn.get(c.id);
        const roleContext = c.role === "control" ? "; current organizational briefing (no connected notes)"
            : c.role === "directive" ? "; order text and seat list"
                : c.role === "workflow" ? "; seat list and current workflow graph" : "";
        const sees = `current message; conversation history or provider session${roleContext}${ctx.length ? `; ${ctx.length} connected note(s)` : ""}. Prompt inputs may be truncated; this is not a filesystem access boundary.`;
        const authority = "does not commission work through a conversation reply; CLI permissions and integrations determine additional tool access";
        for (const r of ctx)
            edges.push({ id: `ctx:${c.id}:${r.noteId}`, from: `note:${r.noteId}`, to: `window:${c.id}`, kind: "private-context", basis: "relation" });
        if (c.role === "control")
            edges.push({ id: `brief:${c.id}`, from: "machine:reconciler", to: `window:${c.id}`, kind: "briefing", basis: "derived" });
        return { id: c.id, title: c.title || "blank window", role: c.role, provider: c.provider, model: c.model, effort: c.effort, createdAt: c.createdAt, updatedAt: c.updatedAt, turns: turnCounts.get(c.id) ?? 0, directiveId: c.directiveId,
            live: live ? { turnId: live.id, since: live.at } : null, context: ctx.map((r) => ({ noteId: r.noteId, title: r.title, connectedAt: r.connectedAt })), exposureDirs: c.exposure, sees, authority, responsibility: "none" };
    });
    const ctxRows = db.prepare("SELECT conversation_id, note_id FROM conversation_context").all();
    const notes = ideas.notes(db).map((n) => ({ id: n.id, title: n.title, folderId: n.folderId, connectedTo: ctxRows.filter((r) => r.note_id === n.id).map((r) => r.conversation_id), servedWorkId: n.servedWorkId, sharedAt: n.sharedAt, updatedAt: n.updatedAt }));
    for (const n of notes)
        if (n.servedWorkId)
            edges.push({ id: `hand:${n.id}`, from: `note:${n.id}`, to: `work:${n.servedWorkId}`, kind: "handed-to-conjure", basis: "work" });
    const directives = ideas.directives(db).map((d) => ({ id: d.id, text: d.text, status: d.status, workId: d.workId, conversationId: d.conversationId, createdAt: d.createdAt }));
    for (const d of directives)
        if (d.workId)
            edges.push({ id: `acc:${d.id}`, from: `directive:${d.id}`, to: `work:${d.workId}`, kind: "accepted", basis: "work" });
    // --- the outside: people and meetings Conjure does not run ---
    const outside = outsidePlane(db, edges);
    if (!rev)
        return { asOf, revision: null, revisions: [], routing: null, machine, circuit: null, organization: { seats: [], work: [], judgments: [] }, private: { windows, notes, directives }, outside, edges, orphans: [] };
    // --- organization plane ---
    const world = worldOf(rt, rev);
    const openWork = q.openWork(db);
    const recent = db.prepare("SELECT id FROM work WHERE status<>'open' ORDER BY closed_at DESC LIMIT 200").all().map((r) => q.work(db, r.id));
    const all = [...openWork, ...recent];
    const depthOf = (w, d = 0) => (w.parentId && d < 20 ? depthOf(q.work(db, w.parentId) ?? { ...w, parentId: null }, d + 1) : d);
    const orphans = [];
    const work = all.map((w) => {
        const view = workView(db, w);
        const attempts = q.attempts(db, w.id);
        const d = w.status === "open" ? decide(world, w) : null;
        if (w.status === "open" && !d)
            orphans.push(w.id);
        if (w.parentId)
            edges.push({ id: `child:${w.id}`, from: `work:${w.id}`, to: `work:${w.parentId}`, kind: "child-of", basis: "work" });
        edges.push({ id: `assign:${w.id}`, from: `work:${w.id}`, to: `seat:${w.seat}`, kind: "assigned", basis: "work" });
        const waitingOn = collab.waitsFor(db, "work", w.id).filter((x) => x.status === "waiting").map((x) => ({ waitId: x.id, personId: x.personId, person: collab.person(db, x.personId)?.name ?? "?", kind: x.kind, description: x.description, since: x.since, dueAt: x.dueAt }));
        return { ...view, brief: w.brief, acceptance: w.acceptance, sourceKind: w.sourceKind, sourceRef: w.sourceRef, revisionId: w.revisionId, depth: depthOf(w),
            children: q.children(db, w.id).map((c) => c.id), evidence: q.evidence(db, w.id).length, returns: db.prepare("SELECT COUNT(*) AS n FROM returns WHERE work_id=?").get(w.id).n,
            next: d ? { kind: d.kind, mode: modeOf(d), text: describe(d), ...(d.kind === "hold" ? { reason: d.reason, clearsWhen: d.clearsWhen } : {}) } : null, waitingOn,
            attemptList: attempts.map((a) => ({ id: a.id, role: a.role, seat: a.seat, provider: a.provider, model: a.model, status: a.status, round: a.round, startedAt: a.startedAt, endedAt: a.endedAt, outcome: a.receipt?.outcome ?? null, error: a.error, alive: a.status === "running" && a.pid ? pidAlive(a.pid) : null, costUsd: a.costUsd, pid: a.pid })),
            evidenceList: q.evidence(db, w.id).map((e) => ({ id: e.id, attemptId: e.attemptId, kind: e.kind, locator: e.locator, summary: e.summary, createdAt: e.createdAt })),
            returnList: db.prepare("SELECT id, attempt_id, outcome, summary, created_at FROM returns WHERE work_id=? ORDER BY created_at").all(w.id).map((r) => ({ id: r.id, attemptId: r.attempt_id, outcome: r.outcome, summary: r.summary, createdAt: r.created_at })) };
    });
    const leases = q.leases(db);
    const seats = rev.seats.map((s) => {
        const mine = work.filter((w) => w.status === "open" && w.seat === s.id);
        const held = leases.filter((l) => l.seat === s.id);
        const slots = Array.from({ length: s.lanes }, (_, i) => {
            const l = held[i];
            const a = l ? q.attempt(db, l.attemptId) : null;
            if (a)
                edges.push({ id: `occ:${a.id}`, from: `attempt:${a.id}`, to: `seat:${s.id}`, kind: "occupies", basis: "lease" });
            return { lane: i, attemptId: a?.id ?? null, workId: a?.workId ?? null, workTitle: a ? (q.work(db, a.workId)?.title ?? a.workId) : null, role: a?.role ?? null, provider: a?.provider ?? null, model: a?.model ?? null, since: a?.startedAt ?? null, alive: a?.pid ? pidAlive(a.pid) : null };
        });
        if (s.reportsTo)
            edges.push({ id: `rep:${s.id}`, from: `seat:${s.id}`, to: `seat:${s.reportsTo}`, kind: "reports-to", basis: "config" });
        return { id: s.id, name: s.name, department: s.department, role: s.role, reportsTo: s.reportsTo, charter: s.charter, capabilities: CAPABILITIES[s.role], processors: s.processors, workspaceRoot: s.workspaceRoot, lanes: s.lanes,
            intake: rev.routing.intake === s.id, reviewer: rev.routing.reviewer === s.id, slots, tools: s.tools ?? [], toolsUsable: toolTable.grantedTo(db, s.tools).map((t) => t.id),
            responsibility: { open: mine.length, executing: mine.filter((w) => w.phase === "executing").length, inReview: mine.filter((w) => w.phase === "in-review").length, waiting: mine.filter((w) => w.phase === "waiting").length, blocked: mine.filter((w) => w.phase === "blocked").length, awaitingJudgment: mine.filter((w) => w.phase === "awaiting-judgment").length },
            workIds: mine.map((w) => w.id) };
    });
    if (rev.routing.reviewer)
        edges.push({ id: "reviews", from: `seat:${rev.routing.reviewer}`, to: `seat:${rev.routing.intake}`, kind: "reviews-for", basis: "config" });
    edges.push({ id: "intake", from: "machine:reconciler", to: `seat:${rev.routing.intake}`, kind: "intake", basis: "config" });
    // --- the circuit: designed (drawn) / compiled (what the reconciler executes) / live (which obligations sit at which step now) ---
    const designed = workflowOf(rev);
    const compiled = compileWorkflow(designed, rev.seats, rev.routing);
    const executes = [];
    const recorded = [];
    const startNode = designed.nodes.find((n) => n.kind === "start");
    const intakeNode = designed.nodes.find((n) => n.kind === "seat" && n.seat === compiled.routing.intake && designed.edges.some((e) => e.from === startNode?.id && e.to === n.id));
    const reviewNode = intakeNode ? designed.nodes.find((n) => n.kind === "review" && n.seat === compiled.routing.reviewer && designed.edges.some((e) => e.from === intakeNode.id && e.to === n.id)) : undefined;
    const returnNode = designed.nodes.find((n) => n.kind === "return" && designed.edges.some((e) => e.to === n.id && (e.from === reviewNode?.id || e.from === intakeNode?.id)));
    for (const n of designed.nodes)
        ((n === startNode || n === intakeNode || n === reviewNode || n === returnNode) ? executes : recorded).push(n.id);
    const live = {};
    const at = (nid, wid) => { if (!nid)
        return; (live[nid] ??= []).push(wid); };
    for (const w of work) {
        if (w.status !== "open")
            continue;
        if (w.phase === "in-review")
            at(reviewNode?.id, w.id);
        else if (w.phase === "awaiting-judgment")
            at(reviewNode?.id ?? intakeNode?.id, w.id);
        else if (w.seat === compiled.routing.intake)
            at(intakeNode?.id, w.id);
    }
    const judgments = q.openJudgments(db).map((j) => ({ id: j.id, kind: j.kind, question: j.question, subjectType: j.subjectType, subjectId: j.subjectId, options: j.options, recommended: j.recommended, createdAt: j.createdAt }));
    return { asOf, revision: rev.id, revisions: listRevisions(db), routing: rev.routing, machine,
        circuit: { designed, compiled: { routing: compiled.routing, warnings: compiled.warnings, errors: compiled.errors, executes, recorded }, live },
        organization: { seats, work, judgments }, private: { windows, notes, directives }, outside, edges, orphans };
}
/** People and meetings as Network shows them. Every edge has a relation row behind it (`waits`, `meeting_people`, `meetings.subject_*`). */
function outsidePlane(db, edges) {
    const titleOf = (t, i) => (t === "work" && i ? q.work(db, i)?.title ?? null : t === "meeting" && i ? collab.meeting(db, i)?.title ?? null : t === "note" && i ? ideas.note(db, i)?.title ?? null : null);
    const meetings = collab.meetings(db).filter((m) => m.status !== "cancelled").map((m) => {
        const people = collab.meetingPeople(db, m.id);
        for (const p of people)
            edges.push({ id: `mw:${m.id}:${p.id}`, from: `meeting:${m.id}`, to: `person:${p.id}`, kind: "meeting-with", basis: "relation" });
        if (m.subjectType && m.subjectId)
            edges.push({ id: `ma:${m.id}`, from: `meeting:${m.id}`, to: `${m.subjectType}:${m.subjectId}`, kind: "meeting-about", basis: "relation" });
        return { id: m.id, title: m.title, status: m.status, startsAt: m.startsAt, durationMin: m.durationMin, location: m.location, people: people.map((p) => p.name), subjectType: m.subjectType, subjectId: m.subjectId, subjectTitle: titleOf(m.subjectType, m.subjectId), hasAgenda: !!m.agenda, hasOutcome: !!m.outcome };
    });
    const people = collab.people(db).map((p) => {
        const ws = collab.waitsOn(db, p.id);
        const waiting = ws.filter((w) => w.status === "waiting").map((w) => {
            if (w.subjectType && w.subjectId)
                edges.push({ id: `wo:${w.id}`, from: `${w.subjectType}:${w.subjectId}`, to: `person:${p.id}`, kind: "waiting-on", basis: "relation" });
            const seat = w.subjectType === "work" && w.subjectId ? q.work(db, w.subjectId)?.seat ?? null : null;
            return { waitId: w.id, kind: w.kind, description: w.description, subjectType: w.subjectType, subjectId: w.subjectId, subjectTitle: titleOf(w.subjectType, w.subjectId), seat, since: w.since, dueAt: w.dueAt, sourceKind: w.sourceKind, sourceRef: w.sourceRef };
        });
        const returned = ws.filter((w) => w.status === "returned").slice(0, 12).map((w) => {
            if (w.subjectType && w.subjectId)
                edges.push({ id: `rb:${w.id}`, from: `person:${p.id}`, to: `${w.subjectType}:${w.subjectId}`, kind: "returned-by", basis: "relation" });
            return { waitId: w.id, kind: w.kind, description: w.description, subjectType: w.subjectType, subjectId: w.subjectId, subjectTitle: titleOf(w.subjectType, w.subjectId), returnedAt: w.returnedAt, returnedSummary: w.returnedSummary, sourceKind: w.sourceKind };
        });
        const ms = collab.meetingsWith(db, p.id).filter((m) => m.status !== "cancelled").map((m) => ({ id: m.id, title: m.title, startsAt: m.startsAt, status: m.status }));
        return { id: p.id, name: p.name, handle: p.handle, email: p.email, note: p.note, waiting, returned, meetings: ms, basis: ws.some((w) => w.sourceKind !== "operator") ? "evidence" : "operator-recorded", cognition: "none", lease: "none" };
    });
    return { people, meetings };
}
const NODE_OF = { conversation: "window", work: "work", attempt: "attempt", judgment: "judgment", wait: "wait", person: "person", meeting: "meeting", note: "note", directive: "directive", tool: "tool", revision: "seat", edition: "gateway" };
function stepText(e) {
    const d = e.detail;
    const bits = ["reason", "outcome", "role", "provider", "decision", "kind", "seat", "person", "question", "summary", "title"].filter((k) => typeof d[k] === "string" && d[k].length).map((k) => `${k} ${String(d[k]).slice(0, 60)}`);
    return `${e.entityType} ${e.kind}${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
}
/** Every event that touched a node and the rows it is made of (an obligation: its attempts, judgments, waits and parts), oldest first. Answers "why did this happen" with rows, not narrative. */
export function traceView(db, kind, id, limit = 80) {
    const ids = new Set();
    const add = (t, i) => ids.add(`${t}\0${i}`);
    const visitedWorks = new Set();
    const addWork = (wid, deep = true) => {
        if (visitedWorks.has(wid))
            return;
        visitedWorks.add(wid);
        add("work", wid);
        const sourceWork = q.work(db, wid);
        if (sourceWork?.sourceKind && sourceWork.sourceRef)
            add(sourceWork.sourceKind, sourceWork.sourceRef);
        for (const a of q.attempts(db, wid))
            add("attempt", a.id);
        for (const j of db.prepare("SELECT id FROM judgments WHERE subject_type='work' AND subject_id=?").all(wid))
            add("judgment", j.id);
        for (const x of collab.waitsFor(db, "work", wid))
            add("wait", x.id);
        if (deep)
            for (const c of q.children(db, wid))
                addWork(c.id, true);
    };
    if (kind === "work")
        addWork(id);
    else if (kind === "attempt") {
        const a = q.attempt(db, id);
        if (a)
            addWork(a.workId, false);
        else
            add("attempt", id);
    }
    else if (kind === "judgment") {
        const j = q.judgment(db, id);
        if (j?.subjectType === "work")
            addWork(j.subjectId, false);
        else
            add("judgment", id);
    }
    else if (kind === "seat") {
        for (const w of q.openWork(db))
            if (w.seat === id)
                addWork(w.id, false);
        add("revision", "*");
    }
    else if (kind === "person") {
        for (const x of collab.waitsOn(db, id)) {
            add("wait", x.id);
            if (x.subjectType === "work" && x.subjectId)
                add("work", x.subjectId);
        }
        add("person", id);
    }
    else if (kind === "window")
        add("conversation", id);
    else
        add(kind, id);
    const pairs = [...ids].map((s) => s.split("\0"));
    if (!pairs.length)
        return { node: `${kind}:${id}`, steps: [] };
    // Bound expression depth and parameter count independently of process size. Each chunk's
    // latest N contains every possible member of the global latest N; merge by immutable sequence.
    const candidates = new Map();
    for (let offset = 0; offset < pairs.length; offset += 250) {
        const chunk = pairs.slice(offset, offset + 250);
        const where = chunk.map(([, i]) => i === "*" ? "(entity_type=?)" : "(entity_type=? AND entity_id=?)").join(" OR ");
        const args = chunk.flatMap(([t, i]) => i === "*" ? [t] : [t, i]);
        for (const raw of db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY seq DESC LIMIT ?`).all(...args, limit)) {
            const event = rowToEvent(raw);
            candidates.set(event.seq, event);
        }
    }
    const rows = [...candidates.values()].sort((a, b) => b.seq - a.seq).slice(0, limit).reverse();
    return { node: `${kind}:${id}`, steps: rows.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, node: `${NODE_OF[e.entityType] ?? e.entityType}:${e.entityType === "revision" ? id : e.entityId}`, text: stepText(e), detail: e.detail, related: [
                ...(typeof e.detail.workId === "string" ? [`work:${e.detail.workId}`] : []),
                ...(typeof e.detail.seat === "string" ? [`seat:${e.detail.seat}`] : []),
                ...(e.detail.decisionIds ?? []).map(id => `judgment:${id}`),
                ...(e.detail.returnIds ?? []).map(id => `wait:${id}`),
            ] })) };
}
// --- Judgments cockpit -------------------------------------------------------------------------------
export function judgmentsView(db) {
    const open = q.openJudgments(db).map((j) => ({ ...j, subjectTitle: j.subjectType === "work" ? q.work(db, j.subjectId)?.title ?? j.subjectId : j.subjectId }));
    const recent = q.judgments(db, 30).filter((j) => j.status !== "open").map((j) => ({ ...j, subjectTitle: j.subjectType === "work" ? q.work(db, j.subjectId)?.title ?? j.subjectId : j.subjectId }));
    return { product: open.filter((j) => j.kind === "product"), technical: open.filter((j) => j.kind === "technical"), recent };
}
export function statusView(db, bootId, startedAt, container = null) {
    return {
        ok: true, bootId, startedAt, activeRevision: getSetting(db, "active_revision"),
        providers: db.prepare("SELECT name, available, detail, observed_at, state FROM providers").all().map((p) => ({ ...p, available: p.available === 1 })),
        running: q.runningAttempts(db).length, open: db.prepare("SELECT COUNT(*) AS n FROM work WHERE status='open'").get().n,
        judgmentsOwed: q.openJudgments(db).length,
        self: (() => { const reg = readRegistry(); const id = runningEditionId(reg); return { label: runningLabel(reg), editionId: id, accepted: !!reg.editions.find((e) => e.id === id)?.acceptedAt, skew: skewNow(reg).length, ready: reg.editions.filter((e) => e.status === "proposed").length, container: container ? `${container.kind} ${container.version}` : null }; })(),
    };
}
//# sourceMappingURL=projections.js.map