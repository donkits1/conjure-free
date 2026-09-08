// The organization: immutable revisions, one ACTIVE pointer. Editing produces a new revision. Nothing hot-reloads.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { getSetting, setSetting } from "./db.js";
import { fingerprint, now } from "./ids.js";
import { append } from "./events.js";
export const CAPABILITIES = {
    worker: ["workspace", "return"],
    reviewer: ["workspace:read", "verdict"],
    planner: ["plan", "return"],
    manager: ["plan", "assign", "return"],
};
export function activeRevision(db) {
    const id = getSetting(db, "active_revision");
    return id ? getRevision(db, id) : null;
}
export function getRevision(db, id) {
    const r = db.prepare("SELECT * FROM revisions WHERE id = ?").get(id);
    return r ? rowToRevision(r) : null;
}
export function listRevisions(db) {
    return db.prepare("SELECT id, seq, parent_id, created_at, created_by, note, hash FROM revisions ORDER BY seq DESC").all()
        .map((r) => ({ id: r.id, seq: r.seq, parentId: r.parent_id, createdAt: r.created_at,
        createdBy: r.created_by, note: r.note, hash: r.hash }));
}
function rowToRevision(r) {
    const body = JSON.parse(r.body);
    return { id: r.id, seq: r.seq, parentId: r.parent_id, createdAt: r.created_at,
        createdBy: r.created_by, note: r.note, hash: r.hash, ...body };
}
export function validateBody(body) {
    const errors = [];
    const ids = new Set();
    for (const s of body.seats) {
        if (!/^[a-z][a-z0-9-]*$/.test(s.id))
            errors.push(`seat id '${s.id}' must be kebab-case`);
        if (ids.has(s.id))
            errors.push(`duplicate seat '${s.id}'`);
        ids.add(s.id);
        if (!(s.role in CAPABILITIES))
            errors.push(`seat '${s.id}' has unknown role '${s.role}'`);
        if (!s.processors.length)
            errors.push(`seat '${s.id}' names no processor`);
        if (!(s.lanes >= 1))
            errors.push(`seat '${s.id}' lanes must be >= 1`);
        if (s.workspaceRoot !== null && !path.isAbsolute(s.workspaceRoot))
            errors.push(`seat '${s.id}' workspaceRoot must be absolute`);
    }
    for (const s of body.seats) {
        if (s.reportsTo && !ids.has(s.reportsTo))
            errors.push(`seat '${s.id}' reports to unknown seat '${s.reportsTo}'`);
    }
    if (!ids.has(body.routing.intake))
        errors.push(`routing.intake '${body.routing.intake}' is not a seat`);
    if (body.routing.reviewer && !ids.has(body.routing.reviewer))
        errors.push(`routing.reviewer '${body.routing.reviewer}' is not a seat`);
    if (!(body.routing.maxRounds >= 1))
        errors.push("routing.maxRounds must be >= 1");
    if (!(body.routing.retryLimit >= 0))
        errors.push("routing.retryLimit must be >= 0");
    return errors;
}
/** A workflow graph equivalent to a routing: start -> intake seat -> review -> return, fail loops back. */
export function workflowFromRouting(body) {
    const nodes = [{ id: "start", kind: "start", x: 40, y: 160 }, { id: "intake", kind: "seat", seat: body.routing.intake, x: 220, y: 140 }];
    const edges = [{ id: "e1", from: "start", to: "intake", when: "next" }];
    if (body.routing.reviewer) {
        nodes.push({ id: "review", kind: "review", seat: body.routing.reviewer, x: 460, y: 140 }, { id: "return", kind: "return", x: 700, y: 160 });
        edges.push({ id: "e2", from: "intake", to: "review", when: "next" }, { id: "e3", from: "review", to: "return", when: "pass" }, { id: "e4", from: "review", to: "intake", when: "fail" });
    }
    else {
        nodes.push({ id: "return", kind: "return", x: 460, y: 160 });
        edges.push({ id: "e2", from: "intake", to: "return", when: "next" });
    }
    return { nodes, edges };
}
/** Compile a workflow graph to the routing the reconciler executes. Shapes it cannot execute yet are reported, never faked. */
export function compileWorkflow(wf, seats, base) {
    const errors = [];
    const warnings = [];
    const byId = new Map(wf.nodes.map((n) => [n.id, n]));
    const seatIds = new Set(seats.map((s) => s.id));
    const out = (id, when) => wf.edges.filter((e) => e.from === id && (!when || e.when === when)).map((e) => byId.get(e.to)).filter((n) => !!n);
    for (const e of wf.edges)
        if (!byId.has(e.from) || !byId.has(e.to))
            errors.push(`edge ${e.id} points at a missing node`);
    for (const n of wf.nodes)
        if ((n.kind === "seat" || n.kind === "review") && (!n.seat || !seatIds.has(n.seat)))
            errors.push(`${n.kind} node '${n.label ?? n.id}' names no existing seat`);
    const starts = wf.nodes.filter((n) => n.kind === "start");
    if (starts.length !== 1)
        errors.push(`exactly one start node is required (found ${starts.length})`);
    let intake = base.intake;
    let reviewer = null;
    if (starts.length === 1) {
        const first = out(starts[0].id);
        const seatNode = first.find((n) => n.kind === "seat");
        if (!seatNode)
            errors.push("start must lead to a seat step");
        else {
            intake = seatNode.seat;
            const next = out(seatNode.id);
            const review = next.find((n) => n.kind === "review");
            if (review) {
                reviewer = review.seat;
                if (!out(review.id, "pass").some((n) => n.kind === "return"))
                    warnings.push("review 'pass' does not lead to return; results will still return when review passes");
                if (!out(review.id, "fail").some((n) => n.id === seatNode.id))
                    warnings.push("review 'fail' does not loop back to the seat step; rework still goes back to that seat");
                if (next.some((n) => n.kind === "seat"))
                    warnings.push(`seat steps after '${seatNode.label ?? seatNode.seat}' are recorded but not executed yet`);
            }
            else if (next.some((n) => n.kind === "seat"))
                warnings.push("a chain of seat steps is recorded but only the first step executes in this version");
            else if (!next.some((n) => n.kind === "return"))
                warnings.push("the seat step leads nowhere; results return directly");
        }
    }
    if (wf.nodes.some((n) => n.kind === "judgment"))
        warnings.push("explicit judgment gates are recorded; the reconciler currently owes judgments at review ceilings and processor failure");
    if (errors.length === 0 && !seatIds.has(intake))
        errors.push(`intake seat '${intake}' does not exist`);
    return { routing: { ...base, intake, reviewer }, warnings, errors };
}
/** Freeze a body as a new revision and make it ACTIVE. The single write path for organizational change. */
export function activateRevision(db, body, createdBy, note) {
    if (body.workflow) {
        const c = compileWorkflow(body.workflow, body.seats, body.routing);
        if (c.errors.length)
            throw new Error(`invalid workflow: ${c.errors.join("; ")}`);
        body = { ...body, routing: c.routing };
    }
    const errors = validateBody(body);
    if (errors.length)
        throw new Error(`invalid revision: ${errors.join("; ")}`);
    return db.transaction(() => {
        const parent = getSetting(db, "active_revision");
        const seqRow = db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM revisions").get();
        const id = `r${seqRow.seq}`;
        const json = JSON.stringify(body);
        const hash = fingerprint(json);
        db.prepare("INSERT INTO revisions(id,seq,parent_id,created_at,created_by,note,body,hash) VALUES(?,?,?,?,?,?,?,?)")
            .run(id, seqRow.seq, parent, now(), createdBy, note, json, hash);
        setSetting(db, "active_revision", id);
        append(db, "revision", id, "activated", { parent, note, createdBy });
        return getRevision(db, id);
    })();
}
/** Re-activate an older revision (its body is frozen; a rollback is a new ACTIVE pointer, recorded). */
export function rollbackTo(db, revisionId, createdBy) {
    const target = getRevision(db, revisionId);
    if (!target)
        throw new Error(`no revision ${revisionId}`);
    return activateRevision(db, { seats: target.seats, routing: target.routing, workflow: target.workflow }, createdBy, `rollback to ${revisionId}`);
}
/** Apply a small operator edit to one seat of ACTIVE and freeze the result as a new revision. */
export function editSeat(db, seatId, patch, createdBy) {
    const active = activeRevision(db);
    if (!active)
        throw new Error("no active revision");
    const seats = active.seats.map((s) => (s.id === seatId ? { ...s, ...patch } : s));
    if (!seats.some((s) => s.id === seatId))
        throw new Error(`no seat ${seatId}`);
    return activateRevision(db, { seats, routing: active.routing, workflow: active.workflow }, createdBy, `edit seat ${seatId}: ${Object.keys(patch).join(",")}`);
}
export function addSeat(db, seat, createdBy) {
    const active = activeRevision(db);
    if (!active)
        throw new Error("no active revision");
    return activateRevision(db, { seats: [...active.seats, seat], routing: active.routing, workflow: active.workflow }, createdBy, `add seat ${seat.id}`);
}
export function editRouting(db, patch, createdBy) {
    const active = activeRevision(db);
    if (!active)
        throw new Error("no active revision");
    const routing = { ...active.routing, ...patch };
    // Routing edits re-derive the graph so the two never disagree.
    return activateRevision(db, { seats: active.seats, routing, workflow: workflowFromRouting({ seats: active.seats, routing }) }, createdBy, `edit routing: ${Object.keys(patch).join(",")}`);
}
export function setWorkflow(db, wf, routingPatch, createdBy, note = "workflow edited") {
    const active = activeRevision(db);
    if (!active)
        throw new Error("no active revision");
    return activateRevision(db, { seats: active.seats, routing: { ...active.routing, ...routingPatch }, workflow: wf }, createdBy, note);
}
export function workflowOf(rev) {
    return rev.workflow ?? workflowFromRouting(rev);
}
/** A minimal organization for a fresh install. Three offices; the operator can reshape it from Network. */
export function seedBody(workspaceRoot) {
    const claude = { provider: "claude", model: "sonnet" };
    return {
        seats: [
            { id: "planner", name: "Planner", department: "engineering", reportsTo: null, role: "planner",
                charter: "Turn an objective into a small set of independently completable pieces of work with clear acceptance.",
                processors: [claude], workspaceRoot: workspaceRoot, lanes: 1 },
            { id: "builder", name: "Builder", department: "engineering", reportsTo: "planner", role: "worker",
                charter: "Make one bounded change in the workspace that satisfies the acceptance, with evidence.",
                processors: [claude, { provider: "codex", model: "gpt-5.6-terra" }], workspaceRoot: workspaceRoot, lanes: 2 },
            { id: "reviewer", name: "Reviewer", department: "engineering", reportsTo: "planner", role: "reviewer",
                charter: "Judge whether a returned result satisfies the acceptance. Record a verdict; never rework it yourself.",
                processors: [claude], workspaceRoot: workspaceRoot, lanes: 1 },
        ],
        routing: { intake: "builder", reviewer: "reviewer", maxRounds: 2, retryLimit: 2 },
    };
}
export function ensureSeeded(db) {
    const active = activeRevision(db);
    if (active)
        return active;
    const root = process.env.CONJURE_WORKSPACE_ROOT ? path.resolve(process.env.CONJURE_WORKSPACE_ROOT) : null;
    return activateRevision(db, seedBody(root), "setup", "initial organization");
}
function tong1Role(s) {
    const n = s.name.toLowerCase();
    if (n.includes("review"))
        return "reviewer";
    if (n.includes("plan"))
        return "planner";
    if (n.includes("manager") || n.includes("director") || s.rank === "manager" || s.rank === "executive")
        return "manager";
    return "worker";
}
export function importTong1(jinnHome = path.join(os.homedir(), ".jinn")) {
    const circuit = path.join(jinnHome, "circuit");
    const active = fs.readFileSync(path.join(circuit, "ACTIVE"), "utf8").trim();
    const orgDir = path.join(circuit, "revisions", active, "org");
    const seats = [];
    const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory())
                walk(p);
            else if (ent.name.endsWith(".yaml") && ent.name !== "department.yaml") {
                const doc = YAML.parse(fs.readFileSync(p, "utf8"));
                if (!doc?.name)
                    continue;
                const id = doc.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
                const reportsTo = Array.isArray(doc.reportsTo) ? doc.reportsTo[0] ?? null : doc.reportsTo ?? null;
                const processors = [{ provider: doc.engine ?? "claude", model: doc.model ?? "sonnet" }];
                for (const alt of doc.engineAlternates ?? [])
                    if (alt.engine && alt.model)
                        processors.push({ provider: alt.engine, model: alt.model });
                const root = doc.execution?.defaultRoot ?? doc.execution?.allowedRoots?.[0] ?? null;
                seats.push({
                    id, name: doc.displayName ?? doc.name, department: doc.department ?? "general", reportsTo,
                    role: tong1Role(doc), charter: (doc.persona ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 400),
                    processors, workspaceRoot: root && path.isAbsolute(root) ? root : null, lanes: 1,
                });
            }
        }
    };
    walk(orgDir);
    const ids = new Set(seats.map((s) => s.id));
    for (const s of seats)
        if (s.reportsTo && !ids.has(s.reportsTo))
            s.reportsTo = null;
    const workers = seats.filter((s) => s.role === "worker");
    const intake = (workers.find((s) => s.id.includes("builder")) ?? workers[0] ?? seats[0])?.id ?? "builder";
    const reviewer = seats.find((s) => s.role === "reviewer")?.id ?? null;
    return { seats, routing: { intake, reviewer, maxRounds: 2, retryLimit: 2 } };
}
//# sourceMappingURL=org.js.map