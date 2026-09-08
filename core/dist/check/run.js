// Non-Vitest evidence. Boots real gateways on temp homes with the fake provider and drives them over HTTP.
// Each scenario prints PASS/FAIL with the measured facts. Exit code is non-zero if any scenario fails.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { providerExecChecks } from "./provider-exec.js";
import { httpSecurityIntegrationChecks, httpSecurityPrimitiveChecks } from "./http-security.js";
import { selfChecks } from "./self.js";
import { contractChecks } from "./contracts.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, "..", "gateway-entry.js");
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 7900 + Math.floor(Math.random() * 300);
async function boot(name, extraEnv = {}, reuse) {
    const port = reuse?.port ?? nextPort++;
    const home = reuse?.home ?? fs.mkdtempSync(path.join(os.tmpdir(), `conjure-check-${name}-`));
    const ws = reuse?.ws ?? fs.mkdtempSync(path.join(os.tmpdir(), `conjure-ws-${name}-`));
    const env = { ...process.env, CONJURE_HOME: home, CONJURE_PORT: String(port), CONJURE_FAKE_PROVIDER: "1", CONJURE_WORKSPACE_ROOT: ws, CONJURE_QUIET: "1", CONJURE_FALLBACK_MS: "2000", CONJURE_PROBE_MS: "1500", ...extraEnv };
    const proc = spawn(process.execPath, [ENTRY], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const base = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 30000) {
        try {
            const r = await fetch(`${base}/api/health`);
            if (r.ok) {
                up = true;
                break;
            }
        }
        catch { /* not yet */ }
        await sleep(50);
    }
    if (!up)
        throw new Error(`gateway on ${port} did not answer within 30s`);
    let controlSecret = "";
    while (Date.now() - t0 < 30000) {
        try {
            const gateway = JSON.parse(fs.readFileSync(path.join(home, "gateway.json"), "utf8"));
            if (typeof gateway.controlSecret === "string") {
                controlSecret = gateway.controlSecret;
                break;
            }
        }
        catch { /* gateway record not ready */ }
        await sleep(50);
    }
    if (!controlSecret)
        throw new Error(`gateway on ${port} did not write a control secret`);
    const gw = { proc, port, home, ws, base, env, controlSecret };
    if (!reuse) {
        // point every seat at the fake provider
        for (const seat of ["planner", "builder", "reviewer"])
            await post(gw, `/api/org/seats/${seat}`, { processors: [{ provider: "fake", model: "m" }] });
    }
    return gw;
}
async function stop(gw) { gw.proc.kill(); await sleep(300); }
async function get(gw, p) { const r = await fetch(gw.base + p, { headers: { authorization: `Conjure ${gw.controlSecret}` } }); return (await r.json()); }
async function post(gw, p, body = {}) { const r = await fetch(gw.base + p, { method: "POST", headers: { authorization: `Conjure ${gw.controlSecret}`, origin: gw.base, "content-type": "application/json" }, body: JSON.stringify(body) }); return (await r.json()); }
async function waitFor(gw, pred, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) {
    if (await pred())
        return true;
    await sleep(100);
} return false; }
function record(name, ok, note) { results.push({ name, ok, note }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  - ${note}`); }
const work = (gw, id) => get(gw, `/api/work/${id}`);
async function scenarioHappyPath() {
    const gw = await boot("happy");
    try {
        const w = await post(gw, "/api/work", { title: "Greeting", brief: "Write hello. [[fake: write]]" });
        const ok = await waitFor(gw, async () => (await work(gw, w.id)).status === "done");
        const d = await work(gw, w.id);
        const ret = await get(gw, "/api/control");
        record("C: real work returns without operator shepherding", ok && d.attemptList.length === 2 && ret.cameBack.length === 1 && ret.judgments.product.length + ret.judgments.technical.length === 0, `status=${d.status} attempts=${d.attemptList.map((a) => `${a.role}:${a.status}`).join(",")} returned=${ret.cameBack.length} judgments=0 evidence=${d.evidence.length}`);
        const network = await get(gw, "/api/network");
        const liveIds = Object.values(network.circuit.live).flat();
        record("Network: completed work is not presented as live workflow occupancy", ok && !liveIds.includes(w.id), `completed=${w.id} live=${liveIds.join(",") || "none"}`);
    }
    finally {
        await stop(gw);
    }
}
async function scenarioJudgmentIsQuiet() {
    const gw = await boot("quiet");
    try {
        const w = await post(gw, "/api/work", { title: "Widget default", brief: "Pick a default. [[fake: judgment]]" });
        const asked = await waitFor(gw, async () => (await work(gw, w.id)).judgmentId !== null);
        const before = (await work(gw, w.id)).attempts;
        await sleep(6500); // > 3 fallback ticks + probes; nothing should be bought
        const after = await work(gw, w.id);
        record("5/A: unchanged judgment purchases no cognition over 3+ fallback ticks", asked && before === 1 && after.attempts === 1 && after.phase === "awaiting-judgment", `attempts before=${before} after=${after.attempts} phase=${after.phase} hold=${after.hold?.reason}`);
        // decide -> exactly one more attempt, then done (fake worker returns 'judgment' again unless we amend the brief)
        await post(gw, `/api/work/${w.id}/amend`, { brief: "Pick a default: compact. [[fake: done]]" });
        await post(gw, `/api/judgments/${after.judgmentId}/decide`, { decision: "compact" });
        const done = await waitFor(gw, async () => (await work(gw, w.id)).status === "done");
        const d = await work(gw, w.id);
        record("A: deciding the judgment resumes work exactly once", done && d.attempts === 3, `status=${d.status} attempts=${d.attempts} (1 ask + 1 build + 1 review)`);
    }
    finally {
        await stop(gw);
    }
}
async function scenarioProcessorFailure() {
    const gw = await boot("crash");
    try {
        const w = await post(gw, "/api/work", { title: "Crashy", brief: "Crash. [[fake: crash]]" });
        const owed = await waitFor(gw, async () => (await work(gw, w.id)).hold?.reason === "recovery-exhausted", 60000);
        const d = await work(gw, w.id);
        const js = await get(gw, "/api/judgments");
        record("D: processor failures are bounded, then a technical judgment is owed", owed && d.attempts === 3 && js.technical.length === 1 && d.status === "open", `attempts=${d.attempts} (retryLimit 2 => 3 tries) hold=${d.hold?.reason} technical judgments=${js.technical.length} status=${d.status}`);
        const before = d.attempts;
        await sleep(4500);
        record("5: exhausted work stays quiet until decided", (await work(gw, w.id)).attempts === before, `attempts still ${before} after 4.5s`);
        await post(gw, `/api/judgments/${js.technical[0].id}/decide`, { decision: "cancel" });
        const st = (await work(gw, w.id)).status;
        record("judgment 'cancel' closes the obligation truthfully", st === "cancelled", `status=${st}`);
    }
    finally {
        await stop(gw);
    }
}
async function scenarioNoReceipt() {
    const gw = await boot("noreceipt", { CONJURE_ATTEMPT_TIMEOUT_MS: "3000" });
    try {
        const w = await post(gw, "/api/work", { title: "Silent", brief: "Say nothing useful. [[fake: noreceipt]]" });
        await waitFor(gw, async () => (await work(gw, w.id)).attempts >= 1 && (await work(gw, w.id)).attemptList[0].status !== "running");
        const d = await work(gw, w.id);
        record("7: a turn without a receipt is a failed attempt, never success", d.attemptList[0].status === "failed" && d.status === "open", `attempt=${d.attemptList[0].status} work=${d.status}`);
        const w2 = await post(gw, "/api/work", { title: "Hang", brief: "Never finish. [[fake: hang]]" });
        const timedOut = await waitFor(gw, async () => { const x = await work(gw, w2.id); return x.attemptList.some((a) => a.status === "interrupted"); }, 15000);
        record("7: a hung processor is interrupted by timeout, work stays open", timedOut && (await work(gw, w2.id)).status === "open", `interrupted=${timedOut}`);
    }
    finally {
        await stop(gw);
    }
}
async function scenarioBlockedThenAmend() {
    const gw = await boot("blocked");
    try {
        const w = await post(gw, "/api/work", { title: "Needs file", brief: "Use design.png. [[fake: blocked]]" });
        const held = await waitFor(gw, async () => (await work(gw, w.id)).hold?.reason === "blocked");
        const a1 = (await work(gw, w.id)).attempts;
        await sleep(4500);
        const a2 = (await work(gw, w.id)).attempts;
        const ctl = await get(gw, "/api/control");
        record("4: blocked work holds quietly and is not an operator judgment", held && a1 === 1 && a2 === 1 && ctl.blocked.length === 1 && ctl.judgments.technical.length === 0, `attempts=${a2} blocked=${ctl.blocked.length} judgments=${ctl.judgments.technical.length}`);
        await post(gw, `/api/work/${w.id}/amend`, { brief: "design.png is attached now. [[fake: done]]" });
        const done = await waitFor(gw, async () => (await work(gw, w.id)).status === "done");
        record("4: amending the brief is a durable change that retries once", done, `status=${(await work(gw, w.id)).status}`);
    }
    finally {
        await stop(gw);
    }
}
async function scenarioPlan() {
    const gw = await boot("plan");
    try {
        const w = await post(gw, "/api/work", { title: "Big thing", brief: "Split me. [[fake: plan]]", seat: "planner" });
        const done = await waitFor(gw, async () => (await work(gw, w.id)).status === "done", 20000);
        const d = await work(gw, w.id);
        record("C: a planner's plan becomes child work; the parent closes when children deliver", done && d.children.length === 2 && d.children.every((c) => c.status === "done"), `children=${d.children.map((c) => c.status).join(",")} parent=${d.status}`);
    }
    finally {
        await stop(gw);
    }
}
async function scenarioReviewCeiling() {
    const gw = await boot("ceiling");
    try {
        // reviewer always fails; maxRounds=2 => build, review(fail), rework, review(fail) -> judgment
        await post(gw, "/api/org/seats/reviewer", { charter: "Always fail. [[fake: verdict fail]]" });
        const w = await post(gw, "/api/work", { title: "Never good enough", brief: "Try. [[fake: done]]" });
        const owed = await waitFor(gw, async () => (await work(gw, w.id)).hold?.reason === "review-ceiling", 20000);
        const d = await work(gw, w.id);
        record("C: review rounds are bounded; the ceiling is a technical judgment", owed && d.attempts === 4 && d.judgmentId !== null && d.phase === "awaiting-judgment", `attempts=${d.attempts} hold=${d.hold?.reason} phase=${d.phase} rounds=${d.rounds}`);
        await post(gw, `/api/judgments/${d.judgmentId}/decide`, { decision: "accept as is" });
        record("judgment 'accept as is' delivers the result", (await work(gw, w.id)).status === "done", `status=${(await work(gw, w.id)).status}`);
    }
    finally {
        await stop(gw);
    }
}
async function scenarioProviderOutage() {
    const gw = await boot("outage", { CONJURE_FAKE_UNAVAILABLE: "1" });
    try {
        const w = await post(gw, "/api/work", { title: "During outage", brief: "Do it. [[fake: done]]" });
        const held = await waitFor(gw, async () => (await work(gw, w.id)).hold?.reason === "no-processor");
        const t0 = Date.now();
        const nav = await Promise.all([get(gw, "/api/control"), get(gw, "/api/network"), get(gw, "/api/judgments"), get(gw, "/api/work"), get(gw, "/api/conversations")]);
        const ms = Date.now() - t0;
        const ctl = await get(gw, "/api/control");
        record("D/F: provider outage -> work waits with a named hold; all surfaces answer cold", held && nav.length === 5 && ms < 500 && ctl.degraded.length >= 1, `hold=no-processor 5 surfaces in ${ms}ms degraded="${ctl.degraded[0]}"`);
        // conversation during outage: truthful failure, no crash
        const c = await post(gw, "/api/conversations", { provider: "fake" });
        const t = await post(gw, `/api/conversations/${c.id}/speak`, { content: "hi" });
        record("D: Idea Room during outage fails truthfully", t.status === "failed" && /not available/.test(t.error), `turn=${t.status} error="${t.error}"`);
    }
    finally {
        await stop(gw);
    }
    // provider returns: same home, outage flag off -> work proceeds
    const gw2 = await boot("outage", {}, gw);
    try {
        const rows = await get(gw2, "/api/work");
        const id = rows[0].id;
        const done = await waitFor(gw2, async () => (await work(gw2, id)).status === "done", 15000);
        record("D: when the provider returns, held work proceeds without operator action", done, `status=${(await work(gw2, id)).status}`);
    }
    finally {
        await stop(gw2);
    }
}
async function scenarioRestart() {
    const gw = await boot("restart");
    try {
        const w = await post(gw, "/api/work", { title: "Long", brief: "Slow. [[fake: sleep 8000]] [[fake: done]]" });
        await waitFor(gw, async () => (await work(gw, w.id)).phase === "executing");
        const running = (await work(gw, w.id)).attemptList.length;
        gw.proc.kill();
        await sleep(500);
        const gw2 = await boot("restart", {}, gw);
        try {
            const d0 = await work(gw2, w.id);
            const interrupted = d0.attemptList[0].status === "interrupted";
            const done = await waitFor(gw2, async () => (await work(gw2, w.id)).status === "done", 30000);
            const d = await work(gw2, w.id);
            record("2/D: gateway restart mid-attempt -> attempt interrupted (truth), work survives and completes", interrupted && done && d.attemptList.length >= running + 1, `first=${d0.attemptList[0].status} final=${d.status} attempts=${d.attemptList.map((a) => a.status).join(",")}`);
        }
        finally {
            await stop(gw2);
        }
    }
    catch (e) {
        record("2/D: restart", false, String(e));
    }
}
async function scenarioLatencyUnderLoad() {
    const gw = await boot("latency");
    try {
        for (let i = 0; i < 12; i++)
            await post(gw, "/api/work", { title: `Load ${i}`, brief: `Busy. [[fake: sleep 2500]] [[fake: done]]` });
        await sleep(300);
        const samples = [];
        for (let i = 0; i < 40; i++) {
            const t0 = process.hrtime.bigint();
            await get(gw, i % 2 ? "/api/control" : "/api/network");
            samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
            await sleep(50);
        }
        samples.sort((a, b) => a - b);
        const p50 = samples[Math.floor(samples.length * 0.5)], p95 = samples[Math.floor(samples.length * 0.95)], max = samples[samples.length - 1];
        const st = await get(gw, "/api/status");
        record("8/F: cold navigation stays fast while background attempts run", p95 < 150, `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms while running=${st.running} attempts (builder lanes=2, reviewer lanes=1)`);
        const done = await waitFor(gw, async () => (await get(gw, "/api/work")).every((w) => w.status === "done"), 90000);
        record("capacity: 12 items drain through 2 builder lanes + 1 reviewer lane", done, `all done=${done}`);
    }
    finally {
        await stop(gw);
    }
}
async function scenarioIdeaRoom() {
    const gw = await boot("ideas");
    try {
        const c = await post(gw, "/api/conversations", { provider: "fake" });
        const t = await post(gw, `/api/conversations/${c.id}/speak`, { content: "Think with me. [[fake: done]]" });
        const conv = await get(gw, `/api/conversations/${c.id}`);
        const art = await post(gw, "/api/notes", { conversationId: c.id, title: "A plan", body: "Do the thing. [[fake: done]]" });
        const preview = await get(gw, `/api/notes/${art.id}/contract`);
        const open0 = (await get(gw, "/api/work")).length;
        record("B: private thought: no exposure, no work created by thinking or previewing", conv.exposure.length === 0 && conv.turns.length === 2 && t.status === "done" && preview.alreadyServed === null && open0 === 0, `exposure=[] turns=${conv.turns.length} turn=${t.status} preview.seat=${preview.seat} alreadyServed=${JSON.stringify(preview.alreadyServed)} work=${open0}`);
        const blank = await post(gw, "/api/conversations", {});
        const bconv = await get(gw, `/api/conversations/${blank.id}`);
        record("B: New Window is cold: a blank conversation with no turns and no provider call", blank.title === "" && bconv.turns.length === 0 && (await get(gw, "/api/work")).length === 0, `title="${blank.title}" provider=${blank.provider} turns=${bconv.turns.length}`);
        const w = await post(gw, `/api/notes/${art.id}/hand-to-conjure`, {});
        const again = await post(gw, `/api/notes/${art.id}/hand-to-conjure`, {});
        const a2 = await get(gw, `/api/notes/${art.id}`);
        const done = await waitFor(gw, async () => (await work(gw, w.id)).status === "done");
        record("B/C: hand-to-Conjure is explicit, idempotent, bidirectionally attested, and returns", w.sourceRef === art.id && again.id === w.id && a2.servedWorkId === w.id && done, `work=${w.id} artifact.servedWorkId=${a2.servedWorkId} done=${done}`);
    }
    finally {
        await stop(gw);
    }
}
async function scenarioRoast() {
    const gw = await boot("roast");
    try {
        const provs = await get(gw, "/api/providers");
        const codex = provs.find((p) => p.name === "codex");
        record("providers: capability truth is served (codex models + efforts, availability)", !!codex && codex.models.some((m) => m.id === "gpt-5.6-terra") && codex.efforts.includes("high") && provs.some((p) => p.name === "fake"), `providers=${provs.map((p) => `${p.name}:${p.available}`).join(",")}`);
        const f = await post(gw, "/api/folders", { name: "Game ideas" });
        const n1 = await post(gw, "/api/notes", { title: "civilization" });
        const moved = await post(gw, `/api/notes/${n1.id}`, { folderId: f.id });
        const tree = await get(gw, "/api/notes");
        record("notes: folders and notes are durable terrain; a loose note can be moved into a folder", n1.folderId === null && moved.folderId === f.id && tree.folders.length === 1 && tree.notes[0].folderId === f.id, `folders=${tree.folders.length} notes=${tree.notes.length}`);
        const seed = await post(gw, "/api/seeds", { text: "What if turns were simultaneous?" });
        const routed = await post(gw, `/api/seeds/${seed.id}/to-window`, {});
        const seedsLeft = await get(gw, "/api/seeds");
        record("seeds: a seed routes into a fresh window as a draft, without cognition", routed.draft.startsWith("What if") && (await get(gw, `/api/conversations/${routed.conversation.id}`)).turns.length === 0 && seedsLeft.length === 0, `window="${routed.conversation.title}"`);
        const d = await post(gw, "/api/directives", { text: "make the widget nicer", provider: "fake" });
        const open0 = (await get(gw, "/api/work")).length;
        await post(gw, `/api/conversations/${d.conversation.id}/speak`, { content: "I mean the settings widget. [[fake: contract]]" });
        const dd = await get(gw, `/api/directives/${d.directive.id}`);
        record("directive: conversation clarifies; a contract proposal appears; no work exists yet", d.conversation.role === "directive" && open0 === 0 && !!dd.proposal && dd.proposal.seat === "builder" && dd.workId === null, `proposal="${dd.proposal?.title}" work=${dd.workId}`);
        const w = await post(gw, `/api/directives/${d.directive.id}/accept`, {});
        const again = await post(gw, `/api/directives/${d.directive.id}/accept`, {});
        const done = await waitFor(gw, async () => (await work(gw, w.id)).status === "done");
        record("directive: accepting is where durable Work begins; idempotent; the work then returns", w.sourceKind === "directive" && w.title === "Clarified order" && again.id === w.id && done, `work=${w.id} done=${done}`);
        const org = await get(gw, "/api/org");
        const bad = await post(gw, "/api/org/workflow/validate", { workflow: { nodes: [{ id: "start", kind: "start", x: 0, y: 0 }], edges: [] } });
        const wc = await post(gw, "/api/conversations", { role: "workflow", provider: "fake" });
        await post(gw, `/api/conversations/${wc.id}/speak`, { content: "Add review. [[fake: workflow]]" });
        const prop = await get(gw, `/api/conversations/${wc.id}`);
        const r = await post(gw, "/api/org/workflow", { workflow: prop.proposal, routing: { maxRounds: 3 } });
        const net = await get(gw, "/api/network");
        record("workflow: graph validates honestly, AI proposal is applied by the operator, and it becomes a new ACTIVE revision", org.workflow.nodes.length === 4 && bad.errors.length > 0 && !!prop.proposal && r.id !== org.active.id && net.revision === r.id && r.routing.reviewer === "reviewer" && net.routing.maxRounds === 3, `rev ${org.active.id} -> ${r.id}; errors on bad graph=${bad.errors.length}; maxRounds=${net.routing.maxRounds}`);
    }
    finally {
        await stop(gw);
    }
}
async function scenarioContextBoundary() {
    const gw = await boot("context");
    try {
        const M = "ZEBRA-7731";
        const note = await post(gw, "/api/notes", { title: "pricing", body: `Secret pricing code word: ${M}. Tiers: free, pro.` });
        const A = await post(gw, "/api/conversations", { provider: "fake" });
        const B = await post(gw, "/api/conversations", { provider: "fake" });
        const ctx0 = await get(gw, `/api/conversations/${A.id}/context`);
        record("ctx 1: a fresh window begins blind (zero connected notes)", ctx0.length === 0, `context=${ctx0.length}`);
        const ctxA = await post(gw, `/api/conversations/${A.id}/context`, { noteId: note.id });
        const ctxB = await get(gw, `/api/conversations/${B.id}/context`);
        await post(gw, `/api/conversations/${A.id}/exposure`, { dirs: [gw.ws] });
        const projected = await get(gw, "/api/network");
        const selectedDirs = projected.private.windows.find((w) => w.id === A.id)?.exposureDirs;
        record("Network: conversation directory selections are visible to the operator", selectedDirs?.length === 1 && selectedDirs[0] === gw.ws, `selected=${JSON.stringify(selectedDirs)}`);
        record("ctx 2-4: connecting lists the note on window A; window B stays blind", ctxA.length === 1 && ctxA[0].noteId === note.id && ctxB.length === 0, `A=${ctxA.map((c) => c.title).join(",")} B=${ctxB.length}`);
        const ta = await post(gw, `/api/conversations/${A.id}/speak`, { content: `[[fake: grep ${M}]]` });
        const tb = await post(gw, `/api/conversations/${B.id}/speak`, { content: `[[fake: grep ${M}]]` });
        record("ctx 5-6: provider context for A contains the note; B does not receive it", ta.content.startsWith("SEES") && tb.content.startsWith("NO"), `A="${ta.content.trim()}" B="${tb.content.trim()}"`);
        await post(gw, `/api/conversations/${A.id}/context/${note.id}/disconnect`, {});
        const disconnected = await get(gw, `/api/notes/${note.id}`);
        const newMarker = "LYNX-9918-EDITED-AFTER-DISCONNECT";
        await post(gw, `/api/notes/${note.id}`, { body: `New private pricing code: ${newMarker}.` });
        // Past disclosures may remain in saved conversation history. Only newly edited note contents must be absent.
        // Dump avoids fake grep's first-marker selection when earlier grep requests are replayed in that history.
        const ta2 = await post(gw, `/api/conversations/${A.id}/speak`, { content: "Inspect the selected context. [[fake: dump]]" });
        const n2 = await get(gw, `/api/notes/${note.id}`);
        record("ctx 7-9: disconnect preserves the note and excludes its future edits without erasing past disclosures", disconnected.body === note.body && disconnected.updatedAt === note.updatedAt && disconnected.folderId === null
            && n2.body.includes(newMarker) && n2.folderId === null && !ta2.content.includes(newMarker) && !ta2.content.includes("--- note: pricing ---"), `new private text excluded=${!ta2.content.includes(newMarker)} historical disclosure present=${ta2.content.includes(M)} note still in place=${n2.folderId === null}`);
        await post(gw, `/api/conversations/${A.id}/context`, { noteId: note.id });
        const dirs = await get(gw, "/api/directives");
        const works = await get(gw, "/api/work");
        const n3 = await get(gw, `/api/notes/${note.id}`);
        const ctl = JSON.stringify(await get(gw, "/api/control"));
        const control = await post(gw, "/api/conversations", { role: "control", provider: "fake" });
        const tc = await post(gw, `/api/conversations/${control.id}/speak`, { content: `[[fake: grep ${M}]]` });
        record("ctx 10: connecting creates no directive, no work, no handoff (Black Box), no share, and nothing reaches Control", dirs.length === 0 && works.length === 0 && n3.servedWorkId === null && n3.sharedAt === null && !ctl.includes(M) && tc.content.startsWith("NO"), `directives=${dirs.length} work=${works.length} served=${n3.servedWorkId} shared=${n3.sharedAt} control="${tc.content.trim()}"`);
        const refused = await post(gw, `/api/conversations/${control.id}/context`, { noteId: note.id });
        record("ctx: Control refuses private context (must cross a real boundary)", !!refused.error, refused.error ?? "");
        const f = await post(gw, "/api/folders", { name: "Money" });
        await post(gw, `/api/notes/${note.id}`, { folderId: f.id });
        const ctxA3 = await get(gw, `/api/conversations/${A.id}/context`);
        const ctxB3 = await get(gw, `/api/conversations/${B.id}/context`);
        record("ctx 12: moving the note between folders is file organization; context sets are untouched", ctxA3.length === 1 && ctxB3.length === 0, `A=${ctxA3.length} B=${ctxB3.length}`);
    }
    finally {
        await stop(gw);
    }
    // 11: the relation survives a gateway restart (durable, not provider- or browser-held)
    const gw2 = await boot("context", {}, gw);
    try {
        const convs = await get(gw2, "/api/conversations");
        const withCtx = [];
        for (const c of convs)
            withCtx.push((await get(gw2, `/api/conversations/${c.id}/context`)).length);
        record("ctx 11: per-window context survives restart (exactly one window has it)", withCtx.filter((n) => n === 1).length === 1 && withCtx.filter((n) => n === 0).length === convs.length - 1, `per-window=${withCtx.join(",")}`);
    }
    finally {
        await stop(gw2);
    }
}
/** The mission's stress scenario: 20 obligations, 6 blocked, review load, runnable work, 2 unavailable provider families,
 *  2 cognition slots, an outstanding judgment, a processor death, a failed review, and one obligation that plans 3 children. */
async function scenarioStress() {
    const gw = await boot("stress", { CONJURE_FAKE_SLOTS: "2", CONJURE_FALLBACK_MS: "2000" });
    try {
        // two provider families that do not exist here: a seat configured only on them can never be staffed.
        await post(gw, "/api/org/seats", { id: "ghost", name: "Ghost", department: "engineering", reportsTo: "planner", role: "worker", charter: "Configured on providers this host does not have.", processors: [{ provider: "grok", model: "g" }, { provider: "gemini", model: "g" }], workspaceRoot: gw.ws, lanes: 1 });
        const ids = { blocked: [], review: [], runnable: [], judgment: [], plan: [], reviewfail: [], die: [], ghost: [], noreceipt: [] };
        const mk = async (k, title, brief, seat) => { const w = await post(gw, "/api/work", { title, brief, seat }); ids[k].push(w.id); };
        for (let i = 0; i < 6; i++)
            await mk("blocked", `Blocked ${i}`, "Needs a file that is missing. [[fake: blocked]]");
        for (let i = 0; i < 4; i++)
            await mk("review", `Reviewed ${i}`, "Build then review. [[fake: sleep 1200]] [[fake: done]]");
        for (let i = 0; i < 3; i++)
            await mk("runnable", `Runnable ${i}`, "Quick. [[fake: sleep 800]] [[fake: done]]");
        await mk("judgment", "Needs a decision", "Pick a default. [[fake: judgment]]");
        await mk("plan", "Big feature", "Split me. [[fake: plan 3]]", "planner");
        await mk("reviewfail", "Never good enough", "Try. [[fake: done]] [[fake: verdict fail]]");
        await mk("die", "Long one", "Slow. [[fake: sleep 5000]] [[fake: done]]");
        for (let i = 0; i < 2; i++)
            await mk("ghost", `Ghost work ${i}`, "Do it. [[fake: done]]", "ghost");
        await mk("noreceipt", "Silent", "Say nothing useful. [[fake: noreceipt]]");
        const total = (await get(gw, "/api/work")).length;
        record("S1: 20 durable obligations exist as work rows before any process runs", total === 20, `work rows=${total}`);
        // sample the machine while it runs: concurrency, holds, and the invariant that every open obligation has a next mover.
        let maxRunning = 0, maxLeases = 0, orphanSeen = 0, sawProviderCapacity = false, sawSeatCapacity = false;
        const holdReasons = new Set();
        const modes = new Set();
        let killed = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 45000) {
            const n = await get(gw, "/api/network");
            const running = n.organization.work.filter((w) => w.running).length;
            const leases = n.organization.seats.reduce((a, s) => a + s.slots.filter((x) => x.attemptId).length, 0);
            maxRunning = Math.max(maxRunning, running);
            maxLeases = Math.max(maxLeases, leases);
            orphanSeen += n.orphans.length;
            for (const w of n.organization.work) {
                if (w.hold) {
                    holdReasons.add(w.hold.reason);
                    if (w.hold.reason === "capacity" && /provider fake/.test(w.hold.detail))
                        sawProviderCapacity = true;
                    if (w.hold.reason === "capacity" && /lane/.test(w.hold.detail))
                        sawSeatCapacity = true;
                }
                if (w.next)
                    modes.add(w.next.mode);
            }
            // one active processor dies: kill the OS process of the long attempt while it is running.
            if (!killed) {
                const d = await work(gw, ids.die[0]);
                const a = d.attemptList.find((x) => x.status === "running" && x.pid);
                if (a) {
                    try {
                        process.kill(a.pid);
                        killed = { attemptId: a.id, pid: a.pid };
                    }
                    catch { /* already gone */ }
                }
            }
            const open = n.organization.work.filter((w) => w.status === "open");
            const settled = open.every((w) => w.hold && ["blocked", "no-processor", "judgment", "review-ceiling", "recovery-exhausted"].includes(w.hold.reason));
            if (settled && killed && Date.now() - t0 > 8000)
                break;
            await sleep(150);
        }
        record("S2: only 2 cognition slots exist for the whole organization; occupancy never exceeds them, and the shortfall is a named hold", maxRunning <= 2 && maxLeases <= 2 && sawProviderCapacity, `max running=${maxRunning} max leases=${maxLeases} provider-capacity hold seen=${sawProviderCapacity} seat-lane hold seen=${sawSeatCapacity}`);
        record("S3: every open obligation always had a next mover (no orphans), and all three movers appeared", orphanSeen === 0 && modes.has("cold") && modes.has("cognition") && modes.has("human"), `orphan samples=${orphanSeen} modes=${[...modes].join(",")} holds=${[...holdReasons].sort().join(",")}`);
        const all = await Promise.all((await get(gw, "/api/work")).map((w) => work(gw, w.id)));
        const by = (k) => all.filter((w) => ids[k].includes(w.id));
        const blocked = by("blocked");
        record("S4: 6 blocked obligations hold with a reason and consume no lane: one attempt each, no lease, quiet", blocked.length === 6 && blocked.every((w) => w.hold?.reason === "blocked" && w.attempts === 1 && !w.attemptList.some((a) => a.status === "running")), `holds=${blocked.map((w) => w.hold?.reason).join(",")} attempts=${blocked.map((w) => w.attempts).join(",")}`);
        const ghost = by("ghost");
        record("S5: work on a seat whose provider families are unavailable waits with 'no-processor' and zero attempts", ghost.length === 2 && ghost.every((w) => w.hold?.reason === "no-processor" && w.attempts === 0), `holds=${ghost.map((w) => `${w.hold?.reason}`).join(",")} attempts=${ghost.map((w) => w.attempts).join(",")}`);
        const j = by("judgment")[0];
        record("S6: an obligation that asked for judgment holds quietly; only that obligation waits on the operator", j.phase === "awaiting-judgment" && j.attempts === 1 && j.judgmentId !== null, `phase=${j.phase} attempts=${j.attempts}`);
        const plan = by("plan")[0];
        const kids = plan.children;
        record("S7: one obligation created 3 child obligations; the parent waited on them without a process and closed itself when they delivered", kids.length === 3 && kids.every((k) => k.status === "done") && plan.status === "done" && plan.attempts === 1, `children=${kids.map((k) => k.status).join(",")} parent=${plan.status} parentAttempts=${plan.attempts}`);
        const rf = by("reviewfail")[0];
        const roles = rf.attemptList.map((a) => `${a.role}${a.round}`);
        record("S8: a failed review routes back to the worker seat for rework; the ceiling becomes a technical judgment", roles.join(",") === "worker0,reviewer0,worker1,reviewer1" && rf.hold?.reason === "review-ceiling" && rf.judgmentId !== null, `attempts=${roles.join(",")} hold=${rf.hold?.reason}`);
        const die = by("die")[0];
        const first = die.attemptList.find((a) => a.id === killed?.attemptId);
        record("S9: a processor died mid-attempt; the attempt settled as a failure, the lease released, responsibility survived, and the obligation completed on a fresh attempt", !!killed && !!first && first.status !== "running" && first.status !== "succeeded" && die.status === "done" && die.attemptList.length >= 3 && die.seat === "builder", `killed pid=${killed?.pid} first=${first?.status} final=${die.status} attempts=${die.attemptList.map((a) => a.status).join(",")}`);
        const nr = by("noreceipt")[0];
        record("S10: repeated failures are bounded: after retryLimit the obligation holds 'recovery-exhausted' and asks a technical judgment", nr.hold?.reason === "recovery-exhausted" && nr.judgmentId !== null && nr.attempts === 3, `hold=${nr.hold?.reason} attempts=${nr.attempts}`);
        const runnable = by("runnable"), reviewed = by("review");
        record("S11: runnable and reviewed obligations all delivered through 2 slots", runnable.every((w) => w.status === "done") && reviewed.every((w) => w.status === "done" && w.attemptList.filter((a) => a.role === "reviewer").length === 1), `runnable=${runnable.map((w) => w.status).join(",")} reviewed=${reviewed.map((w) => w.status).join(",")}`);
        // nothing changes: no cognition is bought.
        const attemptsBefore = (await get(gw, "/api/network")).organization.work.reduce((a, w) => a + ((all.find((x) => x.id === w.id)?.attempts) ?? 0), 0);
        const st0 = await get(gw, "/api/status");
        await sleep(6500);
        const after = await Promise.all((await get(gw, "/api/work")).map((w) => work(gw, w.id)));
        const attemptsAfter = after.reduce((a, w) => a + w.attempts, 0);
        record("S12: when nothing changes, 3+ fallback ticks buy no cognition (blocked, unstaffed, and judgment-held work stays quiet)", st0.running === 0 && attemptsAfter === attemptsBefore, `attempts before=${attemptsBefore} after=${attemptsAfter} running=${st0.running}`);
        // provider availability returns for the ghost seat: reconfigure it onto a provider that exists; held work proceeds by itself.
        await post(gw, "/api/org/seats/ghost", { processors: [{ provider: "fake", model: "m" }] });
        const recovered = await waitFor(gw, async () => (await Promise.all(ids.ghost.map((id) => work(gw, id)))).every((w) => w.status === "done"), 20000);
        record("S13: when a provider becomes available for the unstaffed seat, its held work proceeds without operator action", recovered, `ghost work done=${recovered}`);
        // Network truth: the projection agrees with the durable rows.
        const n = await get(gw, "/api/network");
        const openIds = new Set(n.organization.work.filter((w) => w.status === "open").map((w) => w.id));
        const seatSum = n.organization.seats.reduce((a, s) => a + s.workIds.length, 0);
        const judgments = await get(gw, "/api/judgments");
        record("S14: Network reflects authoritative truth: every open obligation sits on exactly one seat, occupancy equals running attempts, judgments match", seatSum === openIds.size && n.organization.seats.every((s) => s.slots.filter((x) => x.attemptId).length === 0) && n.organization.judgments.length === judgments.technical.length + judgments.product.length && n.orphans.length === 0, `open=${openIds.size} onSeats=${seatSum} judgments=${n.organization.judgments.length} orphans=${n.orphans.length}`);
    }
    finally {
        await stop(gw);
    }
}
/** A reviewer's process dies. The worker's result still stands; review is re-summoned, not the build. */
async function scenarioReviewerDeath() {
    const gw = await boot("revdeath");
    try {
        await post(gw, "/api/org/seats/reviewer", { charter: "Slow reviewer. [[fake: sleep 4000]]" });
        const w = await post(gw, "/api/work", { title: "Reviewed slowly", brief: "Build. [[fake: done]]" });
        const reviewing = await waitFor(gw, async () => (await work(gw, w.id)).phase === "in-review", 15000);
        const d0 = await work(gw, w.id);
        const rv = d0.attemptList.find((a) => a.role === "reviewer" && a.status === "running");
        if (rv?.pid) {
            try {
                process.kill(rv.pid);
            }
            catch { /* gone */ }
        }
        const done = await waitFor(gw, async () => (await work(gw, w.id)).status === "done", 30000);
        const d = await work(gw, w.id);
        const seq = d.attemptList.map((a) => `${a.role}:${a.status}`);
        record("S15: reviewer process death re-summons review, never the build (the worker's result is still usable)", reviewing && !!rv && done && d.attemptList.filter((a) => a.role === "worker").length === 1 && d.attemptList.filter((a) => a.role === "reviewer").length === 2, `attempts=${seq.join(",")}`);
    }
    finally {
        await stop(gw);
    }
}
async function scenarioNetworkConfig() {
    const gw = await boot("network");
    try {
        const n0 = await get(gw, "/api/network");
        const occupied0 = n0.organization.seats.reduce((a, s) => a + s.slots.filter((x) => x.attemptId).length, 0);
        const r = await post(gw, "/api/org/seats/builder", { processors: [{ provider: "fake", model: "m2" }, { provider: "claude", model: "opus" }], lanes: 1 });
        const n1 = await get(gw, "/api/network");
        const b = n1.organization.seats.find((s) => s.id === "builder");
        record("E: Network configuration goes through one authoritative mechanism (new revision), no browser truth", n1.revision === r.id && n1.revision !== n0.revision && b.processors[0].model === "m2" && occupied0 === 0 && b.slots.length === 1 && b.slots[0].attemptId === null, `revision ${n0.revision} -> ${n1.revision}; builder processors=${b.processors.map((p) => p.provider).join(",")}; occupied=${occupied0} (configured != active)`);
        await post(gw, "/api/work", { title: "Occupy", brief: "Slow. [[fake: sleep 3000]] [[fake: done]]" });
        await waitFor(gw, async () => (await get(gw, "/api/network")).organization.seats.some((s) => s.slots.some((x) => x.attemptId)));
        const n2 = await get(gw, "/api/network");
        const slot = n2.organization.seats.find((s) => s.id === "builder").slots[0];
        record("E: cognition appears only while a lease exists, with the attempt's actual model, on a lease-based edge", !!slot.attemptId && slot.model === "m2" && slot.alive === true && n2.edges.some((e) => e.kind === "occupies" && e.basis === "lease"), `slot model=${slot.model} alive=${slot.alive}`);
        const rb = await post(gw, "/api/org/rollback", { revisionId: n0.revision });
        record("E: rollback is a new ACTIVE pointer over a frozen body", rb.id !== n0.revision && (await get(gw, "/api/network")).revision === rb.id, `rolled back to body of ${n0.revision} as ${rb.id}`);
    }
    finally {
        await stop(gw);
    }
}
/** Homework, external humans, meetings: the human layer around the operator's machine, proven cold with the fake provider. */
async function scenarioCollab() {
    const gw = await boot("collab");
    try {
        const attemptsOf = async (ids) => { let n = 0; for (const i of ids)
            n += (await work(gw, i)).attempts; return n; };
        // --- Homework -----------------------------------------------------------------------------------------------
        const w1 = await post(gw, "/api/work", { title: "Widget default", brief: "Pick a default. [[fake: judgment-once]]" });
        const w2 = await post(gw, "/api/work", { title: "Banner codename", brief: "Name it. [[fake: question]] [[fake: grepdone AURORA]]" });
        const w3 = await post(gw, "/api/work", { title: "Ship after Jane signs off", brief: "Ship it. [[fake: judgment-once]] [[fake: grepdone JANE-SAYS-GO]]" });
        const ids = [w1.id, w2.id, w3.id];
        const asked = await waitFor(gw, async () => (await get(gw, "/api/homework")).items.length === 3, 20000);
        const hw0 = await get(gw, "/api/homework");
        const before = await attemptsOf(ids);
        await sleep(4500); // > 2 fallback ticks: nothing may be bought while the sheet waits
        const after = await attemptsOf(ids);
        record("H1: questions accumulate on one sheet, ranked cold, each naming what it unblocks; waiting buys no cognition", asked && before === 3 && after === 3 && hw0.items.every((i) => i.unblocks.length === 1) && hw0.items.some((i) => i.openQuestion), `items=${hw0.items.length} openQuestions=${hw0.items.filter((i) => i.openQuestion).length} attempts before=${before} after=${after}`);
        // Jane is owed a review on w3 before the operator answers; her return, not the answer alone, frees it.
        const wait = await post(gw, "/api/waits", { personName: "Jane", kind: "review", description: "sign-off on the release", subjectType: "work", subjectId: w3.id });
        const jid = (wid) => hw0.items.find((i) => i.subjectId === wid).id;
        const sub = await post(gw, "/api/homework/submit", { answers: [{ id: jid(w1.id), decision: "compact" }, { id: jid(w2.id), decision: "AURORA" }, { id: jid(w3.id), decision: "compact", note: "keep it tight" }] });
        const ig = sub.homework.ignition;
        const w3line = ig?.answered.find((a) => a.workId === w3.id);
        const w1line = ig?.answered.find((a) => a.workId === w1.id);
        record("H2: one submit decides the whole sheet; ignition shows each obligation's next mover straight from decide()", sub.decided.length === 3 && sub.errors.length === 0 && ig?.answered.length === 3 && w1line?.next?.mode === "cognition" && w3line?.next?.mode === "external" && ig?.settled === true, `decided=${sub.decided.length} w1.next=${w1line?.next?.mode} w3.next=${w3line?.next?.mode} settled=${ig?.settled}`);
        const done12 = await waitFor(gw, async () => (await work(gw, w1.id)).status === "done" && (await work(gw, w2.id)).status === "done", 25000);
        const d2 = await get(gw, `/api/work/${w2.id}`);
        record("H3: answers become durable operator truth in the next brief; an open question's own words reach the worker", done12 && d2.returns.some((r) => r.summary.includes("SEES AURORA")) && d2.attempts === 3, `w2 returns=${d2.returns.map((r) => r.summary.split("\n")[0]).join(" | ")} attempts=${d2.attempts}`);
        // --- External human ----------------------------------------------------------------------------------------
        const d3 = await work(gw, w3.id);
        await sleep(3000);
        const d3b = await work(gw, w3.id);
        const net = await get(gw, "/api/network");
        const jane = net.outside.people.find((p) => p.name === "Jane");
        const w3n = net.organization.work.find((x) => x.id === w3.id);
        record("X1: waiting on a real person is a cold hold: no lane, no process, no cognition bought; Network shows the person (no cognition, no lease), what is owed, and the mover EXTERNAL HUMAN on a relation-based edge", d3.hold?.reason === "external" && d3.attempts === 1 && d3b.attempts === 1 && !!jane && jane.waiting.length === 1 && jane.cognition === "none" && jane.lease === "none" && w3n?.next?.mode === "external" && w3n.waitingOn.length === 1 && net.edges.some((e) => e.kind === "waiting-on" && e.basis === "relation" && e.from === `work:${w3.id}`) && net.orphans.length === 0, `hold=${d3.hold?.reason} attempts=${d3.attempts}->${d3b.attempts} jane.waiting=${jane?.waiting.length} next=${w3n?.next?.mode} orphans=${net.orphans.length}`);
        await post(gw, `/api/waits/${wait.id}/return`, { summary: "Reviewed, looks good. JANE-SAYS-GO" });
        const done3 = await waitFor(gw, async () => (await work(gw, w3.id)).status === "done", 25000);
        const d3c = await get(gw, `/api/work/${w3.id}`);
        const net2 = await get(gw, "/api/network");
        const jane2 = net2.outside.people.find((p) => p.name === "Jane");
        record("X2: when the person returns, the hold clears with no operator shepherding, the next brief carries what came back, and Network shows the return", done3 && d3c.attempts === 3 && d3c.returns.some((r) => r.summary.includes("SEES JANE-SAYS-GO")) && jane2.waiting.length === 0 && jane2.returned.length === 1 && net2.edges.some((e) => e.kind === "returned-by"), `attempts=${d3c.attempts} returns=${d3c.returns.map((r) => r.summary.split("\n")[0]).join(" | ")} jane.returned=${jane2.returned.length}`);
        // --- Meetings ------------------------------------------------------------------------------------------------
        const m = await post(gw, "/api/meetings", { title: "Sync with Mike", purpose: "Agree the rollout date", personNames: ["Mike"], subjectType: "work", subjectId: w1.id });
        const slots = await get(gw, "/api/meetings/suggest?duration=30&days=10");
        const scheduled = await post(gw, `/api/meetings/${m.id}`, { startsAt: slots[0]?.startsAt ?? new Date(Date.now() + 86400000).toISOString() });
        const worksBeforePrep = (await get(gw, "/api/work")).length;
        await post(gw, `/api/meetings/${m.id}/prepare`, { provider: "fake" });
        const prepared = await waitFor(gw, async () => !!(await get(gw, `/api/meetings/${m.id}`)).proposal, 15000);
        const applied = await post(gw, `/api/meetings/${m.id}/agenda/apply`, {});
        const dec = await post(gw, `/api/meetings/${m.id}/decision`, { question: "Rollout date?", decision: "the 14th" });
        const icsRes = await fetch(`${gw.base}/api/meetings/${m.id}/ics`, { headers: { authorization: `Conjure ${gw.controlSecret}` } });
        const ics = await icsRes.text();
        const mdet = await get(gw, `/api/meetings/${m.id}`);
        const net3 = await get(gw, "/api/network");
        const mnode = net3.outside.meetings.find((x) => x.id === m.id);
        const worksAfter = (await get(gw, "/api/work")).length;
        // M2: migrations must succeed on a POPULATED database. Fresh check homes are empty when they migrate, which is
        // exactly how a table rebuild that violates live foreign keys passed 115 checks and then failed on the operator's data.
        {
            const { default: Database } = await import("better-sqlite3");
            const { MIGRATIONS, openDb } = await import("../db.js");
            const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "conjure-migrate-")), "conjure.db");
            const old = new Database(file);
            old.pragma("foreign_keys = ON");
            for (let v = 0; v < 4; v++) {
                old.exec(MIGRATIONS[v]);
                old.pragma(`user_version = ${v + 1}`);
            }
            old.prepare("INSERT INTO conversations(id,title,role,provider,model,created_at,updated_at) VALUES('c1','t','idea','fake','m','2026-01-01','2026-01-01')").run();
            old.prepare("INSERT INTO turns(id,conversation_id,role,content,at) VALUES('t1','c1','operator','hello','2026-01-01')").run();
            old.prepare("INSERT INTO notes(id,title,body,created_at,updated_at) VALUES('n1','n','b','2026-01-01','2026-01-01')").run();
            old.prepare("INSERT INTO conversation_context(conversation_id,note_id,connected_at) VALUES('c1','n1','2026-01-01')").run();
            old.close();
            let error = "";
            let after = null;
            try {
                const db = openDb(file);
                after = { version: db.pragma("user_version", { simple: true }), turns: db.prepare("SELECT COUNT(*) n FROM turns WHERE conversation_id='c1'").get().n, ctx: db.prepare("SELECT COUNT(*) n FROM conversation_context").get().n, fk: db.pragma("foreign_key_check").length, role: db.prepare("SELECT role FROM conversations WHERE id='c1'").get().role };
                db.prepare("INSERT INTO conversations(id,title,role,provider,model,created_at,updated_at) VALUES('c2','m','meeting','fake','m','2026-01-01','2026-01-01')").run();
                db.close();
            }
            catch (e) {
                error = e.message;
            }
            record("M2: migrations run on a populated database: the conversations rebuild keeps every referencing row and the new role is accepted", !error && !!after && after.version === MIGRATIONS.length && after.turns === 1 && after.ctx === 1 && after.fk === 0 && after.role === "idea", error || `v${after?.version} turns=${after?.turns} ctx=${after?.ctx} dangling=${after?.fk}`);
        }
        record("M1: a meeting is organization, not transport: cold time suggestions, cognition only on request to prepare, agenda applied by the operator, a decision as durable truth, an .ics for the calendar humans already use, a Network node with its people; and it creates no work", m.status === "proposed" && scheduled.status === "scheduled" && slots.length > 0 && prepared && applied.agenda.includes("Questions:") && dec.status === "decided" && dec.decision === "the 14th" && icsRes.headers.get("content-type")?.startsWith("text/calendar") === true && ics.includes("BEGIN:VEVENT") && ics.includes("SUMMARY:Sync with Mike") && mdet.people[0]?.name === "Mike" && mdet.decisions.length === 1 && !!mnode && mnode.people.includes("Mike") && net3.edges.some((e) => e.kind === "meeting-with") && net3.edges.some((e) => e.kind === "meeting-about") && worksAfter === worksBeforePrep && worksAfter === 3, `status=${m.status}->${scheduled.status} slots=${slots.length} prepared=${prepared} agenda=${applied.agenda.split("\n")[0]} decision=${dec.decision} ics=${icsRes.status}/${icsRes.headers.get("content-type")} work=${worksAfter}`);
    }
    finally {
        await stop(gw);
    }
}
// --- the desktop Tong: tools as capabilities, experimental providers bounded to windows, a container that announces itself ---
async function scenarioDesktop() {
    const gw = await boot("desktop");
    try {
        const tl = await waitFor(gw, async () => (await get(gw, "/api/tools")).every((t) => t.state !== "unknown"), 30000);
        const t0 = await get(gw, "/api/tools");
        const godot = t0.find((t) => t.id === "godot");
        const ase = t0.find((t) => t.id === "aseprite");
        record("T1: Godot and Aseprite exist as experimental tools on first boot and are probed cold (present or not is reported, never assumed)", tl && !!godot && !!ase && ["ready", "not-installed", "not-executable", "error"].includes(godot.state) && godot.status === "experimental" && !t0.some((t) => t.available && t.state !== "ready"), `godot=${godot?.state} (${godot?.detail.slice(0, 60)}) aseprite=${ase?.state}`);
        // T2: a real program registers and probes with a version; a missing one says so.
        const nodeTool = await post(gw, "/api/tools", { id: "nodetool", name: "Node runtime", command: process.execPath, probeArgs: ["--version"], usage: "node <script>" });
        const ghost = await post(gw, "/api/tools", { id: "ghost", name: "Ghost", command: "definitely-not-a-program-xyz" });
        record("T2: a tool is located and probed by cold software: a real program answers with its version; an absent one is not-installed", nodeTool.state === "ready" && nodeTool.available && /^v\d+/.test(nodeTool.version ?? "") && ghost.state === "not-installed" && !ghost.available, `nodetool=${nodeTool.state}/${nodeTool.version} ghost=${ghost.state}`);
        // T3: granting is a revision; the brief tells the worker only what it may actually use; promotion gates it.
        await post(gw, "/api/org/seats/builder", { tools: ["nodetool", "ghost"] });
        const w = await post(gw, "/api/work", { title: "Tooling", brief: "Use the tool. [[fake: grepdone TOOLS AVAILABLE TO THIS WORK]]" });
        const b1 = await get(gw, `/api/work/${w.id}/brief`);
        await post(gw, "/api/tools/nodetool", { status: "promoted" });
        const b2 = await get(gw, `/api/work/${w.id}/brief`);
        const done = await waitFor(gw, async () => (await work(gw, w.id)).status === "done", 20000);
        const ret = await get(gw, "/api/control");
        const net = await get(gw, "/api/network");
        const builder = net.organization.seats.find((s) => s.id === "builder");
        record("T3: tool access is a seat grant, not cognition: unpromoted -> the brief says NOT available; promoted -> the brief names it and the attempt's PATH carries it; Network shows granted vs usable", b1.brief.includes("Node runtime: NOT available to you (experimental, not promoted)") && b1.tools.length === 0
            && b2.brief.includes("Node runtime (v") && b2.brief.includes("run it as 'node'") && b2.brief.includes("Ghost: NOT available") && b2.tools.some((t) => t.id === "nodetool" && t.exe === "node")
            && done && ret.cameBack.some((r) => r.summary.includes("SEES TOOLS AVAILABLE"))
            && !!builder && builder.tools.length === 2 && builder.toolsUsable.join(",") === "nodetool" && net.machine.tools.some((t) => t.id === "nodetool" && t.grantedTo.includes("builder")), `before=${b1.tools.length} after=${b2.tools.map((t) => t.exe).join(",")} done=${done} usable=${builder?.toolsUsable.join(",")} summary=${ret.cameBack[0]?.summary}`);
        // F1: an experimental provider from a spec is a window's provider at once and the organization's only when promoted.
        const script = path.join(here, "..", "..", "assets", "fake-worker.js");
        const reg = await post(gw, "/api/providers/experimental", { name: "toy", label: "Toy CLI", command: process.execPath, args: [script], output: "text", note: "a frontier toy" });
        const provs = await get(gw, "/api/providers");
        const toy = provs.find((p) => p.name === "toy");
        const c = await post(gw, "/api/conversations", { provider: "toy" });
        const turn = await post(gw, `/api/conversations/${c.id}/speak`, { content: "Hello toy. [[fake: dump]]" });
        record("F1: a new CLI becomes a window's provider from one JSON spec, probed and labelled experimental, with its boundary stated; the turn really ran it", !reg.error && !!toy && toy.experimental && !toy.promoted && toy.available && (toy.boundary ?? "").includes("not promoted") && toy.label.includes("experimental") && c.provider === "toy" && turn.status === "done" && turn.content.includes("Hello toy"), `toy=${toy ? `${toy.experimental}/${toy.promoted}/${toy.available}` : "missing"} turn=${turn.status} content=${turn.content.slice(0, 40).replace(/\n/g, " ")}`);
        await post(gw, "/api/org/seats/builder", { processors: [{ provider: "toy", model: "default" }], tools: [] });
        const w2 = await post(gw, "/api/work", { title: "On the toy", brief: "Try it. [[fake: done]]" });
        const held = await waitFor(gw, async () => (await work(gw, w2.id)).hold?.reason === "no-processor", 8000);
        const h = (await work(gw, w2.id)).hold;
        await post(gw, "/api/providers/toy/promote", {});
        const done2 = await waitFor(gw, async () => (await work(gw, w2.id)).status === "done", 20000);
        const a2 = (await work(gw, w2.id)).attemptList;
        record("F1: the organization refuses an unpromoted experimental provider with a hold that says why; promotion is one operator act and the work then runs on it", held && !!h && h.detail.includes("toy: experimental, not promoted") && h.clearsWhen.includes("promotes") && done2 && a2.some((a) => a.role === "worker" && a.status === "succeeded") && a2.find((a) => a.role === "worker")?.provider === "toy", `hold=${h?.reason}: ${h?.detail.slice(0, 70)} done=${done2} worker=${JSON.stringify(a2.find((a) => a.role === "worker"))?.slice(0, 80)}`);
        await post(gw, "/api/org/seats/builder", { processors: [{ provider: "fake", model: "m" }] });
        const disc = await post(gw, "/api/providers/toy/discard", {});
        const gone = !(await get(gw, "/api/providers")).some((p) => p.name === "toy");
        const specs = await get(gw, "/api/providers/experimental");
        record("F1: an experiment can be discarded: the spec file and the provider go; work and windows that used it remain as history", disc.ok === true && gone && !specs.some((s) => s.name === "toy") && (await work(gw, w2.id)).status === "done" && (await get(gw, `/api/conversations/${c.id}`)).turns.length === 2, `discarded=${disc.ok} gone=${gone} specs=${specs.length}`);
        // D1: a container announces itself; Conjure's own truth says which container operates it.
        const before = await get(gw, "/api/self");
        const ann = await post(gw, "/api/self/container", { kind: "desktop", version: "0.1.0", electron: "44.2.0", node: "22.0.0", pid: 4242 });
        const self = await get(gw, "/api/self");
        const ctl = await get(gw, "/api/control");
        const st = await get(gw, "/api/status");
        const net2 = await get(gw, "/api/network");
        const bad = await post(gw, "/api/self/container", { kind: "Not Valid!", version: "" });
        record("D1: the container is an observation in Conjure's self-truth, not an edition: announced per boot, shown in Control's cold lines, status and Network; malformed announcements are refused", before.container === null && ann.kind === "desktop" && self.container?.kind === "desktop" && self.container.version === "0.1.0" && self.container.detail.includes("electron 44.2.0")
            && ctl.self.lines.some((l) => l.startsWith("Operated through: desktop container 0.1.0") && l.includes("not an edition")) && st.self.container === "desktop 0.1.0" && net2.machine.gateway.container === "desktop 0.1.0" && !!bad.error, `container=${JSON.stringify(self.container)} line=${ctl.self.lines.find((l) => l.startsWith("Operated through"))?.slice(0, 60)}`);
    }
    finally {
        await stop(gw);
    }
}
async function main() {
    const only = process.argv[2];
    const all = [
        ["happy", scenarioHappyPath], ["quiet", scenarioJudgmentIsQuiet], ["crash", scenarioProcessorFailure], ["noreceipt", scenarioNoReceipt],
        ["blocked", scenarioBlockedThenAmend], ["plan", scenarioPlan], ["ceiling", scenarioReviewCeiling], ["outage", scenarioProviderOutage],
        ["restart", scenarioRestart], ["latency", scenarioLatencyUnderLoad], ["ideas", scenarioIdeaRoom], ["roast", scenarioRoast], ["context", scenarioContextBoundary], ["network", scenarioNetworkConfig], ["stress", scenarioStress], ["revdeath", scenarioReviewerDeath],
        ["collab", scenarioCollab], ["desktop", scenarioDesktop],
        ["contracts", () => contractChecks(record)],
        ["procexec", () => providerExecChecks(record)],
        ["httpsec-unit", () => httpSecurityPrimitiveChecks(record)],
        ["httpsec", () => httpSecurityIntegrationChecks(record)],
        ["self", () => selfChecks(record)],
    ];
    for (const [name, fn] of all) {
        if (only && only !== name)
            continue;
        console.log(`\n== ${name}`);
        try {
            await fn();
        }
        catch (e) {
            record(name, false, `threw: ${e.stack}`);
        }
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}
main();
//# sourceMappingURL=run.js.map