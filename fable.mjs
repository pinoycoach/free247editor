#!/usr/bin/env node
// Fable autopilot: a raw recording in, a cut, captioned, mixed draft out. No agent in the loop.
//
//   node fable.mjs edit <video> [--slug name] [--script words.txt] [--format vertical|horizontal|both] [--quality draft|standard|high]
//       A script beside the video (same name, .txt or .md) is picked up on its own: captions then
//       show the script's words at the moment they were said, and the hook comes from its first line.
//   node fable.mjs rebuild <slug> [--quality ...]   after editing fable/video-projects/<slug>/edit.json
//   node fable.mjs final <slug>                      standard-quality render to outbox/<slug>-final.mp4
//   node fable.mjs stitch <folder> [--caption "..."] [--tag AI-generated] [--final]
//       Finished clips joined in order with hard cuts, their own audio, one fixed caption; nothing re-timed.
//   node fable.mjs watch [--every 5] [--once]        24/7: edit every new video that lands in inbox/
//   node fable.mjs status
//   --engine fast|browser   fast (default): FFmpeg + libass, seconds. browser: HyperFrames + Chrome, minutes.
//
// Every stage is local and free: FFmpeg for cuts, captions, and sound; Groq or faster-whisper for
// words. Nothing is sent anywhere (HyperFrames telemetry and update checks are switched off).
// Style comes from my-style.md; rules from my-rules.md.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { freemem, tmpdir, totalmem } from 'node:os';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { captionLayout, hasFastFonts, renderFast, reviewSheets } from './tools/fast-render.mjs';
import { alignScript, hookFromScript } from './tools/script-align.mjs';
import { isOutput, orderClips, parseBrief, stitchFrame, wrapCaption } from './tools/stitch.mjs';

const FPS = 30;
const root = dirname(fileURLToPath(import.meta.url));
const engine = join(root, 'fable');
const projects = join(engine, 'video-projects');
const fontsDir = join(engine, 'fonts');
const inbox = join(root, 'inbox');
const outbox = join(root, 'outbox');
const win = process.platform === 'win32';
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.mts', '.3gp']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
// Stealth: the browser renderer phones home by default (PostHog usage events, npm update checks,
// feedback prompts, skill downloads). Every one has a documented switch; set them all.
const STEALTH_ENV = { HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_NO_FEEDBACK: '1', HYPERFRAMES_NO_AUTO_INSTALL: '1', HYPERFRAMES_SKIP_SKILLS: '1' };

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    slug: { type: 'string' }, format: { type: 'string' }, quality: { type: 'string', default: 'draft' },
    every: { type: 'string', default: '5' }, once: { type: 'boolean' }, 'no-render': { type: 'boolean' },
    engine: { type: 'string', default: 'fast' },
    script: { type: 'string' }, tag: { type: 'string' }, caption: { type: 'string' }, final: { type: 'boolean' },
  },
});
const [command, target] = positionals;

const log = (msg) => console.log(`[fable] ${msg}`);
const die = (msg, code = 1) => { console.error(`[fable] ${msg}`); process.exit(code); };
const r3 = (n) => Math.round(n * 1000) / 1000;
const frames = (s) => Math.round(s * FPS);
const secs = (f) => f / FPS;
const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

