# Source status

This repository is the public, free edition of Conjure. This page says plainly what form the code is in.

## What is here

- `core/dist/**`: the engine, as the JavaScript emitted by the TypeScript compiler. It is unminified and readable: one file per module, comments preserved, no bundling. `core/dist/check/**` is the check suite in the same form.
- `app/dist/**`: the Electron desktop container, in the same compiled-TypeScript form.
- `core/dist/web/**`: the browser UI (React 19), as a production Vite bundle. This part is minified.
- `core/assets/`, `app/static/`: small runtime assets.

`core/dist/build.json` records the exact build this edition was cut from: commit `522140f6`, schema v7, and the capability list.

## What is not here yet

The TypeScript sources for this exact build are not included in this first release. The engine and desktop are still fully readable and patchable as JavaScript, and that is how the maintainer's own local fixes have been made so far. The web UI is the one part that is not practically editable in this form.

Publishing the TypeScript sources and a reproducible build is the intended next step for this repository. Until then:

- Conjure's built-in **editions** feature (`conjure edition propose --source <repo>`), which builds and trials a new edition of Conjure from a git checkout, expects the TypeScript monorepo layout and will not work against this repository.
- Contributions that change the web UI can be discussed in issues, but cannot be merged as bundle edits.
- Contributions to the engine or desktop can be made directly against the JavaScript in `core/dist` and `app/dist`; the maintainer will port accepted changes into the TypeScript source.

## Keeping the engine honest about itself

The engine compares what is on disk against what it was started with and reports any skew in the **Conjure itself** surface and in `conjure self`. If you edit files under `core/dist` while a gateway is running, it will tell you the code on disk changed; restart it with `pnpm restart`.
