// Fable fast renderer: captions, hook card, and B-roll inserts drawn by FFmpeg + libass in one pass.
// Seconds instead of minutes, no browser, no frame cache. Used by fable.mjs for drafts and finals;
// the HyperFrames composition stays for motion graphics the agent adds by hand.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  for (const c of plan.captions) {
    if (c.kind === 'word') {
      const color = c.key && /\d/.test(c.text) ? `\\c${accent}` : '';
      ev.push(`Dialogue: 0,${t(c.start)},${t(c.end)},Word,,0,0,0,,{\\pos(${L.capX},${L.capY})${fit(c.text, L.word, L.maxWidth)}${pop()}${color}}${esc(c.text)}`);
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

// One FFmpeg pass: background (band layouts), footage, B-roll inserts, captions, mix.
// Returns { out, encoder, seconds }.
export function renderFast({ dir, plan, lay, style, out, quality, ff, fontsDir, hasAmf }) {
  mkdirSync(join(dir, 'assets/fonts'), { recursive: true });
  for (const f of readdirSync(fontsDir)) if (f.endsWith('.ttf')) copyFileSync(join(fontsDir, f), join(dir, 'assets/fonts', f));
  writeFileSync(join(dir, 'assets/captions.ass'), buildAss(plan, lay, style));
  const D = plan.duration, F = lay.foot;
  const inputs = ['-i', 'assets/footage.mp4', '-i', 'assets/mix.wav'];
  const chain = [];
  let base = '[0:v]';
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
  const video = draft && hasAmf
    ? ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '24', '-qp_p', '24']
    : draft ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24']
      : ['-c:v', 'libx264', '-preset', quality === 'high' ? 'slow' : 'medium', '-crf', quality === 'high' ? '17' : '19'];
  const started = Date.now();
  ff([...inputs, '-filter_complex', chain.join(';'), '-map', '[v]', '-map', '1:a', '-t', String(D), ...video, '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], dir);
  return { out: join(dir, out), encoder: video[1], seconds: Math.round((Date.now() - started) / 100) / 10 };
}

// Contact sheets for review: the first 2.5 s at 0.25 s steps (3x3), and one frame per shot.
export function reviewSheets(dir, video, plan, ff) {
  const open = join(dir, 'assets/review-open.png');
  ff(['-i', video, '-t', '2.5', '-vf', `fps=4,scale=640:-1,tile=3x3`, '-frames:v', '1', open], dir);
  const mids = plan.segments.slice(0, 9).map((s) => (s.out0 + s.out1) / 2);
  const sel = mids.map((m) => `eq(n\\,${Math.round(m * FPS)})`).join('+');
  const shots = join(dir, 'assets/review-shots.png');
  ff(['-i', video, '-vf', `select=${sel},scale=640:-1,tile=3x3`, '-fps_mode', 'vfr', '-frames:v', '1', shots], dir);
  return { open, shots };
}
export const hasFastFonts = (fontsDir) => existsSync(join(fontsDir, 'Montserrat-ExtraBold.ttf'));
