// Frontier freedom: a new model, CLI or harness should be usable today without Conjure shipping an adapter for it.
// An experimental provider is a small JSON spec in <home>/providers/<name>.json describing how to run a program with a
// prompt and read its answer. It is loaded cold at boot (or registered live), probed like every other provider, and
// offered to Idea Room windows immediately: bounded context (the window's private directory, connected notes only),
// no organizational authority. It is NOT allocated to seats until the operator promotes it; until then a seat that
// names it holds with `no-processor` and says why. Promotion is one durable flag in the same file. Discarding removes
// the file. Nothing about a provider's identity is durable organizational identity; work and windows survive it.
//
// What Conjure can and cannot enforce is stated on the provider (`boundary`) and shown wherever it appears: an unknown
// program has no tool policy Conjure knows how to set, so the truth is "runs in a private directory; no write policy".
import fs from "node:fs";
import path from "node:path";
import { conjureHome } from "./home.js";
import { resolveExecutable, spawnProvider, execProvider, classifyProbe } from "./provider-exec.js";
export const SPEC_NAME = /^[a-z][a-z0-9-]{1,30}$/;
export function specDir() { return path.join(conjureHome(), "providers"); }
export function specFile(name) { return path.join(specDir(), `${name}.json`); }
export function readSpecs() {
    const dir = specDir();
    if (!fs.existsSync(dir))
        return [];
    const out = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
        try {
            const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            const v = validateSpec(s);
            if (!v)
                out.push(s);
        }
        catch { /* an unreadable spec is not a provider */ }
    }
    return out;
}
export function validateSpec(s) {
    if (!s || typeof s !== "object")
        return "spec must be an object";
    if (typeof s.name !== "string" || !SPEC_NAME.test(s.name))
        return "name: lowercase letters, digits, dashes; 2-31 chars";
    if (["claude", "codex", "fake"].includes(s.name))
        return `'${s.name}' is a built-in provider`;
    if (typeof s.command !== "string" || !s.command.trim())
        return "command: the program to run";
    if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string")))
        return "args: an array of strings";
    if (s.models !== undefined && (!Array.isArray(s.models) || s.models.some((m) => !m || typeof m.id !== "string")))
        return "models: [{id,label}]";
    if (s.output !== undefined && !(s.output === "text" || /^json-last-line:[A-Za-z0-9_.]+$/.test(s.output)))
        return "output: 'text' or 'json-last-line:<field>'";
    return null;
}
export function writeSpec(s) {
    const why = validateSpec(s);
    if (why)
        throw new Error(why);
    fs.mkdirSync(specDir(), { recursive: true });
    const file = specFile(s.name);
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
    return file;
}
export function removeSpec(name) {
    const f = specFile(name);
    if (!fs.existsSync(f))
        return false;
    fs.unlinkSync(f);
    return true;
}
/** The statement of what Conjure enforces for this provider. Shown, never softened. */
export function boundaryOf(s) {
    return `experimental: runs '${path.basename(s.command)}' in the window's private directory with the prompt and connected notes only; Conjure knows no tool or write policy for this program and cannot restrict what it reads or does; ${s.promoted ? "promoted: may be allocated to seats" : "not promoted: never allocated to organizational work"}`;
}
function substitute(args, req) {
    const viaStdin = !args.some((a) => a.includes("{prompt}"));
    return { args: args.map((a) => a.replace(/\{prompt\}/g, req.prompt).replace(/\{model\}/g, req.model).replace(/\{effort\}/g, req.effort ?? "").replace(/\{cwd\}/g, req.cwd)), viaStdin };
}
function parseOutput(spec, stdout) {
    const mode = spec.output ?? "text";
    if (mode === "text")
        return { text: stdout.trim(), error: null };
    const field = mode.slice("json-last-line:".length);
    const line = stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
    if (!line)
        return { text: stdout, error: "no JSON line in output" };
    try {
        let v = JSON.parse(line);
        for (const k of field.split("."))
            v = v?.[k];
        return typeof v === "string" ? { text: v, error: null } : { text: stdout, error: `field '${field}' is not a string` };
    }
    catch (e) {
        return { text: stdout, error: `unparseable JSON: ${e.message}` };
    }
}
/** Build a Provider from a spec. The attach/kill discipline mirrors the built-ins; the process tree is killed on stop. */
export function experimentalProvider(spec, attach, unstartable) {
    const models = (spec.models?.length ? spec.models : [{ id: spec.defaultModel ?? "default", label: spec.defaultModel ?? "default" }]).map((m) => ({ id: m.id, label: m.label ?? m.id }));
    const slotsEnv = Number(process.env[`CONJURE_${spec.name.toUpperCase().replace(/-/g, "_")}_SLOTS`]);
    return {
        name: spec.name,
        capabilities: {
            name: spec.name, label: `${spec.label ?? spec.name} (experimental)`, models, defaultModel: spec.defaultModel ?? models[0].id,
            efforts: spec.efforts ?? [], defaultEffort: spec.defaultEffort ?? null, slots: Number.isFinite(slotsEnv) && slotsEnv > 0 ? slotsEnv : (spec.slots ?? 1),
            experimental: true, promoted: spec.promoted === true, boundary: boundaryOf(spec), note: spec.note ?? "",
        },
        async probe() {
            const res = resolveExecutable(spec.command);
            if (!res.found)
                return classifyProbe(res, null);
            if (!spec.probeArgs?.length)
                return { state: "ready", available: true, detail: `found at ${res.path} (no probe configured; readiness is presence)` };
            const out = await execProvider(res, spec.probeArgs, { timeoutMs: 20_000 });
            return out.error || (out.code !== 0 && out.code !== null) ? { state: "error", available: false, detail: `${spec.probeArgs.join(" ")} failed: ${out.error ?? `exit ${out.code}`}` } : { state: "ready", available: true, detail: `found at ${res.path}` };
        },
        run(req) {
            const res = resolveExecutable(spec.command);
            if (!res.found)
                return unstartable(`cannot start ${spec.name}: ${classifyProbe(res, null).detail}`);
            const { args, viaStdin } = substitute(spec.args ?? [], req);
            let proc;
            try {
                proc = spawnProvider(res, args, { cwd: req.cwd, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
            }
            catch (e) {
                return unstartable(`cannot start ${spec.name}: ${e.message}`);
            }
            return attach(proc, viaStdin ? req.prompt : "", req.timeoutMs, (stdout, stderr, code) => {
                if (code !== 0)
                    return { status: "failed", text: stdout, providerSession: null, costUsd: null, error: `${spec.name} exited ${code}: ${stderr.slice(-300)}` };
                const p = parseOutput(spec, stdout);
                return p.error ? { status: "failed", text: p.text, providerSession: null, costUsd: null, error: p.error } : { status: "succeeded", text: p.text, providerSession: null, costUsd: null, error: null };
            });
        },
    };
}
//# sourceMappingURL=providers-experimental.js.map