function run(cmd, args, { cwd = root, quiet = true, shell = false } = {}) {
  const useShell = shell || (win && /^(npm|npx)$/.test(cmd));
  const env = { ...process.env, ...STEALTH_ENV };
  const r = useShell
    ? spawnSync([cmd, ...args.map(q)].join(' '), { cwd, env, shell: true, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit', maxBuffer: 1 << 28 })
    : spawnSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit', maxBuffer: 1 << 28, windowsHide: true });
  if (r.error) throw new Error(`${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0) {
    const tail = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map((l) => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim()).filter((l) => l && !/[░█]/.test(l)).slice(-8).join('\n');
    throw new Error(`${cmd} failed (${r.status}):\n${tail}`);
  }
  return r.stdout || '';
}
const ff = (args, cwd) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd });
const sha = (s) => createHash('sha256').update(s).digest('hex');
// A second home for outputs, such as a synced Drive folder, when the rules name one. Never fatal:
// if the folder is unreachable (drive not mounted) the local outbox still has everything.
function mirror(file, style) {
  if (!style?.copyTo) return null;
  try {
    mkdirSync(style.copyTo, { recursive: true });
    copyFileSync(file, join(style.copyTo, basename(file)));
    return join(style.copyTo, basename(file));
  } catch (e) { log(`copy to ${style.copyTo} failed: ${e.message.split('\n')[0]}`); return null; }
}
// Machines with 8 GB or less (soldered laptops are common) get the light path by default:
// GPU encoder first, and a warning before each render naming what is eating the memory.
const GB = 1024 ** 3;
const lowMemoryMachine = () => totalmem() <= 8.5 * GB;
function memoryCheck() {
  const free = freemem() / GB;
  if (free >= 1.5) return { free: Math.round(free * 10) / 10, hogs: [] };
  let hogs = [];
  try {
    if (win) {
      const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process | Group-Object Name | ForEach-Object { '{0}|{1}' -f $_.Name, [int](($_.Group | Measure-Object WorkingSet64 -Sum).Sum/1MB) } | Sort-Object { [int]($_ -split '[|]')[1] } -Descending | Select-Object -First 5"], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).stdout || '';
      hogs = out.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [n, mb] = l.split('|'); return `${n} ${mb} MB`; });
    } else {
      const out = spawnSync('sh', ['-c', 'ps -eo rss,comm --sort=-rss | head -6 | tail -5'], { encoding: 'utf8', timeout: 15000 }).stdout || '';
      hogs = out.trim().split(/\n/).filter(Boolean).map((l) => { const [kb, ...c] = l.trim().split(/\s+/); return `${c.join(' ')} ${Math.round(kb / 1024)} MB`; });
    }
  } catch {}
  log(`memory: ${(free * 1024).toFixed(0)} MB free. Taking the light path. Biggest: ${hogs.join(', ') || 'unknown'}. Close what you can for better quality.`);
  return { free: Math.round(free * 10) / 10, hogs };
}
let amfChecked = null;
const hasAmf = () => (amfChecked ??= /h264_amf/.test(run('ffmpeg', ['-hide_banner', '-encoders'])));

// Disk hygiene after every job: the browser renderer's frame cache, filter scripts, and all but
// the two newest renders. The original, the plan, and the cut assets stay.
function cleanup(dir) {
  for (const d of readdirSync(tmpdir())) if (/^hyperframes-(extract-cache|kit-test|render)/.test(d)) rmSync(join(tmpdir(), d), { recursive: true, force: true });
  for (const f of ['footage.filter', 'voice.filter', 'mix.filter', 'footage-primary.mp4']) rmSync(join(dir, 'assets', f), { force: true });
  const renders = join(dir, 'renders');
  if (!existsSync(renders)) return;
  const files = readdirSync(renders).filter((f) => f.endsWith('.mp4')).map((f) => ({ f, t: statSync(join(renders, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(2)) rmSync(join(renders, f), { force: true });
}

// ---------- style: my-style.md and my-rules.md in plain words ----------
// A rule line may start with a scope tag so a note from a Reel never fires on a long horizontal
// tutorial: [9:16] [16:9] [<90s] [>90s]. Untagged lines apply everywhere.
function ruleApplies(line, media) {
  if (!media) return true;
  const tags = [...line.matchAll(/\[(9:16|16:9|<(\d+)s|>(\d+)s)\]/g)];
  for (const t of tags) {
    if (t[1] === '9:16' && !media.vertical) return false;
    if (t[1] === '16:9' && media.vertical) return false;
    if (t[2] && !(media.duration < Number(t[2]))) return false;
    if (t[3] && !(media.duration > Number(t[3]))) return false;
  }
  return true;
}
function readStyle(media = null) {
  const style = {
    format: 'vertical', captions: 'word', position: 'upper', color: '#ffffff', accent: '#facc15',
    hook: true, pace: 'tight', graphics: 'some', grade: 'natural', sound: 'light', font: 'Montserrat', broll: 'none',
  };
  const apply = (text) => {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.toLowerCase();
      if (!line.trim() || line.startsWith('#') || !ruleApplies(raw, media)) continue;
      const never = /\b(never|no|none|wala|huwag|don't|do not)\b/.test(line);
      if (/format|aspect|orientation/.test(line) || /\b(9:16|16:9)\b/.test(line)) {
        if (/both/.test(line)) style.format = 'both';
        else if (/horizontal|16:9|landscape|youtube/.test(line)) style.format = 'horizontal';
        else if (/vertical|9:16|portrait|reel|tiktok|short/.test(line)) style.format = 'vertical';
      }
      if (/caption|subtitle/.test(line)) {
        if (/none|no caption|walang caption/.test(line)) style.captions = 'none';
        else if (/word by word|one word|isang salita|one big/.test(line)) style.captions = 'word';
        else if (/pill/.test(line)) style.captions = 'pills';
        else if (/full.sentence|sentence|subtitle/.test(line)) style.captions = 'subtitles';
        else if (/bold|key ?word/.test(line)) style.captions = 'bold';
        if (/upper|top|taas/.test(line)) style.position = 'upper';
        else if (/middle|center|centre|gitna/.test(line)) style.position = 'middle';
        else if (/lower|bottom|baba/.test(line)) style.position = 'lower';
        const hex = line.match(/#[0-9a-f]{6}\b/g);
        if (hex) { if (/highlight|accent|key/.test(line)) style.accent = hex[0]; else style.color = hex[0]; }
        if (/bigger|larger|mas malaki/.test(line)) style.scale = (style.scale || 1) * 1.15;
        if (/smaller|mas maliit/.test(line)) style.scale = (style.scale || 1) * 0.88;
      }
      if (/\bhook\b/.test(line)) style.hook = !never;
      if (/\bpace\b|pacing|tempo|bilis/.test(line)) {
        if (/natural|breath|relaxed|slow|keep (short )?pauses/.test(line)) style.pace = 'natural';
        else if (/tight|fast|mabilis|cut every/.test(line)) style.pace = 'tight';
      }
      if (/graphic|motion card/.test(line)) {
        if (/minimal|none|no graphics/.test(line)) style.graphics = 'minimal';
        else if (/heavy|lots|maraming/.test(line)) style.graphics = 'heavy';
        else if (/some/.test(line)) style.graphics = 'some';
      }
      if (/\bcolor\b|\bcolour\b|grade|look/.test(line) && !/caption/.test(line)) {
        if (/black and white|b&w|monochrome/.test(line)) style.grade = 'bw';
        else if (/orange.*teal|teal.*orange/.test(line)) style.grade = 'orange-teal';
        else if (/\bwarm\b/.test(line)) style.grade = 'warm';
        else if (/\bcool\b/.test(line)) style.grade = 'cool';
        else if (/natural|as filmed/.test(line)) style.grade = 'natural';
      }
      if (/\bsound\b|audio|music|sfx|effects/.test(line)) {
        if (/voice only|no sound effects|no sfx|walang/.test(line)) style.sound = 'voice';
        else if (/music/.test(line) && !never) style.sound = 'music';
        else if (/light|some|sound effects|sfx/.test(line)) style.sound = 'light';
      }
      if (/\bvoice:/.test(line)) style.voice = /natural|raw|untouched|as recorded/.test(line) ? 'natural' : 'level';
      // "Copy to: G:\My Drive\Fable\outbox" mirrors every draft, final, and notes file to that folder.
      if (/^\s*-?\s*(copy to|mirror( to)?|also save to):/i.test(raw)) { const m = raw.match(/:\s*(.+?)\s*(?:\(.*)?$/); if (m) style.copyTo = m[1].trim().replace(/^["']|["']$/g, ''); }
      if (/retakes?:/.test(line)) style.retakes = /\bcut\b|remove|auto/.test(line) && !never ? 'cut' : 'suggest';
      if (/stutters?:/.test(line)) style.stutters = /suggest|ask|keep/.test(line) || never ? 'suggest' : 'cut';
      if (/privacy|stealth|offline|local only/.test(line)) style.privacy = /local|offline|stealth|only/.test(line) && !/\bno\b|off/.test(line) ? 'local' : 'normal';
      if (/b-?roll|stock (footage|clips?)/.test(line)) {
        if (never) style.broll = 'none';
        else if (/lots|heavy|marami|many|every/.test(line)) style.broll = 'lots';
        else style.broll = 'some';
      }
      if (/\bfont\b/.test(line)) {
        const m = raw.match(/font[^:]*:\s*([A-Za-z][A-Za-z0-9 ]{2,30})/i);
        if (m) style.font = m[1].trim();
      }
    }
  };
  for (const file of ['my-style.md', 'my-rules.md']) {
    const p = join(root, file);
    if (existsSync(p)) apply(readFileSync(p, 'utf8'));
  }
  if (opt.format) style.format = opt.format;
  return style;
}

// ---------- probe ----------
function probe(video) {
  const out = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:stream_side_data=rotation:format=duration', '-of', 'json', video]));
  const v = out.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('no video stream');
  const rot = Math.abs(Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0)) % 180;
  const [w, h] = rot === 90 ? [v.height, v.width] : [v.width, v.height];
  return { width: w, height: h, duration: Number(out.format.duration), hasAudio: out.streams.some((s) => s.codec_type === 'audio') };
}

// ---------- project ----------
function slugify(name) {
  const base = parse(name).name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';
  const date = new Date().toISOString().slice(0, 10);
  let slug = base.includes(date) ? base : `${base}-${date}`;
  let n = 2;
  while (existsSync(join(projects, slug))) slug = `${base}-${date}-${n++}`;
  return slug;
}
function newProject(slug, dims) {
  const dir = join(projects, slug);
  for (const d of ['assets', 'assets/sfx', 'compositions', 'renders']) mkdirSync(join(dir, d), { recursive: true });
  const gsap = join(engine, 'node_modules/gsap/dist/gsap.min.js');
  if (!existsSync(gsap)) throw new Error('fable/node_modules is missing. Run: node setup.mjs');
  copyFileSync(gsap, join(dir, 'assets/gsap.min.js'));
  writeFileSync(join(dir, 'hyperframes.json'), JSON.stringify({
    $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
    paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
  }, null, 2) + '\n');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: 'reel', name: slug, width: dims.w, height: dims.h, fps: FPS }, null, 2) + '\n');
  return dir;
}

// ---------- transcription ----------
// Returns { transcript, provider }. provider is 'groq' (audio leaves the computer), 'local', or null.
function transcribe(dir, style, names = []) {
  const raw = join(dir, 'assets/raw.mp4');
  const out = join(dir, 'assets/raw.json');
  try { process.loadEnvFile(join(root, '.env')); } catch {}
  const groqAllowed = process.env.GROQ_API_KEY && style.privacy !== 'local';
  const attempts = groqAllowed ? [[], ['--local']] : [['--local']];
  // Names and brand words from my-rules.md steer the speech model so "Phi Phi" is not "Stevie".
  const prompt = names.length ? ['--prompt', names.join(', ')] : [];
  let lastError = '';
  for (const extra of attempts) {
    try {
      run('node', [join(root, 'tools/transcribe.mjs'), raw, ...extra, ...prompt]);
      return { transcript: JSON.parse(readFileSync(out, 'utf8')), provider: extra[0] === '--local' ? 'local' : 'groq' };
    } catch (e) { lastError = e.message; log(`transcription ${extra[0] || 'with Groq'} failed, ${attempts.length > 1 ? 'trying the other way' : 'continuing without words'}`); }
  }
  log(`no transcript: ${lastError.split('\n')[0]}`);
  return { transcript: { words: [], audio_duration_secs: 0 }, provider: null };
}

// ---------- cuts: between phrases, at real silence ----------
const STOP = new Set('a an and are as at be but by for from i if in is it of on or so that this to was we with you your they their there what when where why how like um uh the yung ang ng na sa si mga ay at kasi parang yun ako ko mo ka'.split(' '));
const token = (t) => (t || '').toLowerCase().replace(/^[^a-z0-9$%]+|[^a-z0-9$%]+$/g, '');

// Where the audio is actually quiet, from FFmpeg's silencedetect. The transcript says where words
// are; only the audio says where nothing is. Returns [{ start, end }] in source seconds.
function detectSilence(file, { noise = -35, min = 0.15 } = {}) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `silencedetect=noise=${noise}dB:d=${min}`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  const out = [];
  let open = null;
  for (const m of (r.stderr || '').matchAll(/silence_(start|end): ([\d.]+)/g)) {
    if (m[1] === 'start') open = Number(m[2]);
    else if (open !== null) { out.push({ start: open, end: Number(m[2]) }); open = null; }
  }
  if (open !== null) out.push({ start: open, end: Infinity });
  return out;
}
// Phone recordings carry room noise, so one fixed threshold finds nothing. Start strict and loosen
// until the pauses the transcript shows are mostly quiet; stop there. Returns { silences, noise }.
function detectSilenceAdaptive(file, words, gapMin = 0.42) {
  const gaps = [];
  for (let i = 1; i < words.length; i++) if (words[i].start - words[i - 1].end >= gapMin) gaps.push({ start: words[i - 1].end, end: words[i].start });
  const gapTotal = gaps.reduce((a, g) => a + (g.end - g.start), 0);
  let last = { silences: [], noise: -35 };
  for (const noise of [-40, -35, -30, -26, -22, -18, -14]) {
    const silences = detectSilence(file, { noise });
    last = { silences, noise };
    if (!gapTotal) return last;
    const quiet = gaps.reduce((a, g) => { const q = insideSilence(g.start, g.end, silences, 0); return a + (q ? q.end - q.start : 0); }, 0);
    if (quiet / gapTotal >= 0.75) return last;
  }
  return last;
}
// Snap near-misses of known names to their spelling: "Phe" -> "Phi", "Stevie" stays (too far).
function applyNames(words, names) {
  const canon = names.flatMap((n) => n.split(/\s+/)).filter((w) => w.length >= 3);
  if (!canon.length) return 0;
  const dist = (a, b) => { if (Math.abs(a.length - b.length) > 1) return 9; let d = 0, i = 0, j = 0; while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; } else { d++; if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; } } } return d + (a.length - i) + (b.length - j); };
  let n = 0;
  for (const w of words) {
    const t = token(w.text);
    if (!t || t.length < 3) continue;
    const hit = canon.find((c) => c.toLowerCase() !== t && dist(c.toLowerCase(), t) <= 1);
    if (hit) { w.text = w.text.replace(/[\p{L}\p{N}']+/u, hit); n++; }
  }
  return n;
}
// Clip a wanted delete range to the quiet part inside it. Null when no silence overlaps it.
function insideSilence(start, end, silences, tol = 0.03) {
  let best = null;
  for (const s of silences) {
    const a = Math.max(start, s.start - tol), b = Math.min(end, s.end + tol);
    if (b - a > 0.04 && (!best || b - a > best.end - best.start)) best = { start: a, end: b };
  }
  return best;
}
// Speech the transcript missed: voiced stretches with no word in them.
function untranscribed(words, silences, duration, minLen = 0.8) {
  const voiced = [];
  let t = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) { if (s.start > t) voiced.push({ start: t, end: s.start }); t = Math.max(t, Math.min(s.end, duration)); }
  if (t < duration) voiced.push({ start: t, end: duration });
  return voiced.filter((v) => v.end - v.start >= minLen && !words.some((w) => w.start < v.end && w.end > v.start)).map((v) => ({ start: r3(v.start), end: r3(v.end) }));
}
// Names from my-rules.md lines like: Names: the dog is "Phi Phi" ...
function knownNames() {
  const p = join(root, 'my-rules.md');
  if (!existsSync(p)) return [];
  const names = new Set();
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) if (/^\s*-?\s*names?:/i.test(line)) for (const m of line.matchAll(/"([^"]+)"/g)) names.add(m[1]);
  return [...names];
}

function planCuts(words, duration, style, silences = null, names = []) {
  const gapMin = style.pace === 'tight' ? 0.42 : 0.8;
  const headPad = 0.12, tailPad = 0.35;
  const deletes = [], suggestions = [], missed = [];
  const push = (start, end, reason) => { if (end - start >= 0.04) deletes.push({ start, end, reason }); };
  // A pause is deleted only where the audio is really quiet. Without silence data, trust the gap.
  const pause = (start, end, reason, gapStart, gapEnd) => {
    if (!silences) return push(start, end, reason);
    const quiet = insideSilence(start, end, silences);
    if (quiet) return push(quiet.start, quiet.end, reason);
    if (gapEnd - gapStart >= 0.6) missed.push({ start: r3(gapStart), end: r3(gapEnd), reason: 'no words here but the audio is not quiet: likely speech the transcript missed, kept' });
  };
  if (!words.length) return { deletes: [], suggestions, missed, keeps: [{ src0: 0, src1: duration }] };

  if (words[0].start - headPad > 0) pause(0, words[0].start - headPad, 'dead air before the first word', 0, words[0].start);
  if (duration > words.at(-1).end + tailPad) pause(words.at(-1).end + tailPad, duration, 'dead air after the last word', words.at(-1).end, duration);
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1], next = words[i], gap = next.start - prev.end;
    if (gap < gapMin) continue;
    const sentence = /[.!?]$/.test(prev.text);
    const keep = gap >= 2 ? 0.26 : sentence ? 0.22 : 0.16;
    pause(prev.end + keep * 0.55, next.start - keep * 0.45, `pause ${gap.toFixed(2)}s -> ${keep.toFixed(2)}s`, prev.end, next.start);
  }
  // Stutters: "the the". Cut the first one only when it sits in silence on both sides, and never
  // when the repeat is a name ("Phi Phi"), a name from my-rules.md, or said twice on purpose.
  const nameTokens = new Set(names.flatMap((n) => n.split(/\s+/).map(token)));
  const pairs = new Map();
  for (let i = 1; i < words.length; i++) { const t = token(words[i].text); if (t && token(words[i - 1].text) === t) pairs.set(t, (pairs.get(t) || 0) + 1); }
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1], b = words[i], t = token(b.text);
    if (!t || token(a.text) !== t || b.start - a.end >= 0.5) continue;
    const midSentence = i >= 2 && !/[.!?]$/.test(words[i - 2].text);
    const name = nameTokens.has(t) || (midSentence && /^[A-Z]/.test(a.text) && /^[A-Z]/.test(b.text)) || (pairs.get(t) || 0) >= 2;
    if (name) { suggestions.push({ start: a.start, end: b.start, kind: 'repeat kept', reason: `"${a.text} ${b.text}" looks like a name or a deliberate repeat`, why: 'left as spoken' }); continue; }
    const before = i >= 2 ? a.start - words[i - 2].end : a.start;
    const cut = { start: a.start, end: b.start, reason: `stutter "${a.text}"` };
    if (before >= 0.12 && b.start - a.end >= 0.06 && style.stutters !== 'suggest') push(cut.start, cut.end, cut.reason);
    else suggestions.push({ start: cut.start, end: cut.end, kind: 'stutter', reason: `"${a.text}" twice`, why: 'inside a phrase; cutting it would clip the words around it' });
  }
  // Short retakes the phrase comparison below cannot see: the same four words again within 30 s.
  const toks = words.map((w) => token(w.text));
  const grams = new Map();
  for (let i = 0; i + 4 <= words.length; i++) {
    if (toks.slice(i, i + 4).some((x) => !x)) continue;
    const g = toks.slice(i, i + 4).join(' ');
    const first = grams.get(g);
    if (first === undefined) { grams.set(g, i); continue; }
    if (i - first >= 4 && words[i].start - words[first].start <= 30) {
      const silBefore = first === 0 ? Infinity : words[first].start - words[first - 1].end;
      const silAfter = words[i].start - words[i - 1].end;
      const clean = silBefore >= 0.2 && silAfter >= 0.2;
      const s = { start: words[first].start, end: words[i].start, kind: 'possible retake', reason: `"${words.slice(first, first + 4).map((w) => w.text).join(' ')}..." is said again ${(words[i].start - words[first].start).toFixed(1)} s later`, why: clean ? 'both edges sit in silence, so it would cut cleanly if it is a retake' : 'the edges are not in silence; cut only between phrases' };
      if (style.retakes === 'cut' && clean) push(s.start, s.end, `retake: ${s.reason}`); else suggestions.push(s);
    }
    grams.set(g, i);
  }
  // Retakes: the same line said twice. Keep the last clean take when both edges land in silence.
  const segs = [];
  let s = 0;
  for (let i = 1; i <= words.length; i++) {
    const end = i === words.length, prev = words[i - 1], cur = words[i];
    const elapsed = prev.end - words[s].start;
    if (end || cur.start - prev.end > 0.85 || (/[.!?]$/.test(prev.text) && elapsed >= 7.5) || elapsed >= 16) {
      segs.push({ i0: s, i1: i - 1, start: words[s].start, end: prev.end, sig: words.slice(s, i).map((w) => token(w.text)).filter((t) => t.length > 2 && !STOP.has(t)).slice(0, 18) });
      s = i;
    }
  }
  const jaccard = (x, y) => { const X = new Set(x), Y = new Set(y); let o = 0; for (const t of X) if (Y.has(t)) o++; return o / Math.max(1, new Set([...X, ...Y]).size); };
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < Math.min(segs.length, i + 9); j++) {
      if (segs[j].start - segs[i].end > 75) break;
      const score = jaccard(segs[i].sig, segs[j].sig);
      const sameOpening = segs[i].sig.slice(0, 4).filter((t, k) => t === segs[j].sig[k]).length >= 2;
      if (score < 0.34 && !(score >= 0.24 && sameOpening)) continue;
      const silBefore = segs[i].i0 === 0 ? segs[i].start : segs[i].start - words[segs[i].i0 - 1].end;
      const silAfter = words[segs[j].i0].start - words[segs[j].i0 - 1].end;
      // Never cut these on its own: a repeated line is as often a chorus, a list, or emphasis as a retake.
      const clean = score >= 0.45 && silBefore >= 0.2 && silAfter >= 0.2;
      suggestions.push({
        start: segs[i].start, end: segs[j].start, kind: 'possible retake',
        reason: `"${words.slice(segs[i].i0, segs[i].i1 + 1).map((w) => w.text).join(' ').slice(0, 60)}" is said again right after`,
        why: clean ? 'both edges sit in silence, so it would cut cleanly if it is a retake' : 'the edges are not in silence; cut only between phrases',
      });
      break;
    }
  }
  // A sung or chanted run ("na na na na") is one note, not ten.
  for (let i = suggestions.length - 1; i > 0; i--) {
    const a = suggestions[i - 1], b = suggestions[i];
    if ((a.kind === 'stutter' || a.kind === 'repeat kept') && a.kind === b.kind && a.reason === b.reason && b.start - a.end < 0.3) { a.end = b.end; a.reason = a.reason.replace(/ twice$/, ' repeated'); suggestions.splice(i, 1); }
  }
  // Merge, snap to frames, never land inside a word.
  deletes.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const d of deletes) {
    const last = merged.at(-1);
    if (last && d.start <= last.end) { last.end = Math.max(last.end, d.end); last.reason += '; ' + d.reason; } else merged.push({ ...d });
  }
  const keeps = [];
  let cursor = 0;
  for (const d of merged) {
    if (d.start > cursor) keeps.push({ src0: cursor, src1: d.start });
    cursor = Math.max(cursor, d.end);
  }
  if (cursor < duration) keeps.push({ src0: cursor, src1: duration });
  // The same retake found twice (phrase match and four-word match) is one note.
  const seen = [];
  const unique = suggestions.filter((s) => { if (s.kind !== 'possible retake') return true; if (seen.some((t) => Math.abs(t - s.start) < 0.5)) return false; seen.push(s.start); return true; });
  return { deletes: merged, suggestions: unique, missed, keeps: keeps.filter((k) => k.src1 - k.src0 >= 0.1) };
}

// Frame-aligned segments and the words that survive on the new timeline.
function timeline(keeps, words, fixes = {}, extras = []) {
  let t = 0;
  const segments = keeps.map((k) => {
    const f0 = frames(k.src0), n = Math.max(1, frames(k.src1) - f0);
    const seg = { src0: r3(secs(f0)), src1: r3(secs(f0 + n)), frames: n, out0: r3(secs(t)), out1: r3(secs(t + n)) };
    t += n;
    return seg;
  });
  const duration = r3(secs(t));
  const toOut = (src) => { for (const s of segments) if (src >= s.src0 - 0.001 && src < s.src1) return s.out0 + (src - s.src0); return null; };
  const kept = [], dropped = [];
  words.forEach((w, i) => {
    const fix = fixes[String(i)];
    if (fix === '') return;
    // A word stays when at least half of it is inside a kept piece, even if a cut nicked its start.
    const overlap = (s) => Math.min(w.end, s.src1) - Math.max(w.start, s.src0);
    const seg = segments.find((s) => overlap(s) >= Math.max(0.02, (w.end - w.start) / 2));
    if (!seg) {
      // Only a word a cut edge clipped is worth a warning; words inside a removed section were meant to go.
      if (segments.some((s) => overlap(s) > 0.01)) dropped.push({ i, text: w.text, at: w.start });
      return;
    }
    const start = seg.out0 + (Math.max(w.start, seg.src0) - seg.src0);
    const end = Math.min(seg.out0 + (Math.min(w.end, seg.src1) - seg.src0), seg.out1);
    kept.push({ i, text: fix ?? w.text, start: r3(start), end: r3(Math.max(end, start + 0.05)), src: w.start });
  });
  // Words the transcript missed, added by hand in edit.json as { text, start, end } in source time.
  for (const x of extras) {
    const start = toOut(x.start);
    if (start === null || !x.text) continue;
    kept.push({ i: 'extra', text: x.text, start: r3(start), end: r3(start + Math.max(0.2, (x.end || x.start + 0.5) - x.start)), src: x.start });
  }
  kept.sort((a, b) => a.start - b.start);
  return { segments, duration, words: kept, dropped };
}

// ---------- captions ----------
const isKey = (w) => { const t = token(w.text); return t.length >= 4 && !STOP.has(t) || /\d/.test(t) || /[A-Z]{2,}/.test(w.text); };
const clean = (t) => t.replace(/^[^\p{L}\p{N}$#@]+|[^\p{L}\p{N}$%!?.]+$/gu, '').replace(/[.,;:]+$/, '');

// ---------- the hook gate ----------
// The hook is a selection problem over the speaker's own words, never invented text. Fable
// proposes up to three truthful candidates from the first 20 s, each citing the words it came
// from, picks one by default, and leaves the others in edit.json for the user or agent to swap.
const QUESTION = /^(how|why|what|when|who|which|paano|bakit|ano|kailan|sino|alin|pano)$/i;
const CHARGED = /^(never|always|secret|free|stop|mistake|wrong|best|worst|truth|nobody|everyone|only|biggest|hack|trick|wala|lahat|libre|sikreto|mali|totoo|pinaka)/i;

function compress(span, max = 7) {
  // Keep content words in order; drop fillers from the edges first, then from the inside.
  let ws = span.map((w) => clean(w.text)).filter(Boolean);
  while (ws.length > max && ws.length && STOP.has(token(ws[0]))) ws.shift();
  while (ws.length > max && ws.length && STOP.has(token(ws.at(-1)))) ws.pop();
  if (ws.length > max) ws = ws.filter((w, i) => i < 2 || !STOP.has(token(w)) || ws.length <= max);
  return ws.slice(0, max);
}
const toLines = (ws) => {
  const parts = ws.map((w) => w.toUpperCase());
  const mid = Math.ceil(parts.length / 2);
  return parts.length > 3 ? [parts.slice(0, mid).join(' '), parts.slice(mid).join(' ')] : [parts.join(' ')];
};

function hookCandidates(words, slug) {
  const early = words.filter((w) => w.start < 20);
  const out = [];
  const add = (pattern, span, why) => {
    const ws = compress(span);
    if (ws.length < 2 || out.some((c) => c.text === ws.join(' '))) return;
    const payoff = span.at(-1);
    out.push({ pattern, text: ws.join(' '), lines: toLines(ws), source: span.map((w) => w.i), from: r3(span[0].start), payoff: r3(payoff.end), why });
  };
  if (!early.length) {
    // No speech (a pet clip, b-roll): a real title from the file name is fine, a camera name is not.
    const ws = slug.replace(/-\d{4}-\d{2}-\d{2}.*$/, '').split('-').filter((w) => /[a-z]{3,}/i.test(w) && !/^(vid|img|mov|dsc|pxl|screen|recording|clip|video|final|copy)$/i.test(w));
    return ws.length >= 2 ? [{ pattern: 'title', text: ws.join(' '), lines: toLines(ws), source: [], from: 0, payoff: 0, why: 'no speech found, so the file name is the title' }] : [];
  }
  // 1. Claim: the first sentence, the speaker's own opening line.
  const first = [];
  for (const w of early) { first.push(w); if (/[.!?]$/.test(w.text) || first.length >= 9) break; }
  add('claim', first, 'the opening line as spoken');
  // 2. Question: the first clause that starts with a question word.
  const qi = early.findIndex((w) => QUESTION.test(clean(w.text)));
  if (qi >= 0) {
    const span = [];
    for (const w of early.slice(qi)) { span.push(w); if (/[.!?]$/.test(w.text) || span.length >= 8) break; }
    add('question', span, 'a question the video answers');
  }
  // 3. Charged word or number: the first span around a strong word, result first.
  const ci = early.findIndex((w, i) => i > 0 && (/\d/.test(w.text) || CHARGED.test(clean(w.text))));
  if (ci >= 0) add('result', early.slice(Math.max(0, ci - 2), Math.min(early.length, ci + 5)), 'leads with the strongest word');
  return out.slice(0, 3);
}

// Objective checks every opening must pass. Results go in the notes; failures are fixed where
// the code can (sound) and flagged where only eyes can (face position).
function hookGate(plan, style, lay) {
  const checks = [];
  const first = plan.words[0];
  checks.push({ check: 'speech starts within 0.15 s', pass: !first || first.start <= 0.15, value: first ? `${first.start}s` : 'no speech' });
  checks.push({ check: 'text on frame 0', pass: Boolean(plan.hook) || style.captions === 'none', value: plan.hook ? 'hook card' : 'no hook' });
  // Measured, not assumed: the first caption must start before its word, by the 2-frame lead.
  const firstCap = plan.captions[0], firstCapWord = firstCap && plan.words.find((w) => w.start >= firstCap.start - 0.001);
  const lead = firstCap && firstCapWord ? r3(firstCapWord.start - firstCap.start) : null;
  checks.push({ check: 'captions lead the word by 2 frames', pass: lead === null || lead >= 2 / FPS - 0.001 || firstCap.start <= 0.001, value: lead === null ? 'no captions' : firstCap.start <= 0.001 ? 'from frame 0' : `${Math.round(lead * FPS)} frames` });
  // Geometry against the platform UI: nothing above 14% of the height, captions above 80%.
  const L = captionLayout(lay, style), safeTop = Math.round(0.14 * lay.h), safeBottom = Math.round(0.80 * lay.h);
  const hookTop = plan.hook ? Math.round(L.hookY - L.hookBlock / 2) : null;
  const capFont = style.captions === 'subtitles' ? L.sub : style.captions === 'word' ? L.word : L.group;
  const capTop = Math.round(L.capY - capFont * 0.7), capBottom = Math.round(L.capY + capFont * 0.7);
  checks.push({ check: `hook card below the top ${safeTop}px (platform UI)`, pass: hookTop === null || hookTop >= safeTop, value: hookTop === null ? 'no hook' : `top at ${hookTop}px` });
  checks.push({ check: `captions inside ${safeTop}..${safeBottom}px and clear of the hook`, pass: capTop >= safeTop && capBottom <= safeBottom && (hookTop === null || capTop >= L.hookY + L.hookBlock / 2), value: `${capTop}..${capBottom}px` });
  if (plan.face && lay.fit === 'cover') {
    // Measured: the face box from face.json, in pixels of this layout. Text must not enter it.
    const faceTop = Math.round(plan.face.face_top_p10 * lay.h), chin = Math.round(plan.face.chin_p90 * lay.h);
    const textBottom = Math.max(capBottom, hookTop === null ? 0 : Math.round(L.hookY + L.hookBlock / 2));
    const above = textBottom <= faceTop - 20, below = capTop >= chin + 20 && (hookTop === null || hookTop >= chin + 20);
    checks.push({ check: 'text clear of the face (measured at 2 fps)', pass: above || below, value: `text ${Math.round(capTop)}..${textBottom}px, face ${faceTop}..${chin}px, seen in ${Math.round((plan.face.coverage || 0) * 100)}% of samples` });
  } else checks.push({ check: 'face band: look at review-open.png', pass: true, value: plan.face ? 'band layout: footage sits in its own panel' : 'no face data (pip install opencv-python-headless to measure it)' });
  checks.push({ check: 'hook text comes from the speaker', pass: !plan.hook || !plan.hook.source || plan.hook.source.length > 0 || plan.hook.pattern === 'title', value: plan.hook?.pattern || 'none' });
  // The promise on the card must be kept in the cut: every word on the card is spoken in it.
  const said = new Set(plan.words.map((w) => token(w.text)));
  const cardWords = plan.hook ? plan.hook.lines.join(' ').split(/\s+/).map(token).filter((t) => t.length >= 3) : [];
  const missing = cardWords.filter((t) => !said.has(t));
  checks.push({ check: 'the words on the hook card are spoken in the cut', pass: !missing.length, value: missing.length ? `not heard: ${missing.join(', ')}` : cardWords.length ? 'all spoken' : '-' });
  return checks;
}

function chooseHook(edit, words, style, scriptText = null) {
  if (!style.hook || edit.hook === null) return { hook: null, candidates: [] };
  const candidates = hookCandidates(words, edit.slug);
  // A script's first line (or a "Hook:" line) is what the author meant the opening to be.
  if (scriptText) {
    const line = hookFromScript(scriptText);
    if (line) {
      const ws = compress(line.split(/\s+/).map((t) => ({ text: t })), 8);
      if (ws.length) candidates.unshift({ pattern: 'script', text: ws.join(' '), lines: toLines(ws), source: [], from: 0, payoff: words[0]?.end || 0, why: 'the first line of your script' });
    }
  }
  let hook = null;
  if (edit.hook && typeof edit.hook === 'object') hook = { ...edit.hook };
  else if (typeof edit.hook === 'number' && candidates[edit.hook]) hook = { ...candidates[edit.hook] };
  else if (candidates.length) hook = { ...candidates[0] };
  if (hook) {
    // end is seconds. 2200 means someone typed milliseconds; "2.2s" means a string. Both get fixed.
    const typed = hook.end, n = Number(String(typed ?? '').replace(/s$/i, ''));
    if (!Number.isFinite(n) || n < 0.5) hook.end = r3(Math.min(2.6, Math.max(1.6, (hook.payoff || 2) + 0.15)));
    else if (n > 60) hook.end = r3(Math.min(4, n / 1000));
    else hook.end = r3(Math.min(4, n));
    if (typed !== undefined && hook.end !== typed) log(`hook.end ${JSON.stringify(typed)} -> ${hook.end} s`);
  }
  return { hook, candidates };
}

function buildCaptions(words, style, hookEnd, duration) {
  if (style.captions === 'none') return [];
  const lead = 2 / FPS;
  const visible = words.filter((w) => w.start >= hookEnd - 0.05 && clean(w.text));
  if (style.captions === 'word') {
    const single = visible.map((w) => ({ kind: 'word', text: clean(w.text).toUpperCase(), start: r3(Math.max(hookEnd, w.start - lead)), end: w.end, key: isKey(w) }));
    // Fast runs ("the name of the") would flash for a tenth of a second each. Group words that
    // are spoken faster than a reader can take them, up to three per chunk, never across a pause.
    const caps = [];
    for (const w of single) {
      const last = caps.at(-1);
      const fast = last && w.start - last.lastStart < 0.28 && last.words < 3 && (last.text + ' ' + w.text).length <= 14 && !/[.!?]$/.test(last.raw);
      if (fast) { last.text += ' ' + w.text; last.words++; last.lastStart = w.start; last.end = w.end; last.raw = w.text; last.key = last.key || w.key; continue; }
      caps.push({ kind: 'word', text: w.text, start: w.start, end: w.end, key: w.key, words: 1, lastStart: w.start, raw: w.text });
    }
    for (let i = 1; i < caps.length; i++) caps[i].start = r3(Math.max(caps[i].start, caps[i - 1].start + 0.15));
    caps.forEach((c, i) => { c.end = r3(Math.min(i + 1 < caps.length ? caps[i + 1].start : duration, c.start + 0.9)); delete c.words; delete c.lastStart; delete c.raw; });
    return caps.filter((c) => c.end > c.start);
  }
  const max = style.captions === 'subtitles' ? 6 : 4;
  const groups = [];
  let g = null;
  for (const w of visible) {
    const gap = g ? w.start - g.words.at(-1).end : 0;
    if (!g || g.words.length >= max || gap >= 0.35 || /[.!?]$/.test(g.words.at(-1).text)) { g = { kind: 'group', words: [] }; groups.push(g); }
    g.words.push({ text: style.captions === 'subtitles' ? clean(w.text) : clean(w.text).toUpperCase(), start: r3(Math.max(hookEnd, w.start - lead)), end: w.end, key: isKey(w) });
  }
  groups.forEach((grp, i) => {
    grp.start = grp.words[0].start;
    const next = groups[i + 1]?.words[0].start ?? duration;
    grp.end = r3(Math.max(grp.start + 0.3, Math.min(next, grp.words.at(-1).end + 0.3, duration)));
  });
  return groups;
}

// ---------- media ----------
const GRADES = {
  natural: 'eq=contrast=1.03:saturation=1.04',
  warm: 'colorbalance=rs=.07:gs=.02:bs=-.08:rm=.04:bm=-.04,eq=saturation=1.05',
  cool: 'colorbalance=rs=-.06:bs=.08:rm=-.03:bm=.04',
  bw: 'hue=s=0,eq=contrast=1.08',
  'orange-teal': 'colorbalance=rs=.08:bs=-.06:rh=-.04:bh=.12:gh=.03,eq=saturation=1.1',
};
function layoutFor(format, src) {
  const landscape = src.width >= src.height;
  if (format === 'horizontal') {
    if (landscape) return { w: 1920, h: 1080, fit: 'cover', foot: { x: 0, y: 0, w: 1920, h: 1080 } };
    const fw = Math.round(1080 * src.width / src.height / 2) * 2;
    return { w: 1920, h: 1080, fit: 'column', foot: { x: (1920 - fw) / 2, y: 0, w: fw, h: 1080 } };
  }
  if (!landscape) return { w: 1080, h: 1920, fit: 'cover', foot: { x: 0, y: 0, w: 1080, h: 1920 } };
  const fh = Math.round(1080 * src.height / src.width / 2) * 2;
  return { w: 1080, h: 1920, fit: 'band', foot: { x: 0, y: Math.round((1920 - fh) / 2 + 40), w: 1080, h: fh } };
}
function buildFootage(dir, segments, lay, grade) {
  const scale = lay.fit === 'cover'
    ? `scale=${lay.foot.w}:${lay.foot.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${lay.foot.w}:${lay.foot.h}`
    : `scale=${lay.foot.w}:${lay.foot.h}:flags=lanczos`;
  const v = segments.map((s, i) => `[0:v]trim=start_frame=${frames(s.src0)}:end_frame=${frames(s.src0) + s.frames},setpts=PTS-STARTPTS,${scale},${GRADES[grade] || GRADES.natural},setsar=1,format=yuv420p[v${i}]`);
  const script = join(dir, 'assets/footage.filter');
  writeFileSync(script, v.join(';\n') + ';\n' + segments.map((_, i) => `[v${i}]`).join('') + `concat=n=${segments.length}:v=1:a=0[out]`);
  // x264 at medium is the first choice; on a memory-starved laptop it can refuse to open, so step
  // down rather than fail. The file is checked afterwards: a broken footage file stops the run.
  const ladder = [['-c:v', 'libx264', '-preset', 'medium', '-crf', '17'], ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-threads', '2']];
  if (hasAmf()) ladder[lowMemoryMachine() ? 'unshift' : 'push'](['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '18']);
  let lastError = null;
  for (const enc of ladder) {
    try {
      ff(['-i', 'assets/raw.mp4', '-/filter_complex', script, '-map', '[out]', ...enc, '-r', String(FPS), '-movflags', '+faststart', 'assets/footage.mp4'], dir);
      const size = statSync(join(dir, 'assets/footage.mp4')).size;
      if (size < 10000) throw new Error(`footage came out empty (${size} bytes) with ${enc[1]}`);
      if (enc !== ladder[0]) log(`footage encoded with ${enc[1]} ${enc[3]} (the first choice could not start; the computer is low on memory)`);
      return;
    } catch (e) { lastError = e; }
  }
  throw new Error(`could not encode the cut footage. ${lastError?.message.split('\n')[0]}. Free some memory (close browser tabs or other apps) and run again.`);
}
// Soft phrases come up, loud ones stay put: a high-pass for rumble, gentle compression, then a
// speech normalizer that lifts quiet passages without pumping. "Voice: natural" in the rules skips it.
const VOICE_LEVEL = 'highpass=f=80,acompressor=threshold=-22dB:ratio=2.5:attack=8:release=140:makeup=2,speechnorm=e=4:r=0.0005:l=1,alimiter=limit=0.95:level=0';
function buildVoice(dir, segments, hasAudio, duration, style = {}) {
  if (!hasAudio) { ff(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${duration}`, 'assets/voice.wav'], dir); return; }
  const a = segments.map((s, i) => { const d = secs(s.frames); return `[0:a]atrim=start=${s.src0}:end=${r3(s.src0 + d)},asetpts=PTS-STARTPTS,afade=t=in:d=0.012,afade=t=out:st=${r3(Math.max(0, d - 0.015))}:d=0.015[a${i}]`; });
  const script = join(dir, 'assets/voice.filter');
  const level = style.voice === 'natural' ? '' : `,${VOICE_LEVEL}`;
  writeFileSync(script, a.join(';\n') + ';\n' + segments.map((_, i) => `[a${i}]`).join('') + `concat=n=${segments.length}:v=0:a=1${level},aresample=48000[voice]`);
  ff(['-i', 'assets/raw.mp4', '-/filter_complex', script, '-map', '[voice]', '-ac', '2', '-ar', '48000', 'assets/voice.wav'], dir);
}
const SFX = {
  tap: 'sine=f=150:d=0.18,afade=t=out:d=0.17:curve=exp,volume=1.6',
  pop: 'sine=f=900:d=0.07,afade=t=out:d=0.065:curve=exp',
  click: 'sine=f=2200:d=0.05,afade=t=out:d=0.045:curve=exp,volume=0.8',
  whoosh: 'anoisesrc=color=pink:d=0.5:a=0.6,highpass=f=250,lowpass=f=3500,afade=t=in:d=0.28:curve=qsin,afade=t=out:st=0.28:d=0.22',
  ding: 'sine=f=1046:d=0.8,afade=t=out:d=0.78:curve=exp',
};
function userSounds() {
  const found = { music: null, sfx: {} };
  const dir = join(root, 'my-sounds');
  if (!existsSync(dir)) return found;
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : AUDIO_EXT.has(extname(e.name).toLowerCase()) ? [join(d, e.name)] : []);
  for (const f of walk(dir)) {
    const n = basename(f).toLowerCase(), rel = f.slice(dir.length + 1).toLowerCase();
    if (/music|bed|beat|track|song|lofi|lo-fi/.test(rel) && !found.music) found.music = f;
    else for (const k of Object.keys(SFX)) if (n.includes(k) && !found.sfx[k]) found.sfx[k] = f;
  }
  return found;
}
function buildMix(dir, plan, style, duration) {
  const sounds = userSounds();
  for (const [k, gen] of Object.entries(SFX)) {
    const out = join(dir, `assets/sfx/${k}.wav`);
    if (sounds.sfx[k]) ff(['-i', sounds.sfx[k], '-t', '1.5', '-ar', '48000', '-ac', '2', out]);
    else ff(['-f', 'lavfi', '-i', gen, '-ar', '48000', '-ac', '2', out]);
  }
  const cues = [];
  if (style.sound !== 'voice') {
    // Nothing may sit on the first spoken word; the opening tap only plays when there is room.
    const firstWord = plan.words?.[0];
    if (!firstWord || firstWord.start >= 0.45) cues.push(['tap', 0.1, 0.5]);
    if (plan.hook && plan.hook.lines.length > 1 && !(firstWord && Math.abs(firstWord.start - 0.5) < 0.25)) cues.push(['pop', 0.5, 0.12]);
    let last = -9;
    for (let i = 1; i < plan.segments.length; i++) {
      const s = plan.segments[i], removed = s.src0 - plan.segments[i - 1].src1;
      if (removed >= 1.0 && s.out0 - last >= 1.5) { cues.push(['click', r3(s.out0), 0.12]); last = s.out0; }
    }
  }
  const inputs = ['-i', 'assets/voice.wav'], f = [], mix = ['[voice]'];
  f.push(`[0:a]asplit=2[voice][side]`);
  let n = 1;
  cues.forEach(([name, at, vol]) => {
    inputs.push('-i', `assets/sfx/${name}.wav`);
    f.push(`[${n}:a]volume=${vol},adelay=${Math.round(at * 1000)}:all=1[s${n}]`);
    mix.push(`[s${n}]`); n++;
  });
  const music = style.sound === 'music' ? sounds.music : null;
  if (music) {
    inputs.push('-stream_loop', '-1', '-i', music);
    f.push(`[${n}:a]atrim=end=${duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=0.2,afade=t=in:d=0.6,afade=t=out:st=${r3(Math.max(0, duration - 1.5))}:d=1.5[bedraw]`);
    f.push(`[bedraw][side]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350:makeup=1[bed]`);
    mix.push('[bed]');
  } else f.push('[side]anullsink');
  f.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:duration=longest,apad=whole_dur=${duration},atrim=end=${duration},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[m]`);
  const script = join(dir, 'assets/mix.filter');
  writeFileSync(script, f.join(';\n'));
  ff([...inputs, '-/filter_complex', script, '-map', '[m]', '-ac', '2', '-ar', '48000', 'assets/mix.wav'], dir);
  return { cues, music: music ? basename(music) : null };
}

// ---------- composition ----------
function composition(plan, lay, style, formatName) {
  const { w: W, h: H } = lay, F = lay.foot, D = plan.duration, vertical = H > W;
  const sc = style.scale || 1;
  // One layout for both engines: captionLayout() in tools/fast-render.mjs owns the numbers.
  const L = captionLayout(lay, style);
  const capW = vertical ? 900 : 1600, capH = vertical ? 380 : 220, capX = (W - capW) / 2;
  const capY = Math.round(L.capY - capH / 2);
  const big = L.word, group = L.group, sub = L.sub;
  const hookTop = Math.round(L.hookY - L.hookBlock / 2 - capY), hookH = Math.round(L.hookBlock);
  const fade = lay.fit === 'cover' && style.position === 'upper';
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const bg = lay.fit === 'cover' ? '#000' : '#0b0f17';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(plan.slug)} (${formatName})</title>
<script src="assets/gsap.min.js"></script>
<style>
*{box-sizing:border-box}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:${bg}}
#reel{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:${bg}}
#glow{position:absolute;inset:0;background:radial-gradient(ellipse ${W * 0.8}px ${H * 0.4}px at 50% 10%,rgba(109,40,217,.32),transparent 70%),radial-gradient(ellipse ${W * 0.6}px ${H * 0.3}px at 50% 100%,rgba(219,39,119,.12),transparent 70%)}
#fw{position:absolute;left:${F.x}px;top:${F.y}px;width:${F.w}px;height:${F.h}px;overflow:hidden;${lay.fit !== 'cover' ? 'border-radius:22px;box-shadow:0 0 90px rgba(109,40,217,.35);' : ''}}
#fw-inner{position:absolute;inset:0;transform-origin:50% 45%}
#foot{position:absolute;inset:0;width:${F.w}px;height:${F.h}px;object-fit:cover}
.bw{position:absolute;left:${F.x}px;top:${F.y}px;width:${F.w}px;height:${F.h}px;overflow:hidden;opacity:0;visibility:hidden;transform-origin:50% 50%;${lay.fit !== 'cover' ? 'border-radius:22px;' : ''}}
.bw video{position:absolute;inset:0;width:${F.w}px;height:${F.h}px;object-fit:cover}
#fade{position:absolute;left:0;top:0;width:${W}px;height:${Math.round(H * 0.4)}px;background:linear-gradient(rgba(0,0,0,.6),rgba(0,0,0,.35) 55%,rgba(0,0,0,0))}
#cap{position:absolute;left:${capX}px;top:${capY}px;width:${capW}px;height:${capH}px}
.c{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;opacity:0;visibility:hidden;
  font-family:'${style.font}',sans-serif;font-weight:800;line-height:1.05;color:${style.color};
  -webkit-text-stroke:2px rgba(0,0,0,.45);paint-order:stroke fill;text-shadow:0 5px 0 rgba(0,0,0,.55),0 10px 32px rgba(0,0,0,.75)}
.word{font-size:${big}px}.word.long{font-size:${Math.round(big * 0.78)}px}.word.key{color:${style.accent}}
.hook{flex-direction:column;gap:${Math.round(big * 0.14)}px;font-size:${Math.round(big * 0.82)}px}.hook span{display:block}.hook .acc{color:${style.accent}}
.group{flex-wrap:wrap;gap:0 ${Math.round(group * 0.3)}px;font-size:${group}px;align-content:center}
.group i{font-style:normal;opacity:0;display:inline-block}
.group.bold i.k,.group.pills i.k{color:${style.accent};font-size:${Math.round(group * 1.2)}px}
.group.bold i.f,.group.pills i.f{font-size:${Math.round(group * 0.72)}px;font-weight:700;opacity:0}
.group.pills i.k{color:#111;background:${style.accent};border-radius:14px;padding:2px 18px;-webkit-text-stroke:0;text-shadow:none}
.group.subtitles{font-size:${sub}px;font-weight:700;text-transform:none;-webkit-text-stroke:0;background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.18);border-radius:18px;padding:14px 26px;height:auto;top:auto;bottom:0}
</style></head><body>
<div id="reel" data-composition-id="reel" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}">
  ${lay.fit !== 'cover' ? `<div id="glow" class="clip" data-start="0" data-duration="${D}" data-track-index="0"></div>` : ''}
  <div id="fw"><div id="fw-inner">
    <video id="foot" data-start="0" data-duration="${D}" data-track-index="1" src="assets/footage.mp4" muted playsinline></video>
  </div></div>
  <audio id="mix" data-start="0" data-duration="${D}" data-track-index="2" src="assets/mix.wav" data-volume="1"></audio>
  ${(plan.broll || []).map((b, i) => `<div class="bw" id="bw${i}"><video id="b${i}" data-start="${b.at}" data-duration="${b.duration}" data-track-index="${10 + i}" src="${b.file}" muted playsinline></video></div>`).join('\n  ')}
  ${fade ? `<div id="fade" class="clip" data-start="0" data-duration="${D}" data-track-index="3"></div>` : ''}
  <div id="cap" class="clip" data-start="0" data-duration="${D}" data-track-index="4"></div>
</div>
<script>
(function(){
  var P = ${JSON.stringify({ segments: plan.segments.map((s) => [s.out0, s.out1]), hook: plan.hook, captions: plan.captions, mode: style.captions, broll: (plan.broll || []).map((b) => [b.at, b.duration]) })};
  var tl = gsap.timeline({paused:true}), cap = document.getElementById('cap');
  // A slow push-in on every shot so nothing sits still; the origin alternates so cuts feel different.
  P.segments.forEach(function(s, i){
    tl.set('#fw-inner',{transformOrigin: i%2 ? '50% 35%' : '50% 55%'}, s[0]);
    tl.fromTo('#fw-inner',{scale:1},{scale:1.035,duration:s[1]-s[0],ease:'none',immediateRender:false},s[0]);
  });
  ${lay.fit !== 'cover' ? "tl.from('#fw',{y:50,opacity:0,duration:.45,ease:'power3.out'},0.05);" : ''}
  function show(el,t){ tl.set(el,{opacity:1,visibility:'visible'},t); }
  function hide(el,t){ tl.set(el,{opacity:0,visibility:'hidden'},t); }
  // B-roll inserts: a hard cut in on the spoken word, a slow push while it holds, a hard cut out.
  P.broll.forEach(function(b,i){
    var el = document.getElementById('bw'+i); if (!el) return;
    show(el,b[0]);
    tl.fromTo(el,{scale:1.04},{scale:1.10,duration:b[1],ease:'none',immediateRender:false},b[0]);
    hide(el,b[0]+b[1]);
  });
  if (P.hook) {
    var h = document.createElement('div'); h.className='c hook'; h.id='hook';
    P.hook.lines.forEach(function(l,k){ var sp=document.createElement('span'); sp.textContent=l; if(k===1) sp.className='acc'; h.appendChild(sp); });
    h.style.top = '${hookTop}px'; h.style.height = '${hookH}px'; h.style.fontSize = '${L.hook}px';
    cap.appendChild(h); show(h,0);
    tl.from(h.children[0],{y:40,opacity:0,duration:.3,ease:'back.out(1.7)'},0.06);
    if (h.children[1]) tl.from(h.children[1],{scale:.5,opacity:0,duration:.35,ease:'back.out(2.2)'},0.45);
    hide(h,P.hook.end);
  }
  P.captions.forEach(function(c,i){
    var el = document.createElement('div'); el.id='c'+i;
    if (c.kind==='word') {
      el.className='c word'+(c.text.length>8?' long':'')+(c.key&&P.mode==='word'&&/\\d/.test(c.text)?' key':'');
      el.textContent=c.text; cap.appendChild(el);
      show(el,c.start); tl.from(el,{scale:.86,duration:.1,ease:'power2.out'},c.start); hide(el,c.end);
    } else {
      el.className='c group '+P.mode; cap.appendChild(el);
      c.words.forEach(function(w){ var sp=document.createElement('i'); sp.textContent=w.text; sp.className=w.key?'k':'f'; el.appendChild(sp);
        tl.set(sp,{opacity:1},w.start); if (w.key) tl.from(sp,{scale:.7,duration:.14,ease:'back.out(2)'},w.start); });
      show(el,c.start); hide(el,c.end);
    }
  });
  window.__timelines = window.__timelines || {};
  window.__timelines['reel'] = tl;
})();
</script>
</body></html>
`;
}

