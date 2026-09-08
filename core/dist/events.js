// Append-only durable events + an in-process signal. Durable transitions wake the reconciler; timers are safety nets.
import { EventEmitter } from "node:events";
import { now } from "./ids.js";
export const bus = new EventEmitter();
bus.setMaxListeners(200);
export function append(db, entityType, entityId, kind, detail = {}) {
    const at = now();
    const r = db.prepare("INSERT INTO events(at,entity_type,entity_id,kind,detail) VALUES(?,?,?,?,?)")
        .run(at, entityType, entityId, kind, JSON.stringify(detail));
    const ev = { seq: Number(r.lastInsertRowid), at, entityType, entityId, kind, detail };
    // Emit after the surrounding (synchronous) transaction has committed.
    queueMicrotask(() => bus.emit("event", ev));
    return ev;
}
export function eventsSince(db, sinceIso, limit = 500) {
    const rows = (sinceIso
        ? db.prepare("SELECT * FROM events WHERE at > ? ORDER BY seq ASC LIMIT ?").all(sinceIso, limit)
        : db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit).reverse());
    return rows.map(rowToEvent);
}
export function rowToEvent(r) {
    return {
        seq: r.seq, at: r.at, entityType: r.entity_type, entityId: r.entity_id,
        kind: r.kind, detail: JSON.parse(r.detail || "{}"),
    };
}
//# sourceMappingURL=events.js.map