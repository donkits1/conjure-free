// How Conjure finds and starts a provider process. One helper, used by every provider.
//
// Why this exists: on Windows an npm-installed CLI is not a program. `npm i -g @anthropic-ai/claude-code`
// writes TWO files into the npm prefix: an extensionless POSIX shell script (`claude`) that Windows
// cannot execute, and a batch shim (`claude.cmd`) that can. CreateProcess appends `.exe` to a name with
// no extension, so `spawn("claude")` looks for `claude.exe`, finds neither file, and fails with ENOENT --
// even though `where claude` prints a path and the CLI is installed and signed in. Presence is not
// executability, and "not found" is not "not authenticated". This module keeps those facts apart.
//
// Nothing here is Conjure's product behavior; it is a platform boundary. The portable core asks for
// "run this provider with these arguments" and this file decides what that means on the host OS.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
/** Raised for an argument cmd.exe cannot carry without changing its meaning. Refusing is the safe answer. */
export class UnsafeArgumentError extends Error {
    constructor(message) { super(message); this.name = "UnsafeArgumentError"; }
}
/** Extensions Windows can actually launch. .vbs/.js appear in PATHEXT but need a script host, so they are not here. */
const WINDOWS_RUNNABLE = [".exe", ".com", ".bat", ".cmd"];
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
function pathExt(env) {
    const raw = env.PATHEXT ?? env.PathExt ?? env.Pathext ?? DEFAULT_PATHEXT;
    return raw.split(";").map((e) => e.trim().toLowerCase()).filter((e) => e.startsWith("."))
        .filter((e) => WINDOWS_RUNNABLE.includes(e));
}
function pathDirs(env, platform) {
    const raw = env.PATH ?? env.Path ?? "";
    return raw.split(platform === "win32" ? ";" : ":").map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
}
function isFile(p) {
    try {
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    }
}
function kindOf(p) {
    return /\.(cmd|bat)$/i.test(p) ? "shim" : "direct";
}
/**
 * Find the file that will actually run for `bin`, or say precisely why nothing will.
 * `env` and `platform` are injected so this is testable off the host it describes.
 */
export function resolveExecutable(bin, env = process.env, platform = process.platform) {
    if (!bin || !bin.trim())
        return { found: false, reason: "not-installed" };
    const win = platform === "win32";
    const exts = win ? pathExt(env) : [];
    const hasDir = bin.includes("/") || bin.includes("\\") || path.isAbsolute(bin);
    const dirs = hasDir ? [null] : pathDirs(env, platform);
    /** A file with the right name that we cannot start; remembered so the operator is told the truth. */
    let unrunnable = null;
    for (const dir of dirs) {
        const base = dir === null ? path.resolve(bin) : path.join(dir, bin);
        if (win) {
            const ownExt = path.extname(base).toLowerCase();
            // An explicit, runnable extension wins outright.
            if (ownExt && exts.includes(ownExt) && isFile(base))
                return { found: true, path: base, kind: kindOf(base) };
            for (const ext of exts) {
                const candidate = base + ext;
                if (isFile(candidate))
                    return { found: true, path: candidate, kind: kindOf(candidate) };
            }
            // Name matches a real file, but Windows cannot launch it. This is the npm shell-script case.
            if (!unrunnable && isFile(base))
                unrunnable = base;
        }
        else {
            if (isFile(base)) {
                try {
                    fs.accessSync(base, fs.constants.X_OK);
                    return { found: true, path: base, kind: "direct" };
                }
                catch {
                    if (!unrunnable)
                        unrunnable = base;
                }
            }
        }
    }
    if (unrunnable) {
        return { found: false, reason: "not-executable",
            detail: win ? `${unrunnable} exists but is not a runnable Windows program (no .exe/.cmd/.bat beside it)`
                : `${unrunnable} exists but is not executable (chmod +x)` };
    }
    return { found: false, reason: "not-installed" };
}
/** Characters cmd.exe transforms in ways quoting cannot undo. We refuse rather than pass something else along. */
function assertCarryable(value, what) {
    if (value.includes("\0"))
        throw new UnsafeArgumentError(`${what} contains a NUL byte`);
    if (/[\r\n]/.test(value))
        throw new UnsafeArgumentError(`${what} contains a line break, which cmd.exe cannot carry`);
    if (value.includes("%"))
        throw new UnsafeArgumentError(`${what} contains '%', which cmd.exe would expand as a variable`);
}
/**
 * Quote one argument so that, after cmd.exe parses the line AND the batch shim re-expands it through %*,
 * the target program's C runtime recovers the original string byte for byte.
 *
 * Two passes of cmd.exe see this text, so a metacharacter must survive both. Real (unescaped) double
 * quotes are what does that: inside a quoted region cmd treats &, |, <, >, ^, (, ) and ; as ordinary
 * text on every pass. The only character that needs work is the double quote itself, which would end
 * the region -- so each one is caret-escaped for both passes and backslash-escaped for the CRT.
 */
