# Fable engine

The editing engine inside [Fable](../README.md), a free personal video editor that runs
in your AI coding agent. You normally never run anything in here by hand: the autopilot
(`node fable.mjs` in the folder above) and your agent do.

What is here:

- `.agents/skills/` — 13 editing skills your agent reads: cutting, short-form edits,
  long-form edits, storytelling, motion graphics (HyperFrames + GSAP), style library.
- `scripts/` — project scaffolding, preflight, beat-sync and EDL review tools.
- `style-library/` — 400+ draft motion-graphics cards in two styles, with tokens and slots.
- `style-templates/` — whole-scene templates (dark graph paper, left glass popout).
- `docs/` — the editing playbook, short-form guide, workflow, and verification notes.
- `examples/` — a synthetic starter composition and editing fixtures. No footage.
- `video-projects/` — your edits, one folder per video. Local only, never committed.

```sh
npm ci            # packages (setup does this)
npm test          # cutting and short-form validators
npm run check     # distribution check: no media, no secrets, no machine paths
```

## Provenance

The engine began as a fork of [Herk Edit Kit](https://github.com/nateherkai/herk-edit-kit)
by Nate Herk (MIT) at commit `10511e5`, which builds on
[HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0) and
[GSAP](https://gsap.com/). Fable removed the kit's brand assets, example projects,
showcase media, and paid-service scripts, and added the free transcription and the
autopilot. Licenses and notices are in `licenses/` and `THIRD_PARTY_NOTICES.md`.
Fable is not affiliated with Nate Herk or HeyGen.
