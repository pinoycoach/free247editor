// Fable voice care: make a recorded voice easier to listen to without changing who is speaking.
// It measures the recording first and applies only what the numbers call for, so a clean studio
// take is left almost alone and a phone live in a noisy room gets real help. All local, FFmpeg only.
//
//   measureVoice(file)  { noise, speech, sub, lowmid, presence, air, peak } in dB
//   voiceChain(m)       { filter, did } the FFmpeg audio filters and, in plain words, what they do
//
// What is listened for:
//   rumble     energy under 90 Hz (traffic, a hand on the phone, the mic too close): cut harder
//   room noise the level between words (fan, hiss, street): reduced, never gated to silence,
//              because a voice that drops into dead quiet between words sounds worse than hiss
//   mud        too much 100-300 Hz against 1-3 kHz (a phone held close): a small cut low, a small
//              lift where consonants live, so words are easier to make out
//   level      soft phrases come up, loud ones stay put. The leveller is told where the room
//              noise sits, so it lifts quiet speech and not the pauses: lifting everything
//              quiet is what makes a noisy room pump up between words.
import { spawnSync } from 'node:child_process';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (n) => Math.round(n * 10) / 10;
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -120);

// Room noise and speech level from short windows: the quiet fifth that is not digital silence
// is the room, the loudest fifth is the voice.
export function levels(samples, rate = 8000) {
  const win = Math.round(rate * 0.05), list = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let e = 0;
    for (let k = i; k < i + win; k++) e += samples[k] * samples[k];
    const v = db(Math.sqrt(e / win) / 32768);
    if (v > -75) list.push(v); // exact silence is an app's noise gate, not the room
  }
  if (list.length < 20) return { noise: -90, speech: -90 };
  list.sort((a, b) => a - b);
  return { noise: r1(list[Math.floor(list.length * 0.2)]), speech: r1(list[Math.floor(list.length * 0.8)]) };
}

export function measureVoice(file) {
  const pcm = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 1 << 28, windowsHide: true });
  if (pcm.status !== 0 || !pcm.stdout?.length) throw new Error('no sound to measure');
  const lv = levels(new Int16Array(pcm.stdout.buffer, pcm.stdout.byteOffset, Math.floor(pcm.stdout.length / 2)));
  // Energy in four bands, one pass.
  const band = (lo, hi, tag) => `[${tag}]${lo ? `highpass=f=${lo}:p=2,` : ''}lowpass=f=${hi}:p=2,astats=metadata=0:measure_overall=RMS_level:measure_perchannel=none[${tag}o]`;
  const graph = `[0:a]pan=mono|c0=0.5*c0+0.5*c1,asplit=5[f][s][l][m][p];[f]astats=metadata=0:measure_overall=Peak_level:measure_perchannel=none[fo];${band(0, 90, 's')};${band(100, 300, 'l')};${band(1000, 3000, 'm')};${band(5000, 9000, 'p')}`;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-filter_complex', graph, ...['fo', 'so', 'lo', 'mo', 'po'].flatMap((t) => ['-map', `[${t}]`, '-f', 'null', '-'])], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  // Each astats reports under its own number; in order they are: whole, sub, low-mid, presence, air.
  const seen = new Map();
  for (const m of (r.stderr || '').matchAll(/Parsed_astats_(\d+)[^\]]*\] (Peak|RMS) level dB: (-?[\d.]+|-inf)/g)) seen.set(Number(m[1]), m[3] === '-inf' ? -120 : Number(m[3]));
  const v = [...seen.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  if (v.length < 5) throw new Error('could not measure the sound');
  return { ...lv, peak: r1(v[0]), sub: r1(v[1]), lowmid: r1(v[2]), presence: r1(v[3]), air: r1(v[4]) };
}

// The filters for this recording, and what each is for. m null: the fixed chain Fable always used.
export function voiceChain(m) {
  // t is the level under which the leveller holds back; 0 lifts everything quiet.
  const level = (t = 0) => `acompressor=threshold=-22dB:ratio=2.5:attack=8:release=140:makeup=2,speechnorm=e=4:c=2${t ? `:t=${t}` : ''}:r=0.0005:l=1,alimiter=limit=0.95:level=0`;
  if (!m) return { filter: `highpass=f=80,${level()}`, did: ['soft phrases lifted'] };
  const parts = ['highpass=f=80'], did = [];
  let reduced = 0;
  // Rumble: normal speech has little under 90 Hz. When there is a lot, the filter gets steeper.
  if (m.sub > m.lowmid - 12) { parts.push('highpass=f=95'); did.push(`low rumble cut (it was only ${r1(m.lowmid - m.sub)} dB under the voice's body)`); }
  // Room noise: reduced in proportion to how loud it is, up to 12 dB, and tracked as it changes.
  if (m.noise > -58) {
    const by = Math.round(clamp((m.noise + 64) * 0.45, 4, 12));
    parts.push(`afftdn=nr=${by}:nf=${Math.round(clamp(m.noise, -70, -30))}:tn=1`);
    reduced = by;
    did.push(`room noise between words turned down by about ${by} dB (it sat at ${m.noise} dB, ${r1(m.speech - m.noise)} dB under the voice)`);
  }
  // Mud: the body of the voice against the band where consonants live. About 8 dB apart is normal.
  const tilt = m.lowmid - m.presence;
  if (tilt > 8) {
    const g = r1(clamp((tilt - 8) * 0.8, 0.5, 4));
    parts.push(`equalizer=f=220:t=q:w=0.9:g=-${g}`, `equalizer=f=3000:t=q:w=1.1:g=${g}`);
    did.push(`a little less boom and a little more clarity (${g} dB each way)`);
    if (g >= 2.5) parts.push('deesser=i=0.25');
  }
  // What is left of the room after the clean-up, plus headroom for its peaks: below that the
  // leveller presses down instead of lifting. Only when the room is loud enough to hear.
  const hold = m.noise > -58 ? Math.round(clamp(10 ** ((m.noise - reduced + 18) / 20), 0.01, 0.04) * 1000) / 1000 : 0;
  parts.push(level(hold));
  did.push(hold ? 'soft phrases lifted, pauses left quiet' : 'soft phrases lifted');
  return { filter: parts.join(','), did };
}
