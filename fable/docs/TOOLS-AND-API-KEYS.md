# Tools and services

Fable is free end to end. Nothing here needs a card.

| Need | What Fable uses | Where |
| --- | --- | --- |
| Transcription (word timestamps) | Groq Whisper (free key) or faster-whisper on this computer | `node ../tools/transcribe.mjs <video> [--local]` from this folder, or `node tools/transcribe.mjs` from the repo root. Writes `<video>.json` in the shape the cutting tools read: `{ text, audio_duration_secs, words: [{ text, start, end }] }`. |
| Cutting | FFmpeg | `.agents/skills/cut-silences` and `.agents/skills/cut-mistakes`, or the autopilot `node ../fable.mjs edit`. |
| Rendering | HyperFrames + Chrome | `npx hyperframes render` inside a project. `npx hyperframes doctor` when Chrome is the problem. |
| Sound effects and music | The user's `my-sounds/` folder, or effects synthesized with FFmpeg | The autopilot mixes them; never download music you have no right to use. |
| Generated B-roll or voices | None by default | Any paid service (ElevenLabs, Kie.ai, OpenAI, and others) needs the user's explicit yes first, every time. |

Keys live in the repo root `.env` (`GROQ_API_KEY=`). Never print or log them.