// ---------- B-roll: free stock footage on the concrete words ----------
// Pexels or Pixabay, whichever key is in .env. Both licenses allow use in your own videos,
// commercial included, without attribution; every clip's source is still logged in the ledger.
const BROLL_SKIP = new Set(['okay', 'yeah', 'right', 'thing', 'things', 'stuff', 'really', 'gonna', 'wanna', 'know', 'like', 'just', 'very', 'because', 'about', 'there', 'where', 'which', 'would', 'could', 'should', 'have', 'been', 'then', 'than', 'that', 'this', 'with', 'what', 'when', 'your', 'they', 'them', 'will', 'also', 'into', 'some', 'more', 'most', 'said', 'says', 'want', 'need', 'make', 'made', 'does', 'done', 'going', 'come', 'came', 'here', 'much', 'many', 'every', 'other', 'again', 'still', 'even', 'only', 'back', 'well', 'sure', 'kind', 'sort', 'mean', 'guys', 'ever', 'never', 'always', 'maybe', 'actually', 'basically', 'literally', 'something', 'anything', 'everything', 'nothing', 'someone', 'everyone', 'mommy', 'daddy', 'hello', 'okay', 'alright', 'tapos', 'kaya', 'naman', 'lang', 'ganun', 'ganito', 'yung', 'para', 'pero', 'hindi', 'wala', 'meron', 'dito', 'doon', 'sila', 'kami', 'tayo', 'nila', 'natin', 'namin', 'niya', 'nung']);
const BROLL_INTERVAL = { some: 8, lots: 5 };

