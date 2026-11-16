---
name: lip-sync
description: Sync a person's mouth to a song or to a reference performer (a singing cat reel, a trend the user is copying, an AI lip-sync clip against its original). Use when the user says the lips are off, "sync the lipsync", "it has to match the original", "the mouth opens too early or late", or hands over a take plus the video it copies. Measures the voice on a spectrogram with both mouths lined up under it frame by frame, retimes the take with tools/lipsync.py, and checks the result on the same sheets before showing it.
---

# Lip sync to music

The user records a take that copies a reference (a reel with a song in it). The song is added
in the app later, so the take goes out silent and must already sit on the reference's clock.
This skill is how the mouth gets onto the voice. It was learned the hard way on the cat-mic
reel (2026-11-16, six versions); the mistakes are listed so they are not made twice.

Part of Fable: read `.agents/skills/fable/SKILL.md` for the house rules (outbox, Save to,
never post, never put the song in the posted file). Run everything from the repo root.

## What "in sync" means here

- **The voice is the clock, not the reference performer.** Put the take's *wide-open* frame on
  the frame the voice starts, and start closing when the voice ends. A cat or an AI face often
  eases its mouth open well before the note; a person snaps open. Matching mouth to mouth
  leaves the person wide open a quarter second before any sound.
- **The reference performer is the clock for gestures**: head turns, hands, sunglasses, the
  moment a prop lands. Match those to the reference frame for frame.
- A mouth leading the sound by 1 to 3 frames looks right. Leading by 6 or more, or closing
  while the voice is still going, is what the user calls "off".
- Timing can be fixed in the edit. Mouth *shape* cannot: say so, do not promise it.

## Steps

1. **Get both files on one clock.** Copy the reference and the take into the scratchpad (never
   touch the originals). Check the frame rates match (`sheets` refuses if not) and that the
   take starts where the reference starts. If the take has no burned-in text and the raw
   recording is on the laptop, work from the raw.

2. **Make the measuring sheets first. Do not eyeball, do not trust a loudness print.**

   ```
   python tools/lipsync.py sheets <reference> <take> --out <scratch>/sheets
   ```

   One JPEG per 1.5 s: spectrogram on top, reference strip, take strip, one thumbnail per
   frame, a white line every 6 frames. `sync-0132.jpg` starts at frame 132; a point at pixel x
   is frame `132 + x / 48`. Set `--ref-crop` and `--take-crop` (left,top,width,height as
   fractions) so each strip shows the mouth; the defaults fit a face in the upper middle.

3. **Read the voice off the spectrogram**, sheet by sheet:
   - Sung voice: bright lines that hold or bend (a glide, vibrato), stacked in harmonics.
   - Drums and claps: vertical streaks. Cymbals and risers: a speckled wash with no lines.
   - Synth stabs: a bright vertical edge with a flat line after it, repeating on the beat.
   Write a table: for every note, the frame the lines start and the frame they fade. A wash of
   noise right before a note is the build-up, not the voice (this was the cat-mic mistake:
   the "woo" was read at 6.1 s from loudness and was really 6.5 s).

4. **Read the take** on the same sheets, and at full size where it matters (a 24 fps tile of
   mouth crops): per note, the source frame the mouth is first small-open, first wide, starts
   closing, is shut. Also the frames of each gesture, in the take and in the reference.

5. **Write the map**, `fable/video-projects/<slug>/sync-map.txt`, one anchor per line:

   ```
   # output frame   source frame   [blend]
   0     0
   120   120  blend     # slowed stretch with movement: cross-fade it
   151   137            # head starts to rise
   156   142            # WIDE lands on the voice (6.50 s)
   174   160            # starts closing as late as the next gesture allows
   182   173            # sunglasses appear, with the reference
   ```

   Rules for a clean map:
   - Keep the motion itself at normal speed (anchor both ends of an opening or a gesture with
     the same offset) and take the time from holds: a held open mouth, a still face.
   - Dropping frames in a hold is invisible. Slowing a hold to about half speed is fine;
     slower, or slowing real movement, needs `blend` and a mention to the user.
   - If the voice runs on after the reference's mouth leaves the frame, keep the take's mouth
     open as long as the next gesture allows. The person is on screen the whole time.

6. **Retime**:

   ```
   python tools/lipsync.py retime <take> <map> <scratch>/<slug>-vN.mp4 --check <reference>
   ```

   It writes the silent video and a `-SYNC-CHECK-not-for-posting` copy carrying the
   reference's sound. The check copy is for judging only and stays on the laptop.

7. **Verify on the sheets again** (`sheets <reference> <new video>`) for every stretch the map
   changed, and read them: wide-open on the voice start, closing at the voice end, gestures
   on the reference. Only then copy the silent file to the outbox (the `Save to` rule) and the
   check copy to the local `outbox/`, and run `node fable.mjs check <file>`.

8. **Hand over** with the table (note, voice start, mouth wide before, mouth wide now), what
   was verified and what was not, and the reminder to use the reference reel's own audio from
   the very start in the app. Ask which note still looks off; fix only that one next.

## Lessons from the cat-mic job

- v3 matched the take's mouth to the cat's mouth within two frames and was rejected.
- v4 and v5 used a voice-band loudness print; cymbals and synth stabs read as voice.
- v6 used the spectrogram sheets and was accepted as good enough.
- When the user names one note ("the third is off"), zoom on that note only and measure it
  again from scratch instead of nudging the last guess.
- Whisper word times are useless on sung ad-libs ("ah", "woo", "yeah").
- This laptop runs out of memory and disk mid-render. The tool pipes two frames at a time;
  if the encoder fails, look at free disk first (`node fable.mjs clean`).

## Where it can still get better

- The table is read by eye from the sheets, to about one frame. A pitch tracker on the vocal
  would give onsets automatically.
- Mouth openness of the take could be measured per frame (face landmarks) instead of read.
- A retime cannot change mouth shape. For a held note the user sang shorter than the song, a
  new take beats any stretch.
