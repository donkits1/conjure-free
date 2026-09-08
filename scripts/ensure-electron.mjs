// Make sure the Electron binary is present after `pnpm install` / `npm install`.
// Some package managers skip Electron's own postinstall (the step that downloads the binary);
// this runs it explicitly when the binary is missing. Safe to run repeatedly.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";

const require = createRequire(import.meta.url);
let electronDir;
try {
  electronDir = path.dirname(require.resolve("electron/package.json"));
} catch {
  console.log("[ensure-electron] electron is not installed; nothing to do");
  process.exit(0);
}
const exe = path.join(electronDir, "dist", process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app" : "electron");
if (existsSync(exe)) {
  process.exit(0);
}
console.log("[ensure-electron] downloading the Electron binary (one time)...");
const r = spawnSync(process.execPath, [path.join(electronDir, "install.js")], { stdio: "inherit", cwd: electronDir });
if (r.status !== 0 || !existsSync(exe)) {
  console.error("[ensure-electron] the Electron binary could not be downloaded. Check your network, then run: node scripts/ensure-electron.mjs");
  process.exit(1);
}
console.log("[ensure-electron] ok");
