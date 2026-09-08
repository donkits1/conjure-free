import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export const SESSION_COOKIE = "conjure_session";
export const CONTROL_SCHEME = "Conjure";
export const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const TICKET_TTL_MS = 30_000;
const MAX_SESSIONS = 20;
const SESSION_TTL_MS = 24 * 60 * 60_000;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const secureToken = () => randomBytes(32).toString("base64url");
const sameSecret = (left, right) => {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
};
export class GatewayAccess {
    port;
    controlSecret;
    now;
    randomToken;
    tickets = new Map();
    sessions = new Map();
    store;
    constructor(port, options = {}) {
        this.port = port;
        this.now = options.now ?? Date.now;
        this.randomToken = options.randomToken ?? secureToken;
        this.controlSecret = this.randomToken();
        this.store = options.sessionStore ?? null;
        for (const s of this.store?.load() ?? [])
            if (SESSION_PATTERN.test(s.token) && this.now() - s.issuedAt < SESSION_TTL_MS)
                this.sessions.set(s.token, s.issuedAt);
    }
    hostAllowed(values) {
        return values.length === 1 && values[0] === `127.0.0.1:${this.port}`;
    }
    controlAuthorized(value) {
        const prefix = `${CONTROL_SCHEME} `;
        return value?.startsWith(prefix) === true
            && sameSecret(value.slice(prefix.length), this.controlSecret);
    }
    issueTicket() {
        const ticket = this.randomToken();
        this.tickets.set(ticket, this.now() + TICKET_TTL_MS);
        return ticket;
    }
    consumeTicket(ticket) {
        if (ticket === null)
            return null;
        const expiresAt = this.tickets.get(ticket);
        this.tickets.delete(ticket);
        if (expiresAt === undefined || expiresAt < this.now())
            return null;
        const session = this.randomToken();
        this.sessions.set(session, this.now());
        for (const [t, at] of this.sessions)
            if (this.now() - at >= SESSION_TTL_MS)
                this.sessions.delete(t);
        while (this.sessions.size > MAX_SESSIONS)
            this.sessions.delete(this.sessions.keys().next().value);
        this.store?.save([...this.sessions].map(([token, issuedAt]) => ({ token, issuedAt })));
        return session;
    }
    authorized(cookieValues, authorizationValues) {
        if (cookieValues.length > 1 || authorizationValues.length > 1)
            return false;
        if (authorizationValues.length === 1)
            return this.controlAuthorized(authorizationValues[0]);
        if (cookieValues.length !== 1)
            return false;
        const sessionValues = cookieValues[0].split(";")
            .map((pair) => pair.trim())
            .map((pair) => {
            const equals = pair.indexOf("=");
            return equals < 0 ? null : { name: pair.slice(0, equals), value: pair.slice(equals + 1) };
        })
            .filter((pair) => pair?.name === SESSION_COOKIE);
        return sessionValues.length === 1
            && [...this.sessions].some(([session, at]) => this.now() - at < SESSION_TTL_MS && sameSecret(sessionValues[0].value, session));
    }
    sessionCookie(session) {
        return `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`;
    }
}
export function fileSessionStore(file) {
    return {
        load: () => { try {
            const v = JSON.parse(fs.readFileSync(file, "utf8"));
            return Array.isArray(v) ? v.filter((x) => !!x && typeof x.token === "string" && typeof x.issuedAt === "number") : [];
        }
        catch {
            return [];
        } },
        save: (sessions) => { try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(sessions), { mode: 0o600 });
        }
        catch { /* a session that cannot be persisted still works for this boot */ } },
    };
}
export function requestHeaderValues(req, name) {
    return req.headersDistinct[name.toLowerCase()] ?? [];
}
export function mutationRejection(facts) {
    if (facts.method !== "POST")
        return null;
    if (facts.originValues.length !== 1 || facts.originValues[0] !== facts.expectedOrigin) {
        return { status: 403, error: "forbidden" };
    }
    if (facts.secFetchSiteValues.length > 1 || facts.secFetchSiteValues.some((value) => value.toLowerCase() === "cross-site")) {
        return { status: 403, error: "forbidden" };
    }
    if (facts.contentTypeValues.length !== 1 || facts.contentTypeValues[0].split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        return { status: 415, error: "unsupported media type" };
    }
    return null;
}
export function applySecurityHeaders(res) {
    res.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("permissions-policy", "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()");
    res.setHeader("cross-origin-opener-policy", "same-origin");
}
//# sourceMappingURL=http-security.js.map