function brollProvider() {
  try { process.loadEnvFile(join(root, '.env')); } catch {}
  if (process.env.PEXELS_API_KEY) return 'pexels';
  if (process.env.PIXABAY_API_KEY) return 'pixabay';
  return null;
}

async function searchStock(provider, query, vertical, word = query) {
  const pick = (files) => {
    // Smallest file that still fills the frame; portrait when the reel is portrait.
    const ok = files.filter((f) => f.width && f.height && Math.min(f.width, f.height) >= 720);
    const oriented = ok.filter((f) => vertical ? f.height > f.width : f.width >= f.height);
    return (oriented.length ? oriented : ok).sort((a, b) => a.width * a.height - b.width * b.height)[0] || null;
  };
  if (provider === 'pexels') {
    const u = new URL('https://api.pexels.com/videos/search');
    u.search = new URLSearchParams({ query, orientation: vertical ? 'portrait' : 'landscape', size: 'medium', per_page: '8' });
    const res = await fetch(u, { headers: { Authorization: process.env.PEXELS_API_KEY } });
    if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
    for (const v of (await res.json()).videos || []) {
      if (v.duration < 3) continue;
      const f = pick(v.video_files || []);
      if (f) return { provider, id: String(v.id), page: v.url, author: v.user?.name || '', download: f.link, width: f.width, height: f.height, license: 'Pexels License (free, no attribution required)' };
    }
    return null;
  }
  const u = new URL('https://pixabay.com/api/videos/');
  u.search = new URLSearchParams({ key: process.env.PIXABAY_API_KEY, q: query, per_page: '8', safesearch: 'true' });
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Pixabay HTTP ${res.status}`);
  for (const h of (await res.json()).hits || []) {
    // The clip must be tagged with the spoken word itself, not just rank for it.
    if (h.duration < 3 || !(h.tags || '').toLowerCase().split(/,\s*/).some((tag) => tag.split(' ').includes(word) || tag === word)) continue;
    const f = pick(Object.values(h.videos || {}).map((x) => ({ ...x, link: x.url })));
    if (f) return { provider, id: String(h.id), page: h.pageURL, author: h.user || '', download: f.url, width: f.width, height: f.height, license: 'Pixabay Content License (free, no attribution required)' };
  }
  return null;
}

async function fetchBroll(dir, tl, style, hookEnd) {
  const provider = brollProvider();
  if (!provider || style.broll === 'none') return [];
  const interval = BROLL_INTERVAL[style.broll] || BROLL_INTERVAL.some;
  const hold = 2.0;
  const used = new Set(), picks = [];
  let last = hookEnd - interval + 1.2; // the first insert may come soon after the hook
  for (const w of tl.words) {
    const t = token(w.text);
    // Only plain words: no contractions, numbers, names, or filler.
    if (t.length < 4 || /['’\d]/.test(w.text) || /^[A-Z]/.test(w.text.trim()) && tl.words.indexOf(w) > 0 && !/[.!?]$/.test(tl.words[tl.words.indexOf(w) - 1].text) || STOP.has(t) || BROLL_SKIP.has(t) || used.has(t)) continue;
    const at = r3(Math.max(hookEnd + 0.3, w.start - 0.08));
    if (at - last < interval || at + hold > tl.duration - 1.5) continue;
    used.add(t); last = at;
    // Two words beat one: "clap hands" finds the action, "clap" finds anything.
    const k = tl.words.indexOf(w), n = tl.words[k + 1], p = tl.words[k - 1];
    const buddy = [n, p].find((x) => x && Math.abs(x.start - w.end) < 0.4 && !/['’\d]/.test(x.text) && token(x.text).length >= 3 && !STOP.has(token(x.text)) && !BROLL_SKIP.has(token(x.text)));
    picks.push({ query: buddy ? (buddy === n ? `${t} ${token(buddy.text)}` : `${token(buddy.text)} ${t}`) : t, at, duration: hold, word: t });
  }
  const out = [], vertical = style.format !== 'horizontal';
  mkdirSync(join(dir, 'assets/broll'), { recursive: true });
  for (const p of picks) {
    try {
      const hit = await searchStock(provider, p.query, vertical, p.word) || (p.query !== p.word && await searchStock(provider, p.word, vertical, p.word));
      if (!hit) { log(`b-roll: nothing usable for "${p.query}"`); continue; }
      const src = join(dir, `assets/broll/${hit.provider}-${hit.id}.mp4`);
      if (!existsSync(src)) {
        const res = await fetch(hit.download);
        if (!res.ok) throw new Error(`download HTTP ${res.status}`);
        writeFileSync(src, Buffer.from(await res.arrayBuffer()));
      }
      out.push({ ...p, provider: hit.provider, id: hit.id, page: hit.page, author: hit.author, license: hit.license, src: basename(src) });
      log(`b-roll: "${p.query}" at ${p.at}s from ${hit.provider} (${hit.author})`);
    } catch (e) { log(`b-roll: "${p.query}" skipped: ${e.message.split('\n')[0]}`); }
  }
  return out;
}

// Trim and frame each clip for this layout. Skips the first half second (stock often fades in).
function prepareBroll(dir, broll, lay) {
  const files = [];
  if (!broll.length) return files;
  mkdirSync(join(dir, 'assets/broll'), { recursive: true });
  broll.forEach((b, i) => {
    const out = `assets/broll/b${i}-${lay.w}x${lay.h}.mp4`;
    if (!existsSync(join(dir, out))) {
      ff(['-ss', '0.5', '-t', String(b.duration + 0.2), '-i', `assets/broll/${b.src}`, '-an', '-vf', `fps=${FPS},scale=${lay.foot.w}:${lay.foot.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${lay.foot.w}:${lay.foot.h},setsar=1,format=yuv420p`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-movflags', '+faststart', out], dir);
    }
    files.push({ ...b, file: out });
  });
  writeFileSync(join(dir, 'assets/broll/ledger.json'), JSON.stringify(files.map((f) => ({ query: f.query, at: f.at, duration: f.duration, provider: f.provider, id: f.id, page: f.page, author: f.author, license: f.license, file: f.file })), null, 2) + '\n');
  return files;
}

// ---------- the pipeline ----------
function nextVersion(slug, suffix) {
  mkdirSync(outbox, { recursive: true });
  const re = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${suffix}-v(\\d+)\\.mp4$`);
  const n = readdirSync(outbox).map((f) => Number(f.match(re)?.[1] || 0)).reduce((a, b) => Math.max(a, b), 0);
  return n + 1;
}
function render(dir, compositionFile, out, quality) {
  const args = ['hyperframes', 'render', '--quality', quality, '--output', out, '--frames-cache-dir', 'off'];
  if (compositionFile) args.push('--composition', compositionFile);
  log(`rendering ${out} (${quality}); this takes a few minutes`);
  const output = run('npx', args, { cwd: dir });
  const summary = output.split('\n').map((l) => l.trim()).filter((l) => /MB · .* video · rendered in/.test(l)).pop();
  if (summary) log(summary);
  return join(dir, out);
}

