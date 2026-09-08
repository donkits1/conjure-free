"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Conjure Desktop: the container. It owns what an application owns (launch, windows, tray, notifications, quit,
// recovery, the way out to the operator's browser) and adopts what it does not own (the organization: a supervisor
// and a gateway that outlive every window). Laws this file keeps:
//   - The container is not an edition. Editions are the product inside it; the container runs whichever is current.
//   - The container never replaces the gateway; the supervisor does. The container waits and reattaches.
//   - No localhost, port, ticket or process is an operator concept here. They exist; they are not asked about.
//   - Closing the window is not stopping the organization. Stopping is explicit and says what it interrupts.
//   - The window is a trusted local client with the same credentials a CLI has; the gateway's boundary is unchanged.
const electron_1 = require("electron");
const node_fs_1 = __importDefault(require("node:fs"));
const node_crypto_1 = require("node:crypto");
const node_http_1 = __importDefault(require("node:http"));
const node_path_1 = __importDefault(require("node:path"));
const machine_js_1 = require("./machine.js");
const APP_DIR = node_path_1.default.resolve(__dirname, "..");
const VERSION = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(APP_DIR, "package.json"), "utf8")).version;
process.env.CONJURE_DESKTOP_VERSION = VERSION;
const PARTITION = "persist:conjure";
const PROOF_DIR = process.env.CONJURE_DESKTOP_PROOF?.trim() || null;
const BOOT_WINDOW_MS = 150_000;
let loc;
let tray = null;
let quitting = false;
let stopOnQuit = false;
let hiddenOnce = false;
let startedByThisApp = false;
let gateway = null;
let liveBootId = null;
let missed = 0;
let sseAbort = null;
const windows = new Set();
const state = { phase: "locating", detail: "", since: new Date().toISOString(), bootId: null, port: null, home: "", supervisorPid: null, gatewayPid: null, edition: null, startedByThisApp: false };
const log = (line) => { const l = `${new Date().toISOString()} [desktop] ${line}`; console.log(l); try {
    node_fs_1.default.appendFileSync(node_path_1.default.join(loc.home, "logs", "desktop.log"), l + "\n");
}
catch { /* home may not exist yet */ } };
function setPhase(phase, detail) {
    if (state.phase !== phase)
        state.since = new Date().toISOString();
    state.phase = phase;
    state.detail = detail;
    const sup = (0, machine_js_1.readSupervisorRecord)(loc.home);
    state.supervisorPid = sup && (0, machine_js_1.pidAlive)(sup.pid) ? sup.pid : null;
    state.edition = sup?.edition ?? null;
    state.gatewayPid = gateway && (0, machine_js_1.pidAlive)(gateway.pid) ? gateway.pid : null;
    state.bootId = liveBootId;
    state.port = gateway?.port ?? loc.port;
    state.home = loc.home;
    state.startedByThisApp = startedByThisApp;
    updateTray();
}
// --- locate or start ---------------------------------------------------------------------------------------------
async function adopt() {
    const t0 = Date.now();
    let started = false;
    setPhase("locating", `Looking in ${loc.home}`);
    while (Date.now() - t0 < BOOT_WINDOW_MS && !quitting) {
        const rec = (0, machine_js_1.readGatewayRecord)(loc.home);
        if (rec && (0, machine_js_1.pidAlive)(rec.pid)) {
            const h = await (0, machine_js_1.health)(rec.port);
            if (h.ok) {
                gateway = rec;
                liveBootId = h.bootId;
                setPhase("adopted", `${started ? "Started" : "Adopted"} gateway pid ${rec.pid} on port ${rec.port}`);
                return rec;
            }
        }
        if (!started) {
            const sup = (0, machine_js_1.readSupervisorRecord)(loc.home);
            if (sup && (0, machine_js_1.pidAlive)(sup.pid)) {
                setPhase("starting", `Supervisor pid ${sup.pid} is alive; waiting for its gateway to answer`);
            }
            else {
                if (await (0, machine_js_1.portListening)(loc.port)) {
                    setPhase("failed", `Port ${loc.port} is held by another program that is not a Conjure gateway. Close it, or set CONJURE_PORT, and reopen Conjure.`);
                    return null;
                }
                const nv = (0, machine_js_1.nodeVersion)(loc.node);
                if (!nv.ok) {
                    setPhase("failed", nv.detail);
                    return null;
                }
                if (!node_fs_1.default.existsSync(node_path_1.default.join(loc.core, "dist", "cli.js"))) {
                    setPhase("failed", `No Conjure core at ${loc.core}. The container ships one; this copy is incomplete.`);
                    return null;
                }
                setPhase("starting", `Starting the supervisor with ${nv.version}`);
                const r = await (0, machine_js_1.startMachine)(loc);
                log(`conjure start -> ${r.code}: ${r.output}`);
                if (r.code !== 0) {
                    setPhase("failed", `conjure start failed: ${r.output || `exit ${r.code}`}`);
                    return null;
                }
                startedByThisApp = true;
                setPhase("starting", r.output.split("\n")[0] ?? "started");
            }
            started = true;
        }
        await new Promise((r) => setTimeout(r, 400));
    }
    if (!quitting)
        setPhase("failed", `The gateway did not answer within ${BOOT_WINDOW_MS / 1000}s. See ${node_path_1.default.join(loc.home, "logs")}.`);
    return null;
}
// --- windows -----------------------------------------------------------------------------------------------------
function bootUrl() { return "file://" + node_path_1.default.join(APP_DIR, "static", "boot.html").replace(/\\/g, "/"); }
function iconPath() {
    for (const p of [node_path_1.default.join(APP_DIR, "static", "conjure.ico"), node_path_1.default.join(APP_DIR, "static", "conjure.png"), node_path_1.default.join(process.resourcesPath ?? "", "conjure.ico")])
        if (node_fs_1.default.existsSync(p))
            return p;
    return undefined;
}
function createWindow(route) {
    const win = new electron_1.BrowserWindow({
        width: 1480, height: 940, minWidth: 900, minHeight: 600, show: false, backgroundColor: "#090d16", title: loc.preview ? "Conjure — Final product preview" : "Conjure", icon: iconPath(),
        autoHideMenuBar: true, fullscreen: !process.argv.includes("--windowed"),
        webPreferences: { preload: node_path_1.default.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: PARTITION, spellcheck: false },
    });
    windows.add(win);
    win.webContents.on("before-input-event", (event, input) => {
        if (input.type === "keyDown" && input.key === "F11" && !input.control && !input.alt && !input.meta) {
            event.preventDefault();
            if (!input.isAutoRepeat) win.setFullScreen(!win.isFullScreen());
        }
    });
    const reportWindowMode = (full) => {
        if (!win.isDestroyed()) win.webContents.send("window:mode-changed", full);
    };
    win.on("enter-full-screen", () => reportWindowMode(true));
    win.on("leave-full-screen", () => reportWindowMode(false));
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => windows.delete(win));
    win.on("close", (e) => {
        if (quitting)
            return;
        e.preventDefault();
        win.hide();
        if (!hiddenOnce && windows.size === 1) {
            hiddenOnce = true;
            notify({ title: "Conjure keeps working", body: "The organization runs in the tray. Reopen it from there, or stop it explicitly.", route: "" });
        }
    });
    // The window shows exactly one origin: the gateway. Everything else belongs to the operator's own browser.
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url) && !isGatewayUrl(url))
        void electron_1.shell.openExternal(url); return { action: "deny" }; });
    win.webContents.on("will-navigate", (e, url) => { if (!isGatewayUrl(url) && new URL(url).href !== new URL(bootUrl()).href) {
        e.preventDefault();
        if (/^https?:/i.test(url))
            void electron_1.shell.openExternal(url);
    } });
    win.webContents.on("did-fail-load", (_e, code, desc, url, isMain) => { if (isMain && !url.startsWith("file://")) {
        log(`did-fail-load ${code} ${desc} ${url}`);
        void win.loadURL(bootUrl());
    } });
    win.webContents.on("render-process-gone", (_e, d) => { log(`renderer gone: ${d.reason}`); void win.loadURL(bootUrl()); });
    win.on("page-title-updated", (e) => e.preventDefault());
    if (route)
        win.once("ready-to-show", () => { void openRoute(win, route); });
    return win;
}
function isGatewayUrl(url) { return !!gateway && url.startsWith((0, machine_js_1.gatewayBase)(gateway) + "/"); }
function mainWindow() { return [...windows].find((w) => !w.isDestroyed()) ?? null; }
function showWindow() { const w = mainWindow() ?? createWindow(); if (w.isMinimized())
    w.restore(); w.show(); w.focus(); return w; }
