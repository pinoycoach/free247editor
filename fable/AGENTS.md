# Fable engine: workspace guide

This folder is the editing engine of Fable, the user's personal video editor. It turns a
recording into an intentional edit with local HyperFrames rendering, transcript-driven
cuts, and reusable motion graphics. The user-facing rules live one level up in
`.agents/skills/fable/SKILL.md`; this guide covers the engine itself.

## Routing

Skills live in `.agents/skills/` (one copy, read by every agent). Paths in this folder's
docs are relative to this folder, so run engine commands from here. The autopilot
`node ../fable.mjs edit <video>` runs the whole first pass (project, transcription, cuts,
captions, sound, draft render) and leaves `edit.json` in the project for you to refine.

| Need | Skill |
| --- | --- |
| Reels, Shorts, and short advertisements | `short-form-edit` |
| Motion-design showreels and brand reels cut to music | `motion-showreel` |
| New motion-graphics video from a brief | `make-a-video` |
| Full raw-video edit | `edit-video` |
| Silence removal | `cut-silences` |
| Retakes, false starts, or stutters | `cut-mistakes` |
| Narrative arc, persistent world, and visual callbacks | `video-storytelling` |
| Overlay beats, paper takeovers, and glass cards | `hyperframes-video-beats` |
| Select or extend styles and templates | `style-library` |
| HTML compositions and media timing | `hyperframes` |
| Preview, lint, and rendering | `hyperframes-cli` |
| Timeline animation | `gsap` |
| Install HyperFrames catalog blocks | `hyperframes-registry` |

Before a creative session read `MOTION_PHILOSOPHY.md` and the project's DESIGN.md.
The philosophy's fast sizzle pacing is a style reference. Give educational speech
room to breathe. The user's `my-style.md` and `my-rules.md` control pacing, palette,
and typography. Framework skill contracts override historical code recipes.

## Workspace

Create a project with `npm run new-video -- my-video` (the autopilot does this for you).
Keep source media, EDLs, transcripts, compositions, and renders together under
`video-projects/<slug>/`. Run HyperFrames from that project's directory. The root
`scripts/` utilities accept paths from the working directory. `style-library/registry.json`
indexes cards; each style has a DESIGN.md, CSS tokens, and named text slots.
See `style-templates/README.md` for whole-scene templates.

Preserve raw files. Use a new output filename for each editing stage. Video projects,
footage, transcripts, credentials, and renders are gitignored and never leave this
computer. Never print secrets or copy private media into library examples.

## Editing and timing

Transcribe with `node ../tools/transcribe.mjs <video>` (free: Groq, or `--local`
faster-whisper). It writes word timestamps in the shape the cutting tools read.
No paid service is ever used without the user's explicit yes.

Cut silences first; use its edited video AND retimed transcript for cut-mistakes.
Cut between phrases at real silence, never inside one. Review each mistake in
context; intentional repetition is not a mistake. Record the reviewed decisions before
applying them. Never mix original timestamps with edited footage.

Load the relevant skills before changing HTML. Root compositions use a visible
div with id, data-composition-id, data-start, duration, width, and height. Timed
elements carry data-start, data-duration, and data-track-index; same-track clips
must not overlap. Visible timed divs use class="clip"; videos do not.
Mute videos and use sibling audio for the mix. Animate a non-timed video wrapper.
Register one synchronous paused GSAP timeline per composition in window.__timelines
using its exact composition ID. Keep finite timelines and explicit durations.
HyperFrames owns media playback. Use deterministic animation and local assets.

## Verification and approvals

Run `node scripts/preflight.mjs <project>` and HyperFrames lint. For anchored
sub-compositions, run `node scripts/validate-beat-sync.mjs <project>`.

Review the encoded draft: extract and inspect hero frames and transition boundaries,
and listen to the audio joins. Check cropped faces, overflow, black flashes, readable
labels, clipping, and A/V sync. Resolve problems before the final render. Save
evidence in VERIFY.md. Never claim a lint result proves visual quality. Only publish
or upload a finished video when the user authorizes it. Automated browser checks
must be headless, with Pointer Lock and cursor capture disabled.

For short-form edits, read `docs/SHORT-FORM.md` and `docs/EDITING-PLAYBOOK.md`
(the measured house style and the lessons behind it), and use the plan and footage
validators. Structural checks supplement rendered video and audio review.