async function build(dir, edit, { quality = 'draft', render: doRender = true, finalName = false } = {}) {
  const raw = JSON.parse(readFileSync(join(dir, 'assets/raw.json'), 'utf8'));
  const src = edit.source;
  const style = { ...readStyle({ vertical: src.height > src.width, duration: src.duration }), ...(edit.style || {}) };
  validateEdit(edit);
  const tl = timeline(edit.segments, raw.words || [], edit.fixes || {}, edit.extra || []);
  if (tl.dropped.length) log(`${tl.dropped.length} transcript word${tl.dropped.length > 1 ? 's' : ''} fell inside cuts: ${tl.dropped.map((d) => `"${d.text}"@${d.at}s`).join(', ')}`);
  const scriptFile = edit.script?.file && [join(dirname(edit.source.file), edit.script.file)].find((p) => existsSync(p));
  const { hook, candidates } = chooseHook(edit, tl.words, style, scriptFile ? readFileSync(scriptFile, 'utf8') : null);
  const hookEnd = hook ? hook.end : 0;
  // Captions keep running under the hook card; the card sits above the caption zone.
  const facePath = join(dir, 'assets/face.json');
  const face = existsSync(facePath) ? (JSON.parse(readFileSync(facePath, 'utf8')).summary || null) : null;
  if (face) style.face = face;
  // The house rule for AI-made footage: a tag on every frame. From edit.json "tag" or --tag.
  const tag = edit.tag || opt.tag || null;
  const plan = { slug: edit.slug, duration: tl.duration, segments: tl.segments, hook, hookCandidates: candidates, captions: buildCaptions(tl.words, style, 0, tl.duration), words: tl.words, dropped: tl.dropped, network: [], face, tag };
  if (edit.transcription?.provider === 'groq') plan.network.push('audio was sent to Groq for transcription');
  const formats = style.format === 'both' ? ['vertical', 'horizontal'] : [style.format];
  const useBrowser = (edit.style?.engine || opt.engine) === 'browser' || !hasFastFonts(fontsDir);
  log(`cut: ${src.duration.toFixed(1)}s -> ${tl.duration.toFixed(1)}s in ${tl.segments.length} pieces, ${tl.words.length} words, captions: ${style.captions}`);
  const broll = Array.isArray(edit.broll) ? edit.broll : style.privacy === 'local' ? [] : await fetchBroll(dir, tl, style, hookEnd);
  if (broll.length && !Array.isArray(edit.broll)) plan.network.push(`spoken key words were sent to ${broll[0].provider} to find stock clips`);
  buildVoice(dir, tl.segments, src.hasAudio, tl.duration, style);
  const mixInfo = buildMix(dir, plan, style, tl.duration);
  plan.gate = hookGate(plan, style, layoutFor(formats[0], src));
  plan.mix = mixInfo;
  // The plan is the single source of truth and is on disk before any render starts.
  const savePlan = () => writeFileSync(join(dir, 'assets/plan.json'), JSON.stringify({ ...plan, style }, null, 2));
  savePlan();
  const outputs = [], renders = [];
  for (const fmt of formats) {
    const lay = layoutFor(fmt, src);
    plan.broll = prepareBroll(dir, broll, lay);
    const file = fmt === formats[0] ? 'index.html' : 'compositions/horizontal.html';
    if (fmt === formats[0]) buildFootage(dir, tl.segments, lay, style.grade);
    else {
      // The second format needs its own footage framing. Keep it beside the first.
      const first = join(dir, 'assets/footage.mp4'), keep = join(dir, 'assets/footage-primary.mp4');
      copyFileSync(first, keep);
      buildFootage(dir, tl.segments, lay, style.grade);
      copyFileSync(join(dir, 'assets/footage.mp4'), join(dir, 'assets/footage-horizontal.mp4'));
      copyFileSync(keep, first);
    }
    let html = composition(plan, lay, style, fmt);
    if (fmt !== formats[0]) html = html.replace('src="assets/footage.mp4"', 'src="assets/footage-horizontal.mp4"').replace(/src="assets\//g, 'src="../assets/');
    // A hand-edited composition is never overwritten: the generated one goes beside it.
    const target = join(dir, file), hashes = existsSync(join(dir, 'assets/generated.json')) ? JSON.parse(readFileSync(join(dir, 'assets/generated.json'), 'utf8')) : {};
    const handEdited = existsSync(target) && hashes[file] && sha(readFileSync(target, 'utf8')) !== hashes[file];
    if (handEdited) {
      writeFileSync(target.replace(/\.html$/, '.generated.html'), html);
      plan.handEdited = (plan.handEdited || []).concat(file);
      log(`${file} was edited by hand and is kept; the new generated version is ${file.replace(/\.html$/, '.generated.html')}`);
    } else { writeFileSync(target, html); hashes[file] = sha(html); writeFileSync(join(dir, 'assets/generated.json'), JSON.stringify(hashes)); }
    if (fmt === formats[0]) writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: 'reel', name: edit.slug, width: lay.w, height: lay.h, fps: FPS }, null, 2) + '\n');
    if (!doRender) continue;
    plan.memory = memoryCheck();
    if (useBrowser && lowMemoryMachine()) log('browser renderer on an 8 GB machine: one worker, minutes per draft, and Chrome must be closed. Use it only for motion-graphics specials.');
    const suffix = fmt === 'horizontal' && formats.length > 1 ? '-horizontal' : '';
    const name = finalName ? `${edit.slug}${suffix}-final.mp4` : `${edit.slug}${suffix}-v${nextVersion(edit.slug, suffix)}.mp4`;
    const out = `renders/${parse(name).name}.mp4`;
    let rendered;
    if (useBrowser) {
      rendered = render(dir, file === 'index.html' ? null : file, out, quality);
      renders.push({ engine: 'browser', seconds: null });
    } else {
      const footage = fmt === formats[0] ? 'assets/footage.mp4' : 'assets/footage-horizontal.mp4';
      if (footage !== 'assets/footage.mp4') copyFileSync(join(dir, footage), join(dir, 'assets/footage.mp4'));
      const r = renderFast({ dir, plan, lay, style, out, quality, ff, fontsDir, hasAmf: hasAmf(), lowMemory: lowMemoryMachine() });
      rendered = r.out;
      renders.push({ engine: `ffmpeg (${r.encoder})`, seconds: r.seconds });
      log(`rendered ${out} in ${r.seconds}s with ${r.encoder}`);
    }
    copyFileSync(rendered, join(outbox, name));
    outputs.push(join(outbox, name));
    const mirrored = mirror(join(outbox, name), style);
    if (mirrored) log(`copied to ${mirrored}`);
    if (fmt === formats[0]) { try { plan.review = reviewSheets(dir, rendered, plan, ff); } catch (e) { log(`review sheets skipped: ${e.message.split('\n')[0]}`); } }
  }
  plan.renders = renders;
  savePlan();
  cleanup(dir);
  return { plan, style, outputs, mixInfo, broll, renders };
}

