// One SQLite file. One schema. Forward-only migrations by version number; no shape recognizers.
import Database from "better-sqlite3";
import { SCHEMA_VERSION } from "./schema-version.js";
import { paths, ensureHome } from "./home.js";
export const MIGRATIONS = [
    // v1 - the whole product model.
    `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Organization: immutable snapshots. settings.active_revision names the one that governs new work.
  CREATE TABLE revisions (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, parent_id TEXT, created_at TEXT NOT NULL,
    created_by TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, hash TEXT NOT NULL);

  -- Work: a durable obligation. Small lifecycle; everything else is derived or a separate fact.
  CREATE TABLE work (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL, acceptance TEXT NOT NULL,
    seat TEXT NOT NULL, parent_id TEXT, source_kind TEXT, source_ref TEXT,
    status TEXT NOT NULL CHECK (status IN ('open','done','cancelled')),
    priority INTEGER NOT NULL DEFAULT 2, rounds INTEGER NOT NULL DEFAULT 0,
    revision_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT);
  CREATE INDEX work_status ON work(status);

  -- Hold: why open work is not being executed right now. Reason-carrying, with what clears it.
  CREATE TABLE holds (
    work_id TEXT PRIMARY KEY REFERENCES work(id), reason TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    clears_when TEXT NOT NULL, fingerprint TEXT NOT NULL, since TEXT NOT NULL);

  -- Attempt: one execution on behalf of work by allocated cognition. Terminal facts live here, never on a session.
  CREATE TABLE attempts (
    id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work(id), seat TEXT NOT NULL, role TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, workspace TEXT,
    status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted','unknown')),
    pid INTEGER, provider_session TEXT, started_at TEXT NOT NULL, ended_at TEXT, cost_usd REAL,
    receipt TEXT, error TEXT, round INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX attempts_work ON attempts(work_id);
  CREATE INDEX attempts_status ON attempts(status);

  -- Lease: the only basis for "a processor occupies a seat".
  CREATE TABLE leases (seat TEXT NOT NULL, scope TEXT NOT NULL, attempt_id TEXT NOT NULL, acquired_at TEXT NOT NULL,
    PRIMARY KEY (seat, scope));

  CREATE TABLE evidence (
    id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work(id), attempt_id TEXT, kind TEXT NOT NULL,
    locator TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  CREATE INDEX evidence_work ON evidence(work_id);

  -- Return: a usable outcome delivered to the operator. A quiet shelf, not an attention queue.
  CREATE TABLE returns (
    id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work(id), attempt_id TEXT, outcome TEXT NOT NULL,
    summary TEXT NOT NULL, created_at TEXT NOT NULL, seen_at TEXT);

  -- Judgment: a decision genuinely owed to a human. One table for product and technical kinds.
  CREATE TABLE judgments (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('product','technical')),
    subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, question TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL, recommended TEXT, priority INTEGER NOT NULL DEFAULT 2, fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','decided','withdrawn')),
    decision TEXT, decided_by TEXT, decided_at TEXT, note TEXT, created_at TEXT NOT NULL);
  CREATE INDEX judgments_status ON judgments(status);

  -- Events: append-only. What Command Control's "what changed" is computed from.
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
  CREATE INDEX events_at ON events(at);

  -- Processes: the one table of OS children this gateway owns. Reconciled against the OS on boot and each tick.
  CREATE TABLE processes (pid INTEGER PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL,
    started_at TEXT NOT NULL, last_seen TEXT NOT NULL, gateway_boot TEXT NOT NULL);

  -- Idea Room: operator-owned conversations. Private and repo-blind by default.
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('idea','partner','control')),
    provider TEXT NOT NULL, model TEXT NOT NULL, parent_id TEXT, exposure TEXT NOT NULL DEFAULT '[]',
    provider_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
  CREATE TABLE turns (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL,
    content TEXT NOT NULL, at TEXT NOT NULL, cost_usd REAL, status TEXT NOT NULL DEFAULT 'done', error TEXT);
  CREATE INDEX turns_conv ON turns(conversation_id);

  -- Artifacts: durable operator-owned objects that can be exposed, shared, or commissioned. Distinct acts.
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, conversation_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
    shared_at TEXT, served_work_id TEXT, served_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

  -- Provider status: last observed availability, kept so the cold product can show it truthfully.
  CREATE TABLE providers (name TEXT PRIMARY KEY, available INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '', observed_at TEXT NOT NULL);
  `,
    // v2 - operator roast: notes are durable terrain in folders; artifacts become notes; seeds; directives; effort.
    `
  CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, created_at TEXT NOT NULL);
  ALTER TABLE artifacts RENAME TO notes;
  ALTER TABLE notes ADD COLUMN folder_id TEXT;
  -- SQLite cannot widen a CHECK; rebuild conversations with the roles the room now has (idea, partner, control, directive, workflow).
  CREATE TABLE conversations_v2 (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('idea','partner','control','directive','workflow')),
    provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, parent_id TEXT, directive_id TEXT, exposure TEXT NOT NULL DEFAULT '[]',
    provider_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
  INSERT INTO conversations_v2(id,title,role,provider,model,parent_id,exposure,provider_session,created_at,updated_at,archived_at)
    SELECT id,title,role,provider,model,parent_id,exposure,provider_session,created_at,updated_at,archived_at FROM conversations;
  DROP TABLE conversations;
  ALTER TABLE conversations_v2 RENAME TO conversations;

  -- Idea seeds: latent possibilities worth revisiting. Not notes, not work.
  CREATE TABLE seeds (id TEXT PRIMARY KEY, text TEXT NOT NULL, source_conversation_id TEXT, status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL, used_at TEXT);

  -- Directives: operator intent that the company should do something. Becomes Work only when Conjure accepts responsibility.
  CREATE TABLE directives (id TEXT PRIMARY KEY, text TEXT NOT NULL, conversation_id TEXT, status TEXT NOT NULL DEFAULT 'open',
    work_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
    // v3 - context boundary: which notes a given window may see. Visibility only; never ownership, sharing, or commissioning.
    `
  CREATE TABLE conversation_context (
    conversation_id TEXT NOT NULL REFERENCES conversations(id), note_id TEXT NOT NULL REFERENCES notes(id),
    connected_at TEXT NOT NULL, PRIMARY KEY (conversation_id, note_id));
  `,
    // v4 - a provider is not merely available or not: it may be absent, present but unrunnable,
    // present but unauthenticated, or ready. Diagnostics cannot guide anyone without the distinction.
    `
  ALTER TABLE providers ADD COLUMN state TEXT NOT NULL DEFAULT 'unknown';
  `,
    // v5 - the human collaboration layer around the operator's machine. Three durable things, none of them a seat:
    //   person  - a real human outside Conjure, known from evidence or the operator's word. No provider, no lease, no lanes.
    //   wait    - what an obligation (or the operator) is waiting on from a person. A dependency Conjure records, never a task it manages.
    //   meeting - the organizational layer around a meeting humans hold elsewhere: purpose, time, people, preparation, consequences.
    // Homework needs no table: it is a batch view over open judgments; the batch itself is two settings.
    `
  CREATE TABLE people (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE waits (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), kind TEXT NOT NULL, description TEXT NOT NULL,
    subject_type TEXT, subject_id TEXT, source_kind TEXT NOT NULL DEFAULT 'operator', source_ref TEXT,
    status TEXT NOT NULL CHECK (status IN ('waiting','returned','cancelled')), since TEXT NOT NULL, due_at TEXT,
    returned_at TEXT, returned_summary TEXT, created_at TEXT NOT NULL);
  CREATE INDEX waits_subject ON waits(subject_type, subject_id);
  CREATE TABLE meetings (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('proposed','scheduled','held','cancelled')),
    starts_at TEXT, duration_min INTEGER NOT NULL DEFAULT 30, location TEXT NOT NULL DEFAULT '', candidates TEXT NOT NULL DEFAULT '[]',
    agenda TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT '', subject_type TEXT, subject_id TEXT, conversation_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE meeting_people (meeting_id TEXT NOT NULL REFERENCES meetings(id), person_id TEXT NOT NULL REFERENCES people(id), PRIMARY KEY (meeting_id, person_id));
  -- A conversation may now prepare a meeting. SQLite cannot widen a CHECK; rebuild as v2 did.
  CREATE TABLE conversations_v5 (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('idea','partner','control','directive','workflow','meeting')),
    provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, parent_id TEXT, directive_id TEXT, meeting_id TEXT, exposure TEXT NOT NULL DEFAULT '[]',
    provider_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
  INSERT INTO conversations_v5(id,title,role,provider,model,effort,parent_id,directive_id,exposure,provider_session,created_at,updated_at,archived_at)
    SELECT id,title,role,provider,model,effort,parent_id,directive_id,exposure,provider_session,created_at,updated_at,archived_at FROM conversations;
  DROP TABLE conversations;
  ALTER TABLE conversations_v5 RENAME TO conversations;
  `,
    // v6 - tools: real programs available to work (Godot, Aseprite, ...). Capabilities, never cognition: a tool is located and
    // probed by cold software, granted to seats by the operator, and told to worker attempts. Experimental until promoted.
    `
  CREATE TABLE tools (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('application','cli')), command TEXT NOT NULL,
    probe_args TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK (status IN ('experimental','promoted')), note TEXT NOT NULL DEFAULT '',
    usage TEXT NOT NULL DEFAULT '', available INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'unknown', detail TEXT NOT NULL DEFAULT '',
    version TEXT, observed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
    // v7: what an attempt actually received survives the intelligence that received it.
    `CREATE TABLE attempt_contracts (attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), snapshot TEXT NOT NULL);`,
];
if (MIGRATIONS.length !== SCHEMA_VERSION)
    throw new Error(`schema-version.ts says v${SCHEMA_VERSION} but db.ts has ${MIGRATIONS.length} migrations; fix one`);
