#!/usr/bin/env node
// Free word-level transcription in the format Herk Edit Kit's cutting tools expect:
// { text, audio_duration_secs, words: [{ text, start, end }] }, written beside the video.
//
//   node tools/transcribe.mjs <video> [--local] [--model large-v3]
//
// Default: Groq whisper-large-v3 (free key from console.groq.com, GROQ_API_KEY in .env).
// --local: faster-whisper on this computer (needs Python and `pip install faster-whisper`).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts, positionals: [video] } = parseArgs({
  allowPositionals: true,
  options: { local: { type: 'boolean' }, model: { type: 'string', default: 'large-v3' }, prompt: { type: 'string', default: '' } },
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
const out = join(dir, `${name}.json`);
const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]));

let words;
if (local) {
  const json = run('python', [join(root, 'tools', 'transcribe_local.py'), resolve(video), model, prompt]);
  words = JSON.parse(json);
} else {
  if (!process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys and put it in .env, or use --local.');
    process.exit(2);
  }
  // Groq's free tier caps a file at 25 MB, about 50 minutes of 64 kbps mono. Longer recordings are
  // split into chunks of about 10 minutes, cut at the widest silence near each boundary so no
  // word is split, and the last words of each chunk prime the next one so names stay consistent.
  const CHUNK = Number(process.env.FABLE_CHUNK_SECONDS) || 600, SEARCH = Math.min(90, CHUNK / 4);
  const seams = [0];
  if (duration > CHUNK + 60) {
    const sd = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', video, '-vn', '-af', 'silencedetect=noise=-30dB:d=0.3', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true }).stderr || '';
    const silences = [];
    let open = null;
    for (const m of sd.matchAll(/silence_(start|end): ([\d.]+)/g)) { if (m[1] === 'start') open = Number(m[2]); else if (open !== null) { silences.push({ start: open, end: Number(m[2]) }); open = null; } }
    let cursor = 0;
    while (duration - cursor > CHUNK + 60) {
      const want = cursor + CHUNK;
      const near = silences.filter((s) => s.start >= want - SEARCH && s.end <= want + 30);
      const best = near.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
      cursor = best ? (best.start + best.end) / 2 : want;
      seams.push(cursor);
    }
  }
  seams.push(duration);
  words = [];
  let tail = '';
  for (let i = 0; i + 1 < seams.length; i++) {
    const [a, b] = [seams[i], seams[i + 1]];
    const audio = join(dir, `${name}.transcribe.mp3`);
    run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(a), '-to', String(b), '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audio]);
    const form = new FormData();
    form.append('file', new Blob([readFileSync(audio)]), 'audio.mp3');
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    // Names and brand words steer the decoder (Whisper's prompt), plus the previous chunk's tail.
    const p = [prompt, tail].filter(Boolean).join(' ').slice(-800);
    if (p) form.append('prompt', p);
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
    });
    rmSync(audio, { force: true });
    if (!res.ok) {
      console.error(`Groq transcription failed (chunk ${i + 1}/${seams.length - 1}): HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      process.exit(3);
    }
    const body = await res.json();
    const chunkWords = (body.words || []).map((w) => ({ text: w.word.trim(), start: Number((w.start + a).toFixed(3)), end: Number((w.end + a).toFixed(3)) }));
    words.push(...chunkWords);
    tail = chunkWords.slice(-20).map((w) => w.text).join(' ');
    if (seams.length > 2) console.error(`chunk ${i + 1}/${seams.length - 1}: ${chunkWords.length} words`);
  }
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