/** Load the product with a fresh app-private session. The hash survives the gateway's 303 to "/", so the route is kept. */
async function attach(win, route) {
    if (!gateway)
        return false;
    try {
        const url = await (0, machine_js_1.mintBootstrapUrl)(gateway);
        await win.loadURL(url + (route ? route : ""));
        return true;
    }
    catch (e) {
        log(`attach failed: ${e.message}`);
        return false;
    }
}
async function openRoute(win, route) {
    if (isGatewayUrl(win.webContents.getURL()))
        await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)}; undefined`).catch(() => { });
    else
        await attach(win, route);
}
// --- watch the machine; reattach after a restart or an edition switch ---------------------------------------------
async function watch() {
    if (quitting)
        return;
    const rec = (0, machine_js_1.readGatewayRecord)(loc.home);
    const h = rec ? await (0, machine_js_1.health)(rec.port) : { ok: false, bootId: null };
    if (h.ok && rec) {
        const newBoot = h.bootId !== liveBootId;
        const wasDown = state.phase === "reconnecting" || missed > 0;
        gateway = rec;
        liveBootId = h.bootId;
        missed = 0;
        if (newBoot || wasDown) {
            setPhase("adopted", `${newBoot ? "New boot" : "Back"}: gateway pid ${rec.pid} on port ${rec.port}`);
            log(`reattaching (${newBoot ? "new boot " + h.bootId : "recovered"})`);
            announce();
            subscribe();
            for (const w of windows)
                if (!w.isDestroyed()) {
                    const url = w.webContents.getURL();
                    const route = url.includes("#") ? url.slice(url.indexOf("#")) : undefined;
                    if (!isGatewayUrl(url) || newBoot)
                        void attach(w, route);
                }
        }
        else if (state.phase !== "adopted")
            setPhase("adopted", `gateway pid ${rec.pid} on port ${rec.port}`);
    }
    else {
        missed++;
        if (missed >= 2 && state.phase === "adopted") {
            const sup = (0, machine_js_1.readSupervisorRecord)(loc.home);
            const why = sup && (0, machine_js_1.pidAlive)(sup.pid) ? `Gateway not answering; supervisor pid ${sup.pid} is alive and owns the restart.` : "Gateway not answering and no supervisor is alive. Reopen Conjure to start one.";
            setPhase("reconnecting", why);
            log(`lost gateway: ${why}`);
            for (const w of windows)
                if (!w.isDestroyed() && isGatewayUrl(w.webContents.getURL()))
                    void w.loadURL(bootUrl());
        }
    }
    setTimeout(() => { void watch(); }, state.phase === "adopted" ? 4000 : 1500);
}
/** Tell the machine which container operates it. Old editions without the route simply ignore this. */
function announce() {
    if (!gateway)
        return;
    void (0, machine_js_1.controlPost)(gateway, "/api/self/container", { kind: "desktop", version: VERSION, electron: process.versions.electron, node: process.versions.node, pid: process.pid });
}
// --- notifications from the machine's own change stream ---------------------------------------------------------------
function subscribe() {
    if (!gateway)
        return;
    sseAbort?.abort();
    const ctl = new AbortController();
    sseAbort = ctl;
    const g = gateway;
    void (async () => {
        try {
            const r = await fetch((0, machine_js_1.gatewayBase)(g) + "/api/stream", { headers: { authorization: `Conjure ${g.controlSecret}` }, signal: ctl.signal });
            if (!r.ok || !r.body)
                return;
            const reader = r.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                buf += dec.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf("\n\n")) >= 0) {
                    const chunk = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    const data = chunk.split("\n").find((l) => l.startsWith("data: "));
                    if (chunk.startsWith("event: change") && data) {
                        try {
                            onChange(JSON.parse(data.slice(6)));
                        }
                        catch { /* malformed */ }
                    }
                }
            }
        }
        catch { /* aborted or gateway gone; watch() resubscribes */ }
    })();
}
function onChange(ev) {
    const s = (k) => (typeof ev.detail[k] === "string" ? ev.detail[k] : "");
    if (ev.entityType === "judgment" && ev.kind === "asked")
        notify({ title: "Conjure needs your judgment", body: s("question") || ev.entityId, route: "#/homework" });
    else if (ev.entityType === "work" && ev.kind === "done")
        notify({ title: "Delivered", body: s("summary") || ev.entityId, route: "#/control" });
    else if (ev.entityType === "wait" && ev.kind === "created")
        notify({ title: `Waiting on ${s("person")}`, body: `${s("kind")}${ev.detail.subjectId ? " · an obligation waits" : ""}`, route: "#/control" });
    else if (ev.entityType === "provider" && ev.kind === "unavailable")
        notify({ title: `Provider ${ev.entityId} unavailable`, body: s("detail"), route: "#/network/machine" });
    else if (ev.entityType === "edition" && ev.kind === "proposed")
        notify({ title: "A new edition of Conjure is ready to evaluate", body: s("subject"), route: "#/control" });
    else if (ev.entityType === "homework" && ev.kind === "submitted")
        notify({ title: "Homework taken", body: `${String(ev.detail.decided ?? "")} answer(s) are moving the machine`, route: "#/network" });
    void refreshTray();
}
function notify(n) {
    if (!electron_1.Notification.isSupported() || PROOF_DIR) {
        log(`notify: ${n.title} - ${n.body}`);
        return;
    }
    const note = new electron_1.Notification({ title: n.title, body: n.body, silent: true });
    note.on("click", () => { const w = showWindow(); if (n.route)
        void openRoute(w, n.route); });
    note.show();
}
// --- tray: the organization has a presence even with no window ----------------------------------------------------------
let trayCounts = "";
function trayIcon() {
    const p = iconPath();
    const img = p ? electron_1.nativeImage.createFromPath(p) : electron_1.nativeImage.createEmpty();
    return img.isEmpty() ? electron_1.nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVR4nGNgGAWjYBSMAv6DhP//IcQwZcBQhsGAgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYEBABQtBgFn2sJqAAAAAElFTkSuQmCC") : img.resize({ width: 16, height: 16 });
}
function updateTray() {
    if (!tray)
        return;
    const phase = state.phase === "adopted" ? "running" : state.phase;
    tray.setToolTip(`${loc.preview ? "Conjure Preview" : "Conjure"} · ${phase}${trayCounts ? " · " + trayCounts : ""}`);
    tray.setContextMenu(electron_1.Menu.buildFromTemplate([
        { label: "Open Conjure", click: () => showWindow() },
        { label: "Open full screen", click: () => showWindow().setFullScreen(true) },
        { label: "Open as a window", click: () => showWindow().setFullScreen(false) },
        { label: `Organization: ${phase}${state.edition ? ` · ${state.edition}` : ""}`, enabled: false },
        { label: trayCounts || "no counts yet", enabled: false },
        { type: "separator" },
        { label: "New window", click: () => { const w = createWindow(); void attach(w); } },
        { label: "Open the state folder", click: () => { void electron_1.shell.openPath(loc.home); } },
        { type: "separator" },
        { label: "Quit window (organization keeps working)", click: () => { quitting = true; stopOnQuit = false; electron_1.app.quit(); } },
        { label: "Stop the organization and quit", click: () => { void stopAndQuit(); } },
    ]));
}
async function refreshTray() {
    if (!gateway)
        return;
    const st = await (0, machine_js_1.controlGet)(gateway, "/api/status");
    if (st) {
        trayCounts = `${st.open} open · ${st.running} running · ${st.judgmentsOwed} need you`;
        updateTray();
    }
}
async function stopAndQuit() {
    quitting = true;
    stopOnQuit = true;
    setPhase("stopping", "conjure stop");
    for (const w of windows)
        if (!w.isDestroyed())
            void w.loadURL(bootUrl());
    const r = await (0, machine_js_1.stopMachine)(loc);
    log(`conjure stop -> ${r.code}: ${r.output}`);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
        const rec = (0, machine_js_1.readGatewayRecord)(loc.home);
        if (!rec || !(0, machine_js_1.pidAlive)(rec.pid))
            break;
        await new Promise((r2) => setTimeout(r2, 200));
    }
    electron_1.app.quit();
}
// --- IPC: the bridge's server side --------------------------------------------------------------------------------------
function trustedSender(e) {
    const win = electron_1.BrowserWindow.fromWebContents(e.sender);
    const url = e.senderFrame?.url;
    if (!win || !windows.has(win) || e.senderFrame !== e.sender.mainFrame || !url ||
        (!isGatewayUrl(url) && new URL(url).href !== new URL(bootUrl()).href))
        throw new Error("Untrusted desktop bridge caller");
}
electron_1.ipcMain.handle("machine:state", e => { trustedSender(e); return { ...state }; });
electron_1.ipcMain.handle("session:reauth", async (e) => { trustedSender(e); const w = electron_1.BrowserWindow.fromWebContents(e.sender); if (w) {
    const url = w.webContents.getURL();
    await attach(w, url.includes("#") ? url.slice(url.indexOf("#")) : undefined);
} });
electron_1.ipcMain.handle("shell:open-external", (e, url) => { trustedSender(e); if (/^https?:\/\//i.test(url))
    return electron_1.shell.openExternal(url); });
electron_1.ipcMain.handle("shell:notify", (e, n) => { trustedSender(e); notify({ title: String(n.title).slice(0, 120), body: String(n.body).slice(0, 400), route: typeof n.route === "string" && n.route.startsWith("#/") ? n.route : undefined }); });
electron_1.ipcMain.handle("window:hide", (e) => { trustedSender(e); electron_1.BrowserWindow.fromWebContents(e.sender)?.hide(); });
electron_1.ipcMain.handle("window:mode", (e) => { trustedSender(e); return electron_1.BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false; });
electron_1.ipcMain.handle("window:toggle-fullscreen", (e) => { trustedSender(e); const w = electron_1.BrowserWindow.fromWebContents(e.sender); if (w) w.setFullScreen(!w.isFullScreen()); });
electron_1.ipcMain.handle("window:minimize", (e) => { trustedSender(e); electron_1.BrowserWindow.fromWebContents(e.sender)?.minimize(); });
electron_1.ipcMain.handle("dialog:pick-folder", async (e, title) => { trustedSender(e); const w = electron_1.BrowserWindow.fromWebContents(e.sender); const r = await electron_1.dialog.showOpenDialog(w ?? undefined, { title: String(title), properties: ["openDirectory"] }); return r.canceled ? null : r.filePaths[0] ?? null; });
electron_1.ipcMain.handle("dialog:pick-file", async (e, title) => { trustedSender(e); const w = electron_1.BrowserWindow.fromWebContents(e.sender); const r = await electron_1.dialog.showOpenDialog(w ?? undefined, { title: String(title), properties: ["openFile"] }); return r.canceled ? null : r.filePaths[0] ?? null; });
// --- proof driver: only when CONJURE_DESKTOP_PROOF names a directory. Real input events into the real window. -----------
function startProofDriver(dir) {
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    const token = (0, node_crypto_1.randomBytes)(32).toString("base64url");
    const srv = node_http_1.default.createServer(async (req, res) => {
        // This privileged driver is opt-in and available only to the local proof client holding its file token.
        if (req.method !== "POST" || req.url !== "/" || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) {
            res.writeHead(401);
            res.end();
            return;
        }
        let body = "", bytes = 0;
        req.on("data", d => { bytes += d.length; if (bytes > 1_048_576) {
            req.destroy();
            return;
        } body += String(d); });
        req.on("end", async () => {
            const cmd = (() => { try {
                return JSON.parse(body || "{}");
            }
            catch {
                return {};
            } })();
            const w = mainWindow();
            const reply = (v) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(v ?? { ok: true })); };
            try {
                switch (cmd.cmd) {
                    case "state": return reply({ ...state, url: w?.webContents.getURL() ?? null, visible: w?.isVisible() ?? false, windows: windows.size, quitting });
                    case "screenshot": {
                        if (!w)
                            throw new Error("no window");
                        const filename = String(cmd.file);
                        if (node_path_1.default.basename(filename) !== filename || !filename.endsWith(".png"))
                            throw new Error("Screenshot must be a PNG filename inside the proof directory");
                        const img = await w.webContents.capturePage();
                        node_fs_1.default.writeFileSync(node_path_1.default.join(dir, filename), img.toPNG());
                        return reply({ ok: true, bytes: img.toPNG().length });
                    }
                    case "eval": {
                        if (!w)
                            throw new Error("no window");
                        return reply({ value: await w.webContents.executeJavaScript(String(cmd.js), true) });
                    }
                    case "click": {
                        if (!w)
                            throw new Error("no window");
                        const x = Number(cmd.x), y = Number(cmd.y);
                        w.webContents.sendInputEvent({ type: "mouseMove", x, y });
                        w.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
                        w.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
                        return reply({ ok: true });
                    }
                    case "key": {
                        if (!w)
                            throw new Error("no window");
                        w.webContents.sendInputEvent({ type: "keyDown", keyCode: String(cmd.key) });
                        w.webContents.sendInputEvent({ type: "keyUp", keyCode: String(cmd.key) });
                        return reply({ ok: true });
                    }
                    // a real drag: press, several moves, release (left = pan, right = orbit in the space); a real wheel step at a point
                    case "drag": {
                        if (!w)
                            throw new Error("no window");
                        const x0 = Number(cmd.x0), y0 = Number(cmd.y0), x1 = Number(cmd.x1), y1 = Number(cmd.y1);
                        const button = cmd.button === "right" ? "right" : "left";
                        w.webContents.sendInputEvent({ type: "mouseMove", x: x0, y: y0 });
                        w.webContents.sendInputEvent({ type: "mouseDown", x: x0, y: y0, button, clickCount: 1 });
                        for (let i = 1; i <= 8; i++) {
                            const x = x0 + ((x1 - x0) * i) / 8, y = y0 + ((y1 - y0) * i) / 8;
                            w.webContents.sendInputEvent({ type: "mouseMove", x, y, button });
                            await new Promise((r) => setTimeout(r, 16));
                        }
                        w.webContents.sendInputEvent({ type: "mouseUp", x: x1, y: y1, button, clickCount: 1 });
                        return reply({ ok: true });
                    }
                    case "wheel": {
                        if (!w)
                            throw new Error("no window");
                        const x = Number(cmd.x), y = Number(cmd.y);
                        w.webContents.sendInputEvent({ type: "mouseMove", x, y });
                        w.webContents.sendInputEvent({ type: "mouseWheel", x, y, deltaX: 0, deltaY: Number(cmd.deltaY ?? -120), canScroll: true });
                        return reply({ ok: true });
                    }
                    case "route": {
                        if (!w)
                            throw new Error("no window");
                        await openRoute(w, String(cmd.hash));
                        return reply({ ok: true });
                    }
                    case "close": {
                        w?.close();
                        return reply({ ok: true });
                    }
                    case "show": {
                        showWindow();
                        return reply({ ok: true });
                    }
                    case "size": {
                        const [width, height] = w?.getContentSize() ?? [0, 0];
                        return reply({ width, height });
                    }
                    case "resize": {
                        if (!w)
                            throw new Error("no window");
                        w.setSize(Math.max(900, Number(cmd.width)), Math.max(600, Number(cmd.height)));
                        return reply({ ok: true });
                    }
                    case "type": {
                        if (!w)
                            throw new Error("no window");
                        w.webContents.insertText(String(cmd.text ?? ""));
                        return reply({ ok: true });
                    }
                    case "quit": {
                        if (cmd.mode === "stop")
                            void stopAndQuit();
                        else {
                            quitting = true;
                            electron_1.app.quit();
                        }
                        return reply({ ok: true });
                    }
                    default: return reply({ error: `unknown cmd ${String(cmd.cmd)}` });
                }
            }
            catch (e) {
                reply({ error: e.message });
            }
        });
    });
    srv.listen(0, "127.0.0.1", () => { const a = srv.address(); if (a && typeof a === "object")
        node_fs_1.default.writeFileSync(node_path_1.default.join(dir, "driver.json"), JSON.stringify({ port: a.port, pid: process.pid, token })); });
}
// --- lifecycle --------------------------------------------------------------------------------------------------------------
// The container's own state (session partition, caches, the single-instance lock) lives inside the Conjure home it
// operates, so two homes are two applications and a proof run never collides with the operator's real one.
loc = (0, machine_js_1.locate)({ resourcesPath: process.resourcesPath, packaged: electron_1.app.isPackaged, appDir: APP_DIR });
node_fs_1.default.mkdirSync(node_path_1.default.join(loc.home, "desktop"), { recursive: true });
electron_1.app.setPath("userData", node_path_1.default.join(loc.home, "desktop"));
if (!electron_1.app.requestSingleInstanceLock()) {
    electron_1.app.quit();
}
else {
    electron_1.app.setAppUserModelId("Conjure");
    electron_1.app.on("second-instance", (_event, argv) => {
        const w = showWindow();
        if (argv.includes("--windowed")) w.setFullScreen(false);
        else if (argv.includes("--fullscreen")) w.setFullScreen(true);
    });
    electron_1.app.on("window-all-closed", () => { });
    electron_1.app.on("activate", () => showWindow());
    electron_1.app.on("before-quit", () => { quitting = true; sseAbort?.abort(); });
    void electron_1.app.whenReady().then(async () => {
        node_fs_1.default.mkdirSync(node_path_1.default.join(loc.home, "logs"), { recursive: true });
        log(`container ${VERSION} electron ${process.versions.electron} home=${loc.home} core=${loc.core} node=${loc.node} port=${loc.port}${PROOF_DIR ? " PROOF" : ""}`);
        const ses = electron_1.session.fromPartition(PARTITION);
        ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
        ses.setPermissionCheckHandler(() => false);
        tray = new electron_1.Tray(trayIcon());
        tray.on("click", () => showWindow());
        updateTray();
        if (PROOF_DIR)
            startProofDriver(PROOF_DIR);
        const win = createWindow();
        await win.loadURL(bootUrl());
        const rec = await adopt();
        if (rec) {
            announce();
            subscribe();
            void refreshTray();
            await attach(win);
            setInterval(() => { void refreshTray(); }, 15_000);
        }
        void watch();
    });
}
