// Fable fast renderer: captions, hook card, and B-roll inserts drawn by FFmpeg + libass in one pass.
// Seconds instead of minutes, no browser, no frame cache. Used by fable.mjs for drafts and finals;
// the HyperFrames composition stays for motion graphics the agent adds by hand.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zoomAnchor, zoomFilter } from './motion.mjs';

const FPS = 30;

// #rrggbb -> ASS &H00BBGGRR&
const assColor = (hex, alpha = '00') => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) || ['', 'ff', 'ff', 'ff'];
  return `&H${alpha}${m[3]}${m[2]}${m[1]}&`.toUpperCase();
};
const t = (s) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};
const esc = (s) => s.replace(/[{}\\]/g, '').replace(/\n/g, '\\N');

// Where captions and the hook sit, in composition pixels. Mirrors composition() in fable.mjs.
// The top 14% and the bottom 20% of a phone screen belong to the platform's buttons and labels.
// The hook card hangs just below that top line; captions sit below the card, never inside it.
export function captionLayout(lay, style) {
  const { w: W, h: H } = lay, F = lay.foot, vertical = H > W;
  const sc = style.scale || 1;
  const word = Math.round((vertical ? 128 : 96) * sc), group = Math.round((vertical ? 70 : 56) * sc);
  const sub = Math.round((vertical ? 50 : 42) * sc), hook = Math.round((vertical ? 80 : 64) * sc);
  const safeTop = Math.round(0.14 * H), safeBottom = Math.round(0.80 * H);
  const hookBlock = Math.round(hook * 1.25 * 2);                 // two lines at 1.25 line height
  const hookY = safeTop + 12 + hookBlock / 2;                     // center of the card
  const hookBottom = hookY + hookBlock / 2;
  const capFont = style.captions === 'subtitles' ? sub : style.captions === 'word' ? word : group;
  const underHook = Math.round(hookBottom + 36 + capFont * 0.7);  // first safe center under the card
  let capY;
  if (vertical) {
    if (lay.fit === 'band') capY = style.position === 'lower' ? Math.min(F.y + F.h + 120, safeBottom - capFont) : style.position === 'middle' ? Math.max(underHook, F.y - capFont) : underHook;
    else capY = style.position === 'lower' ? safeBottom - capFont : style.position === 'middle' ? H / 2 : underHook;
  } else capY = style.position === 'upper' ? underHook : style.position === 'middle' ? H / 2 : H - 170;
  // With a measured face, text moves off it: upper text stops above the forehead, lower text starts under the chin.
  const face = style.face;
  if (face && lay.fit === 'cover') {
    const faceTop = face.face_top_p10 * H, chin = face.chin_p90 * H;
    if (style.position === 'lower' || style.position === 'middle') capY = Math.min(safeBottom - capFont * 0.7, Math.max(capY, chin + 20 + capFont * 0.7));
    else capY = Math.min(capY, faceTop - 20 - capFont * 0.7);
    if (capY - capFont * 0.7 < hookBottom + 10) capY = hookBottom + 10 + capFont * 0.7; // never under the card
  }
  return { capX: W / 2, capY: Math.round(capY), hookX: W / 2, hookY: Math.round(hookY), hookBlock, word, group, sub, hook, safeTop, safeBottom, maxWidth: vertical ? 920 : 1600 };
}

