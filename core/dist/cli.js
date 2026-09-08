// conjure start | stop | restart | status | doctor | gateway | import-tong1 | edition ... | self
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conjureHome, gatewayPort, paths } from "./home.js";
import { controlHeaders, gatewayBase, mintBrowserUrl, readGatewayRecord } from "./gateway-client.js";
import { pidAlive } from "./reconcile.js";
import { acceptEdition, editionById, proposeEdition, readRegistry, rejectEdition, repoRootOf, supervisorEntryOf, switchOffline, writeRegistry } from "./editions.js";
const here = path.dirname(fileURLToPath(import.meta.url));
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
}
/** The supervisor to start: the current edition's own, so nothing depends on where this CLI happens to live. */
function supervisorEntry() {
    const reg = readRegistry();
    const cur = reg.current ? editionById(reg, reg.current) : null;
    const own = cur ? supervisorEntryOf(cur) : null;
    return own ? { entry: own, edition: cur.id } : { entry: path.join(here, "supervisor-entry.js"), edition: null };
}
function gatewayRunning() { const g = readGatewayRecord(); return !!g && pidAlive(g.pid); }
function flag(rest, name) { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; }
function relation(reg, id) { return reg.current === id ? "CURRENT" : reg.previous === id ? "previous" : (editionById(reg, id)?.status ?? "?"); }
async function gatewayPost(p, body = {}) {
    const g = readGatewayRecord();
    if (!g)
        throw new Error("gateway record unreadable");
    const r = await fetch(gatewayBase(g) + p, { method: "POST", headers: { ...controlHeaders(g), origin: gatewayBase(g), "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json());
    if (!r.ok)
        throw new Error(String(j.error ?? r.status));
    return j;
}
async function main() {
    const [cmd = "help", ...rest] = process.argv.slice(2);
    switch (cmd) {
        case "start": {
            const sup = readJson(paths.supervisor());
            if (sup && typeof sup.pid === "number" && pidAlive(sup.pid)) {
                console.log(`supervisor already running (pid ${sup.pid})`);
                return;
            }
            if (rest.includes("--foreground")) {
                const { runSupervisor } = await import("./supervisor.js");
                await runSupervisor();
                return;
            }
            const { entry, edition } = supervisorEntry();
            const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
            child.unref();
            console.log(`conjure started (supervisor pid ${child.pid}, edition ${edition ?? "none: sibling build"}); home ${conjureHome()}; http://127.0.0.1:${gatewayPort()}`);
            return;
        }
        case "gateway": {
            const { startGateway } = await import("./server.js");
            await startGateway();
            return;
        }
        case "stop": {
            const sup = readJson(paths.supervisor());
            const gw = readJson(paths.gateway());
            for (const [name, rec] of [["supervisor", sup], ["gateway", gw]]) {
                if (rec && typeof rec.pid === "number" && pidAlive(rec.pid)) {
                    try {
                        process.kill(rec.pid);
                        console.log(`sent stop to ${name} pid ${rec.pid}`);
                    }
                    catch (e) {
                        console.log(`${name}: ${e.message}`);
                    }
                }
                else
                    console.log(`${name}: not running`);
            }
            return;
        }
        case "status": {
            const sup = readJson(paths.supervisor());
            const gateway = readGatewayRecord();
            console.log(`home: ${conjureHome()}`);
            console.log(`supervisor: ${sup && typeof sup.pid === "number" && pidAlive(sup.pid) ? `pid ${sup.pid} (${JSON.stringify(sup.gateway?.state)})` : "not running"}`);
            console.log(`gateway: ${gateway && pidAlive(gateway.pid) ? `pid ${gateway.pid} boot ${gateway.bootId}` : "not running"}`);
            const base = gateway ? gatewayBase(gateway) : `http://127.0.0.1:${gatewayPort()}`;
            const route = gateway ? "/api/status" : "/api/health";
            try {
                const r = await fetch(base + route, gateway ? { headers: controlHeaders(gateway) } : {});
                console.log(`http: ${r.status} ${JSON.stringify(await r.json())}`);
            }
            catch (e) {
                console.log(`http: unreachable (${e.message})`);
            }
            return;
        }
        case "browser-url": {
            const gateway = readGatewayRecord();
            if (!gateway)
                throw new Error("Conjure is not ready; reopen it after startup completes");
            console.log(await mintBrowserUrl(gateway));
            return;
        }
        case "restart": {
            const sup = readJson(paths.supervisor());
            if (sup && typeof sup.pid === "number" && pidAlive(sup.pid)) {
                try {
                    process.kill(sup.pid);
                }
                catch { /* already gone */ }
                // The supervisor asks the gateway to shut down, then exits; wait for it to release the port.
                const deadline = Date.now() + 20000;
                while (Date.now() < deadline) {
                    const s2 = readJson(paths.supervisor());
                    if (!s2 || typeof s2.pid !== "number" || !pidAlive(s2.pid))
                        break;
                    await new Promise((r) => setTimeout(r, 200));
                }
            }
            const { entry, edition } = supervisorEntry();
            const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
            child.unref();
            console.log(`conjure restarted (supervisor pid ${child.pid}, edition ${edition ?? "none: sibling build"}); http://127.0.0.1:${gatewayPort()}`);
            return;
        }
        case "doctor": {
            const { diagnose, formatReport } = await import("./doctor.js");
            const report = await diagnose();
            console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
            // Exit code is about the report being produced, not about the news it carries: a diagnostic
            // that fails when things are broken is useless exactly when it is needed.
            return;
        }
        case "import-tong1": {
            const { openDb } = await import("./db.js");
            const { importTong1, activateRevision } = await import("./org.js");
            const body = importTong1(rest.find((a) => !a.startsWith("--")));
            if (rest.includes("--dry-run")) {
                console.log(JSON.stringify(body, null, 2));
                return;
            }
            const db = openDb();
            const rev = activateRevision(db, body, "import", "imported from Tong 1 ACTIVE circuit");
            console.log(`activated ${rev.id} with ${rev.seats.length} seats (intake ${rev.routing.intake}, reviewer ${rev.routing.reviewer ?? "none"})`);
            return;
        }
        case "self": {
            // What Conjure knows about itself. From the gateway when it runs (full truth); from the registry when it does not.
            const g = readGatewayRecord();
            if (g && pidAlive(g.pid)) {
                const r = await fetch(gatewayBase(g) + "/api/self", { headers: controlHeaders(g) });
                const s = (await r.json());
                console.log(`running: ${s.running.label}${s.running.build ? ` (${s.running.build.sha.slice(0, 7)} ${s.running.build.branch}, built ${s.running.build.builtAt})` : " (unstamped)"} edition ${s.running.editionId ?? "none"}${s.running.accepted ? " accepted" : ""}`);
                console.log(`capabilities: ${s.running.capabilities.map((c) => c.name).join(", ")}`);
                for (const e of s.ready)
                    console.log(`ready to evaluate: ${e.id} "${e.subject}" adds ${e.adds.join(", ") || "nothing"}`);
                if (s.previous)
                    console.log(`previous (go back available): ${s.previous.id}`);
                if (s.pending)
                    console.log(`pending: ${s.pending}`);
                console.log(s.skew.length ? `SKEW:\n- ${s.skew.join("\n- ")}` : "skew: none");
            }
            else {
                const reg = readRegistry();
                console.log(`gateway: not running; current edition ${reg.current ?? "none"}; previous ${reg.previous ?? "none"}; ${reg.editions.length} edition(s) registered`);
            }
            return;
        }
        case "edition": {
            const [sub = "list", ...args] = rest;
            const reg = readRegistry();
            if (sub === "list") {
                if (!reg.editions.length) {
                    console.log(`no editions registered in ${conjureHome()}; propose one with: conjure edition propose --ref <branch>`);
                    return;
                }
                for (const e of [...reg.editions].sort((a, b) => b.proposedAt.localeCompare(a.proposedAt))) {
                    console.log(`${e.id}  ${relation(reg, e.id).padEnd(9)} ${e.build.sha.slice(0, 7)} ${(e.build.branch || "detached").padEnd(28)} ${e.build.subject.slice(0, 60)}`);
                    console.log(`  built ${e.build.builtAt} · checks ${e.checks ? `${e.checks.passed}/${e.checks.total}` : "not run"} · capabilities ${e.build.capabilities.map((c) => c.id).join(",") || "(unstated)"}${e.acceptedAt ? ` · accepted ${e.acceptedAt}` : ""}${e.note ? ` · ${e.note}` : ""}`);
                }
                if (reg.switch)
                    console.log(`switch pending: -> ${reg.switch.to}`);
                if (reg.probation)
                    console.log(`on probation: ${reg.probation.edition}`);
                return;
            }
            if (sub === "propose") {
                const source = flag(args, "--source") ?? repoRootOf(here) ?? process.cwd();
                const { edition } = proposeEdition({ source, ref: flag(args, "--ref"), note: flag(args, "--note"), checks: !args.includes("--no-checks"), by: flag(args, "--by") ?? "operator", log: (l) => console.log(`[propose] ${l}`) });
                console.log(`${edition.id} proposed: "${edition.build.subject}" (${edition.build.capabilities.length} capabilities, checks ${edition.checks ? `${edition.checks.passed}/${edition.checks.total}` : "not run"})`);
                console.log(reg.current ? `switch to it from Command Control, or: conjure edition switch ${edition.id}` : `make it current: conjure edition switch ${edition.id}`);
                return;
            }
            if (sub === "switch" || sub === "back") {
                const id = sub === "back" ? reg.previous : args[0];
                if (!id)
                    throw new Error(sub === "back" ? "there is no previous edition" : "usage: conjure edition switch <id>");
                if (gatewayRunning()) {
                    const r = await gatewayPost(`/api/self/editions/${encodeURIComponent(id)}/switch`);
                    console.log(`switching to ${id}; the supervisor will run it and go back automatically if it fails to become healthy (backup: ${String(r.backup)})`);
                    return;
                }
                writeRegistry(switchOffline(reg, id));
                console.log(`${id} is now the current edition; it runs at the next 'conjure start'`);
                return;
            }
            if (sub === "accept" || sub === "reject") {
                const id = args[0];
                if (!id)
                    throw new Error(`usage: conjure edition ${sub} <id>`);
                if (gatewayRunning()) {
                    await gatewayPost(`/api/self/editions/${encodeURIComponent(id)}/${sub}`, { reason: flag(args, "--reason") });
                }
                else
                    writeRegistry(sub === "accept" ? acceptEdition(reg, id) : rejectEdition(reg, id, flag(args, "--reason") ?? "operator"));
                const after = editionById(readRegistry(), id);
                console.log(`${id} ${sub}ed${after?.canonical ? `: ${after.canonical}` : ""}`);
                return;
            }
            console.log("usage: conjure edition list | propose [--ref <gitref>] [--source <repo>] [--note <text>] [--no-checks] | switch <id> | back | accept <id> | reject <id> [--reason <text>]");
            return;
        }
        default:
            console.log("usage: conjure start [--foreground] | stop | restart | status | self | edition ... | doctor [--json] | gateway | import-tong1 [jinnHome] [--dry-run]");
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
//# sourceMappingURL=cli.js.map