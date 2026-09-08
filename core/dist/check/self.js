// Conjure's truth about itself, proven with real processes: a supervisor on a temp home running edition A, a
// proposed edition B that genuinely has one more capability (its compiled capabilities.js differs), a broken
// edition C. Switch, probation, auto-revert, provenance across restart, persisted browser sessions, and the cold
// block Command Control receives before and after. Nothing here touches the developer's checkout or ~/.conjure.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkNodeModules } from "../editions.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, ".."); // the dist this check runs from
const CORE = path.join(DIST, ".."); // packages/core (dist, assets, package.json, node_modules)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A fake but runnable edition: this dist copied, with its own manifest; optionally one more capability, or a broken entry. */
export function makeEdition(home, id, opts) {
    const root = path.join(home, "editions", id, "core");
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(path.join(CORE, "dist"), path.join(root, "dist"), { recursive: true });
    fs.cpSync(path.join(CORE, "assets"), path.join(root, "assets"), { recursive: true });
    fs.copyFileSync(path.join(CORE, "package.json"), path.join(root, "package.json"));
    linkNodeModules(path.join(CORE, "node_modules"), path.join(root, "node_modules"));
    const capFile = path.join(root, "dist", "capabilities.js");
    let caps = JSON.parse(fs.readFileSync(path.join(root, "dist", "build.json"), "utf8")).capabilities;
    if (opts.extraCapability) {
        const src = fs.readFileSync(capFile, "utf8").replace("export const CAPABILITIES = [", `export const CAPABILITIES = [\n    { id: ${JSON.stringify(opts.extraCapability.id)}, name: ${JSON.stringify(opts.extraCapability.name)}, summary: "added for the check", route: "#/x" },`);
        if (!src.includes(opts.extraCapability.id))
            throw new Error("could not patch capabilities.js");
        fs.writeFileSync(capFile, src);
        caps = [{ id: opts.extraCapability.id, name: opts.extraCapability.name }, ...caps];
    }
    if (opts.broken)
        fs.writeFileSync(path.join(root, "dist", "gateway-entry.js"), "console.error('broken edition: refusing to boot'); process.exit(7);\n");
    const manifest = { sha: opts.sha, branch: `check/${id}`, subject: opts.subject, builtAt: new Date().toISOString(), dirty: false, schemaVersion: 4, capabilities: caps, webHash: null, sourcePath: opts.sourcePath ?? path.join(home, "no-such-source"), editionId: id };
    const idx = path.join(root, "dist", "web", "index.html");
    if (fs.existsSync(idx))
        manifest.webHash = createHash("sha1").update(fs.readFileSync(idx)).digest("hex").slice(0, 16);
    fs.writeFileSync(path.join(root, "dist", "build.json"), JSON.stringify(manifest, null, 2));
    return { id, status: opts.status, path: root, note: `check edition ${id}`, proposedAt: new Date().toISOString(), proposedBy: "check", acceptedAt: null, rejectedAt: null, checks: { passed: 1, total: 1, at: new Date().toISOString() }, canonical: null, build: manifest, events: [] };
}
export function writeRegistry(home, reg) { fs.mkdirSync(path.join(home, "editions"), { recursive: true }); fs.writeFileSync(path.join(home, "editions", "editions.json"), JSON.stringify(reg, null, 2)); }
export function readRegistry(home) { return JSON.parse(fs.readFileSync(path.join(home, "editions", "editions.json"), "utf8")); }
const gatewayRecord = (home) => { try {
    return JSON.parse(fs.readFileSync(path.join(home, "gateway.json"), "utf8"));
}
catch {
    return null;
} };
const supervisorRecord = (home) => { try {
    return JSON.parse(fs.readFileSync(path.join(home, "supervisor.json"), "utf8"));
}
catch {
    return null;
} };
export async function health(base) { try {
    const r = await fetch(`${base}/api/health`);
    return (await r.json());
}
catch {
    return null;
} }
export async function waitHealthy(w, notBoot, ms = 40_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const h = await health(w.base);
        const g = gatewayRecord(w.home);
        if (h?.ready && g && h.bootId === g.bootId && (!notBoot || h.bootId !== notBoot))
            return { bootId: h.bootId, controlSecret: g.controlSecret };
        await sleep(100);
    }
    return null;
}
export async function get(w, p, secret, extra = {}) { const r = await fetch(w.base + p, { headers: { ...(secret ? { authorization: `Conjure ${secret}` } : {}), ...extra } }); return { status: r.status, body: (await r.json().catch(() => null)) }; }
export async function post(w, p, secret, body = {}) { const r = await fetch(w.base + p, { method: "POST", headers: { authorization: `Conjure ${secret}`, origin: w.base, "content-type": "application/json" }, body: JSON.stringify(body) }); return (await r.json()); }
/** Boot the supervisor of the edition the registry names as current. */
export function startSupervisor(w) {
    const reg = readRegistry(w.home);
    const cur = reg.editions.find((e) => e.id === reg.current);
    const entry = path.join(cur.path, "dist", "supervisor-entry.js");
    w.sup = spawn(process.execPath, [entry], { env: w.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}
export async function stopWorld(w) {
    const sup = supervisorRecord(w.home);
    const gw = gatewayRecord(w.home);
    try {
        w.sup?.kill();
    }
    catch { /* gone */ }
    if (sup) {
        try {
            process.kill(sup.pid);
        }
        catch { /* gone */ }
    }
    if (gw) {
        try {
            process.kill(gw.pid);
        }
        catch { /* gone */ }
    }
    await sleep(400);
}
let nextPort = 8300 + Math.floor(Math.random() * 300);
export function makeWorld() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-self-"));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-self-ws-"));
    const port = nextPort++;
    const env = { ...process.env, CONJURE_HOME: home, CONJURE_PORT: String(port), CONJURE_FAKE_PROVIDER: "1", CONJURE_WORKSPACE_ROOT: ws, CONJURE_QUIET: "1", CONJURE_FALLBACK_MS: "2000", CONJURE_PROBE_MS: "1500", CONJURE_SUPERVISOR_PROBE_MS: "700" };
    return { home, port, base: `http://127.0.0.1:${port}`, ws, env, sup: null };
}
/** The two-edition world every journey starts from: A current (this build), B proposed (this build + a capability no real build has), C broken. */
export function seedWorld(w) {
    const a = makeEdition(w.home, "ed_aaaaaaa", { sha: "a".repeat(40), subject: "Conjure as it is", status: "current" });
    a.acceptedAt = new Date().toISOString(); // the established reality, not a trial
    const b = makeEdition(w.home, "ed_bbbbbbb", { sha: "b".repeat(40), subject: "Teleport for the operator", extraCapability: { id: "teleport", name: "Teleport" }, status: "proposed" });
    const c = makeEdition(w.home, "ed_ccccccc", { sha: "c".repeat(40), subject: "A build that cannot boot", broken: true, status: "proposed" });
    writeRegistry(w.home, { current: "ed_aaaaaaa", previous: null, switch: null, probation: null, editions: [a, b, c] });
}
async function controlPromptBlock(w, secret, question) {
    const convs = await get(w, "/api/conversations", secret);
    let c = convs.body.find((x) => x.role === "control");
    if (!c)
        c = await post(w, "/api/conversations", secret, { role: "control", provider: "fake", model: "m" });
    const turn = await post(w, `/api/conversations/${c.id}/speak`, secret, { content: `${question} [[fake: dump]]` });
    const text = turn.content ?? "";
    const i = text.indexOf("CONJURE ITSELF");
    return i >= 0 ? text.slice(i, text.indexOf("Rule for questions about Conjure itself", i)) : "";
}
async function waitProbationClear(w, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) {
    if (!readRegistry(w.home).probation)
        return true;
    await sleep(100);
} return false; }
export async function selfChecks(record) {
    const w = makeWorld();
    seedWorld(w);
    try {
        startSupervisor(w);
        let g = await waitHealthy(w);
        if (!g)
            throw new Error("edition A never became healthy");
        // --- S1: the running Conjure knows what it is and what exists ------------------------------------------
        const s0 = (await get(w, "/api/self", g.controlSecret)).body;
        const capsA = s0.running.capabilities.map((c) => c.name);
        const readyB = s0.ready.find((e) => e.id === "ed_bbbbbbb");
        record("S1: /api/self states running edition, its complete capability list, and what a proposed edition adds", s0.running.editionId === "ed_aaaaaaa" && !capsA.includes("Teleport") && !!readyB && readyB.adds.join() === "Teleport" && s0.ready.length === 2 && s0.skew.length === 0 && s0.supervisor?.alive === true, `running=${s0.running.editionId} caps=${capsA.length} homework=${capsA.includes("Teleport")} ready=${s0.ready.map((e) => e.id).join(",")} adds(B)=${readyB?.adds.join(",")} skew=${s0.skew.length}`);
        // --- S2: Command Control's cold block, before -----------------------------------------------------------
        const before = await controlPromptBlock(w, g.controlSecret, "Do we have Teleport?");
        const capLineBefore = before.split("\n").find((l) => l.startsWith("Capabilities of the running Conjure")) ?? "";
        record("S2: Control receives a complete running-capability list WITHOUT Teleport and names the edition that adds it", before.length > 0 && !capLineBefore.includes("Teleport") && before.includes("Edition ready to evaluate: ed_bbbbbbb") && before.includes("ADDS: Teleport") && before.includes("It is NOT running"), `capLine="${capLineBefore.slice(0, 90)}…" mentionsB=${before.includes("ed_bbbbbbb")}`);
        const briefing = (await get(w, "/api/control", g.controlSecret)).body;
        record("S2b: the Control recommendation surfaces the edition when nothing else needs the operator", /edition of Conjure is ready to try/.test(briefing.recommendation) && briefing.recommendation.includes("Teleport"), briefing.recommendation.slice(0, 140));
        // --- S3: a browser session survives the switch --------------------------------------------------------------
        const tk = await fetch(`${w.base}/__conjure/session`, { method: "POST", headers: { authorization: `Conjure ${g.controlSecret}` } });
        const ticket = (await tk.json()).ticket;
        const boot = await fetch(`${w.base}/?bootstrap=${encodeURIComponent(ticket)}`, { redirect: "manual" });
        const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0];
        const okBefore = (await fetch(`${w.base}/api/status`, { headers: { cookie } })).status;
        // --- S4: switch to B: gateway records and exits, supervisor runs B, probation clears when healthy ---------------
        const sw = await post(w, "/api/self/editions/ed_bbbbbbb/switch", g.controlSecret);
        const oldBoot = g.bootId;
        g = await waitHealthy(w, oldBoot);
        const cleared = g ? await waitProbationClear(w) : false;
        const reg1 = readRegistry(w.home);
        const s1 = g ? (await get(w, "/api/self", g.controlSecret)).body : null;
        record("S4: switching is one operator action: the supervisor runs the chosen edition, on probation until healthy, with a backup taken first", sw.switching === true && !!g && cleared && reg1.current === "ed_bbbbbbb" && reg1.previous === "ed_aaaaaaa" && !!s1 && s1.running.editionId === "ed_bbbbbbb" && s1.running.capabilities.some((c) => c.name === "Teleport") && s1.previous?.id === "ed_aaaaaaa" && !!sw.backup && fs.existsSync(sw.backup) && supervisorRecord(w.home)?.edition === "ed_bbbbbbb", `switching=${sw.switching ?? sw.error} newBoot=${g?.bootId} probationCleared=${cleared} current=${reg1.current} previous=${reg1.previous} homeworkRunning=${s1?.running.capabilities.some((c) => c.name === "Teleport")} backup=${sw.backup ? "yes" : "no"}`);
        const okAfter = (await fetch(`${w.base}/api/status`, { headers: { cookie } })).status;
        record("S3: the operator's browser session survives the switch (no launcher round-trip)", okBefore === 200 && okAfter === 200, `status before=${okBefore} after=${okAfter}`);
        // --- S5: the same question, after -----------------------------------------------------------------------------
        const after = g ? await controlPromptBlock(w, g.controlSecret, "Do we have Teleport?") : "";
        const capLineAfter = after.split("\n").find((l) => l.startsWith("Capabilities of the running Conjure")) ?? "";
        record("S5: after the switch the same question is answered from updated truth: Teleport is running, on trial, with go-back available", capLineAfter.includes("Teleport") && after.includes("on trial: not yet accepted") && after.includes("Previous edition kept: ed_aaaaaaa") && !after.includes("Edition ready to evaluate: ed_bbbbbbb"), `capLine has Teleport=${capLineAfter.includes("Teleport")} trial=${after.includes("on trial")} previous=${after.includes("Previous edition kept")}`);
        const hl = g ? (await get(w, "/api/control", g.controlSecret)).body.changed.highlights : [];
        record("S5b: the switch is an organizational event Control can recount", hl.some((h) => /Conjure edition ed_bbbbbbb switch requested/.test(h)), hl.filter((h) => h.includes("edition")).join(" | ").slice(0, 160) || "no edition highlight");
        // --- S6: provenance survives a full restart of the supervisor ---------------------------------------------------
        await stopWorld(w);
        startSupervisor(w);
        g = await waitHealthy(w);
        const s2 = g ? (await get(w, "/api/self", g.controlSecret)).body : null;
        record("S6: after a full restart the same edition runs and knows it is on trial with the previous one kept", !!s2 && s2.running.editionId === "ed_bbbbbbb" && s2.running.accepted === false && s2.previous?.id === "ed_aaaaaaa" && s2.skew.length === 0, `running=${s2?.running.editionId} accepted=${s2?.running.accepted} previous=${s2?.previous?.id} skew=${s2?.skew.join(" | ")}`);
        // --- S7: a broken edition never becomes the reality: supervisor reverts by itself --------------------------------
        const oldBoot2 = g.bootId;
        const swC = await post(w, "/api/self/editions/ed_ccccccc/switch", g.controlSecret);
        g = await waitHealthy(w, oldBoot2);
        const reg2 = readRegistry(w.home);
        const cE = reg2.editions.find((e) => e.id === "ed_ccccccc");
        record("S7: an edition that cannot boot is marked failed and the previous reality is restored without the operator", swC.switching === true && !!g && reg2.current === "ed_bbbbbbb" && cE.status === "failed" && /before becoming healthy/.test(cE.events.at(-1)?.detail ?? "") && !reg2.probation, `current=${reg2.current} C=${cE.status} (${cE.events.at(-1)?.detail ?? ""}) probation=${JSON.stringify(reg2.probation)}`);
        // --- S8: accept and reject; the list stays flat ----------------------------------------------------------------
        const acc = await post(w, "/api/self/editions/ed_bbbbbbb/accept", g.controlSecret);
        const rej = await post(w, "/api/self/editions/ed_aaaaaaa/reject", g.controlSecret, { reason: "check" });
        const reg3 = readRegistry(w.home);
        const bE = reg3.editions.find((e) => e.id === "ed_bbbbbbb");
        const flat = reg3.editions.every((e) => !("parent" in e) && !("children" in e)) && reg3.editions.filter((e) => e.status === "current").length === 1;
        record("S8: accepting records canonical intent (source gone: main line untouched); rejecting the previous one removes go-back; the list is flat with exactly one current", !acc.error && !!bE.acceptedAt && /source .* is gone/.test(bE.canonical ?? "") && !rej.error && reg3.previous === null && reg3.editions.find((e) => e.id === "ed_aaaaaaa").status === "rejected" && !fs.existsSync(path.join(w.home, "editions", "ed_aaaaaaa")) && flat, `accepted=${!!bE.acceptedAt} canonical="${bE.canonical}" previous=${reg3.previous} A=${reg3.editions.find((e) => e.id === "ed_aaaaaaa").status} flat=${flat}`);
        // --- S9: skew is detectable: the code on disk changes under a running gateway ------------------------------------
        const bDist = path.join(w.home, "editions", "ed_bbbbbbb", "core", "dist");
        const m = JSON.parse(fs.readFileSync(path.join(bDist, "build.json"), "utf8"));
        fs.writeFileSync(path.join(bDist, "build.json"), JSON.stringify({ ...m, sha: "d".repeat(40) }));
        fs.appendFileSync(path.join(bDist, "web", "index.html"), "\n<!-- rebuilt behind the server's back -->\n");
        const s3 = (await get(w, "/api/self", g.controlSecret)).body;
        const st = (await get(w, "/api/status", g.controlSecret)).body;
        record("S9: source/build/runtime disagreement is detected, not hidden: code on disk and served UI changed under the running server", s3.skew.some((k) => /code on disk .* changed after this Conjure started/.test(k)) && s3.skew.some((k) => /web UI on disk changed/.test(k)) && st.self.skew >= 2, s3.skew.map((k) => k.slice(0, 70)).join(" | "));
        // --- S10: the CLI sees the same registry when nothing runs -------------------------------------------------------
        await stopWorld(w);
        const cli = spawn(process.execPath, [path.join(DIST, "cli.js"), "edition", "list"], { env: w.env, windowsHide: true });
        let out = "";
        cli.stdout.on("data", (d) => { out += d.toString(); });
        await new Promise((r) => cli.on("exit", r));
        record("S10: `conjure edition list` reads the same registry offline", out.includes("ed_bbbbbbb") && out.includes("CURRENT") && out.includes("ed_ccccccc") && out.includes("failed"), out.split("\n")[0]?.slice(0, 120) ?? "");
    }
    finally {
        await stopWorld(w);
    }
}
//# sourceMappingURL=self.js.map