export function buildAss(plan, lay, style) {
  const L = captionLayout(lay, style);
  const white = assColor(style.color), accent = assColor(style.accent);
  const outline = Math.max(4, Math.round(L.word * 0.055)), shadow = Math.max(2, Math.round(L.word * 0.03));
  const font = 'Montserrat ExtraBold';
  const styles = [
    `Style: Word,${font},${L.word},${white},${white},&H99000000,&HA0000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},5,60,60,0,1`,
    `Style: Group,${font},${L.group},${white},${white},&H99000000,&HA0000000,-1,0,0,0,100,100,0,0,1,${Math.round(outline * 0.7)},${shadow},5,80,80,0,1`,
    `Style: Sub,Montserrat Bold,${L.sub},${white},${white},&H00000000,&H60000000,0,0,0,0,100,100,0,0,3,10,0,5,80,80,0,1`,
    `Style: Hook,${font},${L.hook},${white},${white},&H99000000,&HA0000000,-1,0,0,0,100,100,0,0,1,${Math.round(outline * 0.8)},${shadow},5,60,60,0,1`,
  ];
  const ev = [];
  const pop = (from = 86) => `\\fscx${from}\\fscy${from}\\t(0,100,\\fscx100\\fscy100)`;
  // House rule: a video made by AI says so on every frame. Small, boxed, top right, under the
  // platform UI band, never over the hook card.
  if (plan.tag) {
    const tagSize = Math.round((lay.h > lay.w ? 30 : 26) * (style.scale || 1));
    styles.push(`Style: Tag,Montserrat Bold,${tagSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,-1,0,0,0,100,100,1,0,3,8,0,9,0,30,0,1`);
    ev.push(`Dialogue: 2,${t(0)},${t(plan.duration)},Tag,,0,0,0,,{\\pos(${lay.w - 40},${L.safeTop + 18})\\an9}${esc(String(plan.tag).toUpperCase())}`);
  }
  const fit = (text, size, maxWidth) => {
    // Montserrat ExtraBold caps run about 0.72 em per character; shrink long lines to fit.
    const est = text.length * size * 0.72;
    return est > maxWidth ? `\\fs${Math.floor(size * maxWidth / est)}` : '';
  };
  if (plan.hook) {
    const [l1, l2] = plan.hook.lines;
    const text = l2 ? `${esc(l1)}\\N{\\c${accent}}${esc(l2)}` : esc(l1);
    const longest = Math.max(...plan.hook.lines.map((l) => l.length));
    ev.push(`Dialogue: 1,${t(0)},${t(plan.hook.end)},Hook,,0,0,0,,{\\pos(${L.hookX},${L.hookY})${fit('x'.repeat(longest), L.hook, L.maxWidth)}${pop(70)}}${text}`);
  }
  // Motion cards. A step label is a solid accent pill that slides into the hook card's slot once
  // the hook is gone. A number callout is the caption for its figure: one bigger line in the
  // accent color where "24" and "DAYS" would have flashed separately (the number over its unit
  // when it is long), so those word captions are left out.
  const cards = plan.motion?.cards || [];
  const stats = cards.filter((c) => c.kind === 'stat');
  if (cards.length) {
    const dark = '&H00111111&', statSize = Math.round(L.word * 1.15);
    styles.push(`Style: Stat,${font},${statSize},${accent},${accent},&H99000000,&HA0000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},5,60,60,0,1`);
    styles.push(`Style: Step,${font},${Math.round(L.hook * 0.95)},${dark},${dark},${accent},${accent},-1,0,0,0,100,100,2,0,3,${Math.round(L.hook * 0.28)},0,5,60,60,0,1`);
    for (const c of cards) {
      if (c.kind === 'step') { ev.push(`Dialogue: 1,${t(c.start)},${t(c.end)},Step,,0,0,0,,{\\move(${L.hookX - 140},${L.hookY},${L.hookX},${L.hookY},0,160)\\fad(100,140)}${esc(c.text)}`); continue; }
      const [number, ...unit] = c.text.split(' ');
      const stacked = c.text.length > 9 && unit.length;
      const body = stacked ? `${esc(number)}\\N{\\fs${Math.round(statSize * 0.6)}${fit(unit.join(' '), Math.round(statSize * 0.6), L.maxWidth)}}${esc(unit.join(' '))}` : esc(c.text);
      // A two-line callout grows away from the face: up from the caption line when captions sit
      // above the face, down when they sit under the chin (the draft check found it on the brows).
      const edge = Math.round(L.word * 0.55);
      const place = !stacked || style.position === 'middle' ? `\\pos(${L.capX},${L.capY})` : style.position === 'lower' ? `\\an8\\pos(${L.capX},${L.capY - edge})` : `\\an2\\pos(${L.capX},${L.capY + edge})`;
      ev.push(`Dialogue: 1,${t(c.start)},${t(c.end)},Stat,,0,0,0,,{${place}${stacked ? '' : fit(c.text, statSize, L.maxWidth)}${pop(60)}}${body}`);
    }
  }
  const underStat = (c) => stats.some((s) => c.start >= s.start - 0.05 && c.start < s.end - 0.02);
  for (const c of plan.captions) {
    if (c.kind === 'word') {
      if (underStat(c)) continue;
      const color = c.key && /\d/.test(c.text) ? `\\c${accent}` : '';
      const cut = stats.find((s) => c.start < s.start && c.end > s.start); // never under a callout
      ev.push(`Dialogue: 0,${t(c.start)},${t(cut ? cut.start : c.end)},Word,,0,0,0,,{\\pos(${L.capX},${L.capY})${fit(c.text, L.word, L.maxWidth)}${pop()}${color}}${esc(c.text)}`);
      continue;
    }
    // Group modes: the whole phrase holds, each word turns on at its onset.
    const subtitles = style.captions === 'subtitles';
    const styleName = subtitles ? 'Sub' : 'Group';
    const size = subtitles ? L.sub : L.group;
    const full = c.words.map((w) => w.text).join(' ');
    c.words.forEach((w, k) => {
      const end = k + 1 < c.words.length ? c.words[k + 1].start : c.end;
      if (end <= w.start) return;
      const parts = c.words.map((x, j) => {
        const shown = j <= k;
        if (subtitles) return shown ? esc(x.text) : `{\\alpha&HFF&}${esc(x.text)}{\\alpha&H00&}`;
        const col = x.key ? `\\c${accent}\\fs${Math.round(size * 1.15)}` : `\\c${white}\\fs${Math.round(size * (x.key === false ? 0.8 : 1))}`;
        return shown ? `{${col}}${esc(x.text)}` : `{\\alpha&HFF&${col}}${esc(x.text)}{\\alpha&H00&}`;
      });
      ev.push(`Dialogue: 0,${t(w.start)},${t(end)},${styleName},,0,0,0,,{\\pos(${L.capX},${L.capY})${fit(full, size, L.maxWidth)}}${parts.join(' ')}`);
    });
  }
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${lay.w}`, `PlayResY: ${lay.h}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...ev, '',
  ].join('\n');
}

