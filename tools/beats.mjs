// Fable beats: where the beat is in a piece of music, so cuts and captions can land on it.
// No library and no upload: FFmpeg decodes the sound, and the rest is arithmetic here.
//
//   detectBeats(file)        { bpm, period, first, beats: [seconds...], confidence, duration }
//   beatGrid(envelope, fps)  the pure part: tempo and phase from an onset envelope
//   snapToBeat(t, grid, tol) the nearest beat when one is within tol seconds, else t
//   snapPieces(ranges, grid) kept source ranges, each starting and ending on a beat
//
// How: the sound's energy is measured 86 times a second, in the bass (the kick) and overall. A
// beat is where energy jumps, so the jumps are kept (the onset envelope). The tempo is the spacing
// at which those jumps best line up with themselves; the phase is where a comb of that spacing
// catches the most of them. One steady tempo is assumed, which holds for produced music and for
// the half minute a short video uses.
import { spawnSync } from 'node:child_process';

const RATE = 11025, HOP = 128, WIN = 256;
export const ENV_FPS = RATE / HOP;
const r3 = (n) => Math.round(n * 1000) / 1000;

// Mono 16-bit samples -> onset envelope (one value per hop).
export function onsetEnvelope(samples) {
  const n = Math.max(0, Math.floor((samples.length - WIN) / HOP));
  const full = new Float64Array(n), low = new Float64Array(n);
  // One-pole low-pass near 150 Hz picks out the kick and the bass.
  const a = 1 - Math.exp(-2 * Math.PI * 150 / RATE);
  const bass = new Float64Array(samples.length);
  let y = 0;
  for (let i = 0; i < samples.length; i++) { y += a * (samples[i] - y); bass[i] = y; }
  for (let f = 0; f < n; f++) {
    let e = 0, b = 0;
    for (let i = f * HOP, end = i + WIN; i < end; i++) { e += samples[i] * samples[i]; b += bass[i] * bass[i]; }
    full[f] = Math.log1p(e / WIN / 2e4); low[f] = Math.log1p(b / WIN / 2e4);
  }
  const env = new Float64Array(n);
  for (let f = 1; f < n; f++) env[f] = Math.max(0, low[f] - low[f - 1]) + 0.5 * Math.max(0, full[f] - full[f - 1]);
  // Keep what stands out from the half second around it.
  const half = Math.round(ENV_FPS / 4), out = new Float64Array(n);
  let sum = 0;
  for (let f = 0; f < Math.min(n, half); f++) sum += env[f];
  for (let f = 0; f < n; f++) {
    if (f + half < n) sum += env[f + half];
    if (f - half - 1 >= 0) sum -= env[f - half - 1];
    const count = Math.min(n - 1, f + half) - Math.max(0, f - half) + 1;
    out[f] = Math.max(0, env[f] - sum / count);
  }
  return out;
}

// Tempo and phase from an onset envelope sampled at fps. Returns null when there is no beat to find.
export function beatGrid(env, fps = ENV_FPS) {
  const n = env.length;
  if (n < fps * 3) return null;
  let total = 0;
  for (const v of env) total += v;
  if (total <= 0) return null;
  // Tempo: the lag at which the envelope best matches itself, between 60 and 200 beats a minute,
  // leaning toward the middle so half and double tempo lose to the one a person would tap.
  const lagMin = Math.floor(fps * 60 / 200), lagMax = Math.ceil(fps * 60 / 60);
  let best = { lag: 0, score: -1 };
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
    const bpm = 60 * fps / lag, prior = Math.exp(-0.5 * (Math.log2(bpm / 118) / 0.7) ** 2);
    const score = (s / (n - lag)) * prior;
    if (score > best.score) best = { lag, score };
  }
  // Refine: the exact period and the phase where a comb of beats catches the most onsets.
  const at = (x) => { const i = Math.floor(x); return i < 0 || i + 1 >= n ? 0 : env[i] + (env[i + 1] - env[i]) * (x - i); };
  let fit = { period: best.lag, phase: 0, score: -1 };
  for (let period = best.lag - 1; period <= best.lag + 1; period += 0.01) {
    for (let phase = 0; phase < period; phase += 0.5) {
      let s = 0, k = 0;
      for (let x = phase; x < n - 1; x += period) { s += at(x) + 0.5 * (at(x - 1) + at(x + 1)); k++; }
      if (k && s / k > fit.score) fit = { period, phase, score: s / k };
    }
  }
  const period = fit.period / fps, first = (fit.phase + WIN / HOP / 2) / fps, duration = n / fps;
  const beats = [];
  for (let t = first % period; t < duration; t += period) beats.push(r3(t));
  // How much more happens on the beat than on average: 1 is no beat at all, 3 and up is clear.
  const confidence = fit.score / 2 / (total / n);
  // period and first keep five decimals: a rounded period drifts off the beat over a whole song.
  const r5 = (x) => Math.round(x * 1e5) / 1e5;
  return { bpm: Math.round(600 / period) / 10, period: r5(period), first: r5(first % period), beats, confidence: Math.round(confidence * 10) / 10, duration: r3(duration) };
}

// Any sound or video file. Throws with a plain message when FFmpeg cannot read it.
export function detectBeats(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { maxBuffer: 1 << 28, windowsHide: true });
  if (r.status !== 0 || !r.stdout?.length) throw new Error(`could not read the sound of ${file}: ${String(r.stderr || '').trim().split('\n').pop() || 'no audio'}`);
  const samples = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 2));
  const grid = beatGrid(onsetEnvelope(samples));
  if (!grid) throw new Error(`no beat found in ${file} (too short or silent)`);
  return grid;
}

// A grid from a number: "116" or "116 bpm" means beats from 0 at that tempo.
export function gridFromBpm(bpm, duration) {
  const period = 60 / bpm, beats = [];
  for (let t = 0; t < duration + period; t += period) beats.push(r3(t));
  return { bpm, period, first: 0, beats, confidence: null, duration };
}

const nearest = (t, grid) => { const k = Math.round((t - grid.first) / grid.period); return grid.first + k * grid.period; };
export function snapToBeat(t, grid, tol = 0.2) {
  const b = nearest(t, grid);
  return Math.abs(b - t) <= tol ? r3(Math.max(0, b)) : t;
}

// Kept source ranges, each moved to start and end on a beat (at least one beat long), with where
// each lands on the joined timeline. Every piece then lasts a whole number of beats, so when the
// song runs on underneath, every cut and every move inside a piece stays on the beat.
export function snapPieces(ranges, grid, duration = Infinity) {
  let out = 0;
  return ranges.map((r) => {
    let a = r.start, b = r.end;
    if (grid) {
      a = Math.max(0, nearest(r.start, grid));
      b = nearest(r.end, grid);
      if (b - a < grid.period * 0.9) b = a + grid.period;
      while (b > duration + 0.02) b -= grid.period;
      if (b - a < grid.period * 0.9) { a = Math.max(0, a - grid.period); }
    }
    const piece = { src0: r3(a), src1: r3(b), out0: r3(out), out1: r3(out + (b - a)), beats: grid ? Math.round((b - a) / grid.period) : null };
    out += b - a;
    return piece;
  });
}
