// Idea Room and its neighbors. Six things that must not collapse into one:
//   window/conversation (temporary operator thinking surface) · note (durable operator document) · seed (latent
//   possibility) · black box route (deliberate handoff toward Conjure) · directive (operator intent) · work (accepted).
// Conversations are private and repo-blind by default; that is enforced by the provider call, not by prose.
import fs from "node:fs";
import path from "node:path";
import { id, now, fingerprint } from "./ids.js";
import { append } from "./events.js";
import { paths } from "./home.js";
import { providerAvailable, probeProviders } from "./reconcile.js";
import { commission, q } from "./work.js";
import { activeRevision, workflowOf } from "./org.js";
import { controlBriefing } from "./projections.js";
import { collab, meetingContext } from "./collab.js";
const C = (r) => ({
    id: r.id, title: r.title, role: r.role, provider: r.provider, model: r.model,
    effort: r.effort ?? null, parentId: r.parent_id ?? null, directiveId: r.directive_id ?? null,
    meetingId: r.meeting_id ?? null,
    exposure: JSON.parse(r.exposure), providerSession: r.provider_session ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at ?? null,
});
const T = (r) => ({ id: r.id, conversationId: r.conversation_id, role: r.role, content: r.content, at: r.at, costUsd: r.cost_usd ?? null, status: r.status, error: r.error ?? null });
const N = (r) => ({ id: r.id, folderId: r.folder_id ?? null, conversationId: r.conversation_id ?? null, title: r.title, body: r.body, sharedAt: r.shared_at ?? null, servedWorkId: r.served_work_id ?? null, servedAt: r.served_at ?? null, createdAt: r.created_at, updatedAt: r.updated_at });
const F = (r) => ({ id: r.id, parentId: r.parent_id ?? null, name: r.name, createdAt: r.created_at });
const S = (r) => ({ id: r.id, text: r.text, sourceConversationId: r.source_conversation_id ?? null, status: r.status, createdAt: r.created_at, usedAt: r.used_at ?? null });
const D = (r) => ({ id: r.id, text: r.text, conversationId: r.conversation_id ?? null, status: r.status, workId: r.work_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at });
export const ideas = {
    list: (db) => db.prepare("SELECT * FROM conversations WHERE archived_at IS NULL ORDER BY created_at ASC").all().map(C),
    get: (db, cid) => { const r = db.prepare("SELECT * FROM conversations WHERE id=?").get(cid); return r ? C(r) : null; },
    turns: (db, cid) => db.prepare("SELECT * FROM turns WHERE conversation_id=? ORDER BY at ASC").all(cid).map(T),
    note: (db, nid) => { const r = db.prepare("SELECT * FROM notes WHERE id=?").get(nid); return r ? N(r) : null; },
    notes: (db) => db.prepare("SELECT * FROM notes ORDER BY updated_at DESC").all().map(N),
    folders: (db) => db.prepare("SELECT * FROM folders ORDER BY name").all().map(F),
    seeds: (db) => db.prepare("SELECT * FROM seeds WHERE status='open' ORDER BY created_at DESC").all().map(S),
    directive: (db, did) => { const r = db.prepare("SELECT * FROM directives WHERE id=?").get(did); return r ? D(r) : null; },
    directives: (db) => db.prepare("SELECT * FROM directives ORDER BY created_at DESC").all().map(D),
};
export function contextOf(db, cid) {
    return db.prepare("SELECT c.note_id, n.title, c.connected_at, length(n.body) AS chars FROM conversation_context c JOIN notes n ON n.id = c.note_id WHERE c.conversation_id=? ORDER BY c.connected_at").all(cid)
        .map((r) => ({ noteId: r.note_id, title: r.title, connectedAt: r.connected_at, bodyChars: r.chars }));
}
/** "Help me work on this." The note stays where it is and whose it is; this window may now read it. */
export function connectNote(db, cid, nid) {
    const c = ideas.get(db, cid);
    if (!c)
        throw new Error("no such conversation");
    if (c.role === "control")
        throw new Error("Control does not take private context; hand a note to Conjure deliberately instead");
    if (!ideas.note(db, nid))
        throw new Error("no such note");
    db.prepare("INSERT OR IGNORE INTO conversation_context(conversation_id,note_id,connected_at) VALUES(?,?,?)").run(cid, nid, now());
    append(db, "conversation", cid, "context-connected", { noteId: nid });
    return contextOf(db, cid);
}
export function disconnectNote(db, cid, nid) {
    db.prepare("DELETE FROM conversation_context WHERE conversation_id=? AND note_id=?").run(cid, nid);
    append(db, "conversation", cid, "context-disconnected", { noteId: nid });
    return contextOf(db, cid);
}
// --- windows / conversations ----------------------------------------------------------------------
export function defaultProcessor(rt) {
    const order = ["claude", "codex", "fake"];
    for (const name of order) {
        const p = rt.providers.get(name);
        if (p && providerAvailable(rt, name))
            return { provider: name, model: p.capabilities.defaultModel, effort: p.capabilities.defaultEffort };
    }
    const first = [...rt.providers.values()][0];
    return first ? { provider: first.name, model: first.capabilities.defaultModel, effort: first.capabilities.defaultEffort } : { provider: "claude", model: "sonnet", effort: null };
}
/** A blank window. Cold software; no provider is touched. */
export function createConversation(rt, input) {
    const { db } = rt;
    const cid = id("c");
    const t = now();
    const role = input.role ?? "idea";
    if (role === "control" || role === "partner") {
        const existing = db.prepare("SELECT id FROM conversations WHERE role=? AND archived_at IS NULL").get(role);
        if (existing)
            return ideas.get(db, existing.id);
    }
    const def = defaultProcessor(rt);
    const provider = input.provider ?? def.provider;
    const caps = rt.providers.get(provider)?.capabilities;
    const model = input.model ?? (caps?.defaultModel ?? def.model);
    const effort = input.effort !== undefined ? input.effort : (caps?.defaultEffort ?? null);
    const title = input.title ?? (role === "control" ? "Control" : role === "partner" ? "Partner" : role === "directive" ? "Directive" : role === "workflow" ? "Workflow" : role === "meeting" ? "Meeting preparation" : "");
    db.prepare("INSERT INTO conversations(id,title,role,provider,model,effort,parent_id,directive_id,meeting_id,exposure,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'[]',?,?)")
        .run(cid, title.slice(0, 120), role, provider, model, effort, input.parentId ?? null, input.directiveId ?? null, input.meetingId ?? null, t, t);
    return ideas.get(db, cid);
}
export function updateConversation(rt, cid, patch) {
    const { db } = rt;
    const c = ideas.get(db, cid);
    if (!c)
        throw new Error("no such conversation");
    const provider = patch.provider ?? c.provider;
    const caps = rt.providers.get(provider)?.capabilities;
    if (patch.provider && !caps)
        throw new Error(`unknown provider '${patch.provider}'`);
    const providerChanged = provider !== c.provider;
    const model = patch.model ?? (providerChanged ? caps.defaultModel : c.model);
    let effort = patch.effort !== undefined ? patch.effort : (providerChanged ? caps.defaultEffort : c.effort);
    if (caps && effort && !caps.efforts.includes(effort))
        effort = caps.defaultEffort;
    db.prepare("UPDATE conversations SET title=?, provider=?, model=?, effort=?, provider_session=?, archived_at=?, updated_at=? WHERE id=?")
        .run(patch.title ?? c.title, provider, model, effort, providerChanged ? null : c.providerSession, patch.archived ? now() : (patch.archived === false ? null : c.archivedAt), now(), cid);
    return ideas.get(db, cid);
}
/** EXPOSE (advanced): make a directory visible read-only to this conversation's cognition. Revocable. Not sharing. */
export function setExposure(db, cid, dirs) {
    const c = ideas.get(db, cid);
    if (!c)
        throw new Error("no such conversation");
    const clean = dirs.map((d) => path.resolve(d)).filter((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
    db.prepare("UPDATE conversations SET exposure=?, updated_at=? WHERE id=?").run(JSON.stringify(clean), now(), cid);
    append(db, "conversation", cid, "exposure", { dirs: clean });
    return ideas.get(db, cid);
}
/** The operator speaks; cognition is allocated for one turn. The provider process is temporary; the turn is durable. */
export async function speak(rt, cid, content) {
    const { db } = rt;
    const c = ideas.get(db, cid);
    if (!c)
        throw new Error("no such conversation");
    if (!content.trim())
        throw new Error("empty prompt");
    const provider = rt.providers.get(c.provider);
    if (!rt.probed)
        await probeProviders(rt);
    const t = now();
    const opTurnId = id("t");
    db.prepare("INSERT INTO turns(id,conversation_id,role,content,at,status) VALUES(?,?,?,?,?,'done')").run(opTurnId, cid, "operator", content, t);
    if (!c.title)
        db.prepare("UPDATE conversations SET title=? WHERE id=?").run(content.trim().replace(/\s+/g, " ").slice(0, 60), cid);
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(t, cid);
    const tid = id("t");
    db.prepare("INSERT INTO turns(id,conversation_id,role,content,at,status) VALUES(?,?,?,?,?,'running')").run(tid, cid, "model", "", now());
    append(db, "conversation", cid, "turn", { turnId: tid });
    if (!provider || !providerAvailable(rt, c.provider)) {
        db.prepare("UPDATE turns SET status='failed', error=?, content='' WHERE id=?").run(`provider '${c.provider}' is not available right now`, tid);
        append(db, "conversation", cid, "turn-failed", { turnId: tid });
        return T(db.prepare("SELECT * FROM turns WHERE id=?").get(tid));
    }
    const cwd = paths.privateDir(cid);
    fs.mkdirSync(cwd, { recursive: true });
    const prior = ideas.turns(db, cid).filter((x) => x.id !== tid && x.id !== opTurnId && x.status === "done");
    const prompt = renderConversationPrompt(rt, c, prior, content);
    const handle = provider.run({ prompt, cwd, model: c.model, effort: c.effort, resume: null, allowWrites: false, exposeDirs: c.exposure, timeoutMs: 10 * 60_000 });
    if (handle.pid)
        db.prepare("INSERT OR REPLACE INTO processes(pid,kind,owner_id,started_at,last_seen,gateway_boot) VALUES(?,?,?,?,?,?)").run(handle.pid, "turn", tid, t, t, rt.bootId);
    const res = await handle.done;
    if (handle.pid)
        db.prepare("DELETE FROM processes WHERE pid=?").run(handle.pid);
    if (res.status === "succeeded") {
        db.prepare("UPDATE turns SET status='done', content=?, cost_usd=? WHERE id=?").run(res.text, res.costUsd, tid);
        db.prepare("UPDATE conversations SET provider_session=?, updated_at=? WHERE id=?").run(res.providerSession, now(), cid);
    }
    else {
        db.prepare("UPDATE turns SET status='failed', error=?, content=? WHERE id=?").run(res.error, res.text, tid);
        db.prepare("UPDATE conversations SET provider_session=NULL WHERE id=?").run(cid);
    }
    append(db, "conversation", cid, res.status === "succeeded" ? "turn-done" : "turn-failed", { turnId: tid, costUsd: res.costUsd });
    return T(db.prepare("SELECT * FROM turns WHERE id=?").get(tid));
}
function renderConversationPrompt(rt, c, prior, content) {
    const parts = [];
    const { db } = rt;
    switch (c.role) {
        case "control":
            {
                const briefing = controlBriefing(db, { bootId: rt.bootId, startedAt: "" });
                const { self, ...company } = briefing;
                parts.push("You are the Control seat of Conjure, the operator's rendezvous with their organization of AI workers. You have company awareness (below) and may recommend, but you change nothing yourself: every organizational change is an explicit operator action in the product. Be concise and truthful; say UNKNOWN where the briefing says unknown.", "", "CURRENT COMPANY BRIEFING (cold, generated by software, authoritative as of now):", JSON.stringify(company, null, 1).slice(0, 12000), "");
                parts.push("CONJURE ITSELF (cold facts about the product the operator is using right now; authoritative, generated by software):", ...self.lines, "", "Rule for questions about Conjure itself (\"do we have X\", \"did that land\", \"am I running the new version\", \"why can't I find Y\"): answer ONLY from the facts above, never from memory, documents or this conversation. Keep these states apart and name the one that applies: RUNNING NOW (in the capability list) / READY TO EVALUATE (in an edition that is not running) / IN SOURCE ONLY (commits past this build, not built) / NOT PRESENT HERE. If a capability is absent from the running list, say plainly that the Conjure they are using does not have it. When an edition adds what they are looking for, say so and name the operator's next action (switch from the \"Conjure itself\" panel in Command Control; go back is available); the action is theirs, not yours.", "");
            }
            break;
        case "partner":
            parts.push("You are the operator's private thinking partner. You have no knowledge of, or authority over, their organization; nothing you say is transmitted anywhere. Help them think, challenge, and prepare.", "");
            break;
        case "directive": {
            const d = c.directiveId ? ideas.directive(db, c.directiveId) : null;
            const rev = activeRevision(db);
            parts.push("You are Conjure's intake: the operator is telling their company to do something. Your job is to understand what they mean well enough for Conjure to accept responsibility. Ask only the questions that change what would be built; do not demand a specification. You cannot see any repository and you commission nothing yourself.", "", `THE ORDER, as the operator wrote it: ${d?.text ?? "(missing)"}`, "", `SEATS THAT CAN CARRY WORK: ${(rev?.seats ?? []).map((s) => `${s.id} (${s.role}: ${s.charter.slice(0, 100)})`).join("; ")}. Default intake: ${rev?.routing.intake ?? "?"}.`, "", "Whenever your understanding is good enough to act on, end your message with exactly one fenced block tagged `contract` containing JSON: {\"title\":\"...\",\"brief\":\"what to do, self-contained\",\"acceptance\":\"what done means, checkable\",\"seat\":\"one of the seat ids\"}. Update it in later messages as understanding improves. The operator, not you, decides when Conjure accepts it.", "");
            break;
        }
        case "workflow": {
            const rev = activeRevision(db);
            parts.push("You help the operator define how their organization of AI workers should work, as a small graph. Node kinds: start, seat (a seat step; must name an existing seat id), review (a reviewer seat step), judgment (a human gate), return. Edge 'when': next | pass | fail. Only the shape start -> seat -> review -> return (fail loops to seat) executes today; other shapes are recorded as intent. Keep graphs small and truthful.", "", `SEATS: ${(rev?.seats ?? []).map((s) => `${s.id} (${s.role}, ${s.name})`).join("; ")}`, `CURRENT WORKFLOW: ${JSON.stringify(rev ? workflowOf(rev) : null)}`, "", "When you propose a change, end your message with exactly one fenced block tagged `workflow` containing the full JSON {\"nodes\":[...],\"edges\":[...]} including x/y positions. The operator applies it; you do not.", "");
            break;
        }
        case "meeting": {
            const m = c.meetingId ? collab.meeting(db, c.meetingId) : null;
            parts.push("You help the operator prepare a meeting with real people outside Conjure. You do not attend, schedule, or message anyone; Conjure is not the meeting. Your job is to make the operator's time in the room count: what genuinely needs the other humans, what to bring, and what would move the linked work. Be short.", "", m ? meetingContext(db, m) : "(meeting missing)", "", "When you have a proposal, end your message with exactly one fenced block tagged `agenda` containing JSON: {\"questions\":[\"...\"],\"context\":\"one paragraph on why this meeting matters\",\"bring\":[\"...\"]}. The operator applies it; you do not.", "");
            break;
        }
        default:
            parts.push("You are a private thinking partner in the operator's Idea Room. Nothing here is shared with anyone or commissions any work unless the operator explicitly does so elsewhere. If asked to produce something reusable, write it clearly so it can be saved as a note as-is.", "");
    }
    // Connected context is assembled by cold software from the durable relation, on every turn, so a replaced provider
    // session (or provider) sees exactly what the operator connected, and nothing the operator did not.
    const ctx = c.role === "control" ? [] : contextOf(db, c.id);
    if (ctx.length) {
        parts.push("CONNECTED CONTEXT: the operator connected these notes to this window so you can read and consider them. They remain the operator's documents; propose edits in your reply rather than assuming you changed anything.");
        for (const ref of ctx) {
            const n = ideas.note(db, ref.noteId);
            if (!n)
                continue;
            parts.push(`--- note: ${n.title} ---`, n.body.slice(0, 40000), `--- end of note: ${n.title} ---`);
        }
        parts.push("");
    }
    // Durable bounded history is the authority. CLI-specific resume behaviour must not silently lose context.
    if (prior.length) {
        parts.push("EARLIER IN THIS CONVERSATION:");
        for (const t of prior.slice(-20))
            parts.push(`${t.role === "operator" ? "Operator" : "You"}: ${t.content.slice(0, 4000)}`);
        parts.push("");
    }
    parts.push(content);
    return parts.join("\n");
}
/** Last fenced block of a given tag in the newest model turn, parsed as JSON. Cold software reads proposals this way. */
export function lastProposal(db, cid, tag) {
    const last = [...ideas.turns(db, cid)].reverse().find((t) => t.role === "model" && t.status === "done");
    if (!last)
        return null;
    const re = new RegExp("```" + tag + "\\s*\\n([\\s\\S]*?)\\n```", "g");
    let raw = null;
    for (const m of last.content.matchAll(re))
        raw = m[1] ?? null;
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
// --- notes and folders: durable terrain ---------------------------------------------------------------
export function createFolder(db, name, parentId) {
    const fid = id("f");
    db.prepare("INSERT INTO folders(id,parent_id,name,created_at) VALUES(?,?,?,?)").run(fid, parentId, name.trim().slice(0, 80) || "Folder", now());
    append(db, "folder", fid, "created", {});
    return F(db.prepare("SELECT * FROM folders WHERE id=?").get(fid));
}
export function updateFolder(db, fid, patch) {
    const f = db.prepare("SELECT * FROM folders WHERE id=?").get(fid);
    if (!f)
        throw new Error("no such folder");
    const parent = patch.parentId === undefined ? f.parent_id : patch.parentId;
    if (parent === fid)
        throw new Error("a folder cannot contain itself");
    db.prepare("UPDATE folders SET name=?, parent_id=? WHERE id=?").run(patch.name ?? f.name, parent, fid);
    return F(db.prepare("SELECT * FROM folders WHERE id=?").get(fid));
}
export function deleteFolder(db, fid) {
    db.transaction(() => {
        const f = db.prepare("SELECT parent_id FROM folders WHERE id=?").get(fid);
        if (!f)
            return;
        db.prepare("UPDATE notes SET folder_id=? WHERE folder_id=?").run(f.parent_id, fid);
        db.prepare("UPDATE folders SET parent_id=? WHERE parent_id=?").run(f.parent_id, fid);
        db.prepare("DELETE FROM folders WHERE id=?").run(fid);
    })();
}
export function createNote(db, input) {
    const nid = id("n");
    const t = now();
    db.prepare("INSERT INTO notes(id,conversation_id,folder_id,title,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(nid, input.conversationId ?? null, input.folderId ?? null, (input.title ?? "Untitled").trim().slice(0, 200) || "Untitled", input.body ?? "", t, t);
    append(db, "note", nid, "created", { title: input.title ?? "Untitled" });
    return ideas.note(db, nid);
}
export function updateNote(db, nid, patch) {
    const n = ideas.note(db, nid);
    if (!n)
        throw new Error("no such note");
    if (n.servedWorkId && (patch.title !== undefined || patch.body !== undefined))
        throw new Error("this note has been handed to Conjure and is read-only");
    db.prepare("UPDATE notes SET title=?, body=?, folder_id=?, updated_at=? WHERE id=?").run(patch.title ?? n.title, patch.body ?? n.body, patch.folderId === undefined ? n.folderId : patch.folderId, now(), nid);
    return ideas.note(db, nid);
}
export function deleteNote(db, nid) {
    const n = ideas.note(db, nid);
    if (!n)
        return;
    if (n.servedWorkId)
        throw new Error("this note has been handed to Conjure; cancel the work first");
    db.prepare("DELETE FROM notes WHERE id=?").run(nid);
}
/** SHARE: organizationally available. Still not commissioning. */
export function shareNote(db, nid, shared) {
    const n = ideas.note(db, nid);
    if (!n)
        throw new Error("no such note");
    db.prepare("UPDATE notes SET shared_at=?, updated_at=? WHERE id=?").run(shared ? now() : null, now(), nid);
    append(db, "note", nid, shared ? "shared" : "unshared", {});
    return ideas.note(db, nid);
}
export function contractPreview(db, nid, seatId) {
    const n = ideas.note(db, nid);
    if (!n)
        throw new Error("no such note");
    const rev = activeRevision(db);
    if (!rev)
        throw new Error("no active organization");
    const seat = rev.seats.find((s) => s.id === (seatId ?? rev.routing.intake)) ?? rev.seats[0];
    return {
        noteId: nid, fingerprint: fingerprint(n.id, n.title, n.body, seat, rev.id), title: n.title, seat: seat.id, seatName: seat.name,
        acceptance: "The note has been acted on: a usable result, or a genuine decision the operator must make, has returned on this work.",
        briefIsFullNote: true,
        conjureMaySee: [`the note "${n.title}" in full`, ...(seat.workspaceRoot ? [`the workspace ${seat.workspaceRoot}`] : [])],
        conjureMayChange: seat.role === "worker" && seat.workspaceRoot ? `files inside ${seat.workspaceRoot} (on a per-work git branch when it is a repository)` : "nothing on disk; it returns text and evidence only",
        evidenceRelationship: "the work records this note as its source; the note records the work it became; evidence attaches to the work",
        residualJudgment: "anything the worker returns as a judgment, review ceilings, and repeated processor failure come back to you as judgments; a usable result comes back quietly",
        absentTerms: ["deadline", "budget", "operator-authored scope narrowing"],
        alreadyServed: n.servedWorkId && n.servedAt ? { workId: n.servedWorkId, servedAt: n.servedAt } : null,
    };
}
/** COMMISSION a note: the explicit transfer of responsibility. Idempotent per note. */
export function handNoteToConjure(db, nid, seatId, by, expectedFingerprint) {
    const n = ideas.note(db, nid);
    if (!n)
        throw new Error("no such note");
    if (n.servedWorkId)
        return q.work(db, n.servedWorkId);
    const p = contractPreview(db, nid, seatId);
    if (expectedFingerprint && p.fingerprint !== expectedFingerprint)
        throw new Error("The note or responsibility changed. Review its contract again before commissioning.");
    return db.transaction(() => {
        const w = commission(db, { title: n.title, brief: n.body, acceptance: p.acceptance, seat: p.seat, sourceKind: "note", sourceRef: nid }, by);
        db.prepare("UPDATE notes SET served_work_id=?, served_at=?, updated_at=? WHERE id=?").run(w.id, now(), now(), nid);
        db.prepare("INSERT INTO evidence(id,work_id,attempt_id,kind,locator,summary,created_at) VALUES(?,?,NULL,'note',?,?,?)").run(id("ev"), w.id, nid, `source note: ${n.title}`, now());
        append(db, "note", nid, "handed-to-conjure", { workId: w.id, by });
        return w;
    })();
}
// --- seeds: latent possibilities -------------------------------------------------------------------------
export function createSeed(db, text, sourceConversationId) {
    const sid = id("s");
    db.prepare("INSERT INTO seeds(id,text,source_conversation_id,status,created_at) VALUES(?,?,?,'open',?)").run(sid, text.trim().slice(0, 4000), sourceConversationId, now());
    return S(db.prepare("SELECT * FROM seeds WHERE id=?").get(sid));
}
export function setSeedStatus(db, sid, status) {
    db.prepare("UPDATE seeds SET status=?, used_at=? WHERE id=?").run(status, status === "open" ? null : now(), sid);
    const r = db.prepare("SELECT * FROM seeds WHERE id=?").get(sid);
    if (!r)
        throw new Error("no such seed");
    return S(r);
}
/** Route a seed into a fresh window: the seed text becomes the window's first prompt draft (no cognition yet). */
export function seedToWindow(rt, sid) {
    const r = rt.db.prepare("SELECT * FROM seeds WHERE id=?").get(sid);
    if (!r)
        throw new Error("no such seed");
    const seed = S(r);
    const conversation = createConversation(rt, { title: seed.text.replace(/\s+/g, " ").slice(0, 60) });
    setSeedStatus(rt.db, sid, "used");
    return { conversation, draft: seed.text };
}
// --- directives: operator intent -> clarification -> accepted work -------------------------------------
export function createDirective(rt, text, processor) {
    const { db } = rt;
    if (!text.trim())
        throw new Error("say what you want done");
    const did = id("d");
    const t = now();
    db.prepare("INSERT INTO directives(id,text,status,created_at,updated_at) VALUES(?,?,'open',?,?)").run(did, text.trim(), t, t);
    const conversation = createConversation(rt, { role: "directive", title: text.trim().replace(/\s+/g, " ").slice(0, 60), directiveId: did, ...processor });
    db.prepare("UPDATE directives SET conversation_id=? WHERE id=?").run(conversation.id, did);
    append(db, "directive", did, "given", { text: text.trim().slice(0, 200) });
    return { directive: ideas.directive(db, did), conversation };
}
export function directiveProposal(db, did) {
    const d = ideas.directive(db, did);
    if (!d?.conversationId)
        return null;
    const p = lastProposal(db, d.conversationId, "contract");
    if (!p || typeof p.title !== "string" || typeof p.brief !== "string")
        return null;
    return { title: p.title, brief: p.brief, acceptance: typeof p.acceptance === "string" && p.acceptance ? p.acceptance : "Done when the brief is satisfied and evidence is attached.", seat: typeof p.seat === "string" ? p.seat : undefined };
}
/** Conjure accepts responsibility: durable Work begins here, and only here, for a directive. */
export function acceptDirective(db, did, terms, by) {
    const d = ideas.directive(db, did);
    if (!d)
        throw new Error("no such directive");
    if (d.workId)
        return q.work(db, d.workId);
    const proposal = directiveProposal(db, did);
    const rev = activeRevision(db);
    const seat = terms.seat ?? proposal?.seat;
    const merged = {
        title: terms.title ?? proposal?.title ?? d.text.replace(/\s+/g, " ").slice(0, 120),
        brief: terms.brief ?? proposal?.brief ?? d.text,
        acceptance: terms.acceptance ?? proposal?.acceptance ?? "Done when the brief is satisfied and evidence is attached.",
        seat: seat && rev?.seats.some((s) => s.id === seat) ? seat : undefined,
    };
    return db.transaction(() => {
        const w = commission(db, { title: merged.title, brief: merged.brief, acceptance: merged.acceptance, seat: merged.seat, sourceKind: "directive", sourceRef: did }, by);
        db.prepare("UPDATE directives SET status='accepted', work_id=?, updated_at=? WHERE id=?").run(w.id, now(), did);
        append(db, "directive", did, "accepted", { workId: w.id, by });
        return w;
    })();
}
export function dismissDirective(db, did) {
    db.prepare("UPDATE directives SET status='dismissed', updated_at=? WHERE id=? AND status='open'").run(now(), did);
    return ideas.directive(db, did);
}
/** Workflow proposal from an AI-assisted workflow conversation. */
export function workflowProposal(db, cid) {
    const p = lastProposal(db, cid, "workflow");
    if (!p || !Array.isArray(p.nodes) || !Array.isArray(p.edges))
        return null;
    return { nodes: p.nodes, edges: p.edges };
}
//# sourceMappingURL=ideas.js.map