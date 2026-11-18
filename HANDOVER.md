# Handover to claude-20 (written 2026-11-18)

The Claude Max account (claude-max-editor / claude-max-code) may end soon. From now on
claude-20 runs Fable too: video editing AND the posts / Higgsfield clips it already makes.
Nothing in Fable is tied to an account. It is all in this folder on this laptop.

## Start here

1. Open this folder in the Claude desktop app, **Code tab**, signed in as claude-20:
   `C:\Users\PhiKi\projects\free 24 editor`
2. Read `AGENTS.md`, then `.agents/skills/fable/SKILL.md`. Follow the skill for everything.
   For lip-sync jobs, `.agents/skills/lip-sync/SKILL.md`.
3. Read `my-rules.md` and `my-style.md`. Those are the user's own rules. They win over defaults.
4. Read the memory notes in
   `C:\Users\PhiKi\.claude\projects\C--Users-PhiKi-projects-free-24-editor\memory\`
   (start with `MEMORY.md`). If the app already loaded them, good. If not, read them by hand:
   they hold the recipes and lessons below in full.

Do NOT run `node setup.mjs` again unless something is broken. Setup is done, and the disk is full.

## State of the repo

- Working branch: **`gemini-review`**. It has ~25 commits that `main` does not (lip-sync skill,
  clips, beats, post package, clean, review...). `main` has 3 of its own (stitch in brief order,
  AI tag on every frame, script insert timing). They have not been merged. Stay on
  `gemini-review`. Merge only when the user says so.
- Working tree was clean at handover. Remote: `origin` on GitHub.
- Keys live in `.env` (Groq for transcription, Pexels/Pixabay for B-roll, Gemini for review and
  TTS). All free tiers. Never print them, never commit `.env`.

## The laptop (most important)

8 GB RAM that cannot be upgraded, disk **99% full (about 1.4 GB free)**. Before any render or
download, check free disk and memory. Use the GPU encoder (default). Retime with ffmpeg
`setpts`, not Python frame pipes. Never read one input twice in one ffmpeg graph (ENOMEM).
Use `node fable.mjs clean` to give disk back. Delete test projects when done.

## How the user works

- Talks in English, Tagalog or Taglish. Answer plainly, no editing or coding jargon.
- They record; Fable edits. Drafts go to `outbox/<slug>-v1.mp4` etc.
- Free and local by default. **Anything paid (Higgsfield, Kie, fal, AI video) only after an
  explicit yes each time.**
- AI-made footage always gets the small "AI-generated" tag. Phone-looking clips can still be AI:
  ask.
- Before showing any draft of an AI or lip-sync clip, check every spoken word and mouth sound
  against the frames. The user has caught missed lip-sync three times. Use the spectrogram
  method in the lip-sync skill first.
- "Fable makes, Gemini checks": offer `node fable.mjs review <slug>` for benta-serye and AI clips
  with burned captions, and before a final. Skip it for family clips.

## Ongoing formats and recipes (details in memory)

| Format | Recipe |
| --- | --- |
| Benta-serye (selling skits) | `fable/video-projects/ang-secret-massage-ni-cashie/build.mjs`. Product name, price and CTA still unknown: ask. |
| Jan / @themayormom | Short single takes, captions carry it, silent track. `fable/video-projects/mj-week-1/build_v2.py`. Finals to the Drive outbox for Nap, never to Jan. |
| Kape Muna / Kapi | `fable/video-projects/kape-muna-asean/`. Gemini TTS voice Leda, pitched up 8%. |
| DigitallyManila card explainers | `fable/video-projects/pax-silica-explainer/`. Gemini TTS voice Charon. |
| Higgsfield shorts | English audio plus a Taglish post caption. Tagalog regen only if Ep 3 beat the page median. |
| LuminaNexus output | Use its JSON as a brief. Never post its webm. |
| CapCut | Parked. Don't bring it up. |

## If you hit your usage limit

claude-20 is a smaller plan. Save heavy work for when it's needed: read only the files a job
needs, avoid big subagent fan-outs, and finish one edit before starting the next.