// Where every piece of text sits and when, in output pixels, for the draft check. The same
// numbers buildAss() draws with: { start, end, x0, y0, x1, y1, text, kind }.
export function textBoxes(plan, lay, style) {
  const L = captionLayout(lay, style), W = lay.w, out = [];
  const box = (kind, text, start, end, cy, size, lines = 1) => {
    const longest = Math.max(...String(text).split('\n').map((l) => l.length));
    const w = Math.min(L.maxWidth, longest * size * 0.72), h = size * 1.1 * lines;
    out.push({ kind, text: String(text).replace(/\n/g, ' '), start, end, x0: Math.round(W / 2 - w / 2), x1: Math.round(W / 2 + w / 2), y0: Math.round(cy - h / 2), y1: Math.round(cy + h / 2) });
  };
  if (plan.hook) box('hook', plan.hook.lines.join('\n'), 0, plan.hook.end, L.hookY, L.hook * 1.14, plan.hook.lines.length);
  const cards = plan.motion?.cards || [], stats = cards.filter((c) => c.kind === 'stat');
  const statSize = Math.round(L.word * 1.15);
  for (const c of cards) {
    if (c.kind === 'step') { box('step', c.text, c.start, c.end, L.hookY, L.hook * 1.4); continue; }
    const [number, ...unit] = c.text.split(' ');
    if (c.text.length > 9 && unit.length) {
      // Two lines, anchored on the caption line's far edge from the face (see buildAss).
      const h = statSize * 0.8 * 1.1 * 2, edge = L.word * 0.55;
      const cy = style.position === 'middle' ? L.capY : style.position === 'lower' ? L.capY - edge + h / 2 : L.capY + edge - h / 2;
      box('stat', `${number}\n${unit.join(' ')}`, c.start, c.end, cy, statSize * 0.8, 2);
    }
    else box('stat', c.text, c.start, c.end, L.capY, statSize);
  }
  for (const c of plan.captions || []) {
    if (c.kind === 'word') {
      if (stats.some((s) => c.start >= s.start - 0.05 && c.start < s.end - 0.02)) continue;
      const cut = stats.find((s) => c.start < s.start && c.end > s.start);
      box('caption', c.text, c.start, cut ? cut.start : c.end, L.capY, L.word);
    } else box('caption', c.words.map((w) => w.text).join(' '), c.start, c.end, L.capY, style.captions === 'subtitles' ? L.sub * 1.3 : L.group * 1.15);
  }
  return out;
}

