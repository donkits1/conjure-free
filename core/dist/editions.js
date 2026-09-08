// Editions: built Conjures that exist on this machine. Exactly one is current (the one the supervisor runs); the
// rest are proposed, previous, retired, rejected or failed. The list is flat on purpose: an edition proposed while
// another one is running is a peer, never a child, so Conjure evolving Conjure cannot nest. Git, worktrees, builds and
// processes are mechanics under this file; the operator's model is "which Conjure runs, which exist, what each adds".
//
// Ownership: the gateway may PROPOSE and may RECORD a switch request; only the supervisor performs a switch, and only
// after the gateway has exited. A process never replaces the container it occupies.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { conjureHome } from "./home.js";
import { now } from "./ids.js";
export const SWITCH_EXIT_CODE = 86; // the gateway exits with this after recording a switch; the supervisor applies it
export const editionPaths = {
    dir: () => path.join(conjureHome(), "editions"),
    registry: () => path.join(conjureHome(), "editions", "editions.json"),
    edition: (id) => path.join(conjureHome(), "editions", id),
    buildDir: (id) => path.join(conjureHome(), "editions", ".build", id),
    backups: () => path.join(conjureHome(), "editions", "backups"),
};
export const ID_PATTERN = /^ed_[a-z0-9_-]{3,40}$/;
// --- registry -----------------------------------------------------------------------------------------------
export function readRegistry() {
    try {
        const r = JSON.parse(fs.readFileSync(editionPaths.registry(), "utf8"));
        return { current: r.current ?? null, previous: r.previous ?? null, switch: r.switch ?? null, probation: r.probation ?? null, editions: Array.isArray(r.editions) ? r.editions : [] };
    }
    catch {
        return { current: null, previous: null, switch: null, probation: null, editions: [] };
    }
}
export function writeRegistry(reg) {
    fs.mkdirSync(editionPaths.dir(), { recursive: true });
    const tmp = editionPaths.registry() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, editionPaths.registry());
}
export function editionById(reg, id) { return reg.editions.find((e) => e.id === id) ?? null; }
function note(e, kind, detail) { e.events.push({ at: now(), kind, detail }); if (e.events.length > 40)
    e.events.splice(0, e.events.length - 40); }