function quoteShimArg(arg) {
    let out = '"';
    let backslashes = 0;
    for (const ch of arg) {
        if (ch === "\\") {
            backslashes++;
            continue;
        }
        if (ch === '"') {
            // Leave the quoted region: a caret is literal inside quotes, so an escaped quote cannot live there.
            // `\`*(2n+1) is what the target's C runtime needs; `^^^"` is one literal quote after two cmd parses.
            out += '"' + "\\".repeat(backslashes * 2 + 1) + '^^^"' + '"';
            backslashes = 0;
            continue;
        }
        out += "\\".repeat(backslashes);
        backslashes = 0;
        out += ch;
    }
    out += "\\".repeat(backslashes * 2);
    return out + '"';
}
/** The executable token. cmd.exe must parse this as the command name, so its quotes stay real and unescaped. */
function quoteShimExe(exe) {
    if (/[&|<>^()!"%\r\n\0]/.test(exe))
        throw new UnsafeArgumentError(`provider path contains a character cmd.exe cannot carry: ${exe}`);
    return `"${exe}"`;
}
/** Build the command line handed to `cmd.exe /d /s /c`, without the outer pair that /s strips. */
export function buildShimCommandLine(exe, args) {
    assertCarryable(exe, "provider path");
    args.forEach((a, i) => assertCarryable(a, `provider argument #${i + 1}`));
    return [quoteShimExe(exe), ...args.map(quoteShimArg)].join(" ");
}
/**
 * Start a provider process. A `.cmd`/`.bat` goes through cmd.exe because nothing else can run it;
 * everything else is executed directly, with no shell anywhere in the chain.
 */
export function spawnProvider(res, args, opts) {
    if (!res.found)
        throw new Error(`cannot start provider: ${res.reason}`);
    const base = { windowsHide: true, ...opts };
    if (res.kind !== "shim")
        return spawn(res.path, args, { ...base, shell: false });
    const line = buildShimCommandLine(res.path, args);
    // /d skip AutoRun, /s take the outer quotes off and use the rest as-is, /c run and exit.
    return spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...base, shell: false, windowsVerbatimArguments: true });
}
/** Run a provider to completion and collect its output. Used by probes, never for cognition. */
export function execProvider(res, args, opts) {
    const { timeoutMs = 15000, ...spawnOpts } = opts;
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawnProvider(res, args, { ...spawnOpts, stdio: ["ignore", "pipe", "pipe"] });
        }
        catch (e) {
            resolve({ code: null, stdout: "", stderr: "", error: e.message });
            return;
        }
        let stdout = "", stderr = "", settled = false;
        const finish = (o) => { if (settled)
            return; settled = true; clearTimeout(timer); resolve(o); };
        const timer = setTimeout(() => { try {
            proc.kill();
        }
        catch { /* gone */ } finish({ code: null, stdout, stderr, error: `timed out after ${timeoutMs}ms` }); }, timeoutMs);
        proc.stdout?.on("data", (d) => { stdout += String(d); if (stdout.length > 200_000)
            stdout = stdout.slice(-200_000); });
        proc.stderr?.on("data", (d) => { stderr += String(d); if (stderr.length > 200_000)
            stderr = stderr.slice(-200_000); });
        proc.on("error", (e) => finish({ code: null, stdout, stderr, error: e.message }));
        proc.on("close", (code) => finish({ code, stdout, stderr, error: null }));
    });
}
/** Wording a CLI uses when it runs fine but nobody is signed in. Matched loosely; never on exit code alone. */
const UNAUTHENTICATED = /not logged in|not authenticated|please (run )?(\/)?login|log ?in (first|required)|unauthori[sz]ed|invalid api key|no api key|missing api key|authentication (failed|required)|credentials? (not found|missing|invalid)|session (has )?expired|401/i;
/** Turn "what we found" plus "what it said" into one of the four states. Never guesses authentication from absence. */
export function classifyProbe(res, exec) {
    if (!res.found) {
        return res.reason === "not-installed"
            ? { state: "not-installed", available: false, detail: "not installed (no such command on PATH)" }
            : { state: "not-executable", available: false, detail: res.detail };
    }
    if (!exec)
        return { state: "ready", available: true, detail: `installed at ${res.path}` };
    if (exec.error)
        return { state: "error", available: false, detail: `could not run ${res.path}: ${exec.error}` };
    const said = `${exec.stdout}\n${exec.stderr}`;
    if (UNAUTHENTICATED.test(said)) {
        return { state: "not-authenticated", available: false, detail: `installed but not signed in: ${firstLine(said)}` };
    }
    try {
        const j = JSON.parse(exec.stdout.trim());
        if (typeof j.loggedIn === "boolean") {
            return j.loggedIn
                ? { state: "ready", available: true, detail: "installed and signed in" }
                : { state: "not-authenticated", available: false, detail: "installed but not signed in" };
        }
    }
    catch { /* the CLI does not answer in JSON; fall through to the exit code */ }
    if (exec.code === 0)
        return { state: "ready", available: true, detail: "installed and responding" };
    // It ran and failed without saying anything about credentials. Report that, do not invent a cause.
    return { state: "error", available: false, detail: `exited ${exec.code}: ${firstLine(said) || "no output"}` };
}
function firstLine(s) {
    return redact(s.split("\n").map((l) => l.trim()).filter(Boolean)[0]?.slice(0, 160) ?? "");
}
/**
 * Strip what must never reach a log file, a database row, or a diagnostics report.
 * A provider CLI answers with account identifiers and can echo a key back in an error. Conjure
 * stores no provider credentials, and this keeps the surfaces it DOES store honest about that.
 * A last line of defence, not a licence to pass secrets around.
 */
export function redact(text) {
    return text
        .replace(/\b(?:sk|pk|rk|api|key|tok|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
        .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]")
        .replace(/\b(token|secret|password|api[-_]?key|authorization)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]")
        .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]");
}
//# sourceMappingURL=provider-exec.js.map