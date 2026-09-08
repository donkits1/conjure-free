import { GatewayAccess, SESSION_COOKIE, mutationRejection, } from "../http-security.js";
import { mintBrowserUrl, readGatewayRecord } from "../gateway-client.js";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BODY_LIMIT_BYTES } from "../http-security.js";
export async function httpSecurityPrimitiveChecks(record) {
    let clock = 1_000;
    let token = 0;
    const access = new GatewayAccess(47790, {
        now: () => clock,
        randomToken: () => `token-${++token}`,
    });
    record("SEC-U1: Host is an exact loopback authority", access.hostAllowed(["127.0.0.1:47790"])
        && !access.hostAllowed(["localhost:47790"])
        && !access.hostAllowed(["audit.attacker.example:47790"])
        && !access.hostAllowed(["127.0.0.1:47790", "attacker.example"]), "accepted one exact authority; rejected aliases, rebinding, and duplicates");
    record("SEC-U2: control authorization is exact", access.controlAuthorized(`Conjure ${access.controlSecret}`)
        && !access.controlAuthorized(access.controlSecret)
        && !access.controlAuthorized(`Bearer ${access.controlSecret}`), "only the Conjure authorization scheme is accepted");
    const ticket = access.issueTicket();
    const session = access.consumeTicket(ticket);
    record("SEC-U3: a bootstrap ticket is single-use", session === "token-3" && access.consumeTicket(ticket) === null, `first consume=${session !== null}; second consume=${access.consumeTicket(ticket) !== null}`);
    const expiring = access.issueTicket();
    clock += 30_001;
    record("SEC-U4: bootstrap tickets expire after 30 seconds", access.consumeTicket(expiring) === null, "expired ticket was rejected");
    record("SEC-U5: session cookies are exact", access.authorized([`${SESSION_COOKIE}=${session}`], [])
        && !access.authorized([`${SESSION_COOKIE}=wrong`], [])
        && !access.authorized([`other=${session}`], [])
        && !access.authorized([`${SESSION_COOKIE}=${session}`, `${SESSION_COOKIE}=${session}`], [])
        && !access.authorized([], [`Conjure ${access.controlSecret}`, `Conjure ${access.controlSecret}`]), "only a minted conjure_session value is accepted");
    const deniedOrigin = mutationRejection({
        method: "POST", originValues: ["https://attacker.example"],
        secFetchSiteValues: ["cross-site"], contentTypeValues: ["text/plain"],
        expectedOrigin: "http://127.0.0.1:47790",
    });
    const allowed = mutationRejection({
        method: "POST", originValues: ["http://127.0.0.1:47790"],
        secFetchSiteValues: ["same-origin"], contentTypeValues: ["application/json; charset=utf-8"],
        expectedOrigin: "http://127.0.0.1:47790",
    });
    const wrongMedia = mutationRejection({
        method: "POST", originValues: ["http://127.0.0.1:47790"],
        secFetchSiteValues: ["same-origin"], contentTypeValues: ["text/plain"],
        expectedOrigin: "http://127.0.0.1:47790",
    });
    record("SEC-U6: mutation policy requires same-origin JSON", deniedOrigin?.status === 403 && wrongMedia?.status === 415 && allowed === null, `hostile=${deniedOrigin?.status ?? "allowed"}; text=${wrongMedia?.status ?? "allowed"}; same-origin=${allowed?.status ?? "allowed"}`);
    const brokenStream = http.createServer((req) => { if (req.url === "/reset")
        req.socket.destroy(); });
    await new Promise((resolve) => brokenStream.listen(0, "127.0.0.1", resolve));
    try {
        const address = brokenStream.address();
        if (!address || typeof address === "string")
            throw new Error("missing test listener");
        for (const route of ["/reset", "/silent"]) {
            const outcome = await Promise.race([
                request(address.port, "GET", route, {}, undefined, true, 50).then(() => "headers", () => "rejected"),
                sleep(300).then(() => "hung"),
            ]);
            record(`SEC-U7${route}: stream helper rejects pre-header failure within its deadline`, outcome === "rejected", `outcome=${outcome}`);
        }
    }
    finally {
        brokenStream.closeAllConnections();
        await new Promise((resolve) => brokenStream.close(() => resolve()));
    }
}
const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, "..", "gateway-entry.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextPort = 8200 + Math.floor(Math.random() * 300);
function request(port, method, requestPath, headers = {}, body, stopAfterHeaders = false, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            req.destroy();
            reject(error);
        };
        const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json = null;
                try {
                    json = JSON.parse(text);
                }
                catch { /* not JSON */ }
                finish({ status: res.statusCode ?? 0, headers: res.headers, text, json });
            });
            res.on("error", fail);
            if (stopAfterHeaders) {
                finish({ status: res.statusCode ?? 0, headers: res.headers, text: "", json: null });
                req.destroy();
            }
        });
        const timer = setTimeout(() => fail(new Error("security check HTTP request timed out")), timeoutMs);
        req.on("error", fail);
        if (body)
            req.write(body);
        req.end();
    });
}
async function waitForGatewayRecord(home, timeout = 30_000) {
    const gateway = path.join(home, "gateway.json");
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        try {
            const record = JSON.parse(fs.readFileSync(gateway, "utf8"));
            if (typeof record.controlSecret === "string")
                return record;
        }
        catch { /* gateway has not written its record yet */ }
        await sleep(50);
    }
    return null;
}
async function bootGateway(port, home, workspace, socketTimeoutMs) {
    const env = { ...process.env, CONJURE_HOME: home, CONJURE_PORT: String(port), CONJURE_WORKSPACE_ROOT: workspace, CONJURE_FAKE_PROVIDER: "1", CONJURE_QUIET: "1" };
    // Change only Node's default idle timeout in this test child; all gateway routing stays real.
    const args = socketTimeoutMs === undefined ? [ENTRY] : ["--input-type=module", "-e",
        `import { startGateway } from ${JSON.stringify(pathToFileURL(path.join(here, "..", "server.js")).href)}; (await startGateway()).timeout = ${socketTimeoutMs};`];
    const proc = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const base = `http://127.0.0.1:${port}`;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
        try {
            if ((await request(port, "GET", "/api/health")).status < 500)
                return { proc, port, home, workspace, base };
        }
        catch { /* not ready */ }
        await sleep(50);
    }
    proc.kill();
    throw new Error(`gateway on ${port} did not answer within 30s`);
}
async function stopGateway(gateway) {
    gateway.proc.kill();
    await sleep(300);
}
async function runBrowserUrl(home, port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(here, "..", "cli.js"), "browser-url"], {
            env: { ...process.env, CONJURE_HOME: home, CONJURE_PORT: String(port) },
            stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, output }));
    });
}
function controlHeaders(secret, base, body) {
    return {
        authorization: `Conjure ${secret}`,
        origin: base,
        "content-type": "application/json",
        ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }),
    };
}
export async function httpSecurityIntegrationChecks(record) {
    const port = nextPort++;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-httpsec-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-httpsec-ws-"));
    let gateway;
    try {
        gateway = await bootGateway(port, home, workspace, 250);
        const recordFile = path.join(home, "gateway.json");
        const trustedGateway = readGatewayRecord(recordFile);
        const launchUrl = trustedGateway ? await mintBrowserUrl(trustedGateway) : "";
        record("SEC-11: the trusted client validates the gateway record and mints only a loopback URL", trustedGateway !== null
            && launchUrl.startsWith(`http://127.0.0.1:${port}/?bootstrap=`)
            && !launchUrl.includes(trustedGateway.controlSecret), `valid record=${trustedGateway !== null}; loopback ticket URL=${launchUrl.startsWith("http://127.0.0.1:")}`);
        const malformedPath = path.join(home, "malformed-gateway.json");
        const validRecord = { pid: 123, port: 47790, bootId: "boot_012345abcdef", startedAt: "2026-09-07T12:00:00Z", controlSecret: "A".repeat(43) };
        const invalidFields = [
            ["pid", ["123", 0, -1, 1.5, null]],
            ["port", ["47790", 0, -1, 65536, 1.5, null]],
            ["bootId", ["boot_012345abcde", "boot_012345ABCDEf", "other_012345abcdef", null]],
            ["startedAt", ["not-a-date", 123, null]],
            ["controlSecret", ["A".repeat(42), "A".repeat(44), "+".repeat(43), null]],
        ];
        fs.writeFileSync(malformedPath, JSON.stringify(validRecord));
        const baselineValid = readGatewayRecord(malformedPath) !== null;
        for (const [field, invalidValues] of invalidFields) {
            const rejected = invalidValues.filter((value) => {
                fs.writeFileSync(malformedPath, JSON.stringify({ ...validRecord, [field]: value }));
                return readGatewayRecord(malformedPath) === null;
            }).length;
            record(`SEC-12/${field}: malformed gateway field is rejected independently`, baselineValid && rejected === invalidValues.length, `valid baseline=${baselineValid}; rejected=${rejected}/${invalidValues.length}`);
        }
        const browser = await runBrowserUrl(home, port);
        record("SEC-13: browser-url prints one ephemeral loopback launcher URL", browser.code === 0
            && browser.output.trim().startsWith(`http://127.0.0.1:${port}/?bootstrap=`)
            && !browser.output.includes(trustedGateway?.controlSecret ?? ""), `exit=${browser.code}; loopback ticket URL=${browser.output.trim().startsWith("http://127.0.0.1:")}`);
        const firstRecord = await waitForGatewayRecord(home, 500);
        const controlSecret = firstRecord?.controlSecret ?? "missing-control-secret";
        const base = gateway.base;
        const noteBody = JSON.stringify({ title: "private marker", body: "private marker" });
        const marker = await request(port, "POST", "/api/notes", controlHeaders(controlSecret, base, noteBody), noteBody);
        const noteId = typeof marker.json?.id === "string" ? marker.json.id : "missing-note";
        const markerRead = await request(port, "GET", `/api/notes/${noteId}`, { authorization: `Conjure ${controlSecret}` });
        const rebound = await request(port, "GET", `/api/notes/${noteId}`, { host: `attacker.example:${port}`, authorization: `Conjure ${controlSecret}` });
        record("SEC-1: DNS rebinding Host cannot read private API data", markerRead.text.includes("private marker") && rebound.status === 421 && !rebound.text.includes("private marker"), `HTTP ${rebound.status}; leaked=${rebound.text.includes("private marker")}`);
        const unauth = await request(port, "GET", "/api/notes");
        const health = await request(port, "GET", "/api/health");
        record("SEC-2: unauthenticated API access is rejected", unauth.status === 401 && health.status === 200
            && JSON.stringify(Object.keys(health.json ?? {}).sort()) === JSON.stringify(["bootId", "ok", "ready"]), `private HTTP ${unauth.status}; health HTTP ${health.status}; fields=${Object.keys(health.json ?? {}).sort().join(",")}`);
        const malformed = await request(port, "GET", "//[").catch(() => null);
        const healthyAfterMalformed = await request(port, "GET", "/api/health").catch(() => null);
        record("SEC-14: malformed request targets are rejected without killing the gateway", malformed?.status === 400 && healthyAfterMalformed?.status === 200, `malformed=${malformed?.status ?? "connection failed"}; health=${healthyAfterMalformed?.status ?? "connection failed"}`);
        // Node truncates headersDistinct at maxHeadersCount, hiding the second Host from policy.
        const overLimitHeaders = ["Host", `127.0.0.1:${port}`,
            ...Array.from({ length: 99 }, (_, i) => [`X-Padding-${i}`, "ok"]).flat(),
            "Host", "attacker.example", "Connection", "close"];
        const headerOverflow = await request(port, "GET", "/api/health", overLimitHeaders);
        record("SEC-16: excess raw headers cannot hide a duplicate Host from policy", headerOverflow.status === 431, `102 header pairs; HTTP=${headerOverflow.status}`);
        const mint = await request(port, "POST", "/__conjure/session", { authorization: `Conjure ${controlSecret}`, "content-length": 0 });
        const ticket = typeof mint.json?.ticket === "string" ? mint.json.ticket : "missing-ticket";
        const bootstrap = await request(port, "GET", `/?bootstrap=${encodeURIComponent(ticket)}`);
        const cookieHeader = bootstrap.headers["set-cookie"]?.[0];
        const sessionValue = cookieHeader?.split(";", 1)[0]?.split("=", 2)[1] ?? "missing-session";
        const cookie = cookieHeader?.split(";", 1)[0];
        const beforeNotes = Array.isArray((await request(port, "GET", "/api/notes", { cookie: cookie ?? "", authorization: `Conjure ${controlSecret}` })).json?.notes)
            ? ((await request(port, "GET", "/api/notes", { cookie: cookie ?? "", authorization: `Conjure ${controlSecret}` })).json?.notes).length : -1;
        const attackBody = JSON.stringify({ title: "attacker marker", body: "attacker marker" });
        const attack = await request(port, "POST", "/api/notes", {
            cookie: cookie ?? "",
            origin: "https://attacker.example",
            "sec-fetch-site": "cross-site",
            "content-type": "text/plain",
            "content-length": Buffer.byteLength(attackBody),
        }, attackBody);
        const notesAfter = await request(port, "GET", "/api/notes", { cookie: cookie ?? "", authorization: `Conjure ${controlSecret}` });
        const afterNotes = Array.isArray(notesAfter.json?.notes) ? notesAfter.json.notes.length : -1;
        record("SEC-3: cross-site text/plain POST cannot mutate state", attack.status >= 400 && afterNotes === beforeNotes, `HTTP ${attack.status}; notes ${beforeNotes} -> ${afterNotes}`);
        record("SEC-4: control secret mints one short-lived browser ticket", mint.status === 200 && typeof mint.json?.ticket === "string", `HTTP ${mint.status}; ticket returned=${typeof mint.json?.ticket === "string"}`);
        const replay = await request(port, "GET", `/?bootstrap=${encodeURIComponent(ticket)}`);
        record("SEC-5: bootstrap establishes a session and cannot be replayed", bootstrap.status === 303 && Boolean(cookie) && replay.status === 401, `bootstrap=${bootstrap.status}; replay=${replay.status}; cookie=${Boolean(cookie)}`);
        const root = await request(port, "GET", "/", { cookie: cookie ?? "" });
        const status = await request(port, "GET", "/api/status", { cookie: cookie ?? "" });
        const stream = await request(port, "GET", "/api/stream", { cookie: cookie ?? "" }, undefined, true);
        record("SEC-6: authenticated browser routes and SSE still work", root.status === 200 && status.status === 200 && stream.status === 200, `root=${root.status}; status=${status.status}; stream=${stream.status}`);
        record("SEC-7: security headers and no-store are present", root.headers["content-security-policy"]?.includes("frame-ancestors 'none'") === true
            && status.headers["x-content-type-options"] === "nosniff"
            && status.headers["cache-control"] === "no-store", "CSP, nosniff, and no-store inspected on real responses");
        const missingAssets = await Promise.all(["/assets/deadbeef.js", "/Assets/deadbeef.js"].map((assetPath) => request(port, "GET", assetPath, { cookie: cookie ?? "" })));
        record("SEC-17: a missing hashed asset cannot cache the HTML fallback", missingAssets.every((asset) => asset.status === 404 && asset.headers["cache-control"] === "no-store"
            && !asset.text.toLowerCase().includes("<!doctype html")), missingAssets.map((asset) => `HTTP=${asset.status}; cache=${asset.headers["cache-control"]}`).join("; "));
        const emptyOversizeBody = JSON.stringify({ title: "large", body: "" });
        const oversize = Buffer.from(JSON.stringify({ title: "large", body: "x".repeat(BODY_LIMIT_BYTES + 1 - Buffer.byteLength(emptyOversizeBody)) }));
        const oversized = await request(port, "POST", "/api/notes", controlHeaders(controlSecret, base, oversize.toString("utf8")), oversize);
        record("SEC-8: oversized request bodies are rejected before routing", oversized.status === 413, `HTTP ${oversized.status}`);
        // Removing the speak response override must reset this socket before the real provider finishes.
        const conversationBody = JSON.stringify({ provider: "fake", title: "slow response regression" });
        const conversation = await request(port, "POST", "/api/conversations", controlHeaders(controlSecret, base, conversationBody), conversationBody);
        const speakBody = JSON.stringify({ content: "[[fake: sleep 750]] [[fake: done]]" });
        const spoken = await request(port, "POST", `/api/conversations/${conversation.json?.id}/speak`, controlHeaders(controlSecret, base, speakBody), speakBody).catch(() => null);
        record("SEC-15: a provider turn outlives the general idle timeout and returns its result", spoken?.status === 200 && spoken.json?.status === "done" && String(spoken.json?.content).includes("Completed the brief"), `default idle=250ms; provider delay=750ms; HTTP=${spoken?.status ?? "connection reset"}; turn=${spoken?.json?.status ?? "missing"}`);
        await stopGateway(gateway);
        gateway = await bootGateway(port, home, workspace);
        const nextRecord = await waitForGatewayRecord(home, 500);
        const nextControlSecret = nextRecord?.controlSecret ?? "missing-next-control-secret";
        const log = fs.readFileSync(path.join(home, "logs", "gateway.log"), "utf8");
        record("SEC-9: gateway logs contain no access material", !log.includes(controlSecret) && !log.includes(nextControlSecret)
            && !log.includes(ticket) && !log.includes(sessionValue), "scanned gateway.log across restart for both control secrets, the ticket, and the session value");
        const staleSession = await request(port, "GET", "/api/status", { cookie: cookie ?? "" });
        const staleControl = await request(port, "GET", "/api/status", { authorization: `Conjure ${controlSecret}` });
        // The control secret is per boot. The browser session deliberately is not: an edition switch or a restart must not
        // eject the operator (sessions are stored 0600 in the home, capped, and expire after 24h). A session file that was
        // tampered with, or a session token that never existed, still gets 401.
        const forged = await request(port, "GET", "/api/status", { cookie: "conjure_session=" + "A".repeat(43) });
        record("SEC-10: restart rotates the control secret; the browser session survives on purpose; a forged session does not", nextControlSecret !== controlSecret && staleSession.status === 200 && staleControl.status === 401 && forged.status === 401, `control rotated=${nextControlSecret !== controlSecret}; persisted session=${staleSession.status}; stale control=${staleControl.status}; forged session=${forged.status}`);
    }
    finally {
        if (gateway)
            await stopGateway(gateway);
    }
}
//# sourceMappingURL=http-security.js.map