function notes(dir, edit, result, suggestions) {
  const { plan, style, outputs } = result;
  const src = edit.source;
  const removed = src.duration - plan.duration;
  const lines = [
    `# ${edit.slug}`, '',
    `Draft${outputs.length ? ': ' + outputs.map((o) => basename(o)).join(', ') : ' (not rendered)'}`,
    `Project: fable/video-projects/${edit.slug} (edit.json holds every decision; rebuild with \`node fable.mjs rebuild ${edit.slug}\`)`, '',
    '## What Fable did', '',
    `- Cut ${src.duration.toFixed(1)} s down to ${plan.duration.toFixed(1)} s (removed ${removed.toFixed(1)} s${(edit.removed || edit.deletes || []).some((d) => /stutter/.test(d.reason)) ? ' of dead air and stutters' : ' of dead air'}${(edit.removed || edit.deletes || []).some((d) => /retake/.test(d.reason)) ? ', plus retakes' : ''}) in ${plan.segments.length} pieces, cutting only where the audio is quiet.`,
    `- Captions: ${style.captions}${style.captions !== 'none' ? `, ${style.position} third, ${style.color}${style.captions !== 'subtitles' ? ` with ${style.accent} accents` : ''}` : ''}. ${plan.words.length} of ${edit.transcription?.words ?? plan.words.length} transcript words kept${edit.transcription?.voicedSeconds ? `; ${(edit.transcription.words / edit.transcription.voicedSeconds).toFixed(1)} words per voiced second` : ''}${plan.dropped?.length ? `; ${plan.dropped.length} fell inside cuts` : ''}.`,
    edit.script ? `- Script "${edit.script.file}": ${edit.script.matched} of ${edit.script.script} words matched; ${edit.script.changed} shown as written, ${edit.script.inserted} inserted where the model missed them, ${edit.script.dropped} transcript words not in the script left uncaptioned (the footage is untouched; cut it with segments if it should go).` : null,
    edit.transcription?.missed?.length ? `- LOW COVERAGE: voice with no transcript words at ${edit.transcription.missed.map((m) => `${fmt(m.start)}-${fmt(m.end)}`).join(', ')} (source time). Kept uncut. Listen there and add words with "extra" if needed.` : null,
    plan.hook ? `- Hook card for the first ${plan.hook.end} s: "${plan.hook.lines.join(' / ')}" (${plan.hook.pattern || 'custom'}: ${plan.hook.why || 'set by hand'}). Captions keep running under it.` : '- No hook text (per your style).',
    `- Format ${style.format}, color ${style.grade}${result.renders?.[0]?.engine?.startsWith('browser') ? ', slow push-in on every shot' : ''}.`,
    plan.tag ? `- Tag "${plan.tag}" on every frame, top right (house rule for AI-made footage).` : null,
    result.renders?.length ? `- Rendered with ${result.renders.map((r) => r.engine + (r.seconds ? ` in ${r.seconds} s` : '')).join(' and ')}.` : null,
    plan.memory?.hogs?.length ? `- Memory was tight (${plan.memory.free} GB free): ${plan.memory.hogs.slice(0, 3).join(', ')}. Fable used the light encoder path.` : null,
    `- Privacy: ${plan.network?.length ? plan.network.join('; ') + '. Everything else stayed on this computer.' : 'nothing left this computer.'}${style.privacy === 'local' ? ' (local-only mode)' : ''}`,
    plan.handEdited?.length ? `- ${plan.handEdited.join(', ')} was edited by hand and was kept; the freshly generated version sits beside it as *.generated.html. Render the hand-edited one with npx hyperframes render.` : null,
    `- Sound: ${style.sound === 'voice' ? 'voice only' : `${result.mixInfo.cues.length} soft effects`}${result.mixInfo.music ? `, music bed "${result.mixInfo.music}" ducked under the voice` : ''}, mastered to -14 LUFS.`,
    result.broll.length
      ? `- B-roll: ${result.broll.length} free stock clip${result.broll.length > 1 ? 's' : ''} on the words ${result.broll.map((b) => `"${b.query}" (${fmt(b.at)}, ${b.provider}, ${b.author || 'unknown'})`).join(', ')}. Sources in assets/broll/ledger.json. Your own clips in inbox/ beat stock: tell your agent which ones.`
      : brollProvider() ? '- B-roll: none found or turned off.' : '- B-roll: off. Put a free Pexels or Pixabay key in .env to add stock clips on the key words.',
    '',
  ].filter((l) => l !== null);
  if (plan.hookCandidates?.length > 1 || plan.gate?.length) {
    lines.push('## The opening', '');
    if (plan.hookCandidates?.length) {
      lines.push('Three ways in, all from your own words. Fable used the first; set `"hook": 1` or `2` in edit.json to switch, or write your own `{"lines": [...], "end": 2.4}`.', '');
      plan.hookCandidates.forEach((c, i) => lines.push(`${i}. "${c.lines.join(' / ')}" (${c.pattern}: ${c.why}; spoken at ${fmt(c.from)}, pays off by ${fmt(c.payoff)})`));
      lines.push('');
    }
    if (plan.gate?.length) {
      lines.push('Opening checks:', '');
      for (const g of plan.gate) lines.push(`- ${g.pass ? 'ok' : 'LOOK'}: ${g.check} (${g.value})`);
      if (plan.review) lines.push('', `Muted check: open ${plan.review.open.replace(/\\/g, '/')} (first 2.5 s, 9 frames) and ask: do I know what this is about, with the sound off? Shots: ${plan.review.shots.replace(/\\/g, '/')}.`);
      lines.push('');
    }
  }
  if (suggestions.length) {
    lines.push('## Left in, for you to decide', '');
    for (const s of suggestions) lines.push(`- ${fmt(s.start)}-${fmt(s.end)} (source time), ${s.kind}: ${s.reason}. ${s.why[0].toUpperCase()}${s.why.slice(1)}.`);
    lines.push('');
  }
  lines.push('## Give notes', '', 'Say what to change in plain words ("faster", "captions lower", "cut the part about X", "approved").',
    'Your agent edits edit.json (segments are source-time in/out points; fixes change or drop a word by its number; hook and style override my-style.md) and rebuilds.', '');
  const p = join(outbox, `${edit.slug}-notes.md`);
  if (style.copyTo) lines.splice(lines.indexOf('## Give notes'), 0, `Copies of the drafts and these notes go to ${style.copyTo}.`, '');
  writeFileSync(p, lines.join('\n'));
  mirror(p, style);
  return p;
}
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;

