"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.locate = locate;
exports.nodeVersion = nodeVersion;
exports.readGatewayRecord = readGatewayRecord;
exports.readSupervisorRecord = readSupervisorRecord;
exports.pidAlive = pidAlive;
exports.health = health;
exports.portListening = portListening;
exports.startMachine = startMachine;
exports.stopMachine = stopMachine;
exports.gatewayBase = gatewayBase;
exports.controlHeaders = controlHeaders;
exports.mintBootstrapUrl = mintBootstrapUrl;
exports.controlGet = controlGet;
exports.controlPost = controlPost;
// The container's view of the machine. The desktop app does not run the organization: the supervisor (a separate
// process that outlives every window) does. The app LOCATES a running machine and adopts it, or STARTS one through
// the same `conjure start` the CLI uses, then holds a trusted client's credentials (the per-boot control secret in
// the operator's 0600 gateway record) to mint an app-private browser session. Nothing here weakens the gateway's
// boundary: Host, Origin, ticket and cookie checks are exactly the ones a CLI client faces.
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_net_1 = __importDefault(require("node:net"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BOOT_ID_PATTERN = /^boot_[0-9a-f]{12}$/;
function locate(opts) {
    const env = process.env;
    let preview = false;
    if (opts.packaged) {
        try {
            preview = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(opts.resourcesPath, "launch-profile.json"), "utf8")).profile === "final-product-preview";
        }
        catch { /* ordinary desktop package */ }
    }
    const home = env.CONJURE_HOME && env.CONJURE_HOME.trim() ? node_path_1.default.resolve(env.CONJURE_HOME) : node_path_1.default.join(node_os_1.default.homedir(), preview ? ".conjure-final-product" : ".conjure");
    const core = env.CONJURE_CORE && env.CONJURE_CORE.trim() ? node_path_1.default.resolve(env.CONJURE_CORE)
        : opts.packaged ? node_path_1.default.join(opts.resourcesPath, "core") : node_path_1.default.resolve(opts.appDir, "..", "core");
    const node = env.CONJURE_NODE && env.CONJURE_NODE.trim() ? node_path_1.default.resolve(env.CONJURE_NODE)
        : opts.packaged ? node_path_1.default.join(opts.resourcesPath, "node", process.platform === "win32" ? "node.exe" : "node") : "node";
    const p = Number(env.CONJURE_PORT ?? (preview ? 7794 : 7790));
    return { home, core, node, preview, port: Number.isFinite(p) && p > 0 ? p : 7790 };
}
/** The runtime must be Node 24+: the machine's native SQLite module is built for that ABI. Checked once, truthfully. */
function nodeVersion(nodeExe) {
    const r = (0, node_child_process_1.spawnSync)(nodeExe, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (r.status !== 0)
        return { ok: false, version: "", detail: `${nodeExe} could not run (${r.error?.message ?? `exit ${r.status}`})` };
    const v = r.stdout.trim();
    const major = Number(/^v(\d+)/.exec(v)?.[1] ?? 0);
    return major >= 24 ? { ok: true, version: v, detail: `${v} at ${nodeExe}` } : { ok: false, version: v, detail: `${nodeExe} is ${v}; Conjure needs Node 24 or newer` };
}
function readGatewayRecord(home) {
    try {
        const v = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(home, "gateway.json"), "utf8"));
        const { pid, port, bootId, startedAt, controlSecret } = v;
        if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof port === "number" && port > 0 && port <= 65535
            && typeof bootId === "string" && BOOT_ID_PATTERN.test(bootId) && typeof startedAt === "string" && typeof controlSecret === "string" && TOKEN_PATTERN.test(controlSecret)) {
            return { pid, port, bootId, startedAt, controlSecret };
        }
    }
    catch { /* no record */ }
    return null;
}
function readSupervisorRecord(home) {
    try {
        const v = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(home, "supervisor.json"), "utf8"));
        if (typeof v.pid !== "number")
            return null;
        const g = v.gateway;
        return { pid: v.pid, entry: typeof v.entry === "string" ? v.entry : null, edition: typeof v.edition === "string" ? v.edition : null, gateway: g ? { pid: typeof g.pid === "number" ? g.pid : null, state: String(g.state ?? "") } : null };
    }
    catch {
        return null;
    }
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === "EPERM";
    }
}
async function health(port, timeoutMs = 3000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal });
        const j = (await r.json().catch(() => null));
        return { ok: r.ok && j?.ok === true && j.ready === true, bootId: typeof j?.bootId === "string" ? j.bootId : null };
    }
    catch {
        return { ok: false, bootId: null };
    }
    finally {
        clearTimeout(t);
    }
}
/** Is something listening on the port at all? Distinguishes "no machine" from "another program holds our port". */
function portListening(port) {
    return new Promise((resolve) => {
        const s = node_net_1.default.createConnection({ host: "127.0.0.1", port });
        const done = (v) => { s.destroy(); resolve(v); };
        s.once("connect", () => done(true));
        s.once("error", () => done(false));
        setTimeout(() => done(false), 1500).unref();
    });
}
function machineEnv(loc) {
    const env = { ...process.env, CONJURE_HOME: loc.home, CONJURE_PORT: String(loc.port) };
    delete env.ELECTRON_RUN_AS_NODE; // the machine is plain Node, never the container's runtime in disguise
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    return env;
}
/** `conjure start`: the CLI spawns the current edition's own supervisor, detached. Returns what the CLI printed. */
function startMachine(loc) {
    return new Promise((resolve) => {
        const cli = node_path_1.default.join(loc.core, "dist", "cli.js");
        const p = (0, node_child_process_1.spawn)(loc.node, [cli, "start"], { cwd: loc.core, env: machineEnv(loc), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        p.stdout.on("data", (d) => { out += String(d); });
        p.stderr.on("data", (d) => { out += String(d); });
        p.on("error", (e) => resolve({ code: null, output: `could not run ${loc.node}: ${e.message}` }));
        p.on("close", (code) => resolve({ code, output: out.trim() }));
    });
}
function stopMachine(loc) {
    return new Promise((resolve) => {
        const cli = node_path_1.default.join(loc.core, "dist", "cli.js");
        const p = (0, node_child_process_1.spawn)(loc.node, [cli, "stop"], { cwd: loc.core, env: machineEnv(loc), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        p.stdout.on("data", (d) => { out += String(d); });
        p.stderr.on("data", (d) => { out += String(d); });
        p.on("error", (e) => resolve({ code: null, output: e.message }));
        p.on("close", (code) => resolve({ code, output: out.trim() }));
    });
}
function gatewayBase(rec) { return `http://127.0.0.1:${rec.port}`; }
function controlHeaders(rec) { return { authorization: `Conjure ${rec.controlSecret}` }; }
/** One ticket, thirty seconds, one use: the gateway turns it into an HttpOnly session cookie in the app's own partition. */
async function mintBootstrapUrl(rec) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try {
        const r = await fetch(`${gatewayBase(rec)}/__conjure/session`, { method: "POST", headers: controlHeaders(rec), redirect: "manual", signal: ctl.signal });
        if (r.status !== 200)
            throw new Error(`the gateway did not mint a session (HTTP ${r.status})`);
        const j = (await r.json().catch(() => null));
        if (!j || typeof j.ticket !== "string" || !TOKEN_PATTERN.test(j.ticket))
            throw new Error("the gateway returned an invalid ticket");
        return `${gatewayBase(rec)}/?bootstrap=${encodeURIComponent(j.ticket)}`;
    }
    finally {
        clearTimeout(t);
    }
}
async function controlGet(rec, p) {
    try {
        const r = await fetch(gatewayBase(rec) + p, { headers: controlHeaders(rec) });
        return r.ok ? (await r.json()) : null;
    }
    catch {
        return null;
    }
}
async function controlPost(rec, p, body = {}) {
    try {
        const r = await fetch(gatewayBase(rec) + p, { method: "POST", headers: { ...controlHeaders(rec), origin: gatewayBase(rec), "content-type": "application/json" }, body: JSON.stringify(body) });
        return r.ok ? (await r.json()) : null;
    }
    catch {
        return null;
    }
}
