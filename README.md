# Fable

![License](https://img.shields.io/github/license/pinoycoach/free247editor?style=flat-square&color=green) ![Agent Skills](https://img.shields.io/badge/Agent-Skills-8A2BE2?style=flat-square) ![Claude Code](https://img.shields.io/badge/Claude%20Code-ready-D97757?style=flat-square&logo=anthropic&logoColor=white) ![Price](https://img.shields.io/badge/price-free-brightgreen?style=flat-square)

A free, private video editor that runs on your own computer, 24/7, inside your AI coding
agent or on its own. Formerly free247editor.

Drop a raw video in the inbox. A minute or two later a cut, captioned, mixed draft is in the
outbox, with notes on what was done. Captions and the hook are drawn by FFmpeg, so a draft
renders in seconds on a plain laptop. Local by default: the only things that ever leave your
computer are the audio sent to Groq for free transcription (if you chose Groq) and key words
sent to Pixabay or Pexels (if you turned on stock B-roll). A "Privacy: local only" line in your
rules switches both off. Give notes in plain words (English, Tagalog, Taglish),
the way you would to a human editor. Lasting notes become rules it follows on every future
edit, so it learns your style. Nothing is uploaded anywhere.

## Two ways to use it

**Autopilot.** No agent needed once set up.

```bash
node fable.mjs edit inbox/my-video.mp4
```

```bash
node fable.mjs watch
```

`watch` keeps running and edits every video that lands in `inbox/`. Each draft comes with
`outbox/<name>-notes.md` and an editable `edit.json` in its project folder.

**With your agent** (Claude Code, Codex, Cursor, Antigravity, Gemini CLI, GitHub Copilot,
Windsurf, or any other that supports [Agent Skills](https://agentskills.io)). Say
**"edit this"**. The agent runs the autopilot, watches the result, then goes further: motion
cards, B-roll from your other clips, zoom-ins, a payoff. Then you give notes.

## Setup (once)

### One prompt

Open your agent in any folder (for example `claude` or `codex` in a terminal, or a new chat
in Cursor or Antigravity) and paste:

```text
Set up Fable for me. Clone https://github.com/pinoycoach/free247editor.git into my
Documents folder as "fable" (install Git first if it is missing, after asking me). Then follow
the "start" steps in its skill, .agents/skills/fable/SKILL.md: run node setup.mjs from that
folder, install anything it reports missing after asking me, help me choose free
transcription (a Groq key, which you get for me if you have browser tools such as Claude in
Chrome, or local faster-whisper), open the test video, and walk me through style setup. When
you finish, tell me the full path of the inbox folder and remind me to open my agent in the
fable folder from now on.
```

From then on, open your agent in the Fable folder so it finds the skill. The Claude desktop
app works too: in its Code tab, pick Local and the folder.

### Step by step

1. **Get it.** `git clone https://github.com/pinoycoach/free247editor.git fable`, or use
   *Code > Download ZIP* on GitHub and unzip it.
2. **Open the folder in your agent.** In a terminal: `cd fable` then `claude` or `codex`. In
   Cursor, Antigravity, or Windsurf, open the folder as the workspace.
3. **Type `start`.** The agent checks your computer, installs what is missing (with your OK),
   renders a test video, and asks a few questions about your style.

Without an agent: install Node.js 22+, Git, FFmpeg, and Chrome, run `node setup.mjs`, put a
free Groq key in `.env` (or `pip install faster-whisper`), and write `my-style.md` by hand
(see the style questions in the skill).

## Editing

1. Put a raw video in the `inbox` folder, or drag it into the agent's chat.
2. Say **"edit this"** (or let `node fable.mjs watch` pick it up).
3. Watch the draft from `outbox`, say what to change, and repeat until you say "final".

Plain words are enough; every agent picks the skill from its description. You can also call
it by name: `/fable` in Claude Code and Cursor, `$fable` in Codex.

Vertical 9:16 for Reels, TikTok, and Shorts by default. Ask for a horizontal version for
YouTube and it gets its own framing and text placement.

## What it does

| | |
| --- | --- |
| Cuts | Removes dead air and stutters, cutting only where the audio is measured quiet, frame-aligned so lips stay in sync. Repeated lines are listed as possible retakes for you to decide (or "Retakes: cut" in your rules) |
| Captions | Word by word, bold key words, key-word pills, or subtitles, in your position and colors, timed to each word |
| Hook | Up to three openings taken from your own words (claim, question, strongest word), one chosen, all listed in the notes with objective checks and a nine-frame muted-view sheet |
| B-roll | Optional: free stock clips from Pixabay or Pexels cut in on the key words, every source logged; your own extra clips win |
| Camera | A slow push-in on every shot; landscape clips get a glowing band layout in vertical |
| Color | Natural, warm, cool, black and white, or orange and teal |
| Sound | Soft taps and clicks on real cuts, a music bed from `my-sounds` ducked under your voice, mastered to -14 LUFS |
| Judgment | Doubtful cuts are left in and listed in the notes for you to decide |
| Agent extras | Motion cards, B-roll, zoom-ins, payoffs, built on the same timeline (`plan.json`) and rendered through Chrome only when asked |
| Private | No telemetry, no update checks; the notes say exactly what left the computer (Groq audio, stock key words) or that nothing did; render cache off, temp files cleaned after every job |
| Learning | Your notes are saved as rules in `my-rules.md` and applied every time |
| 24/7 | `node fable.mjs watch` edits everything that lands in the inbox |

## What you need

- **Node.js 22+, Git, FFmpeg, and Chrome.** Setup tells you what is missing and the agent can
  install it for you.
- **Transcription, free either way:** a free [Groq](https://console.groq.com/keys) key
  (fast, best for Taglish), or [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
  on your own computer (`pip install faster-whisper`, needs Python). If Groq fails, Fable
  falls back to local automatically when it is installed.
- **Optional: a free [Pixabay](https://pixabay.com/api/docs/) or Pexels key** in `.env` for
  stock B-roll, turned on with a "B-roll: some" line in your style. Without it, Fable edits
  with your footage only.
- **Optional: an AI coding agent that can run terminal commands** for the refined edits and
  for talking in plain words. Editing uses a lot of usage. Codex blocks internet in its
  sandbox by default, so approve network access when setup or transcription asks.
- About 1 GB of disk space.

Tested on Windows 11 with Claude Code (setup, autopilot edit and render, transcription). A 44 s
vertical draft renders in about 12 s with the AMD encoder on a Ryzen 3 laptop. The
other agents read the same standard files but are not tested yet. The engine is
cross-platform, so macOS and Linux should work, but they are not tested yet either.

## Costs

The software is free. Groq's free tier covers normal use. An agent costs whatever its plan
costs; the autopilot costs nothing. Fable never calls a paid service (ElevenLabs, Kie.ai, or
others) without asking.

## How each agent finds it

The whole editor is one skill, `.agents/skills/fable/SKILL.md`, in the shared Agent Skills
folder that Codex, Cursor, Antigravity, Gemini CLI, GitHub Copilot, Windsurf, and OpenCode
read. Claude Code reads skills only from `.claude/skills/`, so a short copy there points to
the same file. `AGENTS.md`, which `CLAUDE.md` imports, tells every agent to use the skill.
Edit only `.agents/skills/fable/SKILL.md`; if you change its description, copy the new one
into `.claude/skills/fable/SKILL.md` too.

## Not included

- An exported CapCut project. You get the MP4 plus the editable HyperFrames project in
  `fable/video-projects/<name>`; open it in HyperFrames Studio with `npx hyperframes preview`.
- Stock music or footage. Bring your own into `my-sounds` and `inbox`.
- Posting. It never uploads your videos anywhere.

## Folders

```
fable/
  .agents/skills/    the fable skill: how your agent runs the editor
  .claude/skills/    pointer to that skill for Claude Code
  AGENTS.md          tells every agent to use the skill (CLAUDE.md imports it)
  setup.mjs          one-time setup (safe to re-run)
  fable.mjs          the autopilot: edit, rebuild, final, watch, status
  tools/             free transcription
  inbox/             your raw videos
  outbox/            drafts, finals, and notes
  my-style.md        your style (created at setup, stays private)
  my-rules.md        rules learned from your notes (stays private)
  my-sounds/         your music and sound effects
  fable/             the engine: skills, scripts, style library, and your projects
```

Your footage, renders, style, rules, and keys are in `.gitignore`. Nothing is uploaded except
what you opted into (Groq transcription, stock B-roll), and each notes file says which.

## Credits

The engine in `fable/` began as a fork of [Herk Edit Kit](https://github.com/nateherkai/herk-edit-kit)
by Nate Herk (MIT), built on [HyperFrames](https://github.com/heygen-com/hyperframes) and
[GSAP](https://gsap.com/). Fable removed its brand assets, example projects, and paid-service
scripts (the remaining skills still mention paid services as options; none is called without
asking), and added free transcription and the autopilot. Parts of the engine are under the kit's
own pipeline-use permission, kept in `fable/licenses/`. See `fable/README.md`. Fable is not affiliated with Nate Herk, HeyGen, or any of the AI agent makers.

## License

MIT. See [LICENSE](LICENSE).
