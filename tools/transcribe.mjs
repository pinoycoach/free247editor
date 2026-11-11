#!/usr/bin/env node
// Free word-level transcription in the format Herk Edit Kit's cutting tools expect:
// { text, audio_duration_secs, words: [{ text, start, end }] }, written beside the video.
//
//   node tools/transcribe.mjs <video> [--local] [--model large-v3] [--chunk 1200]
//
// Default: Groq whisper-large-v3 (free key from console.groq.com, GROQ_API_KEY in .env).
// --local: faster-whisper on this computer (needs Python and `pip install faster-whisper`).
// Long recordings: Groq takes at most 25 MB per upload, so sound longer than --chunk seconds
// (20 minutes by default) is split in pauses, sent piece by piece, and joined on one clock.
// Each finished piece is kept until the whole recording is done, so a run that stops halfway
// (the free tier allows about two hours of sound an hour) picks up where it left off.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chunkPlan, mergeChunks, restorePunctuation } from './long.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts, positionals: [video] } = parseArgs({
  allowPositionals: true,
  options: { local: { type: 'boolean' }, model: { type: 'string', default: 'large-v3' }, prompt: { type: 'string', default: '' }, chunk: { type: 'string', default: '1200' } },
});
const { local, model, prompt } = opts;
if (!video || !existsSync(video)) {
  console.error('Usage: node tools/transcribe.mjs <video> [--local] [--model large-v3] [--prompt "names, brand words"]');
  process.exit(1);
}
try { process.loadEnvFile(join(root, '.env')); } catch {}

const run = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`${cmd} failed: ${r.error?.message || r.stderr.trim().split('\n').pop()}`);
  return r.stdout;
};

const { dir, name } = parse(resolve(video));
// Soft speech is the usual reason words go missing. Level the audio before the model hears it.
const LEVEL = 'highpass=f=80,acompressor=threshold=-22dB:ratio=2.5:attack=8:release=140:makeup=2,speechnorm=e=4:r=0.0005:l=1,alimiter=limit=0.95:level=0';
const out = join(dir, `${name}.json`);
const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]));

