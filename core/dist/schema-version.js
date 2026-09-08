// The schema version this build migrates to. Kept apart from db.ts so a build can describe itself (stamp.js)
// without loading the native database module; db.ts refuses to load if the two ever disagree.
export const SCHEMA_VERSION = 7;
//# sourceMappingURL=schema-version.js.map