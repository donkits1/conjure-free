// One truthful account of whether this installation can actually do anything, and what to fix if not.
//
// Portable on purpose: the Windows launcher renders this report, it does not compute it. Nothing here
// knows about installers, Start menus, or drive letters. A hosted deployment can serve the same report.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { conjureHome, gatewayPort, paths } from "./home.js";
import { providerRegistry } from "./providers.js";
import { resolveExecutable } from "./provider-exec.js";
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === "EPERM";
    }
}
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
}
function appDir() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
export function conjureVersion() {
    return String(readJson(path.join(appDir(), "package.json"))?.version ?? "unknown");
}
/** What to tell someone whose provider is not usable. Instructions only; Conjure never installs or signs in for them. */
const GUIDANCE = {
    claude: {
        install: "Install Claude Code: open a terminal and run  npm install -g @anthropic-ai/claude-code",
        auth: "Sign in: open a terminal and run  claude  then follow the prompts. Conjure never stores your credentials.",
    },
    codex: {
        install: "Install Codex: open a terminal and run  npm install -g @openai/codex",
        auth: "Sign in: open a terminal and run  codex login. Conjure never stores your credentials.",
    },
};
function guidanceFor(name, state) {
    const g = GUIDANCE[name];
    switch (state) {
        case "ready": return null;
        case "not-installed": return g?.install ?? `Install the ${name} CLI and make sure it is on your PATH.`;
        case "not-executable": return `The ${name} command was found but this computer cannot run it. Reinstall it, or set CONJURE_${name.toUpperCase()}_BIN to the full path of the program.`;
        case "not-authenticated": return g?.auth ?? `Sign in to ${name} in a terminal.`;
        default: return `Run the ${name} CLI in a terminal to see what it reports.`;
    }
}
async function httpStatus(port) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal });
        const body = (await r.json().catch(() => null));
        return { status: r.status, healthy: r.ok && body?.ok === true && body.ready === true };
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(t);
    }
}
/** Is the port free, and if not, is it ours? Answered without assuming any particular OS tool exists. */
async function portState(port, gatewayAlive) {
    const net = await import("node:net");
    const inUse = await new Promise((resolve) => {
        const s = net.createServer();
        s.once("error", (e) => resolve(e.code === "EADDRINUSE"));
        s.once("listening", () => s.close(() => resolve(false)));
        s.listen(port, "127.0.0.1");
    });
    if (!inUse)
        return { free: true, owner: null };
    const http = await httpStatus(port);
    if (http)
        return { free: false, owner: gatewayAlive ? "Conjure" : "something answering Conjure's API" };
    return { free: false, owner: "another application" };
}
export async function diagnose() {
    const home = conjureHome();
    const port = gatewayPort();
    const sup = readJson(paths.supervisor());
    const gw = readJson(paths.gateway());
    const supPid = typeof sup?.pid === "number" ? sup.pid : null;
    const gwPid = typeof gw?.pid === "number" ? gw.pid : null;
    const supRunning = supPid !== null && pidAlive(supPid);
    const gwRunning = gwPid !== null && pidAlive(gwPid);
    const http = await httpStatus(port);
    const portInfo = await portState(port, gwRunning);
    // Probing never needs the gateway: this is exactly the case where someone needs an answer.
    const providers = [];
    for (const p of providerRegistry().values()) {
        if (p.name === "fake")
            continue;
        let outcome;
        try {
            outcome = await p.probe();
        }
        catch (e) {
            outcome = { state: "error", available: false, detail: e.message };
        }
        const res = resolveExecutable(process.env[`CONJURE_${p.name.toUpperCase()}_BIN`]?.trim() || p.name);
        providers.push({
            name: p.name, label: p.capabilities.label, state: outcome.state, available: outcome.available,
            detail: outcome.detail, path: res.found ? res.path : null, guidance: guidanceFor(p.name, outcome.state),
        });
    }
    const logDir = path.join(home, "logs");
    const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith(".log") || f.endsWith(".txt")) : [];
    const usable = providers.filter((p) => p.available);
    const readyForCognition = usable.length > 0;
    const summary = !gwRunning && !http
        ? "Conjure is not running."
        : readyForCognition
            ? `Conjure is running and can use ${usable.map((p) => p.label).join(" and ")}.`
            : "Conjure is running, but no AI provider is usable yet, so it cannot carry out work. See the guidance below.";
    return {
        ok: Boolean(http?.healthy),
        at: new Date().toISOString(),
        conjure: { version: conjureVersion(), home, port, appDir: appDir() },
        runtime: { node: process.version, platform: process.platform, arch: process.arch, execPath: process.execPath },
        supervisor: { running: supRunning, pid: supPid },
        gateway: { running: gwRunning, pid: gwPid, http, port: portInfo },
        providers, readyForCognition,
        logs: { dir: logDir, files },
        summary,
    };
}
/** The same report as prose, for a terminal or a text box. */
export function formatReport(r) {
    const L = [];
    const yn = (b) => (b ? "yes" : "no");
    L.push(`Conjure ${r.conjure.version}`);
    L.push(`Checked ${r.at}`);
    L.push("");
    L.push(r.summary);
    L.push("");
    L.push("APPLICATION");
    L.push(`  Running          ${yn(r.gateway.running || Boolean(r.gateway.http))}`);
    L.push(`  Address          http://127.0.0.1:${r.conjure.port}`);
    L.push(`  Health           ${r.gateway.http ? `HTTP ${r.gateway.http.status}${r.gateway.http.healthy ? " (healthy)" : " (not healthy)"}` : "no answer"}`);
    L.push(`  Port ${String(r.conjure.port).padEnd(12)}${r.gateway.port.free ? "free" : `in use by ${r.gateway.port.owner}`}`);
    L.push(`  Supervisor       ${r.supervisor.running ? `running (pid ${r.supervisor.pid})` : "not running"}`);
    L.push(`  Gateway          ${r.gateway.running ? `running (pid ${r.gateway.pid})` : "not running"}`);
    L.push(`  Your data        ${r.conjure.home}`);
    L.push(`  Program files    ${r.conjure.appDir}`);
    L.push(`  Node runtime     ${r.runtime.node} (${r.runtime.platform}/${r.runtime.arch}), bundled with Conjure`);
    L.push("");
    L.push("AI PROVIDERS");
    if (!r.providers.length)
        L.push("  none configured");
    for (const p of r.providers) {
        L.push(`  ${p.label}`);
        L.push(`    Installed      ${yn(p.state !== "not-installed")}`);
        L.push(`    Runnable       ${yn(p.state !== "not-installed" && p.state !== "not-executable")}`);
        L.push(`    Signed in      ${p.state === "ready" ? "yes" : p.state === "not-authenticated" ? "no" : "unknown"}`);
        L.push(`    Usable now     ${yn(p.available)}`);
        if (p.path)
            L.push(`    Program        ${p.path}`);
        L.push(`    Detail         ${p.detail}`);
        if (p.guidance)
            L.push(`    To fix         ${p.guidance}`);
    }
    L.push("");
    L.push(`Ready to carry out work: ${yn(r.readyForCognition)}`);
    if (!r.readyForCognition)
        L.push("Conjure will open and keep your work, but cannot run it until one provider above is usable.");
    L.push("");
    L.push("LOGS");
    L.push(`  ${r.logs.dir}`);
    for (const f of r.logs.files)
        L.push(`    ${f}`);
    L.push("");
    L.push(`Host ${os.hostname()} - this report contains no credentials or tokens.`);
    return L.join("\n");
}
//# sourceMappingURL=doctor.js.map