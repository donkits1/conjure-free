import fs from "node:fs";
import { paths } from "./home.js";
import { CONTROL_SCHEME } from "./http-security.js";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BOOT_ID_PATTERN = /^boot_[0-9a-f]{12}$/;
function isGatewayRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    const { pid, port, bootId, startedAt, controlSecret } = record;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0
        && typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535
        && typeof bootId === "string" && BOOT_ID_PATTERN.test(bootId)
        && typeof startedAt === "string" && Number.isFinite(Date.parse(startedAt))
        && typeof controlSecret === "string" && TOKEN_PATTERN.test(controlSecret);
}
export function readGatewayRecord(file = paths.gateway()) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return isGatewayRecord(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
export function controlHeaders(record) {
    return { authorization: `${CONTROL_SCHEME} ${record.controlSecret}` };
}
export function gatewayBase(record) {
    return `http://127.0.0.1:${record.port}`;
}
export async function mintBrowserUrl(record) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
        const response = await fetch(`${gatewayBase(record)}/__conjure/session`, {
            method: "POST",
            headers: controlHeaders(record),
            redirect: "manual",
            signal: controller.signal,
        });
        if (response.status !== 200)
            throw new Error("Conjure did not mint a browser session");
        const body = await response.json().catch(() => null);
        const ticket = body !== null && typeof body === "object" && !Array.isArray(body)
            ? body.ticket
            : null;
        if (typeof ticket !== "string" || !TOKEN_PATTERN.test(ticket)) {
            throw new Error("Conjure returned an invalid browser session");
        }
        return `${gatewayBase(record)}/?bootstrap=${encodeURIComponent(ticket)}`;
    }
    finally {
        clearTimeout(timeout);
    }
}
//# sourceMappingURL=gateway-client.js.map