// One FFmpeg pass: background (band layouts), footage, B-roll inserts, captions, mix.
// Returns { out, encoder, seconds }.
export function renderFast({ dir, plan, lay, style, out, quality, ff, fontsDir, hasAmf, lowMemory = false }) {
  mkdirSync(join(dir, 'assets/fonts'), { recursive: true });
  for (const f of readdirSync(fontsDir)) if (f.endsWith('.ttf')) copyFileSync(join(fontsDir, f), join(dir, 'assets/fonts', f));
  writeFileSync(join(dir, 'assets/captions.ass'), buildAss(plan, lay, style));
  const D = plan.duration, F = lay.foot;
  const inputs = ['-i', 'assets/footage.mp4', '-i', 'assets/mix.wav'];
  const chain = [];
  let base = '[0:v]';
  // Punch-ins on the footage itself, before anything is laid over it (B-roll and text stay put).
  const zooms = plan.motion?.zooms || [];
  if (zooms.length) {
    chain.push(...zoomFilter(zooms, F.w, F.h, zoomAnchor(lay.fit === 'cover' ? plan.face : null, style.position), D, base, '[punched]'));
    base = '[punched]';
  }
  if (lay.fit !== 'cover') {
    chain.push(`color=c=0x0b0f17:s=${lay.w}x${lay.h}:r=${FPS}:d=${D}[bg]`);
    chain.push(`[bg]${base}overlay=${F.x}:${F.y}:shortest=1[base0]`);
    base = '[base0]';
  }
  (plan.broll || []).forEach((b, i) => {
    const n = inputs.length / 2;
    inputs.push('-itsoffset', String(b.at), '-i', b.file);
    chain.push(`[${n}:v]setpts=PTS-STARTPTS+${b.at}/TB[br${i}]`);
    chain.push(`${base}[br${i}]overlay=${F.x}:${F.y}:eof_action=pass:enable='between(t,${b.at},${b.at + b.duration})'[base${i + 1}]`);
    base = `[base${i + 1}]`;
  });
  chain.push(`${base}ass=assets/captions.ass:fontsdir=assets/fonts,format=yuv420p[v]`);
  const draft = quality === 'draft';
  // Encoder ladder: the first that opens wins. x264 at medium wants more RAM than a busy laptop
  // sometimes has, so finals step down to a lighter x264 and then to the GPU encoder.
  const amfFinal = hasAmf && ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '20'];
  const x264Final = ['-c:v', 'libx264', '-preset', quality === 'high' ? 'slow' : 'medium', '-crf', quality === 'high' ? '17' : '19'];
  const x264Light = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-threads', '2'];
  const ladder = draft
    ? [hasAmf && ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '24', '-qp_p', '24'], ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24']]
    // On an 8 GB machine the GPU encoder goes first: it uses almost no system memory and never refuses to start.
    : lowMemory ? [amfFinal, x264Light, x264Final] : [x264Final, x264Light, amfFinal];
  const started = Date.now();
  let lastError = null, used = null;
  for (const video of ladder.filter(Boolean)) {
    try {
      ff([...inputs, '-filter_complex', chain.join(';'), '-map', '[v]', '-map', '1:a', '-t', String(D), ...video, '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], dir);
      used = `${video[1]} ${video[3]}`; lastError = null; break;
    } catch (e) { lastError = e; }
  }
  if (lastError) throw lastError;
  return { out: join(dir, out), encoder: used, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

// Contact sheets for review: the first 2.5 s at 0.25 s steps (3x3), and one frame per shot.
export function reviewSheets(dir, video, plan, ff) {
  const open = join(dir, 'assets/review-open.png');
  ff(['-i', video, '-t', '2.5', '-vf', `fps=4,scale=640:-1,tile=3x3`, '-frames:v', '1', open], dir);
  // The whole video, not just its start: the middle of every shot, and long shots every 4 s,
  // thinned evenly to 40 frames when there are more.
  let mids = plan.segments.flatMap((s) => { const n = Math.max(1, Math.round((s.out1 - s.out0) / 4)); return Array.from({ length: n }, (_, i) => s.out0 + (s.out1 - s.out0) * (i + 0.5) / n); });
  if (mids.length > 40) mids = Array.from({ length: 40 }, (_, i) => mids[Math.floor(i * mids.length / 40)]);
  const frames = [...new Set(mids.map((m) => Math.round(m * FPS)))];
  const cols = Math.min(8, Math.max(3, Math.ceil(Math.sqrt(frames.length))));
  const sel = frames.map((n) => `eq(n\\,${n})`).join('+');
  const shots = join(dir, 'assets/review-shots.png');
  ff(['-i', video, '-vf', `select=${sel},scale=${frames.length > 9 ? 360 : 640}:-2,tile=${cols}x${Math.ceil(frames.length / cols)}`, '-fps_mode', 'vfr', '-frames:v', '1', '-update', '1', shots], dir);
  return { open, shots };
}
export const hasFastFonts = (fontsDir) => existsSync(join(fontsDir, 'Montserrat-ExtraBold.ttf'));