export function gatewayEntryOf(e) { const f = path.join(e.path, "dist", "gateway-entry.js"); return fs.existsSync(f) ? f : null; }
export function supervisorEntryOf(e) { const f = path.join(e.path, "dist", "supervisor-entry.js"); return fs.existsSync(f) ? f : null; }
// --- build manifest ------------------------------------------------------------------------------------------
export function readManifest(distDir) {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(distDir, "build.json"), "utf8"));
        if (typeof m.sha !== "string")
            return null;
        return { sha: m.sha, branch: String(m.branch ?? ""), subject: String(m.subject ?? ""), builtAt: String(m.builtAt ?? ""), dirty: m.dirty === true, schemaVersion: typeof m.schemaVersion === "number" ? m.schemaVersion : null, capabilities: Array.isArray(m.capabilities) ? m.capabilities.map((c) => typeof c === "string" ? { id: c, name: c } : { id: String(c.id), name: String(c.name ?? c.id) }) : [], webHash: typeof m.webHash === "string" ? m.webHash : null, sourcePath: String(m.sourcePath ?? ""), editionId: typeof m.editionId === "string" ? m.editionId : null };
    }
    catch {
        return null;
    }
}
export function webHashOf(distDir) {
    try {
        return createHash("sha1").update(fs.readFileSync(path.join(distDir, "web", "index.html"))).digest("hex").slice(0, 16);
    }
    catch {
        return null;
    }
}
export function git(args, cwd) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : null;
}
export function repoRootOf(dir) { return fs.existsSync(dir) ? git(["rev-parse", "--show-toplevel"], dir) : null; }
export function gitFacts(repo, sha) {
    const head = sha ?? git(["rev-parse", "HEAD"], repo);
    if (!head)
        return null;
    const branch = sha ? (git(["branch", "--points-at", head, "--format=%(refname:short)"], repo)?.split("\n")[0] ?? "") : (git(["rev-parse", "--abbrev-ref", "HEAD"], repo) ?? "");
    const subject = git(["log", "-1", "--format=%s", head], repo) ?? "";
    const dirty = sha ? false : (git(["status", "--porcelain", "--untracked-files=no"], repo) ?? "").length > 0;
    return { sha: head, branch: branch === "HEAD" ? "detached" : branch, subject, dirty };
}
/** What the built code says about itself, obtained by running the build's own stamp module: never this process's idea of it. */
function selfDescription(distDir) {
    const stamp = path.join(distDir, "stamp.js");
    if (!fs.existsSync(stamp))
        return { capabilities: [], schemaVersion: null };
    const r = spawnSync(process.execPath, [stamp, "describe"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    try {
        const j = JSON.parse(r.stdout);
        return { capabilities: (j.capabilities ?? []).map((c) => typeof c === "string" ? { id: c, name: c } : { id: c.id, name: c.name ?? c.id }), schemaVersion: j.schemaVersion ?? null };
    }
    catch {
        return { capabilities: [], schemaVersion: null };
    }
}
export function stampManifest(distDir, facts) {
    const self = selfDescription(distDir);
    const m = { sha: facts.sha, branch: facts.branch, subject: facts.subject, builtAt: now(), dirty: facts.dirty, schemaVersion: self.schemaVersion, capabilities: self.capabilities, webHash: webHashOf(distDir), sourcePath: facts.sourcePath, editionId: facts.editionId ?? null };
    fs.writeFileSync(path.join(distDir, "build.json"), JSON.stringify(m, null, 2));
    return m;
}
export function proposeEdition(opts) {
    const log = opts.log ?? (() => { });
    const source = repoRootOf(opts.source);
    if (!source)
        throw new Error(`${opts.source} is not inside a git repository`);
    const sha = opts.ref ? git(["rev-parse", "--verify", `${opts.ref}^{commit}`], source) : git(["rev-parse", "HEAD"], source);
    if (!sha)
        throw new Error(`cannot resolve ${opts.ref ?? "HEAD"} in ${source}`);
    const head = gitFacts(source);
    const building = opts.ref && head && (head.sha !== sha || head.dirty) ? gitFacts(source, sha) : head;
    if (!opts.ref && head?.dirty)
        log(`note: building the working tree of ${source}, which has uncommitted changes`);
    const id = `ed_${sha.slice(0, 7)}${building.dirty ? `_wt${Date.now().toString(36).slice(-4)}` : ""}`;
    const reg = readRegistry();
    const existing = editionById(reg, id);
    if (existing && (existing.status === "current" || reg.current === id))
        throw new Error(`${id} is already the current edition`);
    if (reg.switch?.to === id)
        throw new Error(`${id} is being switched to right now`);
    // Where to build: the source tree itself when it already sits at that commit, else a detached worktree of our own.
    const needsWorktree = !!opts.ref && !!head && (head.sha !== sha || head.dirty);
    const tree = needsWorktree ? editionPaths.buildDir(id) : source;
    if (needsWorktree) {
        fs.rmSync(tree, { recursive: true, force: true });
        git(["worktree", "prune"], source);
        const r = spawnSync("git", ["worktree", "add", "--detach", tree, sha], { cwd: source, encoding: "utf8", windowsHide: true });
        if (r.status !== 0)
            throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
        for (const rel of ["node_modules", path.join("packages", "core", "node_modules"), path.join("packages", "web", "node_modules")]) {
            const from = path.join(source, rel);
            if (fs.existsSync(from))
                fs.symlinkSync(fs.realpathSync(from), path.join(tree, rel), "junction");
        }
        log(`building ${sha.slice(0, 7)} in ${tree}`);
    }
    else
        log(`building ${sha.slice(0, 7)} in place at ${tree}`);
    const core = path.join(tree, "packages", "core");
    const web = path.join(tree, "packages", "web");
    let checksLog = null;
    try {
        run(log, "tsc (core)", process.execPath, [path.join(core, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], core);
        run(log, "tsc (web)", process.execPath, [path.join(web, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "tsconfig.json"], web);
        run(log, "vite build", process.execPath, [path.join(web, "node_modules", "vite", "bin", "vite.js"), "build"], web);
        const dist = path.join(core, "dist");
        const manifest = stampManifest(dist, { ...building, sourcePath: source, editionId: id });
        log(`stamped ${manifest.sha.slice(0, 7)} capabilities=${manifest.capabilities.map((c) => c.id).join(",") || "(unstated)"} schema=v${manifest.schemaVersion ?? "?"}`);
        let checks = null;
        if (opts.checks !== false) {
            log("running the check suite (this takes a few minutes)");
            const env = { ...process.env };
            for (const k of Object.keys(env))
                if (k.startsWith("CONJURE_"))
                    delete env[k];
            const r = spawnSync(process.execPath, [path.join(dist, "check", "run.js")], { cwd: core, encoding: "utf8", windowsHide: true, env, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
            checksLog = (r.stdout ?? "") + (r.stderr ?? "");
            const m = /(\d+)\/(\d+) checks passed/.exec(checksLog);
            checks = m ? { passed: Number(m[1]), total: Number(m[2]), at: now() } : { passed: 0, total: 0, at: now() };
            log(`checks: ${checks.passed}/${checks.total}${r.status === 0 ? "" : ` (exit ${r.status ?? "signal"})`}`);
        }
        // Install: the edition owns a copy of what it needs to run, so deleting a branch or worktree later cannot kill it.
        const home = editionPaths.edition(id);
        fs.rmSync(home, { recursive: true, force: true });
        const target = path.join(home, "core");
        fs.mkdirSync(target, { recursive: true });
        for (const rel of ["dist", "assets", "bin", "package.json"]) {
            const from = path.join(core, rel);
            if (fs.existsSync(from))
                fs.cpSync(from, path.join(target, rel), { recursive: true });
        }
        linkNodeModules(path.join(core, "node_modules"), path.join(target, "node_modules"));
        if (checksLog)
            fs.writeFileSync(path.join(home, "checks.log"), checksLog.slice(-200_000));
        const edition = {
            id, status: "proposed", path: target, note: opts.note ?? "", proposedAt: now(), proposedBy: opts.by ?? "operator", acceptedAt: null, rejectedAt: null,
            checks, canonical: null, build: manifest, events: [{ at: now(), kind: "proposed", detail: `built from ${building.branch || "detached"} @ ${sha.slice(0, 7)}${needsWorktree ? " in a temporary worktree" : " in place"}` }],
        };
        const fresh = readRegistry(); // the registry may have moved while we built
        fresh.editions = fresh.editions.filter((e) => e.id !== id);
        fresh.editions.push(edition);
        if (fresh.previous === id)
            fresh.previous = null;
        writeRegistry(fresh);
        log(`proposed ${id}: ${edition.build.subject}`);
        return { edition, checksLog };
    }
    finally {
        if (needsWorktree) {
            spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: source, windowsHide: true });
            fs.rmSync(tree, { recursive: true, force: true });
        }
    }
}
/** A real node_modules directory holding one junction per package, each to the package's real location. A single
 *  junction to a pnpm node_modules would not do: pnpm's package links are relative symlinks, and Node resolves them
 *  against the path as traversed, which lands outside the store. */
export function linkNodeModules(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
        if (name.startsWith("."))
            continue;
        const src = path.join(from, name);
        if (name.startsWith("@")) {
            linkNodeModules(src, path.join(to, name));
            continue;
        }
        try {
            fs.symlinkSync(fs.realpathSync(src), path.join(to, name), "junction");
        }
        catch { /* not a directory, or already there */ }
    }
}
function run(log, label, cmd, args, cwd) {
    log(label);
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0)
        throw new Error(`${label} failed (exit ${r.status ?? "signal"}):\n${((r.stdout ?? "") + (r.stderr ?? "")).slice(-4000)}`);
}
// --- lifecycle transitions (pure over the registry; callers persist) ------------------------------------------
export function switchable(reg, id) {
    const e = editionById(reg, id);
    if (!e)
        return `no such edition ${id}`;
    if (reg.current === id)
        return `${id} is already the current edition`;
    if (reg.switch)
        return `a switch to ${reg.switch.to} is already in progress`;
    if (reg.probation)
        return `${reg.probation.edition} is still proving itself; wait for it to become healthy or fail`;
    if (e.status === "rejected")
        return `${id} was rejected; propose it again if you changed your mind`;
    if (!gatewayEntryOf(e))
        return `${id} has no runnable build at ${e.path}`;
    return null;
}
/** Recorded by the gateway; performed by the supervisor once the gateway has exited. */
export function recordSwitch(reg, id, by) {
    const why = switchable(reg, id);
    if (why)
        throw new Error(why);
    reg.switch = { to: id, from: reg.current, at: now(), by };
    note(editionById(reg, id), "switch-requested", `by ${by}${reg.current ? ` (from ${reg.current})` : ""}`);
    return reg;
}
/** Supervisor side: make the requested edition current and put it on probation until it is healthy. */
export function applySwitch(reg) {
    if (!reg.switch)
        return reg;
    const { to, from } = reg.switch;
    const target = editionById(reg, to);
    if (!target || !gatewayEntryOf(target)) {
        reg.switch = null;
        return reg;
    }
    for (const e of reg.editions) {
        if (e.id === to) {
            e.status = "current";
            note(e, "switched-to", from ? `replacing ${from}` : "first edition");
        }
        else if (e.id === from) {
            e.status = "previous";
            note(e, "stepped-aside", `for ${to}`);
        }
        else if (e.status === "previous" || e.status === "current")
            e.status = "retired";
    }
    reg.previous = from;
    reg.current = to;
    reg.probation = { edition: to, from, since: now() };
    reg.switch = null;
    return reg;
}
/** Supervisor side: the switched-to edition never became healthy; go back to what ran before. */
export function revertProbation(reg, reason) {
    if (!reg.probation)
        return reg;
    const { edition, from } = reg.probation;
    for (const e of reg.editions) {
        if (e.id === edition) {
            e.status = "failed";
            note(e, "failed", reason);
        }
        else if (e.id === from) {
            e.status = "current";
            note(e, "restored", `after ${edition} failed: ${reason}`);
        }
    }
    reg.current = from;
    reg.previous = null;
    reg.probation = null;
    return reg;
}
export function clearProbation(reg) {
    if (!reg.probation)
        return reg;
    const e = editionById(reg, reg.probation.edition);
    if (e)
        note(e, "healthy", `answered health probes ${reg.probation.from ? `after replacing ${reg.probation.from}` : ""}`.trim());
    reg.probation = null;
    return reg;
}
/** Offline switch (no gateway running): the pointer moves; the next start runs it. No probation because nothing observed it. */
export function switchOffline(reg, id) {
    const why = switchable(reg, id);
    if (why)
        throw new Error(why);
    reg.switch = { to: id, from: reg.current, at: now(), by: "operator (offline)" };
    return applySwitch(reg);
}
export function acceptEdition(reg, id) {
    const e = editionById(reg, id);
    if (!e)
        throw new Error(`no such edition ${id}`);
    if (reg.current !== id)
        throw new Error(`${id} is not the current edition; switch to it first, then accept what you actually ran`);
    if (reg.probation)
        throw new Error(`${id} has not proven healthy yet`);
    e.acceptedAt = now();
    e.canonical = makeCanonical(e);
    note(e, "accepted", e.canonical);
    return reg;
}
/** Canonical means the source repository's main line carries this commit. Fast-forward only; never a merge commit, never a push. */
function makeCanonical(e) {
    const repo = repoRootOf(e.build.sourcePath);
    if (!repo)
        return `accepted; source ${e.build.sourcePath} is gone, so the main line was not updated`;
    if (e.build.dirty)
        return "accepted; built from an uncommitted working tree, so there is no commit to make canonical";
    const mainSha = git(["rev-parse", "--verify", "main^{commit}"], repo);
    if (!mainSha)
        return "accepted; the repository has no main branch to update";
    if (mainSha === e.build.sha || git(["merge-base", "--is-ancestor", e.build.sha, "main"], repo) !== null)
        return `accepted; main already contains ${e.build.sha.slice(0, 7)}`;
    if (git(["merge-base", "--is-ancestor", "main", e.build.sha], repo) === null)
        return `accepted; main has moved in a way that cannot be fast-forwarded to ${e.build.sha.slice(0, 7)}; merge it by hand`;
    // main may be checked out in another worktree of the same repository; fast-forward it where it lives.
    const blocks = (git(["worktree", "list", "--porcelain"], repo) ?? "").split(/\r?\n\r?\n/).map((b) => b.split(/\r?\n/));
    const mainWt = blocks.find((ls) => ls.includes("branch refs/heads/main"))?.[0]?.replace(/^worktree /, "") ?? null;
    if (mainWt) {
        if ((git(["status", "--porcelain", "--untracked-files=no"], mainWt) ?? "x").length)
            return `accepted; main was not fast-forwarded because ${mainWt} has uncommitted changes`;
        const r = spawnSync("git", ["merge", "--ff-only", e.build.sha], { cwd: mainWt, encoding: "utf8", windowsHide: true });
        return r.status === 0 ? `accepted; main fast-forwarded to ${e.build.sha.slice(0, 7)} in ${mainWt} (not pushed)` : `accepted; fast-forward failed: ${r.stderr.trim()}`;
    }
    const r = spawnSync("git", ["branch", "-f", "main", e.build.sha], { cwd: repo, encoding: "utf8", windowsHide: true });
    return r.status === 0 ? `accepted; main moved to ${e.build.sha.slice(0, 7)} in ${repo} (not pushed)` : `accepted; could not move main: ${r.stderr.trim()}`;
}
export function rejectEdition(reg, id, reason) {
    const e = editionById(reg, id);
    if (!e)
        throw new Error(`no such edition ${id}`);
    if (reg.current === id)
        throw new Error(`${id} is running; go back to the previous edition first, then reject it`);
    if (reg.switch?.to === id || reg.probation?.edition === id)
        throw new Error(`${id} is mid-switch`);
    e.status = "rejected";
    e.rejectedAt = now();
    note(e, "rejected", reason);
    if (reg.previous === id)
        reg.previous = null;
    fs.rmSync(editionPaths.edition(id), { recursive: true, force: true });
    return reg;
}
// --- where am I running from ------------------------------------------------------------------------------------
export const RUNNING_DIST = path.dirname(fileURLToPath(import.meta.url));
export function runningEditionId(reg, dist = RUNNING_DIST) {
    const norm = (p) => { try {
        return fs.realpathSync(p).toLowerCase();
    }
    catch {
        return path.resolve(p).toLowerCase();
    } };
    const d = norm(dist);
    return reg.editions.find((e) => norm(path.join(e.path, "dist")) === d)?.id ?? null;
}
export function fileUrl(p) { return pathToFileURL(p).href; }
//# sourceMappingURL=editions.js.map