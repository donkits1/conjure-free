import { randomBytes, createHash } from "node:crypto";
export function id(prefix) {
    return `${prefix}_${randomBytes(6).toString("hex")}`;
}
export function now() {
    return new Date().toISOString();
}
export function fingerprint(...parts) {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}
//# sourceMappingURL=ids.js.map