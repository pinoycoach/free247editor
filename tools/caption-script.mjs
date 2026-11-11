// Fable caption script: written lines on a clip, each at its own time. For footage where the
// captions carry the video (a skit, an AI clip, a quiet single take) and nothing is transcribed.
// The pure parts live here so they can be tested; fable.mjs does the probing and the FFmpeg pass,
// tools/caption_cards.py draws the cards (color emoji included).
//
// The script is plain text, one caption per line:
//
//   position: lower            (upper | middle | lower | a number from 0 to 1; default: under the face)
//   trim: 5-20.6               (use only this part of the source; caption times count from its start)
//   tag: AI-generated          (house rule for generated footage)
//   audio: mute                (default: keep the clip's own sound)
//   zoom: slow                 (a very slow push-in over the whole clip, for a static single take)
//
//   0.0-1.3  [title] KA-VOGUE,
//   1.3      ang laki ng next / water bill mo.      (no end time: it holds until the next line)
//   2.9-4.9  I don't care. 🙂
//   6.9      [big] *Nasaan?* 👀                      (*stars* draw a word in the accent color)
//
// " / " breaks a line by hand; long lines without one are balanced over up to three lines.
// Tags: [title] bigger and in the accent color, [big], [small], [serif].
import { wrapCaption } from './stitch.mjs';

const r3 = (n) => Math.round(n * 1000) / 1000;
// 12.5, 0:12.5, 1:02 -> seconds
const TIME = String.raw`(?:\d+:)?\d+(?:\.\d+)?`;
const seconds = (s) => { const p = s.split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : p[0]; };
const DIRECTIVE = /^(position|trim|tag|audio|zoom)\s*:\s*(.*)$/i;
const LINE = new RegExp(String.raw`^(${TIME})(?:\s*(?:-|–|to)\s*(${TIME}))?[\s:]+(\S.*)$`);
const TAGS = new Set(['title', 'big', 'small', 'serif']);
// What counts as an emoji for layout: pictographs, dingbats, arrows, and the joiners between them.
export const isEmoji = (ch) => { const o = ch.codePointAt(0); return o >= 0x1F000 || (o >= 0x2190 && o <= 0x21FF) || (o >= 0x2600 && o <= 0x27BF) || (o >= 0x2B00 && o <= 0x2BFF) || o === 0xFE0F || o === 0x200D; };
const plain = (t) => [...t.replace(/\*| \/ /g, ' ')].filter((ch) => !isEmoji(ch)).join('').trim();

// Returns { captions: [{ start, end, lines, tags }], position, trim, tag, audio, problems, warnings }.
// problems stop the build (a line Fable cannot read); warnings go in the notes (too fast to read).
export function parseCaptionScript(text, duration = Infinity) {
  const out = { captions: [], position: null, trim: null, tag: null, audio: 'keep', zoom: null, problems: [], warnings: [] };
  const rows = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    const d = line.match(DIRECTIVE);
    if (d) {
      const key = d[1].toLowerCase(), v = d[2].trim();
      if (key === 'position') {
        const n = Number(v);
        if (/^(upper|middle|lower)$/i.test(v)) out.position = v.toLowerCase();
        else if (v && Number.isFinite(n) && n > 0 && n < 1) out.position = n;
        else out.problems.push(`line ${i + 1}: position is upper, middle, lower, or a number between 0 and 1`);
      } else if (key === 'trim') {
        const m = v.match(new RegExp(String.raw`^(${TIME})\s*(?:-|–|to)\s*(${TIME})$`));
        if (m && seconds(m[2]) > seconds(m[1])) out.trim = { start: seconds(m[1]), end: seconds(m[2]) };
        else out.problems.push(`line ${i + 1}: trim wants "start-end" in seconds, like 5-20.6`);
      } else if (key === 'tag') out.tag = /^(none|no|off)?$/i.test(v) ? null : v;
      else if (key === 'zoom') out.zoom = /^(none|no|off)?$/i.test(v) ? null : 'slow';
      else out.audio = /mute|silent|none|off|no/i.test(v) ? 'mute' : 'keep';
      return;
    }
    const m = line.match(LINE);
    if (!m) { out.problems.push(`line ${i + 1}: needs a time first, like "2.5 text" or "2.5-4 text" (got: ${line.slice(0, 40)})`); return; }
    let body = m[3].trim();
    const tags = [];
    for (let t; (t = body.match(/^\[([a-z]+)\]\s*/i));) {
      if (!TAGS.has(t[1].toLowerCase())) { out.problems.push(`line ${i + 1}: [${t[1]}] is not a tag Fable knows (title, big, small, serif)`); break; }
      tags.push(t[1].toLowerCase()); body = body.slice(t[0].length);
    }
    if (!plain(body) && ![...body].some(isEmoji)) { out.problems.push(`line ${i + 1}: no text after the time`); return; }
    rows.push({ n: i + 1, start: seconds(m[1]), end: m[2] === undefined ? null : seconds(m[2]), body, tags });
  });
  if (out.trim) duration = Math.min(duration, out.trim.end) - out.trim.start;
  rows.sort((a, b) => a.start - b.start);
  rows.forEach((r, k) => {
    const next = rows[k + 1]?.start ?? duration;
    let end = r.end ?? next;
    if (!Number.isFinite(end)) end = r.start + 2.5;
    if (r.end !== null && r.end > next + 0.001) { out.warnings.push(`line ${r.n}: runs into the next caption; ended at ${r3(next)} s`); end = next; }
    if (r.start >= duration) { out.warnings.push(`line ${r.n}: starts at ${r.start} s, after the video ends (${r3(duration)} s); left out`); return; }
    if (end > duration + 0.001) end = duration;
    if (end - r.start < 0.1) { out.problems.push(`line ${r.n}: ends before it starts`); return; }
    // " / " is a hand break. Without one, long text is balanced over up to three lines.
    const lines = / \/ /.test(r.body) || r.body.length <= 20 ? r.body.split(/ \/ /).map((s) => s.trim()).filter(Boolean) : wrapCaption(r.body);
    const words = plain(r.body).split(/\s+/).filter(Boolean).length, held = end - r.start;
    // A reader takes in about four words a second; the first 0.4 s goes to finding the text.
    if (words >= 3 && words / held > 4.5) out.warnings.push(`line ${r.n}: ${words} words in ${r3(held)} s is too fast to read ("${plain(r.body).slice(0, 30)}"); give it ${r3(words / 4)} s or cut words`);
    out.captions.push({ start: r3(r.start), end: r3(end), lines, tags: r.tags });
  });
  if (!out.captions.length && !out.problems.length) out.problems.push('no caption lines found (each needs a time first, like "2.5 text")');
  return out;
}

// Center of the caption block, as a fraction of the height. Default: under the chin when the face
// was measured, else lower-middle (60%), where a chest or a table usually is. Always inside the
// band the platform leaves free: below the top 14%, above the bottom 20%.
export function captionCenter(position, face, blockFrac = 0.12) {
  const half = blockFrac / 2, lo = 0.14 + half, hi = 0.80 - half;
  const clamp = (v) => Math.min(hi, Math.max(lo, v));
  if (typeof position === 'number') return clamp(position);
  if (position === 'upper') return clamp(face ? Math.min(0.24, face.face_top_p10 - 0.02 - half) : 0.24);
  if (position === 'middle') return clamp(0.5);
  if (position === 'lower') return clamp(face ? Math.max(0.7, face.chin_p90 + 0.03 + half) : 0.7);
  return clamp(face ? Math.max(0.6, face.chin_p90 + 0.03 + half) : 0.62);
}