let words;
if (local) {
  // The speech model hears a leveled copy: rumble removed, soft phrases lifted. Same chain as the edit's voice.
  const leveled = join(dir, `${name}.transcribe.wav`);
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-af', LEVEL, leveled]);
  let json;
  try { json = run('python', [join(root, 'tools', 'transcribe_local.py'), leveled, model, prompt]); } finally { rmSync(leveled, { force: true }); }
  words = JSON.parse(json);
} else {
  if (!process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys and put it in .env, or use --local.');
    process.exit(2);
  }
  const audio = join(dir, `${name}.transcribe.mp3`);
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-af', LEVEL, '-b:a', '64k', audio]);
  // One upload to Groq. Waits and tries again when the free tier says "too many" (429) or the
  // service hiccups (5xx); anything else is a real error.
  const groq = async (file, hint) => {
    for (let attempt = 1; ; attempt++) {
      const form = new FormData();
      form.append('file', new Blob([readFileSync(file)]), 'audio.mp3');
      form.append('model', 'whisper-large-v3');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      // Names and brand words steer the decoder (Whisper's prompt). Free, and it fixes "Stevie" for "Phi Phi".
      if (hint) form.append('prompt', hint.slice(-800));
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form });
      if (res.ok) {
        const body = await res.json();
        // The timed words take their punctuation from the full text, so sentence ends are never lost.
        const list = restorePunctuation((body.words || []).map((w) => ({ text: w.word.trim(), start: w.start, end: w.end })), body.text);
        list.said = body.text || '';
        return list;
      }
      const wait = Number(res.headers.get('retry-after')) || 20 * attempt;
      if ((res.status === 429 || res.status >= 500) && attempt < 6 && wait <= 180) {
        console.error(`Groq is busy (HTTP ${res.status}); waiting ${Math.ceil(wait)} s, try ${attempt + 1} of 6`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const text = (await res.text()).slice(0, 300);
      throw new Error(res.status === 429 ? `Groq's free limit is used up for now (it resets within the hour). What is done is kept: run the same command again later, or add --local. ${text}` : `Groq transcription failed: HTTP ${res.status} ${text}`);
    }
  };
  const maxLen = Math.max(60, Number(opts.chunk) || 1200);
  // Names as a punctuated line: the model copies the style of its prompt, and a bare list of
  // words nudges it toward leaving punctuation out.
  const names = prompt ? (/[.!?]$/.test(prompt.trim()) ? prompt.trim() : `${prompt.trim()}.`) : '';
  const sentenceEnds = (list) => list.filter((w) => /[.!?]["')\]]?$/.test(w.text)).length;
  // Where the sound is quiet, for splitting between words.
  let quiet = null;
  const silences = () => {
    if (!quiet) {
      const det = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', audio, '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
      quiet = [...(det.stderr || '').matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
    }
    return quiet;
  };
  const cutOut = (start, end, tag) => {
    const part = join(dir, `${name}.transcribe.${tag}.mp3`);
    run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(end - start), '-i', audio, '-ac', '1', '-ar', '16000', '-b:a', '64k', part]);
    return part;
  };
  // One stretch of the recording, times counted from its own start. When the model stops
  // punctuating (it happens after long pauses, and then it never recovers, because each half
  // minute is primed with the last), the stretch is done again in two-minute pieces, each with a
  // fresh start, and the better result is kept. Sentence ends are what cuts, hooks and clips read.
  const stretch = async (start, end, hint, tag, whole = false) => {
    const part = whole ? audio : cutOut(start, end, tag);
    let list;
    try { list = await groq(part, hint); } finally { if (!whole) rmSync(part, { force: true }); }
    if (end - start <= 150 || list.length < 80 || sentenceEnds(list) >= list.length / 40) return list;
    const pieces = chunkPlan(end - start, silences().map((q) => ({ start: q.start - start, end: q.end - start })), 120);
    console.error(`  punctuation dropped out (${sentenceEnds(list)} sentence ends in ${list.length} words); doing ${(start / 60).toFixed(1)}-${(end / 60).toFixed(1)} min again in ${pieces.length} pieces`);
    const lists = [];
    for (let k = 0; k < pieces.length; k++) {
      const p = cutOut(start + pieces[k].start, start + pieces[k].end, `${tag}-${k}`);
      try { lists.push(await groq(p, names)); } finally { rmSync(p, { force: true }); }
    }
    const again = mergeChunks(pieces, lists);
    again.said = lists.map((l) => l.said || '').join(' ');
    return sentenceEnds(again) > sentenceEnds(list) ? again : list;
  };
  try {
    if (duration <= maxLen && statSync(audio).size < 24 * 1024 * 1024) words = await stretch(0, duration, names, 'all', true);
    else {
      // Split in pauses so no word is cut in two.
      const chunks = chunkPlan(duration, silences(), maxLen);
      console.error(`Long recording (${(duration / 60).toFixed(1)} min): ${chunks.length} pieces`);
      const lists = [];
      let tail = '';
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i], kept = join(dir, `${name}.transcribe.part${i}.json`);
        // A piece finished by an earlier run is not sent again.
        let list = null;
        try { const saved = JSON.parse(readFileSync(kept, 'utf8')); if (saved.start === c.start && saved.end === c.end) { list = saved.words; list.said = saved.said || ''; } } catch {}
        if (!list) {
          list = await stretch(c.start, c.end, [names, tail].filter(Boolean).join(' '), `part${i}`);
          writeFileSync(kept, JSON.stringify({ start: c.start, end: c.end, said: list.said || '', words: list }));
        }
        console.error(`  piece ${i + 1} of ${chunks.length} (${(c.start / 60).toFixed(1)}-${(c.end / 60).toFixed(1)} min): ${list.length} words, ${sentenceEnds(list)} sentences`);
        lists.push(list);
        // The next piece is primed with how this one ended, but only when that ending is punctuated:
        // an unpunctuated tail would teach the next piece to drop its punctuation too.
        const end = (list.said || '').slice(-220);
        tail = (end.match(/[.!?]/g) || []).length >= 2 ? end.replace(/^\S*\s/, '') : '';
      }
      words = mergeChunks(chunks, lists);
      chunks.forEach((_, i) => rmSync(join(dir, `${name}.transcribe.part${i}.json`), { force: true }));
    }
  } catch (e) {
    console.error(e.message);
    process.exit(3);
  } finally { rmSync(audio, { force: true }); }
}

words = words.filter((w) => w.text && w.end >= w.start);
if (!words.length) {
  console.error('No words with timestamps came back. Is there speech in this video?');
  process.exit(4);
}
writeFileSync(out, JSON.stringify({
  text: words.map((w) => w.text).join(' '),
  audio_duration_secs: duration,
  words,
}, null, 2));
console.log(`Wrote ${words.length} words (${duration.toFixed(1)} s) to ${out}`);
