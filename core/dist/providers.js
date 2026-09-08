// Provider boundary. A provider turns (prompt, workspace, model) into text + a terminal receipt.
// Nothing durable lives here. Provider identity is never organizational identity.
//
// How a provider process is found and started is NOT decided here: that is one shared, platform-aware
// helper (./provider-exec.js) used by every provider, so a host quirk is fixed in one place for all of
// them rather than re-solved, differently and wrongly, per provider.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable, spawnProvider, execProvider, classifyProbe, redact, } from "./provider-exec.js";
import { experimentalProvider, readSpecs } from "./providers-experimental.js";
function slotsFor(name, fallback) { const v = Number(process.env[`CONJURE_${name.toUpperCase()}_SLOTS`]); return Number.isFinite(v) && v > 0 ? v : fallback; }
/** Bounded tool grant for a worker that may change its workspace. Capability follows role, not a global switch. */
const WORKER_TOOLS = "Read,Edit,Write,MultiEdit,Glob,Grep,Bash(git:*),Bash(pnpm:*),Bash(npm:*),Bash(node:*),Bash(ls:*),Bash(cat:*)";
/** A conversation or reviewer may look, not touch. */
const READ_ONLY_DISALLOWED = "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Agent";
function childEnv(tools) {
    const env = { ...process.env };
    delete env.CLAUDECODE; // a nested launch must not think it is inside the operator's own session
    // Tool access is a PATH fact for the attempt, not a permission for the operator's whole machine.
    if (tools?.length) {
        const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
        env[key] = [...new Set(tools.map((t) => t.dir))].join(path.delimiter) + path.delimiter + (env[key] ?? "");
    }
    return env;
}
/** The worker allowlist plus one `Bash(<tool>:*)` per granted tool: the grant is by name, on the PATH the attempt was given. */
function workerTools(tools) {
    return [WORKER_TOOLS, ...(tools ?? []).map((t) => `Bash(${t.exe}:*)`)].join(",");
}
function binFor(name, fallback) {
    const v = process.env[`CONJURE_${name.toUpperCase()}_BIN`];
    return v && v.trim() ? v : fallback;
}
/** Where this provider's program actually is, or precisely why it is not runnable. */
function locate(name, fallback) {
    return resolveExecutable(binFor(name, fallback));
}
/** Kill a child and everything it spawned. A grandchild holding our stdout pipe must not outlive the turn. */
function killTree(proc) {
    if (!proc.pid)
        return;
    if (process.platform === "win32")
        execFile("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => { });
    else {
        try {
            process.kill(-proc.pid, "SIGKILL");
        }
        catch {
            proc.kill("SIGKILL");
        }
    }
}
/** A run that cannot start. Reported as a normal terminal failure so the reconciler treats it like any other. */
function unstartable(error) {
    return { pid: null, done: Promise.resolve({ status: "failed", text: "", providerSession: null, costUsd: null, error }), kill: () => { } };
}
/** The one place a provider turns "we could not start the program" into a sentence an operator can act on. */
function cannotStart(name, res) {
    return `cannot start ${name}: ${classifyProbe(res, null).detail}`;
}
function attach(proc, prompt, timeoutMs, parse, 
/** Called per complete stdout line; return a result to settle early (the process tree is then killed). */
early) {
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let resolveDone = () => { };
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const settle = (r) => { if (settled)
        return; settled = true; clearTimeout(timer); resolveDone(r); };
    const timer = setTimeout(() => { killed = true; killTree(proc); settle({ status: "interrupted", text: stdout, providerSession: null, costUsd: null, error: "killed (timeout or stop)" }); }, timeoutMs);
    let pending = "";
    proc.stdout?.on("data", (d) => {
        stdout += String(d);
        if (!early || settled)
            return;
        pending += String(d);
        let i;
        while ((i = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, i).trim();
            pending = pending.slice(i + 1);
            if (!line)
                continue;
            const r = early(line, stdout);
            if (r) {
                settle(r);
                killTree(proc);
                return;
            }
        }
    });
    proc.stderr?.on("data", (d) => { stderr += String(d); if (stderr.length > 20000)
        stderr = stderr.slice(-20000); });
    proc.on("error", (err) => settle({ status: "failed", text: "", providerSession: null, costUsd: null, error: `spawn failed: ${err.message}` }));
    proc.on("close", (code) => {
        if (killed)
            settle({ status: "interrupted", text: stdout, providerSession: null, costUsd: null, error: "killed (timeout or stop)" });
        else
            settle(parse(stdout, stderr, code));
    });
    try {
        proc.stdin?.on("error", () => { });
        proc.stdin?.end(prompt);
    }
    catch { /* the error handler reports */ }
    return { pid: proc.pid ?? null, done, kill: () => { killed = true; killTree(proc); settle({ status: "interrupted", text: stdout, providerSession: null, costUsd: null, error: "killed (timeout or stop)" }); } };
}
// --- Claude Code, headless. ---------------------------------------------------------------------
export const claudeProvider = {
    name: "claude",
    capabilities: { name: "claude", label: "Claude", defaultModel: "sonnet", defaultEffort: null, slots: slotsFor("claude", 4),
        models: [{ id: "sonnet", label: "Claude Sonnet" }, { id: "opus", label: "Claude Opus" }, { id: "haiku", label: "Claude Haiku" }],
        efforts: ["low", "medium", "high"] },
    async probe() {
        const res = locate("claude", "claude");
        if (!res.found)
            return classifyProbe(res, null);
        // `claude auth status` answers {"loggedIn":...}, and also carries the account's email and org id.
        // classifyProbe reads only the flag; nothing from this payload is stored, logged, or displayed.
        const out = await execProvider(res, ["auth", "status"], { env: childEnv(), timeoutMs: 20000 });
        return classifyProbe(res, out);
    },
    run(req) {
        const res = locate("claude", "claude");
        if (!res.found)
            return unstartable(cannotStart("claude", res));
        const args = ["-p", "--output-format", "json", "--model", req.model];
        if (req.effort)
            args.push("--effort", req.effort);
        if (req.resume)
            args.push("--resume", req.resume);
        if (req.allowWrites)
            args.push("--permission-mode", "acceptEdits", "--allowedTools", workerTools(req.tools));
        else
            args.push("--disallowedTools", READ_ONLY_DISALLOWED);
        for (const d of req.exposeDirs)
            args.push("--add-dir", d);
        let proc;
        try {
            proc = spawnProvider(res, args, { cwd: req.cwd, env: childEnv(req.allowWrites ? req.tools : undefined), stdio: ["pipe", "pipe", "pipe"] });
        }
        catch (e) {
            return unstartable(`cannot start claude: ${e.message}`);
        }
        return attach(proc, req.prompt, req.timeoutMs, (stdout, stderr, code) => {
            const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
            if (!line)
                return { status: "failed", text: stdout, providerSession: null, costUsd: null, error: `no JSON result (exit ${code}): ${redact(stderr.slice(-400))}` };
            try {
                const j = JSON.parse(line);
                if (j.is_error)
                    return { status: "failed", text: j.result ?? "", providerSession: j.session_id ?? null, costUsd: j.total_cost_usd ?? null, error: `claude error: ${j.subtype ?? "unknown"}` };
                return { status: "succeeded", text: j.result ?? "", providerSession: j.session_id ?? null, costUsd: j.total_cost_usd ?? null, error: null };
            }
            catch (e) {
                return { status: "failed", text: stdout, providerSession: null, costUsd: null, error: `unparseable result: ${e.message}` };
            }
        });
    },
};
// --- Codex, headless. ----------------------------------------------------------------------------
export const codexProvider = {
    name: "codex",
    capabilities: { name: "codex", label: "Codex", defaultModel: "gpt-5.6-terra", defaultEffort: "medium", slots: slotsFor("codex", 2),
        models: [{ id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }, { id: "gpt-5.5", label: "GPT-5.5" }],
        efforts: ["low", "medium", "high", "xhigh"] },
    async probe() {
        const res = locate("codex", "codex");
        if (!res.found)
            return classifyProbe(res, null);
        // `codex login status` exits 0 and says so when signed in; otherwise it says "Not logged in".
        // Presence alone used to be reported as availability, which is how an unauthenticated CLI got staffed.
        const out = await execProvider(res, ["login", "status"], { env: childEnv(), timeoutMs: 20000 });
        return classifyProbe(res, out);
    },
    run(req) {
        const res = locate("codex", "codex");
        if (!res.found)
            return unstartable(cannotStart("codex", res));
        const args = ["exec", "--model", req.model, "--json", "--color", "never", "--skip-git-repo-check", "-C", req.cwd,
            "-c", `sandbox_mode="${req.allowWrites ? "workspace-write" : "read-only"}"`, "-c", 'approval_policy="never"'];
        if (req.effort)
            args.push("-c", `model_reasoning_effort="${req.effort}"`);
        args.push("-");
        let proc;
        try {
            proc = spawnProvider(res, args, { cwd: req.cwd, env: childEnv(req.allowWrites ? req.tools : undefined), stdio: ["pipe", "pipe", "pipe"] });
        }
        catch (e) {
            return unstartable(`cannot start codex: ${e.message}`);
        }
        const parseAll = (stdout) => {
            let text = "";
            let thread = null;
            let completed = false;
            let failed = null;
            for (const l of stdout.split("\n")) {
                if (!l.startsWith("{"))
                    continue;
                try {
                    const j = JSON.parse(l);
                    if (j.type === "thread.started" && j.thread_id)
                        thread = j.thread_id;
                    if (j.item?.type === "agent_message" && typeof j.item.text === "string")
                        text = j.item.text;
                    if (j.type === "turn.completed")
                        completed = true;
                    if (j.type === "turn.failed" || j.type === "error")
                        failed = j.error?.message ?? "turn failed";
                }
                catch { /* partial line */ }
            }
            return { text, thread, completed, failed };
        };
        return attach(proc, req.prompt, req.timeoutMs, (stdout, stderr, code) => {
            const p = parseAll(stdout);
            if (p.failed)
                return { status: "failed", text: p.text, providerSession: p.thread, costUsd: null, error: `codex: ${p.failed}` };
            if (!p.text)
                return { status: "failed", text: stdout, providerSession: p.thread, costUsd: null, error: `no agent message (exit ${code}): ${redact(stderr.slice(-400))}` };
            return { status: "succeeded", text: p.text, providerSession: p.thread, costUsd: null, error: null };
        }, (line, stdoutSoFar) => {
            // Codex signals the end of the turn itself; do not wait for a grandchild to release the pipe.
            if (!line.startsWith("{") || !(line.includes("turn.completed") || line.includes("turn.failed")))
                return null;
            const p = parseAll(stdoutSoFar);
            if (p.failed)
                return { status: "failed", text: p.text, providerSession: p.thread, costUsd: null, error: `codex: ${p.failed}` };
            if (!p.completed)
                return null;
            return p.text ? { status: "succeeded", text: p.text, providerSession: p.thread, costUsd: null, error: null } : { status: "failed", text: stdoutSoFar, providerSession: p.thread, costUsd: null, error: "turn completed without an agent message" };
        });
    },
};
// --- Fake provider for deterministic checks and fault injection. Enabled only by CONJURE_FAKE_PROVIDER=1. ---
export const fakeProvider = {
    name: "fake",
    capabilities: { name: "fake", label: "Fake (checks only)", defaultModel: "m", defaultEffort: null, slots: slotsFor("fake", 6), models: [{ id: "m", label: "fake/m" }], efforts: [] },
    async probe() {
        return process.env.CONJURE_FAKE_UNAVAILABLE === "1"
            ? { state: "error", available: false, detail: "simulated outage" }
            : { state: "ready", available: true, detail: "fake" };
    },
    run(req) {
        const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fake-worker.js");
        // Goes through the same helper as every other provider, so the checks exercise the real start path.
        const res = resolveExecutable(process.execPath);
        if (!res.found)
            return unstartable("cannot start the fake provider: this Node runtime is not executable");
        const proc = spawnProvider(res, [script], { cwd: req.cwd, env: childEnv(req.allowWrites ? req.tools : undefined), stdio: ["pipe", "pipe", "pipe"] });
        return attach(proc, req.prompt, req.timeoutMs, (stdout, stderr, code) => {
            if (code !== 0)
                return { status: "failed", text: stdout, providerSession: null, costUsd: 0, error: `fake exited ${code}: ${stderr.slice(-200)}` };
            return { status: "succeeded", text: stdout, providerSession: "fake-session", costUsd: 0, error: null };
        });
    },
};
export function providerRegistry() {
    const m = new Map();
    m.set("claude", claudeProvider);
    m.set("codex", codexProvider);
    if (process.env.CONJURE_FAKE_PROVIDER === "1")
        m.set("fake", fakeProvider);
    // Frontier: operator specs in <home>/providers/*.json become providers at boot. Bounded to windows until promoted.
    for (const spec of readSpecs())
        if (!m.has(spec.name))
            m.set(spec.name, providerFromSpec(spec));
    return m;
}
export function providerFromSpec(spec) { return experimentalProvider(spec, attach, unstartable); }
export function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
    return p;
}
//# sourceMappingURL=providers.js.map