async function edit(video) {
  const source = resolve(video);
  if (!existsSync(source)) die(`not found: ${source}`);
  const slug = opt.slug || slugify(basename(source));
  log(`editing ${basename(source)} as ${slug}`);
  const info = probe(source);
  const style = readStyle({ vertical: info.height > info.width, duration: info.duration });
  const lay = layoutFor(style.format === 'both' ? 'vertical' : style.format, info);
  const dir = newProject(slug, lay);
  // One normalized copy to cut from: constant 30 fps, rotation baked in, at most 1920 on the long side.
  const long = Math.max(info.width, info.height), k = Math.min(1, 1920 / long);
  const tw = Math.round(info.width * k / 2) * 2, th = Math.round(info.height * k / 2) * 2;
  const audioArgs = info.hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'] : ['-an'];
  log(`normalizing to ${tw}x${th} @ ${FPS} fps`);
  ff(['-i', source, '-map', '0:v:0', ...audioArgs, '-vf', `scale=${tw}:${th}:flags=lanczos`, '-r', String(FPS), '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'assets/raw.mp4')]);
  const norm = probe(join(dir, 'assets/raw.mp4'));
  // A file that is still copying, or stopped copying, has a full header and a short body.
  if (info.duration - norm.duration > 1.0) {
    rmSync(dir, { recursive: true, force: true });
    die(`${basename(source)} is incomplete: its header says ${info.duration.toFixed(1)} s but only ${norm.duration.toFixed(1)} s can be read. The copy into inbox/ was cut short. Copy the file again (wait for the transfer to finish) and try once more.`);
  }
  // A small proxy for anything that only needs to look: frame checks, contact sheets, agents.
  const pk = 960 / Math.max(norm.width, norm.height);
  ff(['-i', join(dir, 'assets/raw.mp4'), '-vf', `scale=${Math.round(norm.width * pk / 2) * 2}:${Math.round(norm.height * pk / 2) * 2}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-an', '-movflags', '+faststart', join(dir, 'assets/proxy.mp4')]);
  // Where the face is, at 2 fps, so text stays off it. Optional: needs OpenCV (pip install opencv-python-headless).
  try {
    const face = JSON.parse(run('python', [join(root, 'tools/track_face.py'), join(dir, 'assets/proxy.mp4'), join(dir, 'assets/face.json')]));
    log(`face: found in ${face.detections}/${face.sampled} samples in ${face.seconds}s${face.summary ? `, top at ${Math.round(face.summary.face_top_p10 * 100)}% of the height` : ''}`);
  } catch (e) { log(`face tracking skipped (${/No module named .cv2./.test(e.message) ? 'pip install opencv-python-headless to enable it' : e.message.split('\n').pop()})`); }
  let transcript = { words: [], audio_duration_secs: norm.duration };
  const names = knownNames();
  let provider = null;
  if (info.hasAudio) { log(`transcribing (${style.privacy === 'local' ? 'local only' : 'free'})`); ({ transcript, provider } = transcribe(dir, style, names)); }
  else writeFileSync(join(dir, 'assets/raw.json'), JSON.stringify(transcript));
  if (!existsSync(join(dir, 'assets/raw.json'))) writeFileSync(join(dir, 'assets/raw.json'), JSON.stringify(transcript));
  // Speech models sometimes emit a word out of time order; everything downstream assumes time order.
  const words = (transcript.words || []).filter((w) => w.text && w.end >= w.start).sort((a, b) => a.start - b.start);
  for (let i = 1; i < words.length; i++) if (words[i].start < words[i - 1].end) { const mid = r3((words[i].start + words[i - 1].end) / 2); words[i - 1].end = Math.max(words[i - 1].start + 0.05, mid); words[i].start = Math.max(words[i].start, words[i - 1].end); words[i].end = Math.max(words[i].end, words[i].start + 0.05); }
  // A script beside the video (same name .txt/.md, or --script) is the truth for the words.
  const scriptPath = opt.script || ['.txt', '.md', '.script.txt'].map((e) => source.replace(/\.[^.]+$/, e)).find((p) => existsSync(p)) || null;
  let scriptInfo = null, scriptText = null;
  if (scriptPath && words.length) {
    scriptText = readFileSync(scriptPath, 'utf8');
    const a = alignScript(words, scriptText);
    scriptInfo = { file: basename(scriptPath), ...a.stats };
    log(`script: ${a.stats.matched}/${a.stats.script} words matched, ${a.stats.changed} spelled as written, ${a.stats.inserted} inserted, ${a.stats.dropped} dropped`);
    var scriptFixes = a.fixes, scriptExtra = a.extra;
  }
  const renamed = applyNames(words, names);
  if (renamed) { log(`${renamed} word${renamed > 1 ? 's' : ''} snapped to a known name`); writeFileSync(join(dir, 'assets/raw.json'), JSON.stringify({ ...transcript, words }, null, 2)); }
  // Cuts need two opinions: the transcript (where words are) and the audio (where it is really quiet).
  const { silences, noise } = info.hasAudio ? detectSilenceAdaptive(join(dir, 'assets/raw.mp4'), words, style.pace === 'tight' ? 0.42 : 0.8) : { silences: [{ start: 0, end: norm.duration }], noise: null };
  if (noise !== null) log(`silence floor ${noise} dB: ${silences.length} quiet stretches`);
  const cuts = planCuts(words, norm.duration, style, silences, names);
  const missed = info.hasAudio ? untranscribed(words, silences, norm.duration) : [];
  if (missed.length) log(`voice without words at ${missed.map((m) => `${m.start}-${m.end}s`).join(', ')}: kept, check the transcript there`);
  const editDoc = {
    version: 1, slug, created: new Date().toISOString(),
    source: { file: source, duration: norm.duration, width: norm.width, height: norm.height, hasAudio: info.hasAudio },
    transcription: { provider, words: words.length, voicedSeconds: r3(norm.duration - silences.reduce((a, s) => a + (Math.min(s.end, norm.duration) - s.start), 0)), missed },
    style: {}, segments: cuts.keeps.map((k) => ({ src0: r3(k.src0), src1: r3(k.src1) })),
    removed: cuts.deletes.map((d) => ({ start: r3(d.start), end: r3(d.end), reason: d.reason })),
    suggestions: cuts.suggestions.map((s) => ({ ...s, start: r3(s.start), end: r3(s.end) })),
    fixes: scriptFixes || {}, extra: scriptExtra || [],
    script: scriptInfo,
    _help: 'EDIT THESE: segments (kept source ranges in order, seconds; the only thing that decides the cut), fixes {"<word index in raw.json>": "new text" or ""}, extra [{"text":"Amen.","start":s,"end":s}] in source time for words the transcript missed, hook (a candidate number from the notes, {"lines":[..],"end":seconds}, or null), style (overrides: format/captions/position/color/accent/hook/pace/grade/sound/broll/retakes/stutters/privacy/engine fast|browser), broll (delete one to drop it, [] for none, remove the key to search again). READ ONLY: source, transcription, removed, suggestions (what Fable did and saw; editing them changes nothing). assets/plan.json is the computed result.',
  };
  writeFileSync(join(dir, 'edit.json'), JSON.stringify(editDoc, null, 2));
  const result = await build(dir, editDoc, { quality: opt.quality, render: !opt['no-render'] });
  editDoc.broll = result.broll;
  writeFileSync(join(dir, 'edit.json'), JSON.stringify(editDoc, null, 2));
  const notesPath = notes(dir, editDoc, result, cuts.suggestions);
  for (const o of result.outputs) log(`draft: ${o}`);
  log(`notes: ${notesPath}`);
  return { slug, outputs: result.outputs };
}

// edit.json is hand-edited, so it is checked before it is trusted. Problems stop the build with a
// plain message; things that are merely ignored get a warning.
const KNOWN_KEYS = new Set(['version', 'slug', 'created', 'source', 'transcription', 'script', 'style', 'segments', 'removed', 'deletes', 'suggestions', 'fixes', 'extra', 'hook', 'broll', 'tag', '_help']);
function validateEdit(doc) {
  const d = doc.source?.duration;
  if (!Array.isArray(doc.segments) || !doc.segments.length) die('edit.json: segments must be a non-empty list of {src0, src1}');
  doc.segments.forEach((s, i) => {
    if (!(Number.isFinite(s.src0) && Number.isFinite(s.src1) && s.src1 > s.src0)) die(`edit.json: segment ${i} needs numeric src0 < src1 (seconds)`);
    if (d && (s.src0 < 0 || s.src1 > d + 0.05)) die(`edit.json: segment ${i} (${s.src0}-${s.src1}) is outside the source (0-${d})`);
    if (i && s.src0 < doc.segments[i - 1].src1 - 0.001) die(`edit.json: segments ${i - 1} and ${i} overlap or are out of order`);
  });
  for (const k of Object.keys(doc)) if (!KNOWN_KEYS.has(k)) log(`edit.json: "${k}" is not something Fable reads`);
  if (doc.deletes) log('edit.json: "deletes" is a record of what Fable removed, not an instruction; edit "segments" to change the cut');
  if (doc.hook && typeof doc.hook === 'object' && !Array.isArray(doc.hook.lines)) die('edit.json: hook must be a candidate number, null, or {"lines": [...], "end": seconds}');
}
function loadEdit(slug) {
  const dir = join(projects, slug);
  const p = join(dir, 'edit.json');
  if (!existsSync(p)) die(`no edit.json in ${dir}. Projects: ${readdirSync(projects).filter((d) => existsSync(join(projects, d, 'edit.json'))).join(', ') || 'none'}`);
  return { dir, edit: JSON.parse(readFileSync(p, 'utf8')) };
}
async function rebuild(slug, finalRender = false) {
  const { dir, edit: doc } = loadEdit(slug);
  const before = existsSync(join(dir, 'assets/plan.json')) ? JSON.parse(readFileSync(join(dir, 'assets/plan.json'), 'utf8')) : null;
  const result = await build(dir, doc, { quality: finalRender ? (opt.quality === 'draft' ? 'standard' : opt.quality) : opt.quality, render: !opt['no-render'], finalName: finalRender });
  // A rebuild that changed nothing should look like one.
  if (before) {
    const p = result.plan, same = before.duration === p.duration && before.segments.length === p.segments.length && before.words.length === p.words.length && JSON.stringify(before.hook) === JSON.stringify(p.hook) && JSON.stringify(before.captions) === JSON.stringify(p.captions);
    log(same ? 'rebuild: nothing changed in the cut, captions, or hook (edit segments, fixes, extra, hook, or style to change the video)'
      : `rebuild: pieces ${before.segments.length} -> ${p.segments.length}, duration ${before.duration}s -> ${p.duration}s, words ${before.words.length} -> ${p.words.length}, hook end ${before.hook?.end ?? '-'} -> ${p.hook?.end ?? '-'}`);
  }
  doc.broll = result.broll;
  writeFileSync(join(dir, 'edit.json'), JSON.stringify(doc, null, 2));
  notes(dir, doc, result, doc.suggestions || []);
  for (const o of result.outputs) log(`${finalRender ? 'final' : 'draft'}: ${o}`);
}

// ---------- watch: the 24/7 part ----------
// ---------- stitch: finished clips joined as they are ----------
function frameRate(video) {
  const [n, d] = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', video]).trim().split('/').map(Number);
  const fps = d ? n / d : n;
  return fps > 0 && fps <= 60 ? Math.round(fps * 1000) / 1000 : FPS;
}
function stitch(folder) {
  const src = resolve(folder);
  if (!existsSync(src) || !statSync(src).isDirectory()) die(`not a folder: ${folder}`);
  const names = readdirSync(src);
  const clips = names.filter((n) => VIDEO_EXT.has(extname(n).toLowerCase()) && !isOutput(n))
    .map((name) => ({ name, path: join(src, name), ...probe(join(src, name)) }));
  if (!clips.length) die(`no videos in ${folder}`);
  const text = (n) => readFileSync(join(src, n), 'utf8');
  const briefFile = names.find((n) => /\.(txt|md)$/i.test(n) && /brief/i.test(n))
    || names.find((n) => /\.(txt|md)$/i.test(n) && /caption|^\s*\d+[).]\s*\d/im.test(text(n)));
  const brief = briefFile ? parseBrief(text(briefFile)) : { clips: [], caption: null, ai: false };
  const { order, by, skipped } = orderClips(clips, brief.clips);
  const caption = opt.caption ?? brief.caption;
  // House rule: AI-made footage carries a tag on every frame.
  const tag = opt.tag || (brief.ai || clips.some((c) => /higgsfield|kling|veo|sora|ai[-_ ]generated/i.test(c.name)) ? 'AI-generated' : null);
  const style = readStyle();

  const slug = opt.slug || parse(src).name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'stitch';
  const dir = join(projects, slug);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  const { w: W, h: H } = stitchFrame(order[0].width, order[0].height);
  const fps = frameRate(order[0].path);
  copyFileSync(join(fontsDir, 'Montserrat-ExtraBold.ttf'), join(dir, 'assets/caption.ttf'));
  const lines = caption ? wrapCaption(caption) : [];
  writeFileSync(join(dir, 'assets/caption.txt'), lines.join('\n'));
  if (tag) writeFileSync(join(dir, 'assets/tag.txt'), tag);

  const inputs = [], chain = [], pairs = [];
  order.forEach((c, i) => {
    inputs.push('-i', c.path);
    chain.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps}[v${i}]`);
    if (c.hasAudio) chain.push(`[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    else chain.push(`anullsrc=r=48000:cl=stereo,atrim=0:${r3(c.duration)},aformat=sample_fmts=fltp[a${i}]`);
    pairs.push(`[v${i}][a${i}]`);
  });
  chain.push(`${pairs.join('')}concat=n=${order.length}:v=1:a=1[cat][a]`);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const size = Math.round(Math.min(W * 0.068, (W * 0.88) / (longest * 0.64)));
  const draw = [];
  // Centered near 60% height: lower-middle, clear of the face and of the bottom 15% (app buttons).
  if (lines.length) draw.push(`drawtext=fontfile=assets/caption.ttf:textfile=assets/caption.txt:fontsize=${size}:fontcolor=white:line_spacing=${Math.round(size * 0.22)}:text_align=C:x=(w-text_w)/2:y=min(h*0.60-text_h/2\\,h*0.85-text_h):borderw=${Math.max(2, Math.round(size / 16))}:bordercolor=black@0.85:shadowx=2:shadowy=3:shadowcolor=black@0.5`);
  if (tag) draw.push(`drawtext=fontfile=assets/caption.ttf:textfile=assets/tag.txt:fontsize=${Math.round(W * 0.03)}:fontcolor=white@0.85:x=w-text_w-${Math.round(W * 0.04)}:y=h*0.13:borderw=2:bordercolor=black@0.6`);
  chain.push(`[cat]${draw.length ? draw.join(',') : 'null'},format=yuv420p[v]`);

  const final = !!opt.final;
  const out = join(outbox, final ? `${slug}-final.mp4` : `${slug}-v${nextVersion(slug, '')}.mp4`);
  const crf = final ? (opt.quality === 'high' ? 16 : 18) : ({ standard: 18, high: 16 }[opt.quality] ?? 20);
  memoryCheck();
  log(`stitching ${order.length} clips (${by} order) into ${basename(out)}`);
  ff([...inputs, '-filter_complex', chain.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', final ? 'medium' : 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], dir);
  const total = probe(out).duration;
  // One frame from the middle of each clip, side by side: checks order and caption placement.
  let t = 0;
  const picks = order.map((c) => { const at = t + c.duration / 2; t += c.duration; return Math.round(at * fps); });
  try { ff(['-i', out, '-vf', `select='${picks.map((n) => `eq(n\\,${n})`).join('+')}',scale=360:-2,tile=${order.length}x1`, '-frames:v', '1', '-update', '1', 'assets/review-shots.png'], dir); } catch {}

  const notesPath = join(outbox, `${slug}-notes.md`);
  writeFileSync(join(dir, 'stitch.json'), JSON.stringify({ slug, source: src, brief: briefFile || null, order: order.map((c) => c.name), by, caption: caption || null, tag, frame: `${W}x${H}`, fps, duration: r3(total) }, null, 2) + '\n');
  writeFileSync(notesPath, [
    `# ${slug}`, '',
    `${final ? 'Final' : 'Draft'}: ${basename(out)} (${W}x${H}, ${r3(total)} s, H.264/AAC)`,
    `Source: ${src}${briefFile ? `, brief ${briefFile}` : ''}`, '',
    '## What Fable did', '',
    `- Joined ${order.length} clips with hard cuts, in ${by} order:`,
    ...order.map((c, i) => `  ${i + 1}. ${c.name} (${c.duration.toFixed(1)} s${c.hasAudio ? '' : ', no audio: silence'})`),
    skipped.length ? `- Left out (not in the brief): ${skipped.map((c) => c.name).join(', ')}.` : null,
    '- Each clip keeps its own audio. No music, no sound effects, no speed changes, no pause cuts.',
    caption ? `- Caption on the whole video: "${lines.join(' / ')}", white bold, black outline, centered near 60% height, clear of the bottom 15%.` : '- No caption (none in a brief; add one with --caption "...").',
    tag ? `- House rule: "${tag}" tag top right on every frame.` : '- No AI tag (nothing says the clips are AI-made; add --tag AI-generated if they are).',
    '- Nothing left the computer: no transcription, no uploads.', '',
    '## Check', '',
    `- fable/video-projects/${slug}/assets/review-shots.png: one frame per clip, for order and caption placement.`,
    briefFile && /upload|save (it )?back|drive folder/i.test(text(briefFile)) ? '- The brief asks for the video to be saved back to its folder. Fable never uploads on its own; your agent copies it there when you say so.' : null,
    final ? null : `- Approved? \`node fable.mjs stitch "${folder}" --final\` writes ${slug}-final.mp4. Change the caption with --caption "...".`,
  ].filter((l) => l !== null).join('\n') + '\n');
  for (const f of [out, notesPath]) { const m = mirror(f, style); if (m) log(`copied to ${m}`); }
  log(`done: ${out}`);
  return { slug, out, notes: notesPath, order, caption, tag };
}

function watch() {
  mkdirSync(inbox, { recursive: true });
  const stateDir = join(root, '.fable'), statePath = join(stateDir, 'watch.json');
  mkdirSync(stateDir, { recursive: true });
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { done: {} };
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
  const every = Math.max(2, Number(opt.every) || 5) * 1000;
  const seen = new Map();
  log(`watching ${inbox} every ${every / 1000}s. Drop a video in; drafts land in outbox/. Ctrl+C to stop.`);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await scan(); } finally { busy = false; }
  };
  const scan = async () => {
    for (const name of readdirSync(inbox)) {
      if (!VIDEO_EXT.has(extname(name).toLowerCase())) continue;
      const p = join(inbox, name), st = statSync(p);
      const key = `${name}|${st.size}|${Math.round(st.mtimeMs)}`;
      if (state.done[key]) continue;
      const prev = seen.get(name);
      seen.set(name, { size: st.size, mtime: st.mtimeMs, at: Date.now() });
      // Wait until the file stops growing (copies and phone syncs arrive in pieces).
      if (!prev || prev.size !== st.size || prev.mtime !== st.mtimeMs || Date.now() - prev.at < every) continue;
      log(`new video: ${name}`);
      try {
        const { slug, outputs } = await edit(p);
        state.done[key] = { slug, outputs, at: new Date().toISOString() };
      } catch (e) {
        state.done[key] = { error: e.message, at: new Date().toISOString() };
        writeFileSync(join(outbox, `${parse(name).name}-error.md`), `# Fable could not edit ${name}\n\n${e.message}\n\nFix the cause and drop the file in again (or touch it) to retry.\n`);
        console.error(`[fable] ${name}: ${e.message}`);
      }
      save();
    }
  };
  tick();
  if (opt.once) return;
  setInterval(tick, every);
}

