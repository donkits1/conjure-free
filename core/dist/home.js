// Where Conjure keeps its durable state. Never ~/.jinn: Tong 1 is prior art, not a store.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
export function conjureHome() {
    const env = process.env.CONJURE_HOME;
    const home = env && env.trim() ? path.resolve(env) : path.join(os.homedir(), ".conjure");
    const jinn = path.join(os.homedir(), ".jinn");
    if (path.resolve(home).toLowerCase() === path.resolve(jinn).toLowerCase()) {
        throw new Error("CONJURE_HOME must not be ~/.jinn (Tong 1 is read-only prior art)");
    }
    return home;
}
export function ensureHome() {
    const home = conjureHome();
    for (const sub of ["", "private", "logs", "workspaces"]) {
        fs.mkdirSync(path.join(home, sub), { recursive: true });
    }
    return home;
}
export const paths = {
    db: () => path.join(conjureHome(), "conjure.db"),
    supervisor: () => path.join(conjureHome(), "supervisor.json"),
    gateway: () => path.join(conjureHome(), "gateway.json"),
    log: (name) => path.join(conjureHome(), "logs", name),
    privateDir: (id) => path.join(conjureHome(), "private", id),
    workspaceDir: (id) => path.join(conjureHome(), "workspaces", id),
};
export function gatewayPort() {
    const p = Number(process.env.CONJURE_PORT ?? 7790);
    return Number.isFinite(p) && p > 0 ? p : 7790;
}
//# sourceMappingURL=home.js.map