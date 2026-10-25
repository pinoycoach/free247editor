# PR: forced word alignment and clips mode

Branch `alignment-and-clips` into `main`.

## What this adds

**Forced word alignment (optional).** After transcription, a small CTC model (MMS-300M,
quantized ONNX, CPU only, 356 MB, downloaded once with `node setup.mjs --with-aligner`)
listens for the letters of each word and moves the word's start and end to where the sound
actually is. Whisper tends to start a soft word on the vowel and end it before the trailing
consonant; that is how "s" and "t" get clipped at cut edges. Default mode `widen` lets a
word only grow, so cuts gain room and nothing is clipped; `Alignment: tight` in the rules
takes the aligned times as they are; `Alignment: off` skips it. The notes report how many
words moved.

Measured on the 44 s dog clip, 8 GB laptop: 26 of 66 words widened, median shift 60 ms,
largest 230 ms, 17 s, under 500 MB of memory.

**Chunked transcription.** Recordings over ten minutes are split at the widest silence near
each ten-minute mark, so no word is cut; word times are offset back; each chunk is primed
with the last twenty words of the previous one plus the user's names. Verified by forcing
three-minute chunks on a nine-minute file: continuous word times, three seams at silences.

**Clips mode.** `node fable.mjs clips <long video> [--count 5] [--min 25] [--max 60]`
transcribes the recording once, scores every window that starts after a real pause and ends
on a finished sentence (strong opener, finished ending, pace, no retakes or untranscribed
speech inside), suppresses overlaps, cuts each pick straight out of the original (no full
transcode of the hour), and runs the normal reel pipeline on each: hook card, captions,
face-aware placement, alignment, sound, review sheets. Output: `outbox/<name>-clipN-v1.mp4`
per clip and `outbox/<name>-clips.md` with reasons and runners-up. The scorer is arithmetic,
no model, so it costs nothing to run on an hour.

Tested on the dog clip with short windows: two picks, each rendered in about 5 s.
Tested on a 9-minute screen recording with almost no speech: see the run log in the PR
discussion.

## Files

- `tools/align_words.py` new; `tools/clips.mjs` new; `tools/transcribe.mjs` chunking;
  `tools/track_face.py` sample count fix
- `fable.mjs`: alignment step, `clips` command, `edit()` takes a window and preset words,
  `Alignment:` rule
- `setup.mjs --with-aligner`; `.gitignore` for the 356 MB model
- `tests/fable.test.mjs`: scorer test (12 tests pass); skill and README docs

## Not in this PR

- Node-only aligner (no Python): possible later with onnxruntime-node; the Python path is
  enough for now.
- Face-tracked punch-ins: the face data exists; the crop move is a separate feature.
- Alignment quality on soft speech is measured by numbers, not by listening. A human listen
  at cut edges on the next few real clips is the real test.
