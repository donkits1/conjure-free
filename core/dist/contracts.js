// An immutable record of the contractual slice of reality actually delivered to an attempt.
// This is evidence, not a provider session and not a replay of private thought.
import { createHash } from "node:crypto";
import { activeRevision } from "./org.js";
import { q } from "./work.js";
const hash = (v) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
function inputsOf({ db, seat, work }) {
    // Deliberately exclude priority, title, rounds, occupancy, provider availability and wall-clock time.
    // Those can change without changing what the obligation means.
    const source = work.sourceKind === "note" && work.sourceRef
        ? db.prepare("SELECT id, body FROM notes WHERE id=?").get(work.sourceRef) ?? null
        : work.sourceKind === "directive" && work.sourceRef
            ? db.prepare("SELECT id, text FROM directives WHERE id=?").get(work.sourceRef) ?? null : null;
    return {
        brief: work.brief, acceptance: work.acceptance, responsibility: work.seat,
        charter: seat.charter, workspace: seat.workspaceRoot, tools: [...(seat.tools ?? [])].sort(), source,
        decisions: db.prepare("SELECT id, question, decision, note FROM judgments WHERE subject_type='work' AND subject_id=? AND status='decided' ORDER BY id").all(work.id),
        returns: db.prepare("SELECT id, person_id, kind, description, returned_summary FROM waits WHERE subject_type='work' AND subject_id=? AND status='returned' ORDER BY id").all(work.id),
    };
}
export function captureContract(ctx, prompt) {
    const inputs = inputsOf(ctx);
    return { capturedAt: new Date().toISOString(), revisionId: ctx.rev.id, seatId: ctx.seat.id, role: ctx.role,
        prompt, promptHash: hash(prompt), inputsHash: hash(inputs), inputs };
}
export function saveContract(db, attemptId, snapshot) {
    db.prepare("INSERT INTO attempt_contracts(attempt_id,snapshot) VALUES(?,?)").run(attemptId, JSON.stringify(snapshot));
}
export function readContract(db, attemptId) {
    const r = db.prepare("SELECT snapshot FROM attempt_contracts WHERE attempt_id=?").get(attemptId);
    return r ? JSON.parse(r.snapshot) : null;
}
export function contractStatus(db, attemptId) {
    const snapshot = readContract(db, attemptId);
    const attempt = q.attempt(db, attemptId);
    if (!attempt)
        return { snapshot, stale: false, changes: [], currentHash: null };
    if (!snapshot) {
        // An old edition did not save the input. A later recorded semantic amendment is still evidence
        // that its result cannot be trusted to settle the amended obligation. No historical prompt is invented.
        const amendments = db.prepare("SELECT detail FROM events WHERE entity_type='work' AND entity_id=? AND kind='amended' AND at>=? ORDER BY seq").all(attempt.workId, attempt.startedAt);
        const changes = [...new Set(amendments.flatMap(e => {
                try {
                    return (JSON.parse(e.detail).fields ?? []).filter(f => ['brief', 'acceptance', 'seat'].includes(f));
                }
                catch {
                    return [];
                }
            }))];
        return { snapshot: null, stale: changes.length > 0, changes, currentHash: null };
    }
    const work = q.work(db, attempt.workId), rev = activeRevision(db);
    const seat = rev?.seats.find((s) => s.id === snapshot.seatId);
    if (!work || !rev || !seat)
        return { snapshot, stale: true, changes: [!seat ? "responsible seat no longer configured" : "obligation unavailable"], currentHash: null };
    const inputs = inputsOf({ db, rev, seat, work, role: snapshot.role, attempts: [] });
    const changes = Object.keys(inputs).filter((key) => hash(inputs[key]) !== hash(snapshot.inputs[key]));
    return { snapshot, stale: changes.length > 0, changes, currentHash: hash(inputs) };
}
//# sourceMappingURL=contracts.js.map