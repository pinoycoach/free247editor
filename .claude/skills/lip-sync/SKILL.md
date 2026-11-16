---
name: lip-sync
description: Sync a person's mouth to a song or to a reference performer (a singing cat reel, a trend the user is copying, an AI lip-sync clip against its original). Use when the user says the lips are off, "sync the lipsync", "it has to match the original", "the mouth opens too early or late", or hands over a take plus the video it copies. Measures the voice on a spectrogram with both mouths lined up under it frame by frame, retimes the take with tools/lipsync.py, and checks the result on the same sheets before showing it.
---

Claude Code only reads skills from `.claude/skills/`. The skill itself lives at the shared
Agent Skills path so every agent uses the same file: read `.agents/skills/lip-sync/SKILL.md`
now and follow it.
