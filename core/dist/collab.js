import { setSetting } from "./db.js";
import { id, now } from "./ids.js";
import { append } from "./events.js";
import { q, askJudgment, decideJudgment } from "./work.js";
import { ideas, createConversation, lastProposal } from "./ideas.js";
const P = (r) => ({ id: r.id, name: r.name, handle: r.handle, email: r.email, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at });
const WT = (r) => ({
    id: r.id, personId: r.person_id, kind: r.kind, description: r.description,
    subjectType: r.subject_type ?? null, subjectId: r.subject_id ?? null, sourceKind: r.source_kind, sourceRef: r.source_ref ?? null,
    status: r.status, since: r.since, dueAt: r.due_at ?? null, returnedAt: r.returned_at ?? null,
    returnedSummary: r.returned_summary ?? null, createdAt: r.created_at,
});
const M = (r) => ({
    id: r.id, title: r.title, purpose: r.purpose, status: r.status, startsAt: r.starts_at ?? null,
    durationMin: r.duration_min, location: r.location, candidates: JSON.parse(r.candidates), agenda: r.agenda, outcome: r.outcome,
    subjectType: r.subject_type ?? null, subjectId: r.subject_id ?? null, conversationId: r.conversation_id ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
});
export const WAIT_KINDS = ["review", "answer", "decision", "merge", "delivery", "other"];
// --- queries -------------------------------------------------------------------------------------------
export const collab = {
    people: (db) => db.prepare("SELECT * FROM people ORDER BY name").all().map(P),
    person: (db, pid) => { const r = db.prepare("SELECT * FROM people WHERE id=?").get(pid); return r ? P(r) : null; },
    waits: (db, status) => (status ? db.prepare("SELECT * FROM waits WHERE status=? ORDER BY since").all(status) : db.prepare("SELECT * FROM waits ORDER BY since DESC").all()).map(WT),
    wait: (db, wid) => { const r = db.prepare("SELECT * FROM waits WHERE id=?").get(wid); return r ? WT(r) : null; },
    waitsFor: (db, subjectType, subjectId) => db.prepare("SELECT * FROM waits WHERE subject_type=? AND subject_id=? ORDER BY since").all(subjectType, subjectId).map(WT),
    waitsOn: (db, personId) => db.prepare("SELECT * FROM waits WHERE person_id=? ORDER BY since DESC").all(personId).map(WT),
    meetings: (db) => db.prepare("SELECT * FROM meetings ORDER BY COALESCE(starts_at, created_at)").all().map(M),
    meeting: (db, mid) => { const r = db.prepare("SELECT * FROM meetings WHERE id=?").get(mid); return r ? M(r) : null; },
    meetingPeople: (db, mid) => db.prepare("SELECT p.* FROM meeting_people mp JOIN people p ON p.id=mp.person_id WHERE mp.meeting_id=? ORDER BY p.name").all(mid).map(P),
    meetingsWith: (db, personId) => db.prepare("SELECT m.* FROM meeting_people mp JOIN meetings m ON m.id=mp.meeting_id WHERE mp.person_id=? ORDER BY COALESCE(m.starts_at, m.created_at)").all(personId).map(M),
};
// --- people ---------------------------------------------------------------------------------------------
export function createPerson(db, input) {
    const name = (input.name ?? "").trim().slice(0, 120);
    if (!name)
        throw new Error("a person needs a name");
    const dup = db.prepare("SELECT id FROM people WHERE lower(name)=lower(?)").get(name);
    if (dup)
        return collab.person(db, dup.id);
    const pid = id("p");
    const t = now();
    db.prepare("INSERT INTO people(id,name,handle,email,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(pid, name, (input.handle ?? "").trim().slice(0, 120), (input.email ?? "").trim().slice(0, 200), (input.note ?? "").slice(0, 2000), t, t);
    append(db, "person", pid, "created", { name });
    return collab.person(db, pid);
}
export function updatePerson(db, pid, patch) {
    const p = collab.person(db, pid);
    if (!p)
        throw new Error("no such person");
    db.prepare("UPDATE people SET name=?, handle=?, email=?, note=?, updated_at=? WHERE id=?").run((patch.name ?? p.name).trim().slice(0, 120) || p.name, (patch.handle ?? p.handle).trim(), (patch.email ?? p.email).trim(), patch.note ?? p.note, now(), pid);
    return collab.person(db, pid);
}
export function deletePerson(db, pid) {
    const open = db.prepare("SELECT COUNT(*) AS n FROM waits WHERE person_id=? AND status='waiting'").get(pid).n;
    if (open)
        throw new Error(`${open} obligation(s) still wait on this person; return or cancel them first`);
    db.transaction(() => {
        db.prepare("DELETE FROM meeting_people WHERE person_id=?").run(pid);
        db.prepare("DELETE FROM waits WHERE person_id=?").run(pid);
        db.prepare("DELETE FROM people WHERE id=?").run(pid);
    })();
}
// --- waits: what Conjure is waiting on from a person ---------------------------------------------------------
export function createWait(db, input, by) {
    const person = input.personId ? collab.person(db, input.personId) : input.personName ? createPerson(db, { name: input.personName }) : null;
    if (!person)
        throw new Error("say who you are waiting on");
    const kind = WAIT_KINDS.includes(input.kind ?? "") ? input.kind : "other";
    let subjectType = null;
    let subjectId = null;
    if (input.subjectType === "work" && input.subjectId) {
        if (!q.work(db, input.subjectId))
            throw new Error("no such work");
        subjectType = "work";
        subjectId = input.subjectId;
    }
    if (input.subjectType === "meeting" && input.subjectId) {
        if (!collab.meeting(db, input.subjectId))
            throw new Error("no such meeting");
        subjectType = "meeting";
        subjectId = input.subjectId;
    }
    const wid = id("wait");
    const t = now();
    const dueAt = input.dueAt && Number.isFinite(Date.parse(input.dueAt)) ? new Date(input.dueAt).toISOString() : null;
    db.transaction(() => {
        db.prepare("INSERT INTO waits(id,person_id,kind,description,subject_type,subject_id,source_kind,source_ref,status,since,due_at,created_at) VALUES(?,?,?,?,?,?,?,?,'waiting',?,?,?)")
            .run(wid, person.id, kind, (input.description ?? "").trim().slice(0, 500), subjectType, subjectId, (input.sourceKind ?? "operator").slice(0, 40), input.sourceRef ?? null, t, dueAt, t);
        append(db, "wait", wid, "created", { person: person.name, kind, subjectType, subjectId, by });
        if (subjectType === "work")
            append(db, "work", subjectId, "waiting-on-person", { waitId: wid, person: person.name, kind });
    })();
    return collab.wait(db, wid);
}
/** The person returned. Recorded by the operator's word today; an integration may record it from evidence later (source_kind says which). */
export function returnWait(db, wid, summary, by, sourceKind = "operator", sourceRef = null) {
    const w = collab.wait(db, wid);
    if (!w)
        throw new Error("no such wait");
    if (w.status !== "waiting")
        return w;
    const person = collab.person(db, w.personId);
    db.transaction(() => {
        const t = now();
        db.prepare("UPDATE waits SET status='returned', returned_at=?, returned_summary=?, source_kind=?, source_ref=COALESCE(?, source_ref) WHERE id=?").run(t, summary.trim().slice(0, 4000) || null, sourceKind, sourceRef, wid);
        append(db, "wait", wid, "returned", { person: person.name, kind: w.kind, by, subjectType: w.subjectType, subjectId: w.subjectId });
        // The return is a durable change on the work: the external hold no longer applies and the next brief carries what came back.
        if (w.subjectType === "work" && w.subjectId) {
            db.prepare("UPDATE work SET updated_at=? WHERE id=?").run(t, w.subjectId);
            append(db, "work", w.subjectId, "person-returned", { waitId: wid, person: person.name, kind: w.kind });
        }
    })();
    return collab.wait(db, wid);
}
export function cancelWait(db, wid, by) {
    const w = collab.wait(db, wid);
    if (!w)
        throw new Error("no such wait");
    if (w.status !== "waiting")
        return w;
    db.transaction(() => {
        db.prepare("UPDATE waits SET status='cancelled' WHERE id=?").run(wid);
        append(db, "wait", wid, "cancelled", { by, subjectType: w.subjectType, subjectId: w.subjectId });
        if (w.subjectType === "work" && w.subjectId)
            db.prepare("UPDATE work SET updated_at=? WHERE id=?").run(now(), w.subjectId);
    })();
    return collab.wait(db, wid);
}
// --- meetings: the organization around a meeting held elsewhere -------------------------------------------------
export function createMeeting(db, input) {
    const title = (input.title ?? "").trim().slice(0, 200);
    if (!title)
        throw new Error("a meeting needs a title");
    const mid = id("m");
    const t = now();
    const startsAt = input.startsAt && Number.isFinite(Date.parse(input.startsAt)) ? new Date(input.startsAt).toISOString() : null;
    let subjectType = null;
    let subjectId = null;
    if (input.subjectType === "work" && input.subjectId && q.work(db, input.subjectId)) {
        subjectType = "work";
        subjectId = input.subjectId;
    }
    if (input.subjectType === "note" && input.subjectId && ideas.note(db, input.subjectId)) {
        subjectType = "note";
        subjectId = input.subjectId;
    }
    db.transaction(() => {
        db.prepare("INSERT INTO meetings(id,title,purpose,status,starts_at,duration_min,location,candidates,agenda,outcome,subject_type,subject_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'[]','','',?,?,?,?)")
            .run(mid, title, (input.purpose ?? "").slice(0, 4000), startsAt ? "scheduled" : "proposed", startsAt, Math.max(5, Math.min(600, Number(input.durationMin) || 30)), (input.location ?? "").slice(0, 300), subjectType, subjectId, t, t);
        for (const pid of input.people ?? [])
            if (collab.person(db, pid))
                db.prepare("INSERT OR IGNORE INTO meeting_people(meeting_id,person_id) VALUES(?,?)").run(mid, pid);
        for (const name of input.personNames ?? []) {
            const p = createPerson(db, { name });
            db.prepare("INSERT OR IGNORE INTO meeting_people(meeting_id,person_id) VALUES(?,?)").run(mid, p.id);
        }
        append(db, "meeting", mid, "created", { title, startsAt });
    })();
    return collab.meeting(db, mid);
}
export function updateMeeting(db, mid, patch) {
    const m = collab.meeting(db, mid);
    if (!m)
        throw new Error("no such meeting");
    const startsAt = patch.startsAt === undefined ? m.startsAt : patch.startsAt && Number.isFinite(Date.parse(patch.startsAt)) ? new Date(patch.startsAt).toISOString() : null;
    // Scheduling is a status fact: a time makes a proposed meeting scheduled; removing it makes it proposed again. Held/cancelled stay.
    const status = m.status === "held" || m.status === "cancelled" ? m.status : startsAt ? "scheduled" : "proposed";
    const candidates = Array.isArray(patch.candidates) ? patch.candidates.filter((c) => Number.isFinite(Date.parse(c))).map((c) => new Date(c).toISOString()).slice(0, 12) : m.candidates;
    db.prepare("UPDATE meetings SET title=?, purpose=?, status=?, starts_at=?, duration_min=?, location=?, agenda=?, outcome=?, candidates=?, updated_at=? WHERE id=?")
        .run((patch.title ?? m.title).trim().slice(0, 200) || m.title, (patch.purpose ?? m.purpose).slice(0, 4000), status, startsAt, Math.max(5, Math.min(600, Number(patch.durationMin ?? m.durationMin) || 30)), (patch.location ?? m.location).slice(0, 300), (patch.agenda ?? m.agenda).slice(0, 8000), (patch.outcome ?? m.outcome).slice(0, 8000), JSON.stringify(candidates), now(), mid);
    if (startsAt !== m.startsAt)
        append(db, "meeting", mid, startsAt ? "scheduled" : "unscheduled", { startsAt });
    return collab.meeting(db, mid);
}
export function setMeetingStatus(db, mid, status) {
    const m = collab.meeting(db, mid);
    if (!m)
        throw new Error("no such meeting");
    if (status === "scheduled" && !m.startsAt)
        throw new Error("set a time first");
    db.prepare("UPDATE meetings SET status=?, updated_at=? WHERE id=?").run(status, now(), mid);
    append(db, "meeting", mid, status, {});
    return collab.meeting(db, mid);
}
export function addMeetingPerson(db, mid, personId, personName) {
    if (!collab.meeting(db, mid))
        throw new Error("no such meeting");
    const p = personId ? collab.person(db, personId) : personName ? createPerson(db, { name: personName }) : null;
    if (!p)
        throw new Error("say who");
    db.prepare("INSERT OR IGNORE INTO meeting_people(meeting_id,person_id) VALUES(?,?)").run(mid, p.id);
    return collab.meetingPeople(db, mid);
}
export function removeMeetingPerson(db, mid, personId) {
    db.prepare("DELETE FROM meeting_people WHERE meeting_id=? AND person_id=?").run(mid, personId);
    return collab.meetingPeople(db, mid);
}
/** Cold help finding a time: free slots in Conjure's own calendar. Conjure knows only the meetings it holds; other calendars are not consulted yet. */
export function suggestTimes(db, durationMin, days = 7, fromIso) {
    const busy = collab.meetings(db).filter((m) => m.status === "scheduled" && m.startsAt).map((m) => ({ a: Date.parse(m.startsAt), b: Date.parse(m.startsAt) + m.durationMin * 60_000 }));
    const out = [];
    const start = fromIso && Number.isFinite(Date.parse(fromIso)) ? new Date(fromIso) : new Date();
    const dur = Math.max(5, durationMin || 30) * 60_000;
    for (let d = 0; d < Math.max(1, Math.min(30, days)) && out.length < 8; d++) {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
        if (day.getDay() === 0 || day.getDay() === 6)
            continue;
        for (const h of [9, 10, 11, 14, 15, 16]) {
            const a = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0, 0).getTime();
            if (a < Date.now() + 30 * 60_000)
                continue;
            const b = a + dur;
            if (busy.some((x) => a < x.b && b > x.a))
                continue;
            out.push({ startsAt: new Date(a).toISOString(), endsAt: new Date(b).toISOString() });
            if (out.length >= 8)
                break;
        }
    }
    return out;
}
/** An .ics the operator can drop into whatever calendar they and the other humans already use. */
export function meetingIcs(db, mid) {
    const m = collab.meeting(db, mid);
    if (!m)
        throw new Error("no such meeting");
    if (!m.startsAt)
        throw new Error("this meeting has no time yet");
    const stamp = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => `\\${c}`);
    const who = collab.meetingPeople(db, mid).map((p) => p.name + (p.email ? ` <${p.email}>` : "")).join(", ");
    const desc = [m.purpose && `Why: ${m.purpose}`, who && `With: ${who}`, m.agenda && `Agenda:\n${m.agenda}`].filter(Boolean).join("\n\n");
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Conjure//Meetings//EN", "BEGIN:VEVENT", `UID:${m.id}@conjure`, `DTSTAMP:${stamp(now())}`, `DTSTART:${stamp(m.startsAt)}`,
        `DTEND:${stamp(new Date(Date.parse(m.startsAt) + m.durationMin * 60_000).toISOString())}`, `SUMMARY:${esc(m.title)}`, m.location ? `LOCATION:${esc(m.location)}` : "", desc ? `DESCRIPTION:${esc(desc)}` : "", "END:VEVENT", "END:VCALENDAR", ""].filter((l) => l !== "").join("\r\n");
}
/** Preparation is the one place cognition helps a meeting: a window that sees the purpose, the people, and the linked obligation, and proposes an agenda. */
export function prepareMeeting(rt, mid, processor) {
    const m = collab.meeting(rt.db, mid);
    if (!m)
        throw new Error("no such meeting");
    if (m.conversationId) {
        const c = ideas.get(rt.db, m.conversationId);
        if (c && !c.archivedAt)
            return c;
    }
    const c = createConversation(rt, { role: "meeting", title: `Prepare: ${m.title}`.slice(0, 120), meetingId: mid, ...processor });
    rt.db.prepare("UPDATE meetings SET conversation_id=?, updated_at=? WHERE id=?").run(c.id, now(), mid);
    return c;
}
export function agendaProposal(db, mid) {
    const m = collab.meeting(db, mid);
    if (!m?.conversationId)
        return null;
    const p = lastProposal(db, m.conversationId, "agenda");
    if (!p || !Array.isArray(p.questions))
        return null;
    return { questions: p.questions.map(String).slice(0, 20), context: typeof p.context === "string" ? p.context : undefined, bring: Array.isArray(p.bring) ? p.bring.map(String).slice(0, 20) : undefined };
}
/** The operator applies a proposal; cognition never writes the agenda itself. */
export function applyAgenda(db, mid) {
    const p = agendaProposal(db, mid);
    if (!p)
        throw new Error("no agenda proposal to apply");
    const text = [p.context ? `Why this matters: ${p.context}` : "", "Questions:", ...p.questions.map((x) => `- ${x}`), ...(p.bring?.length ? ["", "Bring:", ...p.bring.map((x) => `- ${x}`)] : [])].filter((l, i) => l !== "" || i > 0).join("\n");
    return updateMeeting(db, mid, { agenda: text });
}
/** What the meeting is about, assembled cold for the preparation prompt: the operator sees the same things on the meeting page. */
export function meetingContext(db, m) {
    const parts = [];
    const people = collab.meetingPeople(db, m.id);
    parts.push(`MEETING: ${m.title}${m.startsAt ? ` at ${m.startsAt}` : " (not yet scheduled)"}${m.location ? ` · ${m.location}` : ""}`);
    parts.push(`WHY IT MATTERS (operator's words): ${m.purpose || "(not stated)"}`);
    parts.push(`WITH: ${people.length ? people.map((p) => p.name + (p.note ? ` (${p.note.slice(0, 80)})` : "")).join(", ") : "(no one named yet)"}`);
    if (m.agenda)
        parts.push(`AGENDA SO FAR:\n${m.agenda}`);
    if (m.subjectType === "work" && m.subjectId) {
        const w = q.work(db, m.subjectId);
        if (w) {
            parts.push(`LINKED OBLIGATION ${w.id}: ${w.title} [${w.status}]\nBRIEF: ${w.brief.slice(0, 3000)}\nACCEPTANCE: ${w.acceptance}`);
            const hold = q.hold(db, w.id);
            if (hold)
                parts.push(`It is currently waiting: ${hold.reason} - ${hold.detail} (clears when ${hold.clearsWhen})`);
            const owed = q.openJudgmentFor(db, "work", w.id);
            if (owed)
                parts.push(`A judgment is owed on it: ${owed.question}`);
        }
    }
    if (m.subjectType === "note" && m.subjectId) {
        const n = ideas.note(db, m.subjectId);
        if (n)
            parts.push(`LINKED NOTE "${n.title}":\n${n.body.slice(0, 6000)}`);
    }
    for (const p of people) {
        const waiting = collab.waitsOn(db, p.id).filter((w) => w.status === "waiting");
        if (waiting.length)
            parts.push(`CONJURE IS WAITING ON ${p.name.toUpperCase()} FOR: ${waiting.map((w) => `${w.kind}${w.description ? ` (${w.description})` : ""}`).join("; ")}`);
    }
    return parts.join("\n\n");
}
/** A decision made in a meeting is durable operator truth: a judgment on the meeting, decided by the operator, in their own words. */
export function recordMeetingDecision(db, mid, question, decision, by) {
    if (!collab.meeting(db, mid))
        throw new Error("no such meeting");
    if (!question.trim() || !decision.trim())
        throw new Error("a decision needs the question and the answer");
    return db.transaction(() => {
        const j = askJudgment(db, "product", "meeting", mid, { question: question.trim(), options: [], context: "decided in the meeting" });
        return decideJudgment(db, j.id, decision.trim(), by, "from meeting");
    })();
}
/** One transaction per answer (a bad answer must not lose the good ones); one setting for the batch, which is what ignition reads. */
export function submitHomework(db, answers, by) {
    const decided = [];
    const errors = [];
    for (const a of answers) {
        try {
            decideJudgment(db, a.id, String(a.decision ?? ""), by, a.note ? String(a.note).slice(0, 2000) : null);
            decided.push(a.id);
        }
        catch (e) {
            errors.push({ id: a.id, error: e.message });
        }
    }
    const submittedAt = now();
    if (decided.length) {
        setSetting(db, "last_homework_at", submittedAt);
        setSetting(db, "last_homework_ids", JSON.stringify(decided));
        append(db, "homework", submittedAt, "submitted", { decided: decided.length, errors: errors.length, by });
    }
    return { submittedAt, decided, errors };
}
//# sourceMappingURL=collab.js.map