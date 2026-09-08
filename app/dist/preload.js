"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// The one bridge between the product page and its container. Small on purpose: the page renders server
// projections and adds no truth; the container owns windows, tray, notifications, the machine's lifecycle,
// and the way out to the operator's own browser. Everything here is feature-detected by the page
// (`window.conjureDesktop`), so the same UI still works in a plain browser for checks and the CLI path.
const electron_1 = require("electron");
const api = {
    version: String(process.env.CONJURE_DESKTOP_VERSION ?? ""),
    platform: process.platform,
    /** What the container knows about the machine right now. Cold; polled by the boot page. */
    machine: () => electron_1.ipcRenderer.invoke("machine:state"),
    /** The page saw a 401: the session lapsed (24h) or the gateway restarted without its store. Ask for a fresh one. */
    reauth: () => electron_1.ipcRenderer.invoke("session:reauth"),
    /** A link that belongs to the operator's own browser, never to this window. */
    openExternal: (url) => electron_1.ipcRenderer.invoke("shell:open-external", String(url)),
    /** Native notification: a meaningful change or a genuine judgment need, never a timer. */
    notify: (n) => electron_1.ipcRenderer.invoke("shell:notify", n),
    /** Close this window; the organization keeps working in the tray. */
    hide: () => electron_1.ipcRenderer.invoke("window:hide"),
    /** Pick a folder with the OS dialog (workspace roots, tool locations). */
    pickFolder: (title) => electron_1.ipcRenderer.invoke("dialog:pick-folder", title ?? "Choose a folder"),
    pickFile: (title) => electron_1.ipcRenderer.invoke("dialog:pick-file", title ?? "Choose a program"),
};
electron_1.contextBridge.exposeInMainWorld("conjureDesktop", api);

// Desktop controls live outside the product's React tree and survive route changes.
// Escape remains the product's back/close key; F11 belongs to the native window.
window.addEventListener("DOMContentLoaded", () => {
    const host = document.createElement("div");
    host.id = "conjure-window-controls";
    host.style.cssText = "display:flex;flex-shrink:0;margin-left:12px;-webkit-app-region:no-drag";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      :host { color-scheme: dark; }
      .controls { display:flex; gap:6px; align-items:center; }
      button { background:#121a27; color:#dfe8f5; border:1px solid #334359; border-radius:8px; padding:8px 10px; font:12px system-ui, sans-serif; cursor:pointer; white-space:nowrap; }
      button:hover { background:#24354d; }
      button:focus-visible { outline:2px solid #9dbce5; outline-offset:2px; }
    </style><div class="controls" role="group" aria-label="Window controls"><button type="button" id="mode">Window · F11</button><button type="button" id="minimize" aria-label="Minimize Conjure" title="Minimize Conjure. Alt+Tab returns in the same mode.">−</button></div>`;
    const mode = shadow.getElementById("mode");
    const renderMode = full => {
        mode.textContent = full ? "Window · F11" : "Full screen · F11";
        mode.title = full ? "Leave full screen (F11). Alt+Tab switches apps without changing this mode." : "Enter full screen (F11). Alt+Tab switches apps without changing this mode.";
        mode.setAttribute("aria-label", full ? "Exit full screen (F11)" : "Enter full screen (F11)");
    };
    mode.addEventListener("click", () => { void electron_1.ipcRenderer.invoke("window:toggle-fullscreen"); });
    shadow.getElementById("minimize").addEventListener("click", () => { void electron_1.ipcRenderer.invoke("window:minimize"); });
    electron_1.ipcRenderer.on("window:mode-changed", (_event, full) => renderMode(full));
    void electron_1.ipcRenderer.invoke("window:mode").then(renderMode);
    const place = () => {
        const header = document.querySelector("#root > header, #root header");
        const parent = header ?? document.body;
        if (host.parentNode !== parent) parent.appendChild(host);
        const positioning = header ? "" : "position:fixed;top:12px;right:16px;z-index:2147483647;";
        const css = "display:flex;flex-shrink:0;margin-left:12px;-webkit-app-region:no-drag;" + positioning;
        if (host.style.cssText !== css) host.style.cssText = css;
    };
    place();
    new MutationObserver(place).observe(document.body, { childList:true, subtree:true });
});
