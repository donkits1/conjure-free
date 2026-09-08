// The supervisor is the only process that starts, stops, or replaces the gateway. The gateway never replaces itself.
// It judges health only AFTER the gateway has bound its port, and only by an HTTP probe with a generous window.
// It is also the only process that performs an edition switch: the gateway records the request and exits; the
// supervisor applies it, runs the new edition on probation, and goes back to the previous one if it never gets healthy.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, gatewayPort, paths } from "./home.js";
import { now } from "./ids.js";
import { SWITCH_EXIT_CODE, applySwitch, clearProbation, editionById, gatewayEntryOf, readRegistry, revertProbation, writeRegistry } from "./editions.js";
const SIBLING_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "gateway-entry.js");
const BIND_WINDOW_MS = 120_000; // time to bind the port; boot does nothing before listen, so this is generous
const PROBE_MS = Number(process.env.CONJURE_SUPERVISOR_PROBE_MS ?? 15_000); // health probe cadence
const PROBE_TIMEOUT_MS = 10_000; // a probe that takes longer than this counts as one miss
const MISSES_BEFORE_REPLACE = 6; // ~90s of consecutive unresponsiveness (a blocked loop) before replacing
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Which gateway to run: the current edition when the registry names a runnable one, else the sibling of this file. */
function resolveEntry(log) {
    let reg = readRegistry();
    if (reg.switch) {
        const to = reg.switch.to;
        reg = applySwitch(reg);
        writeRegistry(reg);
        log(reg.current === to ? `[supervisor] switching to edition ${to}` : `[supervisor] switch to ${to} dropped: it has no runnable build`);
    }
    if (reg.current) {
        const e = editionById(reg, reg.current);
        const entry = e ? gatewayEntryOf(e) : null;
        if (entry)
            return { entry, edition: e.id };
        log(`[supervisor] current edition ${reg.current} has no runnable build; running ${SIBLING_ENTRY} instead`);
    }
    return { entry: SIBLING_ENTRY, edition: null };
}
export async function runSupervisor() {
    ensureHome();
    const logFile = fs.createWriteStream(paths.log("supervisor.log"), { flags: "a" });
    const log = (l) => { const s = `${now()} ${l}`; logFile.write(s + "\n"); console.log(s); };
    const state = { pid: process.pid, startedAt: now(), entry: SIBLING_ENTRY, edition: null, gateway: { pid: null, bootedAt: null, healthyAt: null, misses: 0, restarts: 0, state: "starting" } };
    const persist = () => fs.writeFileSync(paths.supervisor(), JSON.stringify(state, null, 2));
    let child = null;
    let stopping = false;
    let restarts = 0;
    let everHealthy = false;
    const startChild = () => {
        const { entry, edition } = resolveEntry(log);
        state.entry = entry;
        state.edition = edition;
        everHealthy = false;
        child = spawn(process.execPath, [entry], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, CONJURE_QUIET: process.env.CONJURE_QUIET ?? "1" }, windowsHide: true });
        state.gateway = { pid: child.pid ?? null, bootedAt: now(), healthyAt: null, misses: 0, restarts, state: "booting" };
        persist();
        log(`[supervisor] started gateway pid ${child.pid} from ${edition ?? "sibling build"} (${entry})`);
        child.on("exit", (code, sig) => {
            log(`[supervisor] gateway pid ${state.gateway.pid} exited (${code ?? sig})`);
            child = null;
            state.gateway.state = "exited";
            persist();
            if (stopping)
                return;
            if (code === SWITCH_EXIT_CODE) {
                setTimeout(startChild, 200);
                return;
            } // an edition switch: no backoff; the registry says what runs next
            const reg = readRegistry();
            if (reg.probation && !everHealthy) {
                // The edition we just switched to never answered a health probe. Do not retry it into the ground: go back.
                const failed = reg.probation.edition;
                const restored = revertProbation(reg, `exited (${code ?? sig}) before becoming healthy`);
                writeRegistry(restored);
                log(`[supervisor] edition ${failed} failed on probation; restoring ${restored.current ?? "sibling build"}`);
                setTimeout(startChild, 200);
                return;
            }
            const delay = BACKOFF_MS[Math.min(restarts, BACKOFF_MS.length - 1)];
            restarts++;
            setTimeout(startChild, delay);
        });
    };
    const probe = async () => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
        try {
            const r = await fetch(`http://127.0.0.1:${gatewayPort()}/api/health`, { signal: ctl.signal });
            const body = (await r.json().catch(() => null));
            return r.ok && body?.ok === true && body.ready === true;
        }
        catch {
            return false;
        }
        finally {
            clearTimeout(t);
        }
    };
    const tick = async () => {
        if (!child || stopping)
            return;
        const ok = await probe();
        const g = state.gateway;
        if (ok) {
            g.healthyAt = now();
            g.misses = 0;
            if (g.state !== "healthy") {
                g.state = "healthy";
                restarts = 0;
                log(`[supervisor] gateway healthy`);
            }
            if (!everHealthy) {
                everHealthy = true;
                const reg = readRegistry();
                if (reg.probation && reg.probation.edition === state.edition) {
                    writeRegistry(clearProbation(reg));
                    log(`[supervisor] edition ${state.edition} proved healthy`);
                }
            }
            persist();
            return;
        }
        const sinceBoot = Date.now() - Date.parse(g.bootedAt ?? now());
        if (g.state === "booting" && sinceBoot < BIND_WINDOW_MS)
            return; // still binding: leave it alone
        g.misses++;
        g.state = "unresponsive";
        persist();
        log(`[supervisor] gateway unresponsive (${g.misses}/${MISSES_BEFORE_REPLACE})`);
        if (g.misses >= MISSES_BEFORE_REPLACE) {
            log(`[supervisor] replacing gateway pid ${g.pid}`);
            child.kill();
        }
    };
    const stop = () => {
        stopping = true;
        log(`[supervisor] stopping`);
        if (child) {
            try {
                child.send("shutdown");
            }
            catch { /* ipc gone */ }
            setTimeout(() => child?.kill(), 3000).unref();
        }
        setTimeout(() => { try {
            fs.unlinkSync(paths.supervisor());
        }
        catch { /* ignore */ } process.exit(0); }, 3500).unref();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    startChild();
    setInterval(() => { void tick(); }, PROBE_MS);
    log(`[supervisor] pid ${process.pid} supervising on port ${gatewayPort()}`);
    await new Promise(() => { });
}
//# sourceMappingURL=supervisor.js.map