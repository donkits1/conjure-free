// Tools: real programs available to work. Godot is not an agent; Aseprite is not a provider. A tool is a durable
// capability row that cold software can locate and probe, that a seat may be granted, and that a worker attempt is
// told about and permitted to run. Tool access is not cognition access: nothing here is ever briefed, summoned, or
// leased. Cognition may use a tool; a tool never thinks.
//
// Status is the promotion line the frontier needs: `experimental` tools are known to Conjure and shown truthfully but
// never granted to organizational work; `promoted` tools may be granted to seats. Promotion is an operator act.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { now } from "./ids.js";
import { append } from "./events.js";
import { resolveExecutable, execProvider } from "./provider-exec.js";
const T = (r) => ({
    id: r.id, name: r.name, kind: r.kind, command: r.command, probeArgs: JSON.parse(r.probe_args || "[]"),
    status: r.status, note: r.note, usage: r.usage, available: r.available === 1, state: r.state ?? "unknown", detail: r.detail,
    version: r.version ?? null, observedAt: r.observed_at ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});
export const tools = {
    all: (db) => db.prepare("SELECT * FROM tools ORDER BY name").all().map(T),
    get: (db, tid) => { const r = db.prepare("SELECT * FROM tools WHERE id=?").get(tid); return r ? T(r) : null; },
    /** Tools a seat may actually use right now: granted, promoted, and observed runnable. The brief lists only these. */
    grantedTo: (db, toolIds) => (toolIds ?? []).map((t) => tools.get(db, t)).filter((t) => !!t && t.status === "promoted" && t.available),
};
/** Where well-known tools tend to live on this platform. A hint list, checked cold; never a claim of installation. */
function candidates(name) {
    const home = os.homedir();
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    if (process.platform !== "win32")
        return [name];
    const byName = {
        godot: ["godot", path.join(local, "Programs", "Godot", "godot.exe"), path.join(pf, "Godot", "godot.exe"), path.join(home, "Godot", "godot.exe"), path.join(home, "Desktop", "Godot", "godot.exe")],
        aseprite: ["aseprite", path.join(pf86, "Steam", "steamapps", "common", "Aseprite", "Aseprite.exe"), path.join(pf, "Aseprite", "Aseprite.exe"), path.join(local, "Programs", "Aseprite", "Aseprite.exe")],
        blender: ["blender", path.join(pf, "Blender Foundation", "Blender 4.2", "blender.exe"), path.join(pf, "Blender Foundation", "Blender", "blender.exe")],
    };
    return byName[name] ?? [name];
}
/** The first candidate that resolves to a runnable program, else the bare name so the probe can say "not installed". */
export function discoverCommand(name) {
    for (const c of candidates(name)) {
        const r = resolveExecutable(c);
        if (r.found)
            return c;
    }
    return name;
}
const WELL_KNOWN = [
    { id: "godot", name: "Godot", kind: "application", probeArgs: ["--version"], note: "Game engine. Runs scenes headless for inspection; exports builds.",
        usage: "godot --headless --path <project> --script <gdscript>  (run a script);  godot --headless --path <project> --export-release <preset> <out>  (export)" },
    { id: "aseprite", name: "Aseprite", kind: "application", probeArgs: ["--version"], note: "Pixel art and animation. Batch mode exports sheets and frames without opening the editor.",
        usage: "aseprite -b <file.aseprite> --sheet <out.png> --data <out.json>  (export a sprite sheet);  aseprite -b <file.aseprite> --save-as <out.png>  (export frames)" },
];
/** First boot: the well-known production tools exist as experimental rows whether or not they are installed. Cold. */
export function ensureWellKnownTools(db) {
    const t = now();
    const ins = db.prepare("INSERT OR IGNORE INTO tools(id,name,kind,command,probe_args,status,note,usage,available,state,detail,created_at,updated_at) VALUES(?,?,?,?,?,'experimental',?,?,0,'unknown','not probed yet',?,?)");
    for (const w of WELL_KNOWN)
        ins.run(w.id, w.name, w.kind, discoverCommand(w.id), JSON.stringify(w.probeArgs), w.note, w.usage, t, t);
}
export function registerTool(db, input, by) {
    const name = (input.name ?? "").trim().slice(0, 80);
    if (!name)
        throw new Error("a tool needs a name");
    const command = (input.command ?? "").trim();
    if (!command)
        throw new Error("a tool needs a command or a path");
    const tid = (input.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 40);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(tid))
        throw new Error("tool id must be lowercase letters, digits and dashes");
    if (tools.get(db, tid))
        throw new Error(`tool '${tid}' already exists; edit it instead`);
    const t = now();
    db.prepare("INSERT INTO tools(id,name,kind,command,probe_args,status,note,usage,available,state,detail,created_at,updated_at) VALUES(?,?,?,?,?,'experimental',?,?,0,'unknown','not probed yet',?,?)")
        .run(tid, name, input.kind === "cli" ? "cli" : "application", command, JSON.stringify((input.probeArgs ?? ["--version"]).map(String).slice(0, 8)), (input.note ?? "").slice(0, 500), (input.usage ?? "").slice(0, 2000), t, t);
    append(db, "tool", tid, "registered", { name, command, by });
    return tools.get(db, tid);
}
export function updateTool(db, tid, patch, by) {
    const cur = tools.get(db, tid);
    if (!cur)
        throw new Error("no such tool");
    const status = patch.status === "promoted" ? "promoted" : patch.status === "experimental" ? "experimental" : cur.status;
    db.prepare("UPDATE tools SET name=?, command=?, probe_args=?, note=?, usage=?, status=?, updated_at=? WHERE id=?")
        .run((patch.name ?? cur.name).trim().slice(0, 80) || cur.name, (patch.command ?? cur.command).trim() || cur.command, JSON.stringify(patch.probeArgs ? patch.probeArgs.map(String).slice(0, 8) : cur.probeArgs), (patch.note ?? cur.note).slice(0, 500), (patch.usage ?? cur.usage).slice(0, 2000), status, now(), tid);
    if (status !== cur.status)
        append(db, "tool", tid, status === "promoted" ? "promoted" : "demoted", { by });
    if (patch.command && patch.command !== cur.command)
        append(db, "tool", tid, "relocated", { command: patch.command, by });
    return tools.get(db, tid);
}
export function removeTool(db, tid) {
    db.prepare("DELETE FROM tools WHERE id=?").run(tid);
    append(db, "tool", tid, "removed", {});
}
/** Version text from a `--version`-style probe: the first line that looks like a version, else the first line. */
function versionOf(out) {
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.find((l) => /\d+\.\d+/.test(l))?.slice(0, 80) ?? lines[0]?.slice(0, 80) ?? null;
}
/** Cold probe: is the program there, can this OS run it, does it answer? Records what it saw; never guesses. */
export async function probeTool(db, t) {
    let res = resolveExecutable(t.command);
    if (!res.found && t.command === t.id) {
        const c = discoverCommand(t.id);
        if (c !== t.command) {
            res = resolveExecutable(c);
            if (res.found)
                db.prepare("UPDATE tools SET command=? WHERE id=?").run(c, t.id);
        }
    }
    let state;
    let detail;
    let version = null;
    let available = false;
    if (!res.found) {
        state = res.reason === "not-installed" ? "not-installed" : "not-executable";
        detail = res.reason === "not-installed" ? `no program '${t.command}' found on this machine; tell Conjure where it is` : res.detail;
    }
    else if (!t.probeArgs.length) {
        state = "ready";
        available = true;
        detail = `found at ${res.path} (no version probe configured)`;
    }
    else {
        const out = await execProvider(res, t.probeArgs, { timeoutMs: 20_000, windowsHide: true });
        if (out.error) {
            state = "error";
            detail = `found at ${res.path} but ${t.probeArgs.join(" ")} failed: ${out.error}`;
        }
        else {
            version = versionOf(out.stdout || out.stderr);
            state = "ready";
            available = true;
            detail = `found at ${res.path}${version ? ` · ${version}` : ""}`;
        }
    }
    const prev = t;
    db.prepare("UPDATE tools SET available=?, state=?, detail=?, version=?, observed_at=? WHERE id=?").run(available ? 1 : 0, state, detail, version, now(), t.id);
    if (prev.state !== state || prev.available !== available)
        append(db, "tool", t.id, available ? "available" : "unavailable", { state, detail });
    return tools.get(db, t.id);
}
export async function probeTools(db) {
    const out = [];
    for (const t of tools.all(db))
        out.push(await probeTool(db, t));
    return out;
}
export function grantsFor(db, toolIds) {
    return tools.grantedTo(db, toolIds).map((t) => {
        const r = resolveExecutable(t.command);
        const p = r.found ? r.path : t.command;
        return { id: t.id, name: t.name, command: t.command, exe: path.basename(p).replace(/\.(exe|cmd|bat|com)$/i, ""), dir: path.dirname(p), usage: t.usage, version: t.version };
    }).filter((g) => fs.existsSync(g.dir));
}
//# sourceMappingURL=tools.js.map