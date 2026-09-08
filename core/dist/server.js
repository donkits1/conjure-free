// Gateway boot: open the database, listen, THEN do everything else. Boot repairs nothing.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { ensureHome, gatewayPort, paths } from "./home.js";
import { ensureSeeded } from "./org.js";
import { createRuntime, startReconciler, reconcileProcessesOnBoot, probeProviders, requestReconcile } from "./reconcile.js";
import { handle, setStartedAt } from "./api.js";
import { now } from "./ids.js";
import { GatewayAccess, applySecurityHeaders, fileSessionStore, mutationRejection, requestHeaderValues } from "./http-security.js";
import { onExitRequest } from "./lifecycle.js";
import { RUNNING_DIST, readManifest, readRegistry, runningEditionId } from "./editions.js";
import { ensureWellKnownTools, probeTools } from "./tools.js";
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const MAX_HEADER_PAIRS = 100;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };
export async function startGateway() {
    const home = ensureHome();
    const logFile = fs.createWriteStream(paths.log("gateway.log"), { flags: "a" });
    const log = (line) => { const l = `${now()} ${line}`; logFile.write(l + "\n"); if (process.env.CONJURE_QUIET !== "1")
        console.log(l); };
    const db = openDb();
    const rev = ensureSeeded(db);
    const rt = createRuntime(db, log);
    const startedAt = now();
    setStartedAt(startedAt);
    log(`[boot] ${rt.bootId} home=${home} revision=${rev.id} pid=${process.pid}`);
    const manifest = readManifest(RUNNING_DIST);
    log(`[boot] build ${manifest ? `${manifest.sha.slice(0, 7)}${manifest.dirty ? " dirty" : ""} (${manifest.branch}) built ${manifest.builtAt}` : "UNSTAMPED"} edition ${runningEditionId(readRegistry()) ?? "none"} from ${RUNNING_DIST}`);
    const port = gatewayPort();
    const access = new GatewayAccess(port, { sessionStore: fileSessionStore(path.join(home, "private", "sessions.json")) });
    let ready = false;
    const server = http.createServer((req, res) => {
        applySecurityHeaders(res);
        // headersDistinct is truncated at maxHeadersCount; reject excess pairs before using it.
        if (req.rawHeaders.length > MAX_HEADER_PAIRS * 2)
            return reject(res, 431, "too many headers");
        if (!access.hostAllowed(requestHeaderValues(req, "host")))
            return reject(res, 421);
        let url;
        try {
            url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        }
        catch {
            return reject(res, 400, "bad request");
        }
        if (req.method === "GET" && url.pathname === "/api/health")
            return health(res, rt.bootId, ready);
        if (req.method === "POST" && url.pathname === "/__conjure/session")
            return mintTicket(req, res, access);
        if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("bootstrap"))
            return bootstrap(url, res, access);
        if (!access.authorized(requestHeaderValues(req, "cookie"), requestHeaderValues(req, "authorization")))
            return unauthenticated(url, res);
        const mutation = mutationRejection({
            method: req.method ?? "GET",
            originValues: requestHeaderValues(req, "origin"),
            secFetchSiteValues: requestHeaderValues(req, "sec-fetch-site"),
            contentTypeValues: requestHeaderValues(req, "content-type"),
            expectedOrigin: `http://127.0.0.1:${port}`,
        });
        if (mutation)
            return reject(res, mutation.status, mutation.error);
        if (url.pathname.startsWith("/api/") || url.pathname === "/api/stream")
            res.setHeader("cache-control", "no-store");
        handle(rt, req, res).then((handled) => { if (!handled)
            serveStatic(req, res); }).catch((e) => {
            log(`[http] ${e.message}`);
            if (!res.headersSent) {
                res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
                res.end(JSON.stringify({ error: "internal" }));
            }
        });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.timeout = 30_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = MAX_HEADER_PAIRS;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve()); });
    fs.writeFileSync(paths.gateway(), JSON.stringify({ pid: process.pid, port, bootId: rt.bootId, startedAt, controlSecret: access.controlSecret }, null, 2), { mode: 0o600 });
    ready = true;
    log(`[boot] listening on http://127.0.0.1:${port}`);
    // Post-listen: never on the boot path.
    reconcileProcessesOnBoot(rt);
    void probeProviders(rt).then(() => { requestReconcile(rt); log(`[boot] providers probed`); });
    ensureWellKnownTools(db);
    void probeTools(db).then((ts) => log(`[boot] tools probed: ${ts.map((t) => `${t.id}=${t.state}`).join(", ") || "none"}`));
    const stopReconciler = startReconciler(rt);
    const shutdown = (sig, code = 0) => {
        log(`[boot] ${sig}: shutting down${code ? ` (exit ${code})` : ""}; running attempts will be marked interrupted by the next boot`);
        stopReconciler();
        server.close();
        try {
            if (fs.existsSync(paths.gateway()))
                fs.unlinkSync(paths.gateway());
        }
        catch { /* ignore */ }
        setTimeout(() => process.exit(code), 200).unref();
    };
    onExitRequest((code, why) => shutdown(why, code));
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("message", (m) => { if (m === "shutdown")
        shutdown("supervisor"); });
    return server;
}
function serveStatic(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let file = path.join(WEB_DIR, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(WEB_DIR)) {
        res.writeHead(403);
        res.end();
        return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (/^\/assets\//i.test(url.pathname))
            return reject(res, 404, "not found");
        file = path.join(WEB_DIR, "index.html");
    }
    if (!fs.existsSync(file)) {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end("Conjure gateway is up. The web UI is not built (pnpm build).");
        return;
    }
    const immutableAsset = /^\/assets\/[a-f0-9]{8,}\.[^/]+$/i.test(url.pathname);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": immutableAsset ? "public, max-age=31536000, immutable" : "no-store" });
    fs.createReadStream(file).pipe(res);
}
function reject(res, status, error = "forbidden") {
    const payload = JSON.stringify({ error });
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
    res.end(payload);
}
function health(res, bootId, ready) {
    const payload = JSON.stringify({ ok: ready, ready, bootId });
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
    res.end(payload);
}
function mintTicket(req, res, access) {
    const authorization = requestHeaderValues(req, "authorization");
    const contentLength = requestHeaderValues(req, "content-length");
    const zeroLength = contentLength.length <= 1
        && (contentLength.length === 0 || contentLength[0] === "0")
        && requestHeaderValues(req, "transfer-encoding").length === 0;
    if (authorization.length !== 1 || !zeroLength || !access.controlAuthorized(authorization[0]))
        return reject(res, 401, "unauthorized");
    const payload = JSON.stringify({ ticket: access.issueTicket() });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
    res.end(payload);
}
function bootstrap(url, res, access) {
    const session = access.consumeTicket(url.searchParams.get("bootstrap"));
    if (!session)
        return unauthenticated(url, res);
    res.writeHead(303, { location: "/", "set-cookie": access.sessionCookie(session), "cache-control": "no-store" });
    res.end();
}
function unauthenticated(url, res) {
    if (url.pathname.startsWith("/api/"))
        return reject(res, 401, "unauthorized");
    const payload = "<!doctype html><html><body><p>Please reopen Conjure from its launcher.</p></body></html>";
    res.writeHead(401, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
    res.end(payload);
}
//# sourceMappingURL=server.js.map