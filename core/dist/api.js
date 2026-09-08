import fs from "node:fs";
import { URL } from "node:url";
import { paths } from "./home.js";
import { requestReconcile, stopAttempt, probeProviders } from "./reconcile.js";
import { append, bus, eventsSince } from "./events.js";
import { selfView, switchEdition } from "./self.js";
import { acceptEdition, readRegistry, rejectEdition, writeRegistry } from "./editions.js";
import { getSetting, setSetting } from "./db.js";
import { now } from "./ids.js";
import { BODY_LIMIT_BYTES } from "./http-security.js";
import { activeRevision, activateRevision, editSeat, addSeat, editRouting, rollbackTo, getRevision, importTong1, setWorkflow, workflowOf, compileWorkflow, CAPABILITIES } from "./org.js";
import { commission, cancelWork, amendWork, decideJudgment, markReturnsSeen, q } from "./work.js";
import { controlBriefing, networkView, traceView, judgmentsView, workDetail, workView, statusView, homeworkView } from "./projections.js";
import { renderBrief } from "./brief.js";
import { contractStatus } from "./contracts.js";
import { tools as toolTable, registerTool, updateTool, removeTool, probeTool, probeTools, grantsFor } from "./tools.js";
import { readSpecs, writeSpec, removeSpec, validateSpec, specFile, boundaryOf } from "./providers-experimental.js";
import { providerFromSpec } from "./providers.js";
import { ideas, createConversation, updateConversation, setExposure, speak, createFolder, updateFolder, deleteFolder, createNote, updateNote, deleteNote, shareNote, contractPreview, handNoteToConjure, createSeed, setSeedStatus, seedToWindow, createDirective, directiveProposal, acceptDirective, dismissDirective, workflowProposal, contextOf, connectNote, disconnectNote, } from "./ideas.js";
import { collab, createPerson, updatePerson, deletePerson, createWait, returnWait, cancelWait, createMeeting, updateMeeting, setMeetingStatus, addMeetingPerson, removeMeetingPerson, suggestTimes, meetingIcs, prepareMeeting, agendaProposal, applyAgenda, recordMeetingDecision, submitHomework, WAIT_KINDS, } from "./collab.js";
/** A handler may answer with a non-JSON body (the .ics a human drops into their own calendar). */
class Raw {
    contentType;
    body;
    filename;
    constructor(contentType, body, filename) {
        this.contentType = contentType;
        this.body = body;
        this.filename = filename;
    }
}
const routes = [];
function route(method, path, handler) {
    const keys = [];
    const pattern = new RegExp("^" + path.replace(/:([a-zA-Z]+)/g, (_m, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    routes.push({ method, pattern, keys, handler });
}
export class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
const OPERATOR = "operator";
const str = (v) => (typeof v === "string" ? v : undefined);
// --- status / events / providers -------------------------------------------------------------------
route("GET", "/api/status", ({ rt }) => statusView(rt.db, rt.bootId, startedAt, rt.container));
route("GET", "/api/events", ({ rt, url }) => eventsSince(rt.db, url.searchParams.get("since"), Number(url.searchParams.get("limit") ?? 200)));
route("GET", "/api/providers", ({ rt }) => {
    const st = statusView(rt.db, rt.bootId, startedAt).providers;
    return [...rt.providers.values()].map((p) => ({ ...p.capabilities, experimental: p.capabilities.experimental === true, promoted: p.capabilities.promoted === true, boundary: p.capabilities.boundary ?? null, available: st.find((s) => s.name === p.name)?.available ?? false, detail: st.find((s) => s.name === p.name)?.detail ?? "not probed yet" }));
});
route("POST", "/api/providers/probe", async ({ rt }) => { await probeProviders(rt); requestReconcile(rt); return statusView(rt.db, rt.bootId, startedAt).providers; });
// --- organization ------------------------------------------------------------------------------------
route("GET", "/api/org", ({ rt }) => { const active = activeRevision(rt.db); return { active, workflow: active ? workflowOf(active) : null, capabilities: CAPABILITIES }; });
route("GET", "/api/org/revisions/:id", ({ rt, params }) => getRevision(rt.db, params.id) ?? nf("revision"));
route("POST", "/api/org/seats/:id", ({ rt, params, body }) => editSeat(rt.db, params.id, body, OPERATOR));
route("POST", "/api/org/seats", ({ rt, body }) => addSeat(rt.db, body, OPERATOR));
route("POST", "/api/org/routing", ({ rt, body }) => editRouting(rt.db, body, OPERATOR));
route("POST", "/api/org/rollback", ({ rt, body }) => rollbackTo(rt.db, String(body.revisionId), OPERATOR));
route("POST", "/api/org/activate", ({ rt, body }) => activateRevision(rt.db, { seats: body.seats, routing: body.routing, workflow: body.workflow }, OPERATOR, String(body.note ?? "operator revision")));
route("POST", "/api/org/import-tong1", ({ rt, body }) => { const b = importTong1(str(body.jinnHome)); return body.dryRun ? b : activateRevision(rt.db, b, OPERATOR, "imported from Tong 1 ACTIVE circuit"); });
// workflow: validate (pure) and activate (authoritative, a new revision)
route("POST", "/api/org/workflow/validate", ({ rt, body }) => { const a = activeRevision(rt.db); if (!a)
    nf("organization"); return compileWorkflow(body.workflow, a.seats, { ...a.routing, ...(body.routing ?? {}) }); });
route("POST", "/api/org/workflow", ({ rt, body }) => setWorkflow(rt.db, body.workflow, body.routing ?? {}, OPERATOR, str(body.note) ?? "workflow edited"));
// --- work (durable obligations) -------------------------------------------------------------------------
route("GET", "/api/work", ({ rt, url }) => q.allWork(rt.db, Number(url.searchParams.get("limit") ?? 200)).map((w) => workView(rt.db, w)));
route("GET", "/api/work/:id", ({ rt, params }) => workDetail(rt.db, params.id) ?? nf("work"));
route("POST", "/api/work", ({ rt, body }) => commission(rt.db, { title: String(body.title ?? ""), brief: String(body.brief ?? ""), acceptance: str(body.acceptance), seat: str(body.seat), priority: body.priority ? Number(body.priority) : undefined }, OPERATOR));
route("POST", "/api/work/:id/cancel", ({ rt, params, body }) => cancelWork(rt.db, params.id, OPERATOR, String(body.reason ?? "operator")));
route("POST", "/api/work/:id/amend", ({ rt, params, body }) => amendWork(rt.db, params.id, body, OPERATOR));
route("POST", "/api/work/:id/retry", ({ rt, params }) => { const w = amendWork(rt.db, params.id, {}, OPERATOR); rt.db.prepare("DELETE FROM holds WHERE work_id=?").run(w.id); requestReconcile(rt); return w; });
route("POST", "/api/attempts/:id/stop", ({ rt, params }) => ({ stopped: stopAttempt(rt, params.id) }));
route("GET", "/api/attempts/:id/output", ({ rt, params }) => { const a = q.attempt(rt.db, params.id); if (!a)
    nf("attempt"); return { attempt: a, log: readLog(`attempt-${params.id}.txt`) }; });
route("GET", "/api/attempts/:id/context", ({ rt, params }) => { if (!q.attempt(rt.db, params.id))
    nf("attempt"); return contractStatus(rt.db, params.id); });
// --- directives (operator intent) --------------------------------------------------------------------------
route("GET", "/api/directives", ({ rt }) => ideas.directives(rt.db).map((d) => ({ ...d, proposal: d.status === "open" ? directiveProposal(rt.db, d.id) : null })));
route("POST", "/api/directives", ({ rt, body }) => {
    const r = createDirective(rt, String(body.text ?? ""), { provider: str(body.provider), model: str(body.model), effort: body.effort === null ? null : str(body.effort) });
    // Giving a directive is an explicit ask: intake answers first (one turn), so the operator is not left typing into silence.
    void speak(rt, r.conversation.id, "Here is my order. Ask me only what would change what gets built, or propose the contract if it is already clear.").catch(() => { });
    return r;
});
route("GET", "/api/directives/:id", ({ rt, params }) => { const d = ideas.directive(rt.db, params.id); if (!d)
    nf("directive"); return { ...d, proposal: directiveProposal(rt.db, d.id), work: d.workId ? workView(rt.db, q.work(rt.db, d.workId)) : null }; });
route("POST", "/api/directives/:id/accept", ({ rt, params, body }) => acceptDirective(rt.db, params.id, { title: str(body.title), brief: str(body.brief), acceptance: str(body.acceptance), seat: str(body.seat) }, OPERATOR));
route("POST", "/api/directives/:id/dismiss", ({ rt, params }) => dismissDirective(rt.db, params.id));
// --- judgments -----------------------------------------------------------------------------------------
route("GET", "/api/judgments", ({ rt }) => judgmentsView(rt.db));
route("POST", "/api/judgments/:id/decide", ({ rt, params, body }) => decideJudgment(rt.db, params.id, String(body.decision), OPERATOR, str(body.note) ?? null));
// --- command control --------------------------------------------------------------------------------------
route("GET", "/api/control", ({ rt }) => controlBriefing(rt.db, { bootId: rt.bootId, startedAt, container: rt.container }));
// --- Conjure itself: editions, provenance, skew. Switching is recorded here and performed by the supervisor. -----------
route("GET", "/api/self", ({ rt }) => selfView(rt.db, rt.bootId, startedAt, rt.container));
// A container (the desktop app) announces itself once per boot. In memory only: a container is an observation, not organizational truth.
route("POST", "/api/self/container", ({ rt, body }) => {
    const kind = String(body.kind ?? "").slice(0, 40);
    const version = String(body.version ?? "").slice(0, 40);
    if (!/^[a-z][a-z0-9-]*$/.test(kind) || !version)
        throw new HttpError(400, "container needs a kind and a version");
    rt.container = { kind, version, detail: [body.electron ? `electron ${String(body.electron).slice(0, 20)}` : "", body.node ? `node ${String(body.node).slice(0, 20)}` : ""].filter(Boolean).join(", "), pid: typeof body.pid === "number" ? body.pid : null, at: now() };
    return rt.container;
});
// What cognition WOULD be told for this obligation's next allocation. Inspectable context routing: the brief is a projection, not a secret.
route("GET", "/api/work/:id/brief", ({ rt, params, url }) => {
    const w = q.work(rt.db, params.id);
    if (!w)
        nf("work");
    const rev = activeRevision(rt.db);
    if (!rev)
        nf("organization");
    const roleParam = url.searchParams.get("role");
    const role = (roleParam === "reviewer" ? "reviewer" : roleParam === "planner" ? "planner" : roleParam === "manager" ? "manager" : "worker");
    const seat = rev.seats.find((s) => s.id === (role === "reviewer" ? rev.routing.reviewer : w.seat)) ?? rev.seats.find((s) => s.id === w.seat);
    if (!seat)
        nf("seat");
    return { workId: w.id, role, seat: seat.id, brief: renderBrief({ db: rt.db, rev, seat, work: w, role, attempts: q.attempts(rt.db, w.id) }), tools: grantsFor(rt.db, seat.tools).map((g) => ({ id: g.id, exe: g.exe, dir: g.dir })) };
});
// --- tools: real programs as capabilities. Located and probed cold; granted to seats by the operator; never briefed. ---------------
route("GET", "/api/tools", ({ rt }) => { const rev = activeRevision(rt.db); return toolTable.all(rt.db).map((t) => ({ ...t, grantedTo: (rev?.seats ?? []).filter((s) => (s.tools ?? []).includes(t.id)).map((s) => s.id) })); });
route("POST", "/api/tools", async ({ rt, body }) => { const t = registerTool(rt.db, { id: str(body.id), name: String(body.name ?? ""), kind: str(body.kind), command: String(body.command ?? ""), probeArgs: Array.isArray(body.probeArgs) ? body.probeArgs : undefined, note: str(body.note), usage: str(body.usage) }, OPERATOR); return probeTool(rt.db, t); });
route("POST", "/api/tools/probe", ({ rt }) => probeTools(rt.db));
route("POST", "/api/tools/:id", async ({ rt, params, body }) => { const t = updateTool(rt.db, params.id, { name: str(body.name), command: str(body.command), probeArgs: Array.isArray(body.probeArgs) ? body.probeArgs : undefined, note: str(body.note), usage: str(body.usage), status: str(body.status) }, OPERATOR); return body.command !== undefined || body.probeArgs !== undefined ? probeTool(rt.db, t) : t; });
route("POST", "/api/tools/:id/remove", ({ rt, params }) => { removeTool(rt.db, params.id); return { ok: true }; });
// --- experimental providers: tomorrow's toy today, bounded to windows until promoted --------------------------------------------------
route("GET", "/api/providers/experimental", () => readSpecs().map((s) => ({ ...s, file: specFile(s.name), boundary: boundaryOf(s) })));
route("POST", "/api/providers/experimental", async ({ rt, body }) => {
    const spec = body;
    const why = validateSpec(spec);
    if (why)
        throw new HttpError(400, why);
    if (rt.providers.has(spec.name) && !rt.providers.get(spec.name).capabilities.experimental)
        throw new HttpError(409, `'${spec.name}' is a built-in provider`);
    spec.promoted = false;
    const file = writeSpec(spec);
    rt.providers.set(spec.name, providerFromSpec(spec));
    append(rt.db, "provider", spec.name, "registered", { experimental: true, command: spec.command, file });
    await probeProviders(rt);
    requestReconcile(rt);
    return { name: spec.name, file, boundary: boundaryOf(spec), providers: statusView(rt.db, rt.bootId, startedAt, rt.container).providers };
});
route("POST", "/api/providers/:name/promote", ({ rt, params, body }) => setPromotion(rt, params.name, body.promoted !== false));
route("POST", "/api/providers/:name/discard", ({ rt, params }) => {
    const p = rt.providers.get(params.name);
    if (!p)
        nf("provider");
    if (!p.capabilities.experimental)
        throw new HttpError(409, "built-in providers cannot be discarded");
    const inUse = rt.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status='running' AND provider=?").get(params.name).n;
    if (inUse)
        throw new HttpError(409, `${inUse} attempt(s) are running on ${params.name}; stop them first`);
    rt.providers.delete(params.name);
    removeSpec(params.name);
    rt.db.prepare("DELETE FROM providers WHERE name=?").run(params.name);
    append(rt.db, "provider", params.name, "discarded", { experimental: true });
    return { ok: true };
});
function setPromotion(rt, name, promoted) {
    const p = rt.providers.get(name);
    if (!p)
        nf("provider");
    if (!p.capabilities.experimental)
        throw new HttpError(409, "built-in providers are always allocatable; nothing to promote");
    const spec = readSpecs().find((s) => s.name === name);
    if (!spec)
        nf("provider spec");
    spec.promoted = promoted;
    writeSpec(spec);
    rt.providers.set(name, providerFromSpec(spec));
    append(rt.db, "provider", name, promoted ? "promoted" : "demoted", { experimental: true });
    requestReconcile(rt);
    return { name, promoted, boundary: boundaryOf(spec) };
}
route("POST", "/api/self/editions/:id/switch", ({ rt, params }) => switchEdition(rt.db, params.id, OPERATOR));
route("POST", "/api/self/back", ({ rt }) => { const reg = readRegistry(); if (!reg.previous)
    throw new HttpError(409, "there is no previous edition to go back to"); return switchEdition(rt.db, reg.previous, OPERATOR); });
route("POST", "/api/self/editions/:id/accept", ({ rt, params }) => {
    const reg = acceptEdition(readRegistry(), params.id);
    writeRegistry(reg);
    const e = reg.editions.find((x) => x.id === params.id);
    append(rt.db, "edition", e.id, "accepted", { subject: e.build.subject, canonical: e.canonical });
    return selfView(rt.db, rt.bootId, startedAt);
});
route("POST", "/api/self/editions/:id/reject", ({ rt, params, body }) => {
    const reason = str(body.reason) ?? "operator";
    const reg = rejectEdition(readRegistry(), params.id, reason);
    writeRegistry(reg);
    append(rt.db, "edition", params.id, "rejected", { reason });
    return selfView(rt.db, rt.bootId, startedAt);
});
route("POST", "/api/control/synchronized", ({ rt, body }) => { setSetting(rt.db, "last_rendezvous_at", now()); if (body.markReturnsSeen !== false)
    markReturnsSeen(rt.db, "all"); return { lastRendezvousAt: getSetting(rt.db, "last_rendezvous_at") }; });
route("POST", "/api/returns/seen", ({ rt, body }) => { markReturnsSeen(rt.db, Array.isArray(body.ids) ? body.ids : "all"); return { ok: true }; });
// --- network ---------------------------------------------------------------------------------------------
route("GET", "/api/network", ({ rt }) => networkView(rt));
route("GET", "/api/network/trace/:kind/:id", ({ rt, params }) => traceView(rt.db, params.kind, params.id));
// --- homework: the operator's questions as one sheet; submitting ignites the machine ------------------------------
route("GET", "/api/homework", ({ rt }) => homeworkView(rt));
route("POST", "/api/homework/submit", ({ rt, body }) => {
    const answers = Array.isArray(body.answers) ? body.answers.filter((a) => a && typeof a.id === "string") : [];
    if (!answers.length)
        throw new HttpError(400, "no answers");
    const submission = submitHomework(rt.db, answers, OPERATOR);
    return { ...submission, homework: homeworkView(rt) };
});
// --- people and waits: real humans outside Conjure, and what is waiting on them -----------------------------------
route("GET", "/api/people", ({ rt }) => collab.people(rt.db).map((p) => ({ ...p, waiting: collab.waitsOn(rt.db, p.id).filter((w) => w.status === "waiting").length })));
route("POST", "/api/people", ({ rt, body }) => createPerson(rt.db, { name: String(body.name ?? ""), handle: str(body.handle), email: str(body.email), note: str(body.note) }));
route("GET", "/api/people/:id", ({ rt, params }) => { const p = collab.person(rt.db, params.id); if (!p)
    nf("person"); return { ...p, waits: collab.waitsOn(rt.db, p.id), meetings: collab.meetingsWith(rt.db, p.id) }; });
route("POST", "/api/people/:id", ({ rt, params, body }) => updatePerson(rt.db, params.id, { name: str(body.name), handle: str(body.handle), email: str(body.email), note: str(body.note) }));
route("POST", "/api/people/:id/delete", ({ rt, params }) => { deletePerson(rt.db, params.id); return { ok: true }; });
route("GET", "/api/waits", ({ rt, url }) => { const s = url.searchParams.get("status"); return collab.waits(rt.db, s === "waiting" || s === "returned" || s === "cancelled" ? s : undefined).map((w) => ({ ...w, person: collab.person(rt.db, w.personId)?.name ?? "?" })); });
route("GET", "/api/waits/kinds", () => WAIT_KINDS);
route("POST", "/api/waits", ({ rt, body }) => createWait(rt.db, { personId: str(body.personId), personName: str(body.personName), kind: str(body.kind), description: str(body.description), subjectType: str(body.subjectType) ?? null, subjectId: str(body.subjectId) ?? null, sourceKind: str(body.sourceKind), sourceRef: str(body.sourceRef) ?? null, dueAt: str(body.dueAt) ?? null }, OPERATOR));
route("POST", "/api/waits/:id/return", ({ rt, params, body }) => returnWait(rt.db, params.id, String(body.summary ?? ""), OPERATOR, str(body.sourceKind) ?? "operator", str(body.sourceRef) ?? null));
route("POST", "/api/waits/:id/cancel", ({ rt, params }) => cancelWait(rt.db, params.id, OPERATOR));
// --- meetings: the organizational layer around a meeting held elsewhere --------------------------------------------
route("GET", "/api/meetings", ({ rt }) => collab.meetings(rt.db).map((m) => ({ ...m, people: collab.meetingPeople(rt.db, m.id), proposal: m.conversationId ? agendaProposal(rt.db, m.id) : null })));
route("GET", "/api/meetings/suggest", ({ rt, url }) => suggestTimes(rt.db, Number(url.searchParams.get("duration") ?? 30), Number(url.searchParams.get("days") ?? 7), url.searchParams.get("from") ?? undefined));
route("POST", "/api/meetings", ({ rt, body }) => createMeeting(rt.db, { title: String(body.title ?? ""), purpose: str(body.purpose), startsAt: str(body.startsAt) ?? null, durationMin: Number(body.durationMin ?? 30), location: str(body.location), subjectType: str(body.subjectType) ?? null, subjectId: str(body.subjectId) ?? null, people: Array.isArray(body.people) ? body.people : [], personNames: Array.isArray(body.personNames) ? body.personNames : [] }));
route("GET", "/api/meetings/:id", ({ rt, params }) => {
    const m = collab.meeting(rt.db, params.id);
    if (!m)
        nf("meeting");
    const decisions = rt.db.prepare("SELECT id FROM judgments WHERE subject_type='meeting' AND subject_id=? ORDER BY created_at").all(m.id).map((r) => q.judgment(rt.db, r.id));
    const subject = m.subjectType === "work" && m.subjectId ? { kind: "work", id: m.subjectId, title: q.work(rt.db, m.subjectId)?.title ?? m.subjectId } : m.subjectType === "note" && m.subjectId ? { kind: "note", id: m.subjectId, title: ideas.note(rt.db, m.subjectId)?.title ?? m.subjectId } : null;
    return { ...m, people: collab.meetingPeople(rt.db, m.id), waits: collab.waitsFor(rt.db, "meeting", m.id).map((w) => ({ ...w, person: collab.person(rt.db, w.personId)?.name ?? "?" })), proposal: agendaProposal(rt.db, m.id), decisions, subject };
});
route("POST", "/api/meetings/:id", ({ rt, params, body }) => updateMeeting(rt.db, params.id, { title: str(body.title), purpose: str(body.purpose), startsAt: body.startsAt === null ? null : str(body.startsAt), durationMin: body.durationMin === undefined ? undefined : Number(body.durationMin), location: str(body.location), agenda: str(body.agenda), outcome: str(body.outcome), candidates: Array.isArray(body.candidates) ? body.candidates : undefined }));
route("POST", "/api/meetings/:id/status", ({ rt, params, body }) => setMeetingStatus(rt.db, params.id, String(body.status)));
route("POST", "/api/meetings/:id/people", ({ rt, params, body }) => addMeetingPerson(rt.db, params.id, str(body.personId), str(body.personName)));
route("POST", "/api/meetings/:id/people/:pid/remove", ({ rt, params }) => removeMeetingPerson(rt.db, params.id, params.pid));
route("POST", "/api/meetings/:id/prepare", ({ rt, params, body }) => {
    const c = prepareMeeting(rt, params.id, { provider: str(body.provider), model: str(body.model) });
    // Asking for preparation is an explicit ask: one turn answers first, so the operator is not left typing into silence.
    if (ideas.turns(rt.db, c.id).length === 0)
        void speak(rt, c.id, "Help me prepare. What genuinely needs the other humans in the room, and what should I bring?").catch(() => { });
    return c;
});
route("POST", "/api/meetings/:id/agenda/apply", ({ rt, params }) => applyAgenda(rt.db, params.id));
route("POST", "/api/meetings/:id/decision", ({ rt, params, body }) => recordMeetingDecision(rt.db, params.id, String(body.question ?? ""), String(body.decision ?? ""), OPERATOR));
route("GET", "/api/meetings/:id/ics", ({ rt, params }) => new Raw("text/calendar; charset=utf-8", meetingIcs(rt.db, params.id), `conjure-meeting-${params.id}.ics`));
// --- idea room: windows ----------------------------------------------------------------------------------
route("GET", "/api/conversations", ({ rt }) => ideas.list(rt.db));
route("POST", "/api/conversations", ({ rt, body }) => createConversation(rt, { title: str(body.title), role: str(body.role), provider: str(body.provider), model: str(body.model), effort: body.effort === null ? null : str(body.effort), parentId: str(body.parentId) ?? null }));
route("GET", "/api/conversations/:id", ({ rt, params }) => { const c = ideas.get(rt.db, params.id); if (!c)
    nf("conversation"); return { ...c, turns: ideas.turns(rt.db, params.id), context: contextOf(rt.db, c.id), proposal: c.role === "workflow" ? workflowProposal(rt.db, c.id) : c.role === "directive" && c.directiveId ? directiveProposal(rt.db, c.directiveId) : c.role === "meeting" && c.meetingId ? agendaProposal(rt.db, c.meetingId) : null }; });
route("POST", "/api/conversations/:id", ({ rt, params, body }) => updateConversation(rt, params.id, { title: str(body.title), provider: str(body.provider), model: str(body.model), effort: body.effort === null ? null : str(body.effort), archived: typeof body.archived === "boolean" ? body.archived : undefined }));
route("POST", "/api/conversations/:id/exposure", ({ rt, params, body }) => setExposure(rt.db, params.id, Array.isArray(body.dirs) ? body.dirs : []));
route("POST", "/api/conversations/:id/speak", ({ rt, res, params, body }) => {
    // Body parsing has finished under the general protocol limits. Allow the ten-minute
    // provider budget plus one minute for probing/settlement before this response goes idle.
    res.setTimeout(11 * 60_000);
    return speak(rt, params.id, String(body.content ?? ""));
});
// context boundary: visibility for one window, nothing more
route("GET", "/api/conversations/:id/context", ({ rt, params }) => contextOf(rt.db, params.id));
route("POST", "/api/conversations/:id/context", ({ rt, params, body }) => connectNote(rt.db, params.id, String(body.noteId ?? "")));
route("POST", "/api/conversations/:id/context/:noteId/disconnect", ({ rt, params }) => disconnectNote(rt.db, params.id, params.noteId));
// --- idea room: notes and folders (durable terrain) ------------------------------------------------------
route("GET", "/api/notes", ({ rt }) => ({ folders: ideas.folders(rt.db), notes: ideas.notes(rt.db).map((n) => ({ ...n, body: undefined, bodyChars: n.body.length })) }));
route("GET", "/api/notes/:id", ({ rt, params }) => ideas.note(rt.db, params.id) ?? nf("note"));
route("POST", "/api/notes", ({ rt, body }) => createNote(rt.db, { title: str(body.title), body: str(body.body), folderId: str(body.folderId) ?? null, conversationId: str(body.conversationId) ?? null }));
route("POST", "/api/notes/:id", ({ rt, params, body }) => updateNote(rt.db, params.id, { title: str(body.title), body: str(body.body), folderId: body.folderId === null ? null : str(body.folderId) }));
route("POST", "/api/notes/:id/delete", ({ rt, params }) => { deleteNote(rt.db, params.id); return { ok: true }; });
route("POST", "/api/notes/:id/share", ({ rt, params, body }) => shareNote(rt.db, params.id, body.shared !== false));
route("GET", "/api/notes/:id/contract", ({ rt, params, url }) => contractPreview(rt.db, params.id, url.searchParams.get("seat") ?? undefined));
route("POST", "/api/notes/:id/hand-to-conjure", ({ rt, params, body }) => handNoteToConjure(rt.db, params.id, str(body.seat), OPERATOR, str(body.expectedFingerprint)));
route("POST", "/api/folders", ({ rt, body }) => createFolder(rt.db, String(body.name ?? "Folder"), str(body.parentId) ?? null));
route("POST", "/api/folders/:id", ({ rt, params, body }) => updateFolder(rt.db, params.id, { name: str(body.name), parentId: body.parentId === null ? null : str(body.parentId) }));
route("POST", "/api/folders/:id/delete", ({ rt, params }) => { deleteFolder(rt.db, params.id); return { ok: true }; });
// --- idea room: seeds -----------------------------------------------------------------------------------------
route("GET", "/api/seeds", ({ rt }) => ideas.seeds(rt.db));
route("POST", "/api/seeds", ({ rt, body }) => createSeed(rt.db, String(body.text ?? ""), str(body.conversationId) ?? null));
route("POST", "/api/seeds/:id/status", ({ rt, params, body }) => setSeedStatus(rt.db, params.id, String(body.status)));
route("POST", "/api/seeds/:id/to-window", ({ rt, params }) => seedToWindow(rt, params.id));
function nf(what) { throw new HttpError(404, `no such ${what}`); }
function readLog(name) { try {
    return fs.readFileSync(paths.log(name), "utf8").slice(-20000);
}
catch {
    return "";
} }
let startedAt = now();
export function setStartedAt(t) { startedAt = t; }
export async function handle(rt, req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/"))
        return false;
    if (url.pathname === "/api/stream" && req.method === "GET") {
        sse(req, res);
        return true;
    }
    const t0 = process.hrtime.bigint();
    const method = req.method ?? "GET";
    for (const r of routes) {
        if (r.method !== method)
            continue;
        const m = r.pattern.exec(url.pathname);
        if (!m)
            continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        try {
            let body = {};
            if (method === "POST") {
                const raw = await readBody(req);
                if (raw) {
                    try {
                        body = JSON.parse(raw);
                    }
                    catch {
                        json(res, 400, { error: "invalid JSON body" });
                        return true;
                    }
                }
            }
            const out = await r.handler({ rt, req, res, url, params, body });
            if (method === "POST")
                requestReconcile(rt);
            if (out instanceof Raw) {
                res.writeHead(200, { "content-type": out.contentType, "content-length": Buffer.byteLength(out.body), "cache-control": "no-store", ...(out.filename ? { "content-disposition": `attachment; filename="${out.filename}"` } : {}) });
                res.end(out.body);
                return true;
            }
            json(res, 200, out ?? { ok: true }, t0);
        }
        catch (e) {
            const status = e instanceof HttpError ? e.status : 400;
            json(res, status, { error: e.message }, t0);
        }
        return true;
    }
    json(res, 404, { error: `no route ${method} ${url.pathname}` }, t0);
    return true;
}
function json(res, status, data, t0) {
    const payload = JSON.stringify(data);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...(t0 ? { "server-timing": `app;dur=${Number(process.hrtime.bigint() - t0) / 1e6}` } : {}) });
    res.end(payload);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers["content-length"] ?? 0);
        if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
            req.resume();
            reject(new HttpError(413, "request body too large"));
            return;
        }
        const chunks = [];
        let bytes = 0;
        let rejected = false;
        req.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > BODY_LIMIT_BYTES && !rejected) {
                rejected = true;
                req.resume();
                reject(new HttpError(413, "request body too large"));
                return;
            }
            if (!rejected)
                chunks.push(chunk);
        });
        req.on("end", () => { if (!rejected)
            resolve(Buffer.concat(chunks).toString("utf8")); });
        req.on("error", reject);
    });
}
function sse(req, res) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`event: hello\ndata: ${JSON.stringify({ at: now() })}\n\n`);
    const onEvent = (ev) => { res.write(`event: change\ndata: ${JSON.stringify(ev)}\n\n`); };
    bus.on("event", onEvent);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => { bus.off("event", onEvent); clearInterval(ping); });
}
//# sourceMappingURL=api.js.map