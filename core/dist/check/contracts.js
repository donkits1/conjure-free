// Durable context regression evidence. Real SQLite and command/projection code; no gateway, paid providers or Vitest.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "../db.js";
import { activateRevision, editSeat } from "../org.js";
import { commission, amendWork, cancelWork, askJudgment, decideJudgment, q } from "../work.js";
import { renderBrief } from "../brief.js";
import { createRuntime, decide, runReconcile } from "../reconcile.js";
import { createConversation, createNote, updateNote, speak, ideas, contractPreview, handNoteToConjure } from "../ideas.js";
import { createWait, returnWait, submitHomework } from "../collab.js";
import { homeworkView, workDetail, traceView } from "../projections.js";
import { append } from "../events.js";
import * as contractAPI from "../contracts.js";
import { resolveExecutable, execProvider } from "../provider-exec.js";
async function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-contract-check-"));
    const previousHome = process.env.CONJURE_HOME;
    process.env.CONJURE_HOME = root;
    let db;
    try {
        db = openDb(path.join(root, "contracts.db"));
        const rev = activateRevision(db, {
            seats: [
                { id: "builder", name: "Builder", department: "Production", reportsTo: null, role: "worker", charter: "Build only the commissioned change.", processors: [{ provider: "fixture", model: "fixture" }], workspaceRoot: root, lanes: 1 },
                { id: "reviewer", name: "Reviewer", department: "Production", reportsTo: null, role: "reviewer", charter: "Assess acceptance and operator decisions.", processors: [{ provider: "fixture", model: "fixture" }], workspaceRoot: root, lanes: 1 },
            ], routing: { intake: "builder", reviewer: null, maxRounds: 3, retryLimit: 2 },
        }, "fixture", "isolated context checks");
        const rt = createRuntime(db, () => { });
        rt.providers.clear();
        rt.probed = true;
        const work = commission(db, { title: "Banner", brief: "Build the banner.", acceptance: "The banner uses the chosen name." }, "operator");
        await run({ db, rt, rev, root, work });
    }
    finally {
        db?.close();
        if (previousHome === undefined)
            delete process.env.CONJURE_HOME;
        else
            process.env.CONJURE_HOME = previousHome;
        const resolved = path.resolve(root);
        const tempRoot = path.resolve(os.tmpdir()) + path.sep;
        assert(resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("conjure-contract-check-"), "cleanup target must remain inside the fixture's temp directory");
        fs.rmSync(resolved, { recursive: true, force: true });
    }
}
function briefContext(f, role = "worker") {
    return { db: f.db, rev: f.rev, seat: f.rev.seats.find((s) => s.id === (role === "reviewer" ? "reviewer" : "builder")), work: q.work(f.db, f.work.id), role, attempts: q.attempts(f.db, f.work.id).filter((a) => a.id !== "a_contract_fixture") };
}
function successfulAttempt(f) {
    const attemptId = "a_contract_fixture";
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const endedAt = new Date(Date.now() - 1_000).toISOString();
    f.db.prepare("INSERT INTO attempts(id,work_id,seat,role,provider,model,workspace,status,started_at,ended_at,receipt,round) VALUES(?,?, 'builder','worker','fixture','fixture',?,'succeeded',?,?,?,0)")
        .run(attemptId, f.work.id, f.root, startedAt, endedAt, JSON.stringify({ outcome: "done", summary: "The original banner is complete.", evidence: [] }));
    return attemptId;
}
function readyWorld(f) {
    return { db: f.db, rev: f.rev, probed: true, known: () => true, available: () => true, slots: () => ({ slots: 1, attempts: 0, turns: 0 }), workspaceOk: () => true };
}
/** A stateless provider can return an execution ID without implementing session resumption (as Codex exec does). */
function statelessProvider(prompts) {
    return {
        name: "fixture",
        capabilities: { name: "fixture", label: "Stateless execution fixture", models: [{ id: "fixture", label: "Fixture" }], efforts: [], defaultModel: "fixture", defaultEffort: null, slots: 1 },
        async probe() { return { available: true, state: "ready", detail: "isolated fixture" }; },
        run(request) {
            prompts.push(request);
            return { pid: null, kill() { }, done: Promise.resolve({ status: "succeeded", text: request.prompt.includes("OPERATOR-CODENAME-AURORA") ? "I received OPERATOR-CODENAME-AURORA." : "The codename is missing.", providerSession: `execution-${prompts.length}`, costUsd: null, error: null }) };
        },
    };
}
/** Exercise the real async workspace boundary. The shim only delays, then delegates unchanged argv to real Git. */
async function duringWorkspace(f, mutate) {
    const git = resolveExecutable("git");
    assert(git.found && git.kind === "direct", "workspace race checks require a real Git executable");
    const runGit = async (args) => {
        const result = await execProvider(git, args, { cwd: f.root, timeoutMs: 10_000 });
        assert.equal(result.code, 0, `fixture Git failed: ${result.error ?? result.stderr}`);
    };
    await runGit(["init", "--quiet"]);
    fs.writeFileSync(path.join(f.root, "fixture.txt"), "A real committed workspace.\n");
    await runGit(["add", "fixture.txt"]);
    await runGit(["-c", "user.name=Conjure fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"]);
    const shimDir = path.join(f.root, "delayed-git");
    fs.mkdirSync(shimDir);
    const signal = path.join(shimDir, "entered"), gate = path.join(shimDir, "continue");
    const script = path.join(shimDir, "delay-git.cjs");
    fs.writeFileSync(script, [
        "const fs = require('node:fs'); const { spawnSync } = require('node:child_process');",
        `const signal = ${JSON.stringify(signal)}, gate = ${JSON.stringify(gate)}, git = ${JSON.stringify(git.path)};`,
        "fs.writeFileSync(signal, 'workspace preparation has started');",
        "const start = Date.now(); const timer = setInterval(() => {",
        "  if (!fs.existsSync(gate)) { if (Date.now() - start > 10000) { clearInterval(timer); process.exit(2); } return; }",
        "  clearInterval(timer); const result = spawnSync(git, process.argv.slice(2), { cwd: process.cwd(), stdio: 'inherit', windowsHide: true });",
        "  process.exit(result.status ?? 1);",
        "}, 10);",
    ].join("\n"));
    if (process.platform === "win32") {
        assert(!/[\r\n%]/.test(process.execPath + script), "fixture shim paths must be literal Windows arguments");
        fs.writeFileSync(path.join(shimDir, "git.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    }
    else {
        fs.writeFileSync(path.join(shimDir, "git"), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
    }
    const prompts = [];
    f.rt.providers.set("fixture", statelessProvider(prompts));
    f.db.prepare("INSERT INTO providers(name,available,detail,observed_at,state) VALUES('fixture',1,'ready',?,'ready')").run(new Date().toISOString());
    const originalPath = process.env.PATH;
    process.env.PATH = [shimDir, path.dirname(process.execPath), originalPath ?? ""].join(path.delimiter);
    let tick;
    try {
        tick = runReconcile(f.rt);
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(signal) && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert(fs.existsSync(signal), "the real reconciler did not reach delayed workspace preparation");
        mutate();
        fs.writeFileSync(gate, "continue");
        await tick;
        assert(fs.existsSync(path.join(f.root, ".conjure", "work", f.work.id, "fixture.txt")), "the delayed command must have prepared a real Git worktree");
        return prompts;
    }
    finally {
        fs.writeFileSync(gate, "continue");
        await tick;
        if (originalPath === undefined)
            delete process.env.PATH;
        else
            process.env.PATH = originalPath;
    }
}
export async function contractChecks(record) {
    const check = async (name, run) => {
        try {
            await fixture(run);
            record(name, true, "assertions passed");
        }
        catch (error) {
            record(name, false, error instanceof Error ? error.message : String(error));
        }
    };
    await check("C1: reviewer receives the operator's decided answer", (f) => {
        const judgment = askJudgment(f.db, "product", "work", f.work.id, { question: "Which name?", options: ["AURORA", "NOVA"] });
        decideJudgment(f.db, judgment.id, "AURORA", "operator", "Use the full name in the banner.");
        const prompt = renderBrief(briefContext(f, "reviewer"));
        assert(prompt.includes("AURORA") && prompt.includes("Use the full name in the banner."), "reviewer context omitted the authoritative answer or its note");
    });
    await check("C2: reviewer receives the external return the work relied on", (f) => {
        const wait = createWait(f.db, { personName: "Jane", kind: "review", subjectType: "work", subjectId: f.work.id }, "operator");
        returnWait(f.db, wait.id, "JANE-APPROVED-THE-GREEN-BANNER", "operator");
        assert(renderBrief(briefContext(f, "reviewer")).includes("JANE-APPROVED-THE-GREEN-BANNER"), "reviewer context omitted the external return");
    });
    await check("C3: a provider execution ID does not erase the next turn's saved context", async (f) => {
        const prompts = [];
        f.rt.providers.set("fixture", statelessProvider(prompts));
        f.db.prepare("INSERT INTO providers(name,available,detail,observed_at,state) VALUES('fixture',1,'ready',?,'ready')").run(new Date().toISOString());
        const conversation = createConversation(f.rt, { provider: "fixture", model: "fixture" });
        await speak(f.rt, conversation.id, "Our selected name is OPERATOR-CODENAME-AURORA.");
        const answer = await speak(f.rt, conversation.id, "Repeat the selected name.");
        assert.equal(answer.status, "done");
        assert(answer.content.includes("OPERATOR-CODENAME-AURORA"), "the second stateless execution did not receive saved conversation context");
    });
    await check("C4: Homework does not attribute unrelated questions to this submission", (f) => {
        const first = askJudgment(f.db, "product", "work", f.work.id, { question: "Name?", options: ["AURORA"] });
        const submission = submitHomework(f.db, [{ id: first.id, decision: "AURORA" }], "operator");
        const otherWork = commission(f.db, { title: "Unrelated sound", brief: "Create a sound effect." }, "operator");
        const unrelated = askJudgment(f.db, "product", "work", otherWork.id, { question: "Which sound?", options: ["chime"] });
        f.db.prepare("UPDATE judgments SET created_at=? WHERE id=?").run(new Date(Date.parse(submission.submittedAt) + 1).toISOString(), unrelated.id);
        const view = homeworkView(f.rt);
        assert(view.items.some((item) => item.id === unrelated.id), "unrelated question must remain available on the sheet");
        assert(!view.ignition?.followUps.some((item) => item.id === unrelated.id), "unrelated judgment was misrepresented as a consequence of the submitted answer");
    });
    await check("C5: a parent judgment does not claim to unblock an independently runnable child", (f) => {
        const child = commission(f.db, { title: "Independent child", brief: "Produce the small icon.", parentId: f.work.id }, "operator");
        const judgment = askJudgment(f.db, "product", "work", f.work.id, { question: "How should the whole be named?", options: ["AURORA"] });
        const item = homeworkView(f.rt).items.find((row) => row.id === judgment.id);
        assert(!item.unblocks.some((row) => row.id === child.id), "the parent question falsely claimed to hold its runnable child");
    });
    await check("C6: replacement cognition receives recent history with bounded disclosure", async (f) => {
        const prompts = [];
        f.rt.providers.set("fixture", statelessProvider(prompts));
        f.db.prepare("INSERT INTO providers(name,available,detail,observed_at,state) VALUES('fixture',1,'ready',?,'ready')").run(new Date().toISOString());
        const conversation = createConversation(f.rt, { provider: "fixture", model: "fixture" });
        f.db.prepare("UPDATE conversations SET provider_session='earlier-execution' WHERE id=?").run(conversation.id);
        const insert = f.db.prepare("INSERT INTO turns(id,conversation_id,role,content,at,status) VALUES(?,?,?,?,?,'done')");
        for (let i = 0; i < 60; i++) {
            const marker = i === 0 ? "OLDEST-HISTORY-SHOULD-NOT-BE-REPLAYED" : i === 59 ? "RECENT-HISTORY-MUST-REACH-REPLACEMENT" : `history-${i}`;
            insert.run(`t_history_${i}`, conversation.id, i % 2 ? "model" : "operator", `${marker}\n${"x".repeat(6000)}`, new Date(Date.now() - 100_000 + i).toISOString());
        }
        await speak(f.rt, conversation.id, "Continue from the recent exchange.");
        const prompt = prompts[0].prompt;
        assert(prompt.includes("RECENT-HISTORY-MUST-REACH-REPLACEMENT"), "recent saved context was not delivered to replacement cognition");
        assert(!prompt.includes("OLDEST-HISTORY-SHOULD-NOT-BE-REPLAYED"), "the complete historical conversation was disclosed rather than a bounded recent slice");
        assert(prompt.length < 150_000, "conversation context was replayed without a meaningful size bound");
    });
    await check("C7: the exact delivered prompt survives reopening the database", async (f) => {
        const api = contractAPI;
        const attemptId = successfulAttempt(f);
        const prompt = "Exact delivered input\nUnicode: Aurora 🌌\nLiteral: `code` and $variable\n";
        const captured = api.captureContract(briefContext(f), prompt);
        api.saveContract(f.db, attemptId, captured);
        const reopened = openDb(path.join(f.root, "contracts.db"));
        try {
            const restored = api.readContract(reopened, attemptId);
            assert.equal(restored?.prompt, prompt, "the delivered prompt was lost or reconstructed from current state");
            assert.equal(restored?.revisionId, f.rev.id);
            assert.equal(restored?.seatId, "builder");
            assert.equal(restored?.role, "worker");
            assert(restored?.promptHash && restored.inputsHash && Number.isFinite(Date.parse(restored.capturedAt)), "snapshot is missing durable provenance");
            assert.equal(restored.promptHash, captured.promptHash);
            assert.equal(api.readContract(reopened, "a_never_allocated"), null);
        }
        finally {
            reopened.close();
        }
    });
    await check("C8: changing only priority preserves the contract and usable result", async (f) => {
        const api = contractAPI;
        const attemptId = successfulAttempt(f);
        const ctx = briefContext(f);
        api.saveContract(f.db, attemptId, api.captureContract(ctx, renderBrief(ctx)));
        const before = api.contractStatus(f.db, attemptId);
        assert.equal(before.stale, false);
        assert.equal(before.currentHash, before.snapshot?.inputsHash);
        amendWork(f.db, f.work.id, { priority: 1 }, "operator");
        const after = api.contractStatus(f.db, attemptId);
        assert.equal(after.stale, false, "scheduling priority incorrectly invalidated semantic inputs");
        assert.equal(after.currentHash, before.currentHash);
        assert.deepEqual(after.changes, []);
        assert.equal(decide(readyWorld(f), q.work(f.db, f.work.id)).kind, "close", "a priority-only amendment unnecessarily discarded the usable result");
    });
    await check("C9: a changed acceptance marks the old contract stale and cannot silently complete work", async (f) => {
        const api = contractAPI;
        const attemptId = successfulAttempt(f);
        const ctx = briefContext(f);
        const prompt = renderBrief(ctx);
        const snapshot = api.captureContract(ctx, prompt);
        api.saveContract(f.db, attemptId, snapshot);
        assert.equal(decide(readyWorld(f), q.work(f.db, f.work.id)).kind, "close", "fixture must begin with a usable completed result");
        amendWork(f.db, f.work.id, { acceptance: "The banner includes an accessible high-contrast version." }, "operator");
        const status = api.contractStatus(f.db, attemptId);
        assert.equal(status.stale, true, "an acceptance amendment was not recognized as new semantic input");
        assert(status.changes.length > 0, "the operator was not told what changed");
        assert.notEqual(status.currentHash, snapshot.inputsHash);
        assert.equal(status.snapshot?.prompt, prompt, "the delivered snapshot changed with the new acceptance");
        const next = decide(readyWorld(f), q.work(f.db, f.work.id));
        assert(["allocate", "ask", "hold"].includes(next.kind), `obsolete acceptance result still controls the obligation: ${next.kind}`);
    });
    await check("C10: a changed brief invalidates the previous contract", async (f) => {
        const api = contractAPI;
        const attemptId = successfulAttempt(f);
        const ctx = briefContext(f);
        api.saveContract(f.db, attemptId, api.captureContract(ctx, renderBrief(ctx)));
        amendWork(f.db, f.work.id, { brief: "Build a circular badge instead of a banner." }, "operator");
        assert.equal(api.contractStatus(f.db, attemptId).stale, true, "the new brief was treated as if the earlier attempt had received it");
        assert.notEqual(decide(readyWorld(f), q.work(f.db, f.work.id)).kind, "close");
    });
    await check("C11: a newly decided operator answer changes the delivered context status", async (f) => {
        const api = contractAPI;
        const attemptId = successfulAttempt(f);
        const ctx = briefContext(f);
        api.saveContract(f.db, attemptId, api.captureContract(ctx, renderBrief(ctx)));
        const judgment = askJudgment(f.db, "product", "work", f.work.id, { question: "Which new accent?", options: ["green"] });
        decideJudgment(f.db, judgment.id, "green", "operator", null);
        assert.equal(api.contractStatus(f.db, attemptId).stale, true, "new operator truth was not distinguished from the old delivered inputs");
    });
    await check("C12: unrelated private note edits do not stale organizational cognition", async (f) => {
        const api = contractAPI;
        const note = createNote(f.db, { title: "Private thought", body: "PRIVATE-NOTE-MUST-NOT-REACH-WORK" });
        const attemptId = successfulAttempt(f);
        const ctx = briefContext(f);
        const snapshot = api.captureContract(ctx, renderBrief(ctx));
        api.saveContract(f.db, attemptId, snapshot);
        assert(!snapshot.prompt.includes("PRIVATE-NOTE-MUST-NOT-REACH-WORK"));
        updateNote(f.db, note.id, { body: "A changed private thought." });
        assert.equal(api.contractStatus(f.db, attemptId).stale, false, "unrelated private context leaked into the obligation's semantic fingerprint");
    });
    await check("C13: cancellation during workspace preparation prevents allocation", async (f) => {
        const prompts = await duringWorkspace(f, () => { cancelWork(f.db, f.work.id, "operator", "Intent withdrawn while preparing."); });
        assert.equal(q.work(f.db, f.work.id)?.status, "cancelled");
        assert.equal(q.attempts(f.db, f.work.id).length, 0, "canceled work still created an attempt after workspace preparation");
        assert.equal(q.leases(f.db).length, 0, "canceled work still acquired a lease");
        assert.equal(prompts.length, 0, "cognition was purchased after cancellation");
    });
    await check("C14: a judgment added during workspace preparation prevents allocation", async (f) => {
        const prompts = await duringWorkspace(f, () => { askJudgment(f.db, "product", "work", f.work.id, { question: "Pause until I choose a name.", options: ["AURORA"] }); });
        assert(q.openJudgmentFor(f.db, "work", f.work.id));
        assert.equal(q.attempts(f.db, f.work.id).length, 0, "work allocated without waiting for the newly owed judgment");
        assert.equal(q.leases(f.db).length, 0);
        assert.equal(prompts.length, 0);
    });
    await check("C15: an amendment during workspace preparation reaches the actual attempt", async (f) => {
        const prompts = await duringWorkspace(f, () => { amendWork(f.db, f.work.id, { brief: "Build the revised OPERATOR-CODENAME-AURORA banner." }, "operator"); });
        assert.equal(prompts.length, 1, "exactly one attempt should receive the revised obligation");
        assert(prompts[0].prompt.includes("Build the revised OPERATOR-CODENAME-AURORA banner."), "the allocation used the pre-await brief");
        const attempt = q.attempts(f.db, f.work.id)[0];
        assert.equal(contractAPI.readContract(f.db, attempt.id)?.prompt, prompts[0].prompt, "stored context is not the context delivered to the provider");
    });
    await check("C16: a semantic amendment does not resurrect failures preceding a successful result", (f) => {
        const failure = f.db.prepare("INSERT INTO attempts(id,work_id,seat,role,provider,model,workspace,status,started_at,ended_at,error,round) VALUES(?,?,'builder','worker','fixture','fixture',?,'failed',?,?, 'transient failure',0)");
        for (let i = 0; i < 2; i++) {
            const at = Date.now() - 120_000 + i * 20_000;
            failure.run(`a_old_failure_${i}`, f.work.id, f.root, new Date(at - 1_000).toISOString(), new Date(at).toISOString());
        }
        const attemptId = successfulAttempt(f);
        const ctx = briefContext(f);
        contractAPI.saveContract(f.db, attemptId, contractAPI.captureContract(ctx, renderBrief(ctx)));
        const changed = amendWork(f.db, f.work.id, { brief: "Produce the newly scoped banner." }, "operator");
        assert.equal(decide(readyWorld(f), changed).kind, "allocate", "the revised task should be ready for its first attempt");
        const failedAt = Date.parse(changed.updatedAt) + 2;
        failure.run("a_first_new_failure", f.work.id, f.root, new Date(failedAt - 1).toISOString(), new Date(failedAt).toISOString());
        const next = decide(readyWorld(f), q.work(f.db, f.work.id));
        assert(next.kind === "hold" && next.reason === "backoff", "the first failure on revised work revived the old failure streak and demanded recovery judgment");
    });
    await check("C17: a legacy result survives priority changes but cannot close a newly amended contract", (f) => {
        const attemptId = successfulAttempt(f);
        assert.equal(contractAPI.readContract(f.db, attemptId), null, "fixture must represent an attempt predating snapshot recording");
        assert.equal(decide(readyWorld(f), q.work(f.db, f.work.id)).kind, "close", "unchanged legacy work must remain compatible");
        amendWork(f.db, f.work.id, { priority: 1 }, "operator");
        assert.equal(decide(readyWorld(f), q.work(f.db, f.work.id)).kind, "close", "a priority edit must not invent uncertainty about the original acceptance");
        amendWork(f.db, f.work.id, { acceptance: "The revised banner includes an accessible high-contrast version." }, "operator");
        assert.notEqual(decide(readyWorld(f), q.work(f.db, f.work.id)).kind, "close", "a known semantic amendment still closed with a pre-snapshot receipt");
        assert.equal(contractAPI.readContract(f.db, attemptId), null, "legacy input must not be fabricated from the current contract");
    });
    await check("C18: a passing reviewer cannot make its stale worker result authoritative", (f) => {
        f.rev = activateRevision(f.db, { seats: f.rev.seats, routing: { ...f.rev.routing, reviewer: "reviewer" } }, "operator", "enable review");
        const workerId = successfulAttempt(f);
        const workerContext = briefContext(f);
        contractAPI.saveContract(f.db, workerId, contractAPI.captureContract(workerContext, renderBrief(workerContext)));
        const reviewId = "a_review_fixture";
        f.db.prepare("INSERT INTO attempts(id,work_id,seat,role,provider,model,workspace,status,started_at,ended_at,receipt,round) VALUES(?,?,'reviewer','reviewer','fixture','fixture',?,'succeeded',?,?,?,0)")
            .run(reviewId, f.work.id, f.root, new Date(Date.now() - 500).toISOString(), new Date(Date.now() - 250).toISOString(), JSON.stringify({ outcome: "verdict", pass: true, summary: "The original result satisfies the original constraints." }));
        const reviewContext = { ...briefContext(f, "reviewer"), attempts: [q.attempt(f.db, workerId)] };
        contractAPI.saveContract(f.db, reviewId, contractAPI.captureContract(reviewContext, renderBrief(reviewContext)));
        assert.equal(decide(readyWorld(f), q.work(f.db, f.work.id)).kind, "close", "a matching worker result and review should close before the charter changes");
        f.rev = editSeat(f.db, "builder", { charter: "Every delivered design must include an accessible high-contrast version." }, "operator");
        assert.equal(contractAPI.contractStatus(f.db, workerId).stale, true, "the fixture must invalidate the worker's supplied constraints");
        assert.notEqual(decide(readyWorld(f), q.work(f.db, f.work.id)).kind, "close", "a fresh reviewer verdict closed an obsolete worker result");
    });
    await check("C19: changed note content cannot cross the commissioning boundary under an old preview", (f) => {
        const note = createNote(f.db, { title: "The reviewed note", body: "Only the content the operator previewed." });
        const preview = contractPreview(f.db, note.id, "builder");
        updateNote(f.db, note.id, { body: "NEW-CONTENT-ADDED-AFTER-PREVIEW" });
        assert.throws(() => handNoteToConjure(f.db, note.id, "builder", "operator", preview.fingerprint), /changed|review/i, "commissioning accepted content absent from the approved preview");
        assert.equal(ideas.note(f.db, note.id)?.servedWorkId, null, "rejected handoff froze the note");
        assert.equal(f.db.prepare("SELECT id FROM work WHERE source_kind='note' AND source_ref=?").get(note.id), undefined, "rejected handoff still created organizational work");
        assert.equal(f.db.prepare("SELECT id FROM evidence WHERE kind='note' AND locator=?").get(note.id), undefined, "rejected handoff left source evidence behind");
        const fresh = contractPreview(f.db, note.id, "builder");
        assert.notEqual(fresh.fingerprint, preview.fingerprint);
        const work = handNoteToConjure(f.db, note.id, "builder", "operator", fresh.fingerprint);
        assert.equal(work.brief, "NEW-CONTENT-ADDED-AFTER-PREVIEW");
        assert.equal(ideas.note(f.db, note.id)?.servedWorkId, work.id);
        assert.equal(handNoteToConjure(f.db, note.id, "builder", "operator", fresh.fingerprint).id, work.id, "repeating the accepted handoff duplicated responsibility");
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM work WHERE source_kind='note' AND source_ref=?").get(note.id).n, 1);
    });
    await check("C20: changed seat terms require a fresh note preview before commissioning", (f) => {
        const note = createNote(f.db, { title: "Workspace permission", body: "Create a small banner." });
        let preview = contractPreview(f.db, note.id, "builder");
        f.rev = editSeat(f.db, "builder", { charter: "Create a banner and publish the result." }, "operator");
        assert.throws(() => handNoteToConjure(f.db, note.id, "builder", "operator", preview.fingerprint), /changed|review/i, "the old preview authorized a changed seat charter");
        assert.equal(ideas.note(f.db, note.id)?.servedWorkId, null);
        preview = contractPreview(f.db, note.id, "builder");
        const differentWorkspace = path.join(f.root, "different-workspace");
        fs.mkdirSync(differentWorkspace);
        f.rev = editSeat(f.db, "builder", { workspaceRoot: differentWorkspace }, "operator");
        assert.throws(() => handNoteToConjure(f.db, note.id, "builder", "operator", preview.fingerprint), /changed|review/i, "the old preview authorized access to a different workspace");
        assert.equal(ideas.note(f.db, note.id)?.servedWorkId, null);
        assert.equal(f.db.prepare("SELECT id FROM work WHERE source_kind='note' AND source_ref=?").get(note.id), undefined);
        const fresh = contractPreview(f.db, note.id, "builder");
        assert(fresh.conjureMaySee.some((scope) => scope.includes(differentWorkspace)), "the fresh preview must disclose the changed workspace");
        const work = handNoteToConjure(f.db, note.id, "builder", "operator", fresh.fingerprint);
        assert.equal(work.seat, "builder");
        assert.equal(ideas.note(f.db, note.id)?.servedWorkId, work.id);
    });
    await check("C21: cancellation of later work during another allocation cannot become a delivered return", async (f) => {
        amendWork(f.db, f.work.id, { priority: 0 }, "operator");
        const later = commission(f.db, { title: "Later ready result", brief: "Deliver the later banner.", priority: 2 }, "operator");
        const laterFixture = { ...f, work: later };
        const attemptId = successfulAttempt(laterFixture);
        const ctx = briefContext(laterFixture);
        contractAPI.saveContract(f.db, attemptId, contractAPI.captureContract(ctx, renderBrief(ctx)));
        await duringWorkspace(f, () => { cancelWork(f.db, later.id, "operator", "Withdrawn while the earlier work prepares."); });
        assert.equal(q.work(f.db, later.id)?.status, "cancelled", "the tick's cached open-work list changed a canceled obligation back to done");
        const returns = f.db.prepare("SELECT outcome FROM returns WHERE work_id=? ORDER BY created_at").all(later.id);
        assert.deepEqual(returns.map((row) => row.outcome), ["stopped"], "the withdrawn result was also presented as delivered");
    });
    await check("C22: upgrading a populated v6 database preserves its durable rows without inventing old prompts", (f) => {
        const attemptId = successfulAttempt(f);
        const note = createNote(f.db, { title: "Private legacy note", body: "LEGACY-PRIVATE-NOTE" });
        const judgment = askJudgment(f.db, "product", "work", f.work.id, { question: "Legacy preference?", options: ["AURORA"] });
        decideJudgment(f.db, judgment.id, "AURORA", "operator", "Keep this historical answer.");
        createWait(f.db, { personName: "Legacy collaborator", kind: "review", subjectType: "work", subjectId: f.work.id }, "operator");
        // v7 is one additive table. Removing that empty table recreates the exact v6 schema with populated rows.
        f.db.exec("DROP TABLE attempt_contracts");
        f.db.pragma("user_version = 6");
        const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
        const before = new Map(tables.map((table) => [table, f.db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
        const upgraded = openDb(path.join(f.root, "contracts.db"));
        try {
            assert.equal(upgraded.pragma("user_version", { simple: true }), 7);
            for (const table of tables)
                assert.deepEqual(upgraded.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all(), before.get(table), `migration changed legacy rows in ${table}`);
            assert.deepEqual(upgraded.pragma("foreign_key_check"), [], "migration left dangling durable references");
            assert.equal(contractAPI.readContract(upgraded, attemptId), null, "an old attempt was assigned a prompt it never received");
            assert.equal(ideas.note(upgraded, note.id)?.body, "LEGACY-PRIVATE-NOTE");
            const ctx = { ...briefContext(f), db: upgraded };
            contractAPI.saveContract(upgraded, attemptId, contractAPI.captureContract(ctx, "Explicit new fixture snapshot."));
            assert.equal(contractAPI.readContract(upgraded, attemptId)?.prompt, "Explicit new fixture snapshot.", "the upgraded table cannot persist new context evidence");
        }
        finally {
            upgraded.close();
        }
    });
    await check("C23: an exact work detail preserves older returns and every Return field beyond the global shelf limit", (f) => {
        const attemptId = successfulAttempt(f);
        const older = [
            { id: "ret_old_stopped", workId: f.work.id, attemptId: null, outcome: "stopped", summary: "An earlier cancellation remains historical truth.", createdAt: "2020-01-01T00:00:00.000Z", seenAt: null },
            { id: "ret_old_delivered", workId: f.work.id, attemptId, outcome: "delivered", summary: "The older result 🌌\nwith its recorded acknowledgment.", createdAt: "2020-01-02T00:00:00.000Z", seenAt: "2020-01-03T00:00:00.000Z" },
        ];
        const unrelated = commission(f.db, { title: "Later unrelated history", brief: "Other work's returns must not hide the selected obligation." }, "operator");
        const insert = f.db.prepare("INSERT INTO returns(id,work_id,attempt_id,outcome,summary,created_at,seen_at) VALUES(?,?,?,?,?,?,?)");
        f.db.transaction(() => {
            for (const row of older)
                insert.run(row.id, row.workId, row.attemptId, row.outcome, row.summary, row.createdAt, row.seenAt);
            for (let i = 0; i < 1_005; i++)
                insert.run(`ret_newer_${i}`, unrelated.id, null, "delivered", `Unrelated result ${i}`, new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(), null);
        })();
        assert(!q.returns(f.db, 1_000).some((row) => row.workId === f.work.id), "fixture must place selected work beyond the global shelf window");
        const detail = workDetail(f.db, f.work.id);
        assert(detail, "the exact work must remain inspectable");
        assert.deepEqual(detail.returns, older, "exact work detail lost old returns, their order, nullable attempt IDs, or seenAt acknowledgment state");
    });
    await check("C24: a wide process trace returns the exact latest 80 descendant events across query chunks", (f) => {
        const works = [f.work.id];
        const targets = [];
        const insertAttempt = f.db.prepare("INSERT INTO attempts(id,work_id,seat,role,provider,model,workspace,status,started_at,ended_at,receipt,round) VALUES(?,?,'builder','worker','fixture','fixture',?,'succeeded',?,?,?,0)");
        f.db.transaction(() => {
            for (let branch = 0; branch < 10; branch++) {
                const child = commission(f.db, { title: `Part ${branch}`, brief: "Deliver this part.", parentId: f.work.id }, "operator");
                works.push(child.id);
                for (let leaf = 0; leaf < 100; leaf++) {
                    const grandchild = commission(f.db, { title: `Part ${branch}.${leaf}`, brief: "Deliver the small piece.", parentId: child.id }, "operator");
                    works.push(grandchild.id);
                    if (leaf === 0 || leaf === 99) {
                        const attemptId = `a_trace_${branch}_${leaf}`;
                        insertAttempt.run(attemptId, grandchild.id, f.root, "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:01.000Z", JSON.stringify({ outcome: "done", summary: "The piece was delivered.", evidence: [] }));
                        const judgment = askJudgment(f.db, "product", "work", grandchild.id, { question: `Choose the accent for ${branch}.${leaf}.`, options: ["green"] });
                        targets.push({ workId: grandchild.id, attemptId, judgmentId: judgment.id });
                    }
                }
            }
        })();
        assert.equal(works.length, 1_011, "the fixture must exceed SQLite's 1,000-expression depth limit");
        const unrelated = commission(f.db, { title: "Outside this process", brief: "Keep this history out of the selected process." }, "operator");
        const relevant = [];
        f.db.transaction(() => {
            for (let i = 0; i < 120; i++) {
                // Spread recent events over the whole tree, including its attempt and judgment identities.
                const target = targets[i % targets.length];
                relevant.push(append(f.db, "work", works[(i * 137) % works.length], "trace-fixture-work", { summary: `work event ${i}` }));
                relevant.push(append(f.db, "attempt", target.attemptId, "trace-fixture-attempt", { workId: target.workId, summary: `attempt event ${i}` }));
                relevant.push(append(f.db, "judgment", target.judgmentId, "trace-fixture-judgment", { workId: target.workId, decision: `decision ${i}` }));
                append(f.db, "work", unrelated.id, "unrelated", { summary: `unrelated event ${i}` });
            }
        })();
        const trace = traceView(f.db, "work", f.work.id);
        assert.equal(trace.node, `work:${f.work.id}`);
        assert.equal(trace.steps.length, 80);
        assert.deepEqual(trace.steps.map(({ seq, at, node, kind }) => ({ seq, at, node, kind })), relevant.slice(-80).map((event) => ({ seq: event.seq, at: event.at, node: `${event.entityType}:${event.entityId}`, kind: event.kind })), "chunk merging lost, duplicated, misordered, or admitted unrelated events into the global latest 80");
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    let failed = 0;
    await contractChecks((name, ok, note) => { if (!ok)
        failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}  - ${note}`); });
    process.exitCode = failed ? 1 : 0;
}
//# sourceMappingURL=contracts.js.map