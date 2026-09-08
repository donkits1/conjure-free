# Changelog

All notable changes to the public Conjure repository are recorded here. Anything before 1.0 may change shape between releases.

## 0.1.0 (2026-09-08): first public release

The first public edition of Conjure, cut from build `522140f6` (schema v7).

- Desktop container (Electron 44) with tray presence, full-screen and windowed modes, native notifications and reattachment after engine restarts.
- Engine: supervisor, loopback gateway, deterministic reconciler, durable seats, obligations, attempts, leases, returns and judgments, immutable organization revisions, and attempt contracts recorded before every provider run.
- Surfaces: Universe, Rendezvous, Homework, Idea Room (notes, folders, seeds, private windows), Commission, Organization, Meetings and Outside waits, Workflow designer, Tools, Editions.
- Providers: Claude Code and Codex CLI adapters; experimental provider specs for any prompt-in, answer-out program.
- Built-in check suite that boots real gateways on temporary state.
- Portable, unsigned Windows x64 build attached to the release.

Known limitations of this release are listed in the README and in `docs/SOURCE.md`.
