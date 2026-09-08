// Conjure's knowledge of itself, cold: what is running, what exists, and where they disagree. Imagined, documented,
// implemented, built, proposed, accepted and running are different facts; this projection keeps them apart so
// Command Control can answer "do we have X?" without guessing from conversation history.
import fs from "node:fs";
import path from "node:path";
import { CAPABILITIES, CAPABILITY_IDS } from "./capabilities.js";
import { schemaAhead } from "./db.js";
import { SCHEMA_VERSION } from "./schema-version.js";
import { paths } from "./home.js";
import { RUNNING_DIST, SWITCH_EXIT_CODE, editionById, editionPaths, git, readManifest, readRegistry, recordSwitch, repoRootOf, runningEditionId, switchable, webHashOf, writeRegistry } from "./editions.js";
import { requestExit } from "./lifecycle.js";
import { append } from "./events.js";
// Facts fixed at boot: the manifest this process was started from. Anything that differs later is skew, not truth.
const MANIFEST_AT_BOOT = readManifest(RUNNING_DIST);
const WEB_HASH_AT_BOOT = webHashOf(RUNNING_DIST);
const BOOT_MANIFEST_JSON = JSON.stringify(MANIFEST_AT_BOOT);
let sourceCache = null;
function sourceStatus() {
    if (sourceCache && Date.now() - sourceCache.at < 60_000)
        return sourceCache.value;
    let value = null;
    const src = MANIFEST_AT_BOOT?.sourcePath;
    const repo = src ? repoRootOf(src) : null;
    if (repo && MANIFEST_AT_BOOT) {
        const head = git(["rev-parse", "HEAD"], repo);
        const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], repo) ?? "";
        const ahead = head ? Number(git(["rev-list", "--count", `${MANIFEST_AT_BOOT.sha}..HEAD`], repo) ?? 0) : 0;
        const dirty = (git(["status", "--porcelain", "--untracked-files=no"], repo) ?? "").length > 0;
        if (head)
            value = { path: repo, branch, head, aheadOfBuild: Number.isFinite(ahead) ? ahead : 0, dirty };
    }
    sourceCache = { at: Date.now(), value };
    return value;
}
function view(e, reg, runningIds) {
    const relation = reg.current === e.id ? "running" : reg.previous === e.id ? "previous" : e.status === "proposed" ? "proposed" : e.status === "rejected" ? "rejected" : e.status === "failed" ? "failed" : "retired";
    const caps = e.build.capabilities;
    return {
        id: e.id, status: e.status, relation, subject: e.build.subject, sha: e.build.sha, branch: e.build.branch, builtAt: e.build.builtAt, dirty: e.build.dirty, note: e.note,
        proposedAt: e.proposedAt, proposedBy: e.proposedBy, acceptedAt: e.acceptedAt, canonical: e.canonical, checks: e.checks, schemaVersion: e.build.schemaVersion,
        capabilities: caps.map((c) => c.name), adds: caps.filter((c) => !runningIds.includes(c.id)).map((c) => c.name), removes: CAPABILITIES.filter((c) => !caps.some((x) => x.id === c.id)).map((c) => c.name), events: e.events,
    };
}
function readSupervisor() {
    try {
        const s = JSON.parse(fs.readFileSync(paths.supervisor(), "utf8"));
        if (typeof s.pid !== "number")
            return null;
        let alive = false;
        try {
            process.kill(s.pid, 0);
            alive = true;
        }
        catch {
            alive = false;
        }
        return { pid: s.pid, alive, entry: typeof s.entry === "string" ? s.entry : null, edition: typeof s.edition === "string" ? s.edition : null };
    }
    catch {
        return null;
    }
}
/** Skew that needs no git and no registry: cheap enough for /api/status. */
export function skewNow(reg = readRegistry()) {
    const out = [];
    const onDisk = readManifest(RUNNING_DIST);
    if (!MANIFEST_AT_BOOT)
        out.push(`This Conjure was started from an unstamped build at ${RUNNING_DIST}; its commit and capabilities were not recorded when it was built.`);
    if (JSON.stringify(onDisk) !== BOOT_MANIFEST_JSON)
        out.push(`The code on disk at ${RUNNING_DIST} changed after this Conjure started${onDisk?.sha ? ` (disk: ${onDisk.sha.slice(0, 7)}${onDisk.dirty ? " dirty" : ""}, running: ${MANIFEST_AT_BOOT?.sha.slice(0, 7) ?? "unknown"})` : ""}. What answers you is the older one until Conjure restarts.`);
    const webNow = webHashOf(RUNNING_DIST);
    if (webNow !== WEB_HASH_AT_BOOT)
        out.push("The web UI on disk changed after this server started: browsers now load a UI this server was not started with.");
    else if (MANIFEST_AT_BOOT?.webHash && webNow !== MANIFEST_AT_BOOT.webHash)
        out.push("The web UI being served is not the one recorded in this build's manifest.");
    if (MANIFEST_AT_BOOT && (MANIFEST_AT_BOOT.capabilities.length !== CAPABILITY_IDS.length || MANIFEST_AT_BOOT.capabilities.some((c) => !CAPABILITY_IDS.includes(c.id))))
        out.push("This build's manifest lists different capabilities than its code has; the manifest is stale.");
    if (schemaAhead)
        out.push(`The database is at schema v${schemaAhead}, newer than this build's v${SCHEMA_VERSION}: a newer edition ran on it. This build ignores what it does not know.`);
    if (reg.current) {
        const cur = editionById(reg, reg.current);
        if (cur && runningEditionId(reg) !== reg.current)
            out.push(`Conjure is running from ${RUNNING_DIST}, not from the current edition ${reg.current} (${cur.path}). The supervisor that started it predates editions or was started by hand.`);
    }
    return out;
}
export function runningLabel(reg = readRegistry()) {
    const id = runningEditionId(reg);
    const e = id ? editionById(reg, id) : null;
    if (e)
        return e.build.subject || e.id;
    if (MANIFEST_AT_BOOT)
        return `${MANIFEST_AT_BOOT.subject || MANIFEST_AT_BOOT.sha.slice(0, 7)}${MANIFEST_AT_BOOT.dirty ? " (uncommitted changes)" : ""}`;
    return "unstamped build";
}
export function selfView(db, bootId, startedAt, container = null) {
    const reg = readRegistry();
    const runningId = runningEditionId(reg);
    const runningEdition = runningId ? editionById(reg, runningId) : null;
    const dbVersion = (() => { try {
        return db.pragma("user_version", { simple: true });
    }
    catch {
        return null;
    } })();
    const editions = reg.editions.map((e) => view(e, reg, CAPABILITY_IDS)).sort((a, b) => rank(a) - rank(b) || b.proposedAt.localeCompare(a.proposedAt));
    const pending = reg.switch ? `switching to ${reg.switch.to} (requested ${reg.switch.at} by ${reg.switch.by})` : reg.probation ? `${reg.probation.edition} is proving itself since ${reg.probation.since}` : null;
    return {
        asOf: new Date().toISOString(),
        running: {
            editionId: runningId, path: RUNNING_DIST, bootId, startedAt, pid: process.pid, node: process.version,
            build: MANIFEST_AT_BOOT ? { sha: MANIFEST_AT_BOOT.sha, branch: MANIFEST_AT_BOOT.branch, subject: MANIFEST_AT_BOOT.subject, builtAt: MANIFEST_AT_BOOT.builtAt, dirty: MANIFEST_AT_BOOT.dirty } : null,
            capabilities: CAPABILITIES, schemaVersion: SCHEMA_VERSION, dbSchemaVersion: dbVersion, accepted: !!runningEdition?.acceptedAt, label: runningLabel(reg),
        },
        supervisor: readSupervisor(),
        container,
        editions,
        ready: editions.filter((e) => e.relation === "proposed").sort((a, b) => b.adds.length - a.adds.length || b.proposedAt.localeCompare(a.proposedAt)),
        previous: editions.find((e) => e.relation === "previous") ?? null,
        pending,
        skew: skewNow(reg),
        source: sourceStatus(),
    };
}
function rank(e) { return e.relation === "running" ? 0 : e.relation === "proposed" ? 1 : e.relation === "previous" ? 2 : e.relation === "retired" ? 3 : e.relation === "failed" ? 4 : 5; }
/** The compact, complete truth Command Control receives. Text, not JSON: the model explains it, it does not parse it. */
export function selfBriefing(s) {
    const lines = [];
    const b = s.running.build;
    lines.push(`Running now: ${s.running.label}${b ? ` (commit ${b.sha.slice(0, 7)} on ${b.branch || "detached"}, built ${b.builtAt}${b.dirty ? ", from uncommitted changes" : ""})` : " (no build record)"}${s.running.editionId ? `, edition ${s.running.editionId}${s.running.accepted ? ", accepted" : ", on trial: not yet accepted"}` : ", not registered as an edition"}. Boot ${s.running.bootId}, pid ${s.running.pid}, schema v${s.running.schemaVersion}.`);
    lines.push(`Capabilities of the running Conjure (COMPLETE list; anything absent here does not exist in the Conjure the operator is using right now): ${s.running.capabilities.map((c) => c.name).join(", ")}.`);
    lines.push(s.container ? `Operated through: ${s.container.kind} container ${s.container.version} (${s.container.detail}). The container is not an edition: it runs whichever edition is current and survives edition switches.` : "Operated through: a browser or the CLI (no desktop container has announced itself this boot).");
    if (s.ready.length)
        for (const e of s.ready)
            lines.push(`Edition ready to evaluate: ${e.id} "${e.subject}" (${e.branch || "detached"} @ ${e.sha.slice(0, 7)}, built ${e.builtAt}, checks ${e.checks ? `${e.checks.passed}/${e.checks.total}` : "not run"}${e.note ? `, note: ${e.note}` : ""}). Compared with what runs it ADDS: ${e.adds.join(", ") || "nothing"}; REMOVES: ${e.removes.join(", ") || "nothing"}. It is NOT running; the operator can switch to it from Command Control ("Conjure itself" panel) or the launcher; switching keeps their data and can be undone with "go back".`);
    else
        lines.push("No edition is waiting to be evaluated.");
    if (s.previous)
        lines.push(`Previous edition kept: ${s.previous.id} "${s.previous.subject}" (go back is available; it would REMOVE: ${s.previous.removes.join(", ") || "nothing"}).`);
    if (s.pending)
        lines.push(`In progress: ${s.pending}.`);
    if (s.skew.length) {
        lines.push("SKEW (source, build, and runtime disagree):");
        for (const k of s.skew)
            lines.push(`- ${k}`);
    }
    else
        lines.push("Skew: none; source record, build and running server agree.");
    if (s.source)
        lines.push(`Source repository ${s.source.path} is on ${s.source.branch} at ${s.source.head.slice(0, 7)}${s.source.aheadOfBuild ? `, ${s.source.aheadOfBuild} commit(s) past this build (implemented in source, NOT built, NOT running)` : ", exactly this build"}${s.source.dirty ? ", with uncommitted changes" : ""}.`);
    for (const e of s.editions.filter((x) => x.relation === "failed" || x.relation === "rejected").slice(0, 3))
        lines.push(`${e.relation === "failed" ? "Failed" : "Rejected"} edition: ${e.id} "${e.subject}" (${e.events.at(-1)?.detail ?? ""}).`);
    return lines;
}
/** Take a copy of the database before another edition migrates it. Kept small: the last five. */
async function backupDb(db, label) {
    const dir = editionPaths.backups();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `conjure-${new Date().toISOString().replace(/[:.]/g, "-")}-before-${label}.db`);
    await db.backup(file);
    const old = fs.readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 5))) {
        try {
            fs.unlinkSync(path.join(dir, f));
        }
        catch { /* ignore */ }
    }
    return file;
}
/** The gateway's whole part in a switch: back the data up, record the request, step out. The supervisor does the rest. */
export async function switchEdition(db, id, by) {
    const reg = readRegistry();
    const why = switchable(reg, id);
    if (why)
        throw new Error(why);
    const sup = readSupervisor();
    if (!sup?.alive)
        throw new Error("no supervisor is running to perform the switch; stop Conjure, run `conjure edition switch " + id + "`, then start it again");
    const backup = await backupDb(db, id);
    writeRegistry(recordSwitch(readRegistry(), id, by));
    const e = editionById(reg, id);
    append(db, "edition", id, "switch-requested", { subject: e.build.subject, from: reg.current, backup });
    setTimeout(() => { if (!requestExit(SWITCH_EXIT_CODE, `switch to edition ${id}`))
        process.exit(SWITCH_EXIT_CODE); }, 250);
    return { switching: true, to: id, backup };
}
//# sourceMappingURL=self.js.map