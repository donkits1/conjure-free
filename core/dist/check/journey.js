// The human journey, in a real browser, without Playwright: Edge or Chrome headless driven over the DevTools protocol
// with nothing but Node's WebSocket. `node dist/check/journey.js` builds the two-edition world (see self.ts), opens
// Conjure the way the launcher does, and walks the playtest story: Teleport is absent; Control says an edition adds
// it; one click switches; the page comes back logged in, on the new edition; go back works. Screenshots land in
// CONJURE_JOURNEY_DIR (default: <home>/journey). `node dist/check/journey.js observe <bootstrapUrl> <outDir>` only
// looks at a running Conjure and screenshots Control and the machine view, printing the nav labels it found.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeWorld, seedWorld, startSupervisor, stopWorld, waitHealthy } from "./self.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, note) => { results.push({ name, ok, note }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  - ${note}`); };
export function findBrowser() {
    const candidates = [process.env.CONJURE_BROWSER, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
    return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}
class CDP {
    ws;
    seq = 0;
    pending = new Map();
    listeners = new Set();
    session = null;
    static async connect(url) {
        const c = new CDP();
        c.ws = new WebSocket(url);
        await new Promise((resolve, reject) => { c.ws.onopen = () => resolve(); c.ws.onerror = () => reject(new Error("devtools socket failed")); });
        c.ws.onmessage = (ev) => {
            const m = JSON.parse(String(ev.data));
            if (m.id !== undefined) {
                const p = c.pending.get(m.id);
                c.pending.delete(m.id);
                if (!p)
                    return;
                m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
            }
            else if (m.method)
                for (const l of c.listeners)
                    l(m.method, m.params ?? {}, m.sessionId);
        };
        return c;
    }
    send(method, params = {}, sessionId = this.session) {
        const id = ++this.seq;
        return new Promise((resolve, reject) => { this.pending.set(id, { resolve: resolve, reject }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    }
    on(l) { this.listeners.add(l); return () => this.listeners.delete(l); }
    async openPage() {
        const { targetId } = await this.send("Target.createTarget", { url: "about:blank" }, null);
        const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true }, null);
        this.session = sessionId;
        await this.send("Page.enable");
        await this.send("Runtime.enable");
        await this.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    }
    async nav(url) { await this.send("Page.navigate", { url }); await this.waitFor("document.readyState === 'complete'", 20_000); }
    async eval(expression) {
        const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails)
            throw new Error(r.exceptionDetails.text);
        return r.result.value;
    }
    async waitFor(expression, ms = 15_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) {
        try {
            if (await this.eval(`!!(${expression})`))
                return true;
        }
        catch { /* navigating */ }
        await sleep(150);
    } return false; }
    async text(selector) { return (await this.eval(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`)) ?? ""; }
    async click(selector) { return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`); }
    async shot(file) { const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(data, "base64")); }
    close() { try {
        this.ws.close();
    }
    catch { /* ignore */ } }
}
async function launchBrowser(exe) {
    const port = 9300 + Math.floor(Math.random() * 500);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-journey-profile-"));
    const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1400,1000", "about:blank"], { stdio: "ignore", windowsHide: true });
    const t0 = Date.now();
    let wsUrl = null;
    while (Date.now() - t0 < 20_000 && !wsUrl) {
        try {
            const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json());
            wsUrl = v.webSocketDebuggerUrl ?? null;
        }
        catch {
            await sleep(200);
        }
    }
    if (!wsUrl) {
        proc.kill();
        throw new Error("browser did not expose DevTools");
    }
    const cdp = await CDP.connect(wsUrl);
    await cdp.openPage();
    return { proc, cdp, profile };
}
async function bootstrapUrl(w, secret) {
    const r = await fetch(`${w.base}/__conjure/session`, { method: "POST", headers: { authorization: `Conjure ${secret}` } });
    const { ticket } = (await r.json());
    return `${w.base}/?bootstrap=${encodeURIComponent(ticket)}`;
}
const navLabels = (cdp) => cdp.eval(`[...document.querySelectorAll('nav .nav-links a .nav-label')].map(a => a.textContent)`);
export async function journey(outDir) {
    const exe = findBrowser();
    if (!exe) {
        console.log("SKIP  journey: no Chromium-based browser found (set CONJURE_BROWSER to msedge.exe or chrome.exe)");
        return false;
    }
    const w = makeWorld();
    seedWorld(w);
    let browser = null;
    try {
        startSupervisor(w);
        const g = await waitHealthy(w);
        if (!g)
            throw new Error("edition A never became healthy");
        browser = await launchBrowser(exe);
        const { cdp } = browser;
        // 1. Donne opens his normal Conjure the way the launcher opens it. Teleport is not in the nav.
        await cdp.nav(await bootstrapUrl(w, g.controlSecret));
        const shell = await cdp.waitFor("document.querySelector('[data-testid=self-panel]')", 20_000);
        const nav1 = await navLabels(cdp);
        const panel1 = await cdp.text("[data-testid=self-panel]");
        const foot1 = await cdp.text("[data-testid=foot-edition]");
        await cdp.shot(path.join(outDir, "1-control-before-switch.png"));
        record("J1: the normal Conjure opens on Command Control; Teleport is absent from the nav; the 'Conjure itself' panel says an edition adds it", shell && !nav1.includes("Teleport") && /Ready to try/.test(panel1) && /Teleport for the operator/.test(panel1) && /adds\s*Teleport/.test(panel1) && /Conjure as it is/.test(foot1), `nav=[${nav1.join(",")}] footer="${foot1.trim().slice(0, 60)}" panel mentions Teleport=${/Teleport/.test(panel1)}`);
        // 2. One click (plus confirm). The page waits for the new boot and reloads, still logged in.
        const armed = await cdp.click("[data-testid=switch-ed_bbbbbbb]");
        await cdp.waitFor("document.querySelector('[data-testid=confirm-switch-ed_bbbbbbb]')", 5_000);
        const confirmed = await cdp.click("[data-testid=confirm-switch-ed_bbbbbbb]");
        const came = await cdp.waitFor("/Teleport/.test(document.querySelector('[data-testid=self-capabilities]')?.textContent ?? '') && /trial/.test(document.querySelector('[data-testid=foot-edition]')?.textContent ?? '')", 90_000);
        await sleep(600);
        const foot2 = await cdp.text("[data-testid=foot-edition]");
        const panel2 = await cdp.text("[data-testid=self-panel]");
        const body2 = await cdp.eval("document.body.textContent ?? ''");
        await cdp.shot(path.join(outDir, "2-control-after-switch.png"));
        record("J2: switching from the page is one action; Conjure comes back on the new edition with the operator still signed in", armed && confirmed && came && /Teleport for the operator/.test(foot2) && /You are trying this edition/.test(panel2) && !/reopen Conjure from its launcher/i.test(body2), `footer="${foot2.trim().slice(0, 70)}" trialPanel=${/You are trying this edition/.test(panel2)} signedIn=${!/reopen Conjure/i.test(body2)}`);
        // 3. The machine view tells the same truth spatially.
        await cdp.nav(`${w.base}/#/network/machine`);
        const machine = await cdp.waitFor("document.querySelector('[data-testid=view-machine] [data-testid=self-panel]')", 15_000);
        const mtext = machine ? await cdp.text("[data-testid=view-machine]") : "";
        await cdp.shot(path.join(outDir, "3-network-machine.png"));
        record("J3: Network's cold-software view shows which edition this is, on trial, with go-back to the previous one", machine && /Teleport for the operator/.test(mtext) && /on trial/.test(mtext) && /You are trying this edition/.test(mtext) && /Go back/.test(mtext), `machineView=${machine} trial=${/on trial/.test(mtext)} goBack=${/Go back/.test(mtext)}`);
        // 4. Go back from the page. The previous edition returns; Teleport is gone again; the edition is kept for later.
        await cdp.nav(`${w.base}/#/control`);
        await cdp.waitFor("document.querySelector('[data-testid=self-trial]')", 15_000);
        const back = await cdp.eval(`(() => { const b = [...document.querySelectorAll('[data-testid=self-trial] button')].find(x => /Go back/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
        const backCame = await cdp.waitFor("/Conjure as it is/.test(document.querySelector('[data-testid=foot-edition]')?.textContent ?? '') && !/Teleport/.test(document.querySelector('[data-testid=self-capabilities]')?.textContent ?? '')", 90_000);
        await sleep(600);
        const panel4 = await cdp.text("[data-testid=self-panel]");
        await cdp.shot(path.join(outDir, "4-control-after-go-back.png"));
        record("J4: going back is the same one action; the earlier edition runs again and the tried one stays available", back && backCame && /Previous edition kept/.test(panel4) && /Teleport for the operator/.test(panel4), `back=${back} came=${backCame} panel mentions previous=${/Previous edition kept/.test(panel4)}`);
    }
    catch (e) {
        record("journey", false, `threw: ${e.stack}`);
    }
    finally {
        browser?.cdp.close();
        browser?.proc.kill();
        await stopWorld(w);
        if (browser) {
            await sleep(500);
            fs.rmSync(browser.profile, { recursive: true, force: true });
        }
    }
    return results.every((r) => r.ok);
}
/** Look at a running Conjure: screenshots of Control and the machine view; nav labels and the self panel text printed. */
export async function observe(url, outDir) {
    const exe = findBrowser();
    if (!exe)
        throw new Error("no browser");
    const b = await launchBrowser(exe);
    try {
        await b.cdp.nav(url);
        await b.cdp.waitFor("document.querySelector('nav .nav-links a')", 20_000);
        await b.cdp.waitFor("document.querySelector('[data-testid=self-panel]')", 20_000);
        await sleep(800);
        console.log(`nav: ${(await navLabels(b.cdp)).join(" | ")}`);
        console.log(`footer: ${(await b.cdp.text("[data-testid=foot-edition]")).trim()}`);
        console.log(`panel: ${(await b.cdp.text("[data-testid=self-panel]")).trim().slice(0, 600)}`);
        await b.cdp.shot(path.join(outDir, "control.png"));
        const origin = new URL(url).origin;
        for (const route of process.argv.slice(5)) {
            await b.cdp.nav(`${origin}/#/${route}`);
            await sleep(1200);
            console.log(`${route}: ${(await b.cdp.eval("(document.querySelector('main')?.textContent ?? '').slice(0, 300)")).replace(/\s+/g, " ")}`);
            await b.cdp.shot(path.join(outDir, `${route.replace(/[^a-z0-9]+/gi, "-")}.png`));
        }
    }
    finally {
        b.cdp.close();
        b.proc.kill();
        await sleep(400);
        fs.rmSync(b.profile, { recursive: true, force: true });
    }
}
const [, , cmd, a1, a2] = process.argv;
if (cmd === "observe") {
    observe(a1, a2 ?? path.join(os.tmpdir(), "conjure-observe")).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
else {
    const out = process.env.CONJURE_JOURNEY_DIR ?? path.join(os.tmpdir(), "conjure-journey");
    journey(out).then((ok) => { console.log(`\n${results.filter((r) => r.ok).length}/${results.length} journey checks passed; screenshots in ${out}`); process.exit(ok ? 0 : 1); });
}
//# sourceMappingURL=journey.js.map