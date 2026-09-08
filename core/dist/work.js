import { id, now, fingerprint } from "./ids.js";
import { append } from "./events.js";
import { activeRevision } from "./org.js";
// --- row mappers ---------------------------------------------------------------------------------
const W = (r) => ({
    id: r.id, title: r.title, brief: r.brief, acceptance: r.acceptance, seat: r.seat,
    parentId: r.parent_id ?? null, sourceKind: r.source_kind ?? null, sourceRef: r.source_ref ?? null,
    status: r.status, priority: r.priority, rounds: r.rounds, revisionId: r.revision_id,
    createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at ?? null,
});
const A = (r) => ({
    id: r.id, workId: r.work_id, seat: r.seat, role: r.role, provider: r.provider, model: r.model,
    workspace: r.workspace ?? null, status: r.status, pid: r.pid ?? null,
    providerSession: r.provider_session ?? null, startedAt: r.started_at, endedAt: r.ended_at ?? null,
    costUsd: r.cost_usd ?? null, receipt: r.receipt ? JSON.parse(r.receipt) : null,
    error: r.error ?? null, round: r.round,
});
const H = (r) => ({ workId: r.work_id, reason: r.reason, detail: r.detail, clearsWhen: r.clears_when, fingerprint: r.fingerprint, since: r.since });
const E = (r) => ({ id: r.id, workId: r.work_id, attemptId: r.attempt_id ?? null, kind: r.kind, locator: r.locator, summary: r.summary, createdAt: r.created_at });
const R = (r) => ({ id: r.id, workId: r.work_id, attemptId: r.attempt_id ?? null, outcome: r.outcome, summary: r.summary, createdAt: r.created_at, seenAt: r.seen_at ?? null });
const J = (r) => ({
    id: r.id, kind: r.kind, subjectType: r.subject_type, subjectId: r.subject_id, question: r.question,
    context: r.context, options: JSON.parse(r.options), recommended: r.recommended ?? null, priority: r.priority,
    fingerprint: r.fingerprint, status: r.status, decision: r.decision ?? null, decidedBy: r.decided_by ?? null,
    decidedAt: r.decided_at ?? null, note: r.note ?? null, createdAt: r.created_at,
});
// --- queries -------------------------------------------------------------------------------------
export const q = {
    work: (db, workId) => { const r = db.prepare("SELECT * FROM work WHERE id=?").get(workId); return r ? W(r) : null; },
    openWork: (db) => db.prepare("SELECT * FROM work WHERE status='open' ORDER BY priority ASC, created_at ASC").all().map(W),
    allWork: (db, limit = 200) => db.prepare("SELECT * FROM work ORDER BY created_at DESC LIMIT ?").all(limit).map(W),
    children: (db, parentId) => db.prepare("SELECT * FROM work WHERE parent_id=? ORDER BY created_at").all(parentId).map(W),
    attempts: (db, workId) => db.prepare("SELECT * FROM attempts WHERE work_id=? ORDER BY started_at ASC").all(workId).map(A),
    attempt: (db, attemptId) => { const r = db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId); return r ? A(r) : null; },
    runningAttempts: (db) => db.prepare("SELECT * FROM attempts WHERE status='running'").all().map(A),
    hold: (db, workId) => { const r = db.prepare("SELECT * FROM holds WHERE work_id=?").get(workId); return r ? H(r) : null; },
    holds: (db) => db.prepare("SELECT * FROM holds").all().map(H),
    evidence: (db, workId) => db.prepare("SELECT * FROM evidence WHERE work_id=? ORDER BY created_at").all(workId).map(E),
    returns: (db, limit = 50) => db.prepare("SELECT * FROM returns ORDER BY created_at DESC LIMIT ?").all(limit).map(R),
    unseenReturns: (db) => db.prepare("SELECT * FROM returns WHERE seen_at IS NULL ORDER BY created_at DESC").all().map(R),
    judgment: (db, jid) => { const r = db.prepare("SELECT * FROM judgments WHERE id=?").get(jid); return r ? J(r) : null; },
    openJudgments: (db) => db.prepare("SELECT * FROM judgments WHERE status='open' ORDER BY priority ASC, created_at ASC").all().map(J),
    judgments: (db, limit = 100) => db.prepare("SELECT * FROM judgments ORDER BY created_at DESC LIMIT ?").all(limit).map(J),
    openJudgmentFor: (db, subjectType, subjectId) => { const r = db.prepare("SELECT * FROM judgments WHERE status='open' AND subject_type=? AND subject_id=? ORDER BY created_at DESC").get(subjectType, subjectId); return r ? J(r) : null; },
    leases: (db) => db.prepare("SELECT seat, scope, attempt_id AS attemptId, acquired_at AS acquiredAt FROM leases").all(),
};
/** Conjure accepts responsibility. The only way work comes into existence. */
export function commission(db, input, by) {
    const rev = activeRevision(db);
    if (!rev)
        throw new Error("no active organization revision");
    const seat = input.seat ?? rev.routing.intake;
    if (!rev.seats.some((s) => s.id === seat))
        throw new Error(`no seat '${seat}' in ${rev.id}`);
    const title = input.title.trim().slice(0, 200);
    if (!title)
        throw new Error("title required");
    const wid = id("w");
    const t = now();
    db.transaction(() => {
        db.prepare(`INSERT INTO work(id,title,brief,acceptance,seat,parent_id,source_kind,source_ref,status,priority,rounds,revision_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'open',?,0,?,?,?)`)
            .run(wid, title, input.brief, input.acceptance?.trim() || "Done when the brief is satisfied and evidence is attached.", seat, input.parentId ?? null, input.sourceKind ?? null, input.sourceRef ?? null, input.priority ?? 2, rev.id, t, t);
        append(db, "work", wid, "commissioned", { title, seat, by, parentId: input.parentId ?? null, sourceKind: input.sourceKind ?? null });
    })();
    return q.work(db, wid);
}
export function cancelWork(db, workId, by, reason) {
    const w = q.work(db, workId);
    if (!w)
        throw new Error("no such work");
    if (w.status !== "open")
        return w;
    db.transaction(() => {
        const t = now();
        db.prepare("UPDATE work SET status='cancelled', closed_at=?, updated_at=? WHERE id=?").run(t, t, workId);
        db.prepare("DELETE FROM holds WHERE work_id=?").run(workId);
        db.prepare("UPDATE judgments SET status='withdrawn' WHERE status='open' AND subject_type='work' AND subject_id=?").run(workId);
        db.prepare("INSERT INTO returns(id,work_id,attempt_id,outcome,summary,created_at) VALUES(?,?,NULL,'stopped',?,?)").run(id("ret"), workId, `Cancelled by ${by}: ${reason}`, t);
        append(db, "work", workId, "cancelled", { by, reason });
    })();
    return q.work(db, workId);
}
export function closeDone(db, workId, attemptId, summary) {
    db.transaction(() => {
        const t = now();
        db.prepare("UPDATE work SET status='done', closed_at=?, updated_at=? WHERE id=?").run(t, t, workId);
        db.prepare("DELETE FROM holds WHERE work_id=?").run(workId);
        db.prepare("INSERT INTO returns(id,work_id,attempt_id,outcome,summary,created_at) VALUES(?,?,?,'delivered',?,?)").run(id("ret"), workId, attemptId, summary, t);
        append(db, "work", workId, "done", { attemptId, summary: summary.slice(0, 300) });
    })();
}
/** Operator edits the brief/acceptance: a durable change that may clear a 'blocked' hold. */
export function amendWork(db, workId, patch, by) {
    const w = q.work(db, workId);
    if (!w)
        throw new Error("no such work");
    db.transaction(() => {
        db.prepare("UPDATE work SET title=?, brief=?, acceptance=?, priority=?, seat=?, updated_at=? WHERE id=?")
            .run(patch.title ?? w.title, patch.brief ?? w.brief, patch.acceptance ?? w.acceptance, patch.priority ?? w.priority, patch.seat ?? w.seat, now(), workId);
        append(db, "work", workId, "amended", { by, fields: Object.keys(patch) });
    })();
    return q.work(db, workId);
}
export function setHold(db, workId, reason, detail, clearsWhen, fp) {
    const existing = q.hold(db, workId);
    const f = fp ?? fingerprint(reason, detail, clearsWhen);
    if (existing && existing.reason === reason && existing.fingerprint === f)
        return existing;
    db.prepare("INSERT INTO holds(work_id,reason,detail,clears_when,fingerprint,since) VALUES(?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET reason=excluded.reason, detail=excluded.detail, clears_when=excluded.clears_when, fingerprint=excluded.fingerprint, since=excluded.since")
        .run(workId, reason, detail, clearsWhen, f, now());
    // Silent holds (capacity/no-processor/backoff) are runtime facts, not organizational news; do not spam the ledger.
    if (!["capacity", "no-processor", "backoff"].includes(reason))
        append(db, "work", workId, "held", { reason, detail, clearsWhen });
    return q.hold(db, workId);
}
export function clearHold(db, workId, why) {
    const h = q.hold(db, workId);
    if (!h)
        return;
    db.prepare("DELETE FROM holds WHERE work_id=?").run(workId);
    if (!["capacity", "no-processor", "backoff"].includes(h.reason))
        append(db, "work", workId, "released", { reason: h.reason, why });
}
export function addEvidence(db, workId, attemptId, refs) {
    const stmt = db.prepare("INSERT INTO evidence(id,work_id,attempt_id,kind,locator,summary,created_at) VALUES(?,?,?,?,?,?,?)");
    for (const e of refs)
        stmt.run(id("ev"), workId, attemptId, e.kind.slice(0, 40), e.locator.slice(0, 1000), (e.summary ?? "").slice(0, 1000), now());
}
/** Open a judgment unless an identical open one already exists. Returns the open judgment either way. */
export function askJudgment(db, kind, subjectType, subjectId, ask) {
    const fp = fingerprint(kind, subjectType, subjectId, ask.question, ask.options);
    const dup = db.prepare("SELECT * FROM judgments WHERE status='open' AND fingerprint=?").get(fp);
    if (dup)
        return J(dup);
    const jid = id("j");
    db.prepare("INSERT INTO judgments(id,kind,subject_type,subject_id,question,context,options,recommended,priority,fingerprint,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'open',?)")
        .run(jid, kind, subjectType, subjectId, ask.question.slice(0, 500), (ask.context ?? "").slice(0, 4000), JSON.stringify(ask.options.slice(0, 6)), ask.recommended ?? null, ask.priority ?? 2, fp, now());
    append(db, "judgment", jid, "asked", { kind, subjectType, subjectId, question: ask.question.slice(0, 200) });
    return q.judgment(db, jid);
}
export function decideJudgment(db, jid, decision, by, note) {
    const j = q.judgment(db, jid);
    if (!j)
        throw new Error("no such judgment");
    if (j.status !== "open")
        throw new Error(`judgment already ${j.status}`);
    // Options constrain the answer; an open question (no options) takes the operator's own words.
    if (j.options.length && !j.options.includes(decision))
        throw new Error(`decision must be one of: ${j.options.join(", ")}`);
    if (!j.options.length && !decision.trim())
        throw new Error("an open question needs an answer");
    decision = j.options.length ? decision : decision.trim().slice(0, 4000);
    db.transaction(() => {
        db.prepare("UPDATE judgments SET status='decided', decision=?, decided_by=?, decided_at=?, note=? WHERE id=?").run(decision, by, now(), note, jid);
        append(db, "judgment", jid, "decided", { decision, by, subjectType: j.subjectType, subjectId: j.subjectId });
        if (j.subjectType === "work") {
            db.prepare("UPDATE work SET updated_at=? WHERE id=?").run(now(), j.subjectId);
            const w = q.work(db, j.subjectId);
            if (w && w.status === "open") {
                // Structural decisions cold software understands. Anything else is context for the next attempt.
                if (decision === "cancel")
                    cancelWork(db, w.id, by, `judgment ${jid}`);
                else if (decision === "accept as is")
                    closeDone(db, w.id, null, `Accepted by ${by} after review ceiling.`);
                else if (decision === "allow another round")
                    db.prepare("UPDATE work SET rounds=0 WHERE id=?").run(w.id);
                clearHold(db, w.id, `judgment ${jid} decided: ${decision}`);
            }
        }
    })();
    return q.judgment(db, jid);
}
export function markReturnsSeen(db, ids) {
    if (ids === "all")
        db.prepare("UPDATE returns SET seen_at=? WHERE seen_at IS NULL").run(now());
    else {
        const s = db.prepare("UPDATE returns SET seen_at=? WHERE id=? AND seen_at IS NULL");
        for (const i of ids)
            s.run(now(), i);
    }
}
export function newestAttempt(attempts) {
    return attempts.length ? attempts[attempts.length - 1] : null;
}
//# sourceMappingURL=work.js.map