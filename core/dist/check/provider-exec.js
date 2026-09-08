// Evidence for the provider process boundary: how a provider binary is found and executed.
// These checks are hostile on purpose. A provider command line is assembled from configuration
// (model ids, efforts, workspace paths) and must never become a shell command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveExecutable, buildShimCommandLine, spawnProvider, UnsafeArgumentError, classifyProbe, } from "../provider-exec.js";
const WIN = process.platform === "win32";
function makeEcho() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-exec-"));
    const out = path.join(dir, "echo.json");
    const js = path.join(dir, "echo.js");
    fs.writeFileSync(js, [
        "const fs=require('fs');let d='';",
        "process.stdin.on('data',c=>{d+=c});",
        "process.stdin.on('end',()=>{fs.writeFileSync(process.env.CONJURE_ECHO_OUT,JSON.stringify({args:process.argv.slice(2),stdin:d}));process.exit(0);});",
        "setTimeout(()=>process.exit(3),10000);",
    ].join("\n"));
    // An npm-style install: an extensionless POSIX script CreateProcess cannot run, beside the real shims.
    fs.writeFileSync(path.join(dir, "echoargs"), "#!/bin/sh\nexec node echo.js \"$@\"\n");
    const shim = "@echo off\r\n\"" + process.execPath + "\" \"" + js + "\" %*\r\n";
    fs.writeFileSync(path.join(dir, "echoargs.cmd"), shim);
    // .bat lives apart: with the real PATHEXT order .BAT precedes .CMD, and X1 is about the .cmd shim.
    fs.mkdirSync(path.join(dir, "batdir"));
    fs.writeFileSync(path.join(dir, "batdir", "echoargs.bat"), shim);
    return { dir, out, read: () => JSON.parse(fs.readFileSync(out, "utf8")) };
}
function runEcho(echo, res, args, stdin = "") {
    if (!res.found)
        throw new Error("fixture did not resolve");
    try {
        fs.unlinkSync(echo.out);
    }
    catch { /* first run */ }
    const proc = spawnProvider(res, args, { cwd: echo.dir, env: { ...process.env, CONJURE_ECHO_OUT: echo.out }, stdio: ["pipe", "pipe", "pipe"] });
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { proc.kill(); reject(new Error("echo fixture timed out")); }, 20000);
        let err = "";
        proc.stderr?.on("data", (d) => { err += String(d); });
        proc.on("error", (e) => { clearTimeout(t); reject(e); });
        proc.on("close", (code) => {
            clearTimeout(t);
            try {
                resolve(echo.read());
            }
            catch {
                reject(new Error("no echo output (exit " + code + "): " + err.slice(-300)));
            }
        });
        proc.stdin?.on("error", () => { });
        proc.stdin?.end(stdin);
    });
}
/** Arguments that are ordinary text to a program but are control characters to cmd.exe. */
const HOSTILE = [
    "plain", "with space", "has\"quote", "amp&sand", "pipe|line", "caret^up", "redir>out", "redir<in",
    "(paren)", "semi;colon", "back\\slash", "trail\\\\", "mix \"a&b\" c", "bang!var!", "tick`grave",
    "sandbox_mode=\"workspace-write\"", "--effort", "high",
];
export async function providerExecChecks(record) {
    const echo = makeEcho();
    const withPath = { ...process.env, PATH: echo.dir, Path: echo.dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    // 1. THE ORIGINAL DEFECT. On Windows an npm-installed CLI is an extensionless script plus a .cmd
    //    shim. Presence is not executability: the resolver must skip the unrunnable file and find the shim.
    {
        const r = resolveExecutable("echoargs", withPath, "win32");
        const ok = r.found && /\.cmd$/i.test(r.path) && r.kind === "shim";
        record("X1: an npm-style extensionless script is skipped for its .cmd shim (the `spawn claude ENOENT` defect)", ok, r.found ? "resolved " + path.basename(r.path) + " kind=" + r.kind : "NOT FOUND (" + r.reason + ")");
    }
    // 2. A normal binary is still executed directly. cmd.exe must not creep in where it is not needed.
    {
        const r = resolveExecutable(process.execPath, process.env, "win32");
        record("X2: a real executable resolves to direct execution, not a shell", r.found && r.kind === "direct", r.found ? "kind=" + r.kind : "NOT FOUND (" + r.reason + ")");
    }
    // 3. Absent vs. present-but-unrunnable are different facts and must not collapse into one error.
    {
        const missing = resolveExecutable("definitely-not-installed-xyz", withPath, "win32");
        const noExt = { ...withPath, PATHEXT: ".COM;.EXE" }; // .cmd is not runnable in this environment
        const unrunnable = resolveExecutable("echoargs", noExt, "win32");
        const ok = !missing.found && missing.reason === "not-installed"
            && !unrunnable.found && unrunnable.reason === "not-executable";
        record("X3: 'not installed' and 'present but not executable' are distinguished", ok, "missing=" + (missing.found ? "found" : missing.reason) + " present-unrunnable=" + (unrunnable.found ? "found" : unrunnable.reason));
    }
    // 4/5. Round-trip. Whatever we hand the helper is what the program receives -- through a shim and directly.
    if (WIN) {
        const shim = resolveExecutable("echoargs", withPath, "win32");
        try {
            const got = await runEcho(echo, shim, HOSTILE, "prompt body\nsecond line");
            const same = JSON.stringify(got.args) === JSON.stringify(HOSTILE);
            record("X4: every cmd.exe metacharacter survives a .cmd shim unchanged (argument, not syntax)", same, same ? HOSTILE.length + "/" + HOSTILE.length + " arguments identical" : "got " + JSON.stringify(got.args).slice(0, 400));
            record("X5: stdin reaches a shim-launched provider (this is how the prompt travels)", got.stdin === "prompt body\nsecond line", "stdin=" + JSON.stringify(got.stdin));
        }
        catch (e) {
            record("X4/X5: shim round-trip", false, "threw: " + e.message);
        }
        const bat = resolveExecutable(path.join(echo.dir, "batdir", "echoargs.bat"), withPath, "win32");
        try {
            const got = await runEcho(echo, bat, HOSTILE);
            record("X6: .bat is handled exactly like .cmd", JSON.stringify(got.args) === JSON.stringify(HOSTILE), "bat kind=" + (bat.found ? bat.kind : "?") + " args=" + got.args.length);
        }
        catch (e) {
            record("X6: .bat round-trip", false, "threw: " + e.message);
        }
    }
    {
        const direct = resolveExecutable(process.execPath, process.env, process.platform);
        const js = path.join(echo.dir, "echo.js");
        try {
            const got = await runEcho(echo, direct, [js, ...HOSTILE]);
            record("X7: direct execution of a real binary round-trips identically (no regression for non-shims)", JSON.stringify(got.args) === JSON.stringify(HOSTILE), "args=" + got.args.length);
        }
        catch (e) {
            record("X7: direct round-trip", false, "threw: " + e.message);
        }
    }
    // 8. Command injection. A provider argument must never be able to run a second command.
    if (WIN) {
        const shim = resolveExecutable("echoargs", withPath, "win32");
        const marker = path.join(echo.dir, "PWNED.txt");
        const payloads = [
            "x\" & echo pwned> \"" + marker,
            "x & echo pwned> " + marker,
            "x && echo pwned> " + marker,
            "x | echo pwned> " + marker,
            "$(echo pwned> " + marker + ")",
            "`echo pwned> " + marker + "`",
        ];
        try {
            const got = await runEcho(echo, shim, payloads);
            const noFile = !fs.existsSync(marker);
            const literal = JSON.stringify(got.args) === JSON.stringify(payloads);
            record("X8: an injection payload in an argument executes nothing and arrives as literal text", noFile && literal, "side effect file created=" + !noFile + "; arguments literal=" + literal);
        }
        catch (e) {
            record("X8: injection", false, "threw: " + e.message);
        }
    }
    // 9. What cmd.exe cannot carry safely must be refused loudly, never silently mangled.
    {
        const cases = [["newline", "a\nb"], ["carriage return", "a\rb"], ["percent expansion", "%PATH%"], ["NUL", "a\0b"]];
        const refused = cases.filter(([, v]) => {
            try {
                buildShimCommandLine("c:\\x\\y.cmd", [v]);
                return false;
            }
            catch (e) {
                return e instanceof UnsafeArgumentError;
            }
        });
        const allowed = (() => { try {
            buildShimCommandLine("c:\\x\\y.cmd", HOSTILE);
            return true;
        }
        catch {
            return false;
        } })();
        record("X9: arguments cmd.exe cannot carry are refused with a named error; ordinary ones are not", refused.length === cases.length && allowed, "refused " + refused.map(([n]) => n).join(",") + "; hostile-but-legal accepted=" + allowed);
    }
    // 10. The four provider states the operator is owed, kept apart.
    {
        const notInstalled = classifyProbe({ found: false, reason: "not-installed" }, null);
        const notExec = classifyProbe({ found: false, reason: "not-executable", detail: "x" }, null);
        const unauth = classifyProbe({ found: true, path: "p", kind: "direct" }, { code: 1, stdout: "", stderr: "Invalid API key. Please run /login", error: null });
        const ready = classifyProbe({ found: true, path: "p", kind: "direct" }, { code: 0, stdout: "{\"loggedIn\":true}", stderr: "", error: null });
        const ok = notInstalled.state === "not-installed" && !notInstalled.available
            && notExec.state === "not-executable" && !notExec.available
            && unauth.state === "not-authenticated" && !unauth.available
            && ready.state === "ready" && ready.available;
        record("X10: not-installed / not-executable / not-authenticated / ready are four distinct provider states", ok, [notInstalled, notExec, unauth, ready].map((s) => s.state).join(" | "));
    }
    // 11. The real machine. Informational where claude is absent; a hard check where it is installed.
    {
        const r = resolveExecutable("claude", process.env, process.platform);
        if (!r.found)
            record("X11: local `claude` resolution", true, "not installed here (" + r.reason + ") - skipped");
        else
            record("X11: the locally installed `claude` resolves to something executable", WIN ? /\.(cmd|bat|exe)$/i.test(r.path) : true, r.path + " kind=" + r.kind);
    }
    // 12. A probe reads a provider's account payload. None of it may survive into what we store or show.
    {
        const secrets = [
            "Invalid API key: sk-ant-api03-AbCdEf0123456789AbCdEf0123456789",
            "logged in as donne@example.com (org 0b766805619744cc83b60d9a8267de30)",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            "token=abcd1234efgh5678ijkl",
        ];
        const leaked = secrets.filter((s) => {
            const out = classifyProbe({ found: true, path: "p", kind: "direct" }, { code: 7, stdout: "", stderr: s, error: null }).detail;
            return /sk-ant|@example\.com|eyJhbGci|abcd1234efgh5678ijkl|0b766805619744cc83b60d9a8267de30/.test(out);
        });
        record("X12: nothing secret or personally identifying survives from a provider payload into a stored detail", leaked.length === 0, leaked.length ? "LEAKED: " + leaked.join(" | ").slice(0, 300) : secrets.length + " payloads redacted");
    }
    try {
        fs.rmSync(echo.dir, { recursive: true, force: true });
    }
    catch { /* temp */ }
}
//# sourceMappingURL=provider-exec.js.map