/** Set when the database is at a schema newer than this build knows (a newer edition ran on it). */
export let schemaAhead = null;
export function openDb(file = paths.db()) {
    ensureHome();
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    const version = db.pragma("user_version", { simple: true });
    // A newer edition may have run on this database (the operator tried it and came back). Migrations are additive
    // by law, so an older build keeps working and simply ignores what it does not know; the self projection reports it.
    if (version > MIGRATIONS.length)
        schemaAhead = version;
    if (version < MIGRATIONS.length) {
        // A table rebuild (SQLite's only honest way to change a CHECK) drops a table that live rows in other tables
        // reference. Enforcement is suspended for the migration run and the result is verified before it is trusted:
        // a migration that leaves a dangling reference refuses to boot rather than running on a corrupt store. Fresh
        // databases never exercise this path (their referencing tables are empty); the operator's database does.
        db.pragma("foreign_keys = OFF");
        for (let v = version; v < MIGRATIONS.length; v++) {
            db.transaction(() => {
                db.exec(MIGRATIONS[v]);
                db.pragma(`user_version = ${v + 1}`);
            })();
        }
        const dangling = db.pragma("foreign_key_check");
        if (dangling.length) {
            db.close();
            throw new Error(`migrating conjure.db to v${MIGRATIONS.length} left ${dangling.length} dangling reference(s); refusing to run on it`);
        }
    }
    db.pragma("foreign_keys = ON");
    return db;
}
export function getSetting(db, key) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row?.value ?? null;
}
export function setSetting(db, key, value) {
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
//# sourceMappingURL=db.js.map