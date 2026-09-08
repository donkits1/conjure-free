// `node dist/stamp.js describe` prints what THIS build says about itself; `node dist/stamp.js write` stamps
// dist/build.json from the git tree the dist lives in. Every build step ends with `write`, so a dist without a
// manifest is, by construction, one that was not built through Conjure's lifecycle; the self projection says so.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES } from "./capabilities.js";
import { SCHEMA_VERSION } from "./schema-version.js";
import { gitFacts, repoRootOf, stampManifest } from "./editions.js";
const dist = path.dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2] ?? "describe";
if (cmd === "describe") {
    process.stdout.write(JSON.stringify({ capabilities: CAPABILITIES.map(({ id, name }) => ({ id, name })), schemaVersion: SCHEMA_VERSION }));
}
else if (cmd === "write") {
    const repo = repoRootOf(dist);
    const facts = repo ? gitFacts(repo) : null;
    if (!repo || !facts) {
        console.error(`stamp: ${dist} is not inside a git repository; nothing written`);
        process.exit(1);
    }
    const m = stampManifest(dist, { ...facts, sourcePath: repo, editionId: null });
    console.log(`stamped ${m.sha.slice(0, 7)}${m.dirty ? " (dirty)" : ""} ${m.branch}: ${m.capabilities.length} capabilities, schema v${m.schemaVersion}`);
}
else {
    console.error("usage: stamp.js describe | write");
    process.exit(2);
}
//# sourceMappingURL=stamp.js.map