function status() {
  const list = existsSync(projects) ? readdirSync(projects).filter((d) => existsSync(join(projects, d, 'edit.json'))) : [];
  if (!list.length) return log('no Fable projects yet. Try: node fable.mjs edit inbox/<video>');
  for (const slug of list) {
    const e = JSON.parse(readFileSync(join(projects, slug, 'edit.json'), 'utf8'));
    const outs = existsSync(outbox) ? readdirSync(outbox).filter((f) => f.startsWith(slug) && f.endsWith('.mp4')) : [];
    console.log(`${slug}: ${e.source.duration.toFixed(1)}s source, ${e.segments.length} pieces, ${e.suggestions?.length || 0} suggestions, outbox: ${outs.join(', ') || 'none'}`);
  }
}

export { planCuts, timeline, buildCaptions, hookCandidates, chooseHook, hookGate, insideSilence, untranscribed, layoutFor, readStyle, ruleApplies };

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  switch (command) {
    case 'edit': if (!target) die('usage: node fable.mjs edit <video>'); await edit(target); break;
    case 'rebuild': if (!target) die('usage: node fable.mjs rebuild <slug>'); await rebuild(target); break;
    case 'final': if (!target) die('usage: node fable.mjs final <slug>'); await rebuild(target, true); break;
    case 'stitch': if (!target) die('usage: node fable.mjs stitch <folder>'); stitch(target); break;
    case 'watch': watch(); break;
    case 'status': status(); break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(command ? 1 : 0);
  }
}
