// What allocated cognition is told. Context routing is information selection: the brief, the acceptance, the seat's
// charter, the shared artifact (if any), and the relevant prior attempt facts. Never a transcript.
import fs from "node:fs";
import path from "node:path";
import { receiptInstructions } from "./receipt.js";
import { q } from "./work.js";
import { grantsFor, tools as toolTable } from "./tools.js";
function isConjureSource(root) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, "packages", "core", "package.json"), "utf8")).name === "@conjure/core";
    }
    catch {
        return false;
    }
}
export function renderBrief(ctx) {
    const { db, seat, work, role, attempts } = ctx;
    const lines = [];
    lines.push(`You are occupying the seat "${seat.name}" (${seat.id}) in the ${seat.department} department of Conjure, an organization of AI workers.`);
    lines.push(`ROLE: ${role}`);
    lines.push(`Seat charter: ${seat.charter}`);
    lines.push("");
    lines.push(`WORK ${work.id}: ${work.title}`);
    if (work.parentId) {
        const parent = q.work(db, work.parentId);
        if (parent)
            lines.push(`(part of: ${parent.title})`);
    }
    lines.push("");
    lines.push("BRIEF:");
    lines.push(work.brief);
    lines.push("");
    lines.push("ACCEPTANCE (what done means):");
    lines.push(work.acceptance);
    if (work.sourceKind === "note" && work.sourceRef) {
        const note = db.prepare("SELECT title, body FROM notes WHERE id=?").get(work.sourceRef);
        if (note) {
            lines.push("");
            lines.push(`SOURCE NOTE "${note.title}" (the operator handed this to Conjure):`);
            lines.push(note.body);
        }
    }
    if (work.sourceKind === "directive" && work.sourceRef) {
        const d = db.prepare("SELECT text FROM directives WHERE id=?").get(work.sourceRef);
        if (d) {
            lines.push("");
            lines.push("THE OPERATOR'S ORIGINAL ORDER (the brief above is the clarified version):");
            lines.push(d.text);
        }
    }
    const evidence = q.evidence(db, work.id);
    const settled = attempts.filter((a) => a.status !== "running");
    const decided = db.prepare("SELECT question, decision, note FROM judgments WHERE subject_type='work' AND subject_id=? AND status='decided' ORDER BY decided_at").all(work.id);
    if (decided.length) {
        lines.push("");
        lines.push("DECISIONS THE OPERATOR HAS ALREADY MADE ON THIS WORK:");
        for (const d of decided)
            lines.push(`- Q: ${d.question} -> ${d.decision}${d.note ? ` (${d.note})` : ""}`);
    }
    const returned = db.prepare("SELECT p.name, w.kind, w.description, w.returned_at, w.returned_summary FROM waits w JOIN people p ON p.id=w.person_id WHERE w.subject_type='work' AND w.subject_id=? AND w.status='returned' ORDER BY w.returned_at").all(work.id);
    if (returned.length) {
        lines.push("");
        lines.push("RETURNS FROM PEOPLE (external humans this work waited on):");
        for (const r of returned)
            lines.push(`- ${r.name} (${r.kind}${r.description ? `: ${r.description}` : ""}) returned ${r.returned_at}: ${r.returned_summary ?? "(no summary recorded)"}`);
    }
    if (role === "reviewer") {
        const last = [...settled].reverse().find((a) => a.role !== "reviewer" && a.receipt?.outcome === "done");
        lines.push("");
        lines.push("RESULT UNDER REVIEW:");
        lines.push(last?.receipt?.outcome === "done" ? last.receipt.summary : "(no summary recorded)");
        if (evidence.length) {
            lines.push("EVIDENCE ATTACHED:");
            for (const e of evidence)
                lines.push(`- [${e.kind}] ${e.locator}${e.summary ? ` : ${e.summary}` : ""}`);
        }
        lines.push("");
        lines.push("Judge only whether the result satisfies the acceptance. Do not rework it. If it fails, say precisely what is missing so the next round can fix it.");
    }
    else {
        const feedback = [...settled].reverse().find((a) => a.role === "reviewer" && a.receipt?.outcome === "verdict" && !a.receipt.pass);
        if (feedback?.receipt?.outcome === "verdict") {
            lines.push("");
            lines.push(`PREVIOUS ROUND WAS REJECTED BY REVIEW (round ${work.rounds}). Reviewer said:`);
            lines.push(feedback.receipt.summary);
        }
        const failures = settled.filter((a) => a.role !== "reviewer" && a.status !== "succeeded");
        if (failures.length) {
            lines.push("");
            lines.push(`Note: ${failures.length} earlier attempt(s) on this work ended without a usable result.`);
        }
        if (role === "worker") {
            lines.push("");
            lines.push(seat.workspaceRoot ? `WORKSPACE: your current directory. Make the change there and commit it if it is a git repository.` : "You have no filesystem workspace; return your result as text and evidence.");
            const grants = grantsFor(db, seat.tools);
            const ungranted = (seat.tools ?? []).filter((t) => !grants.some((g) => g.id === t)).map((t) => toolTable.get(db, t)).filter((t) => !!t);
            if (grants.length || ungranted.length) {
                lines.push("");
                lines.push("TOOLS AVAILABLE TO THIS WORK (real programs on your PATH; capabilities, not colleagues; they never think and are never asked):");
                for (const g of grants)
                    lines.push(`- ${g.name}${g.version ? ` (${g.version})` : ""}: run it as '${g.exe}'.${g.usage ? ` ${g.usage}` : ""}`);
                for (const t of ungranted)
                    lines.push(`- ${t.name}: NOT available to you (${t.status === "experimental" ? "experimental, not promoted" : t.detail}). Do not attempt to use it.`);
            }
            if (seat.workspaceRoot && isConjureSource(seat.workspaceRoot)) {
                lines.push("");
                lines.push("SELF-DEVELOPMENT: this workspace is Conjure's own source, and you are running inside the Conjure you are changing. Never start, stop, restart or replace the running Conjure, never touch its home directory, and never switch editions. When your change is committed, built and checked, register it so the operator can evaluate it from Command Control without knowing git: from the repository root run `node packages/core/dist/cli.js edition propose --ref <your branch> --note \"<one line: what it adds>\"` and put the printed edition id in your receipt summary. Proposing is yours; switching, accepting and rejecting are the operator's.");
            }
        }
        if (role === "planner" || role === "manager") {
            const kids = q.children(db, work.id);
            if (kids.length) {
                lines.push("");
                lines.push("EXISTING CHILD WORK:");
                for (const k of kids)
                    lines.push(`- ${k.id} [${k.status}] ${k.title}`);
            }
        }
    }
    lines.push("");
    lines.push("You do not manage sessions, dispatch, or organizational state; Conjure's cold software does. Do not ask for a human unless a decision is genuinely theirs.");
    lines.push("");
    lines.push(receiptInstructions(role));
    return lines.join("\n");
}
//# sourceMappingURL=brief.js.map