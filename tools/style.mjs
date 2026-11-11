// Fable style reader: my-style.md and my-rules.md, one plain line per choice.
//
// A line is read by its LABEL, the words before the first colon: "Captions: word by word",
// "Caption position: lower third", "Pace: tight", "Hook: never". The label decides which setting
// the line is about; only the text after the colon is searched for the choice, as whole words, and
// when it holds more than one choice word the first one wins ("Pace: tight. Cut every breath" is
// tight: "breath" is an explanation, not a choice). Anything in (brackets) is commentary.
//
// A line with a label Fable does not know ("Benta-serye: a selling skit...") is a note for the
// agent and sets nothing, whatever words it contains. A short line with no label at all ("bigger
// captions", "no hook") is still read by its topic word. Every line is reported with what it was
// read as, so a rule that was not understood is visible (`node fable.mjs rules`).
//
// A line may start with scope tags so a note from a Reel never fires on a long horizontal
// tutorial: [9:16] [16:9] [<90s] [>90s]. Untagged lines apply everywhere.
export function ruleApplies(line, media) {
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

export const DEFAULT_STYLE = {
  format: 'vertical', captions: 'word', position: 'upper', color: '#ffffff', accent: '#facc15',
  hook: true, pace: 'tight', graphics: 'some', grade: 'natural', sound: 'light', font: 'Montserrat', broll: 'none',
};

const NEVER = /\b(never|no|none|off|wala|walang|huwag|don't|do not)\b/;
// The choice whose word comes first in the text; null when none is there.
function first(text, choices) {
  let best = null;
  for (const [value, re] of Object.entries(choices)) {
    const m = text.match(re);
    if (m && (!best || m.index < best.index)) best = { value, index: m.index };
  }
  return best ? best.value : null;
}
// A hex color, or a plain color name; whichever comes first in the text.
const COLORS = { white: '#ffffff', black: '#111111', yellow: '#facc15', red: '#ef4444', orange: '#f97316', green: '#22c55e', blue: '#3b82f6', pink: '#ec4899', purple: '#a855f7' };
function colorIn(v) {
  const hex = v.match(/#[0-9a-f]{6}\b/), name = v.match(new RegExp(`\\b(${Object.keys(COLORS).join('|')})\\b`));
  if (hex && (!name || hex.index < name.index)) return hex[0];
  return name ? COLORS[name[1]] : null;
}
const POSITION = { upper: /\b(upper|top|taas)\b/, middle: /\b(middle|center|centre|gitna)\b/, lower: /\b(lower|bottom|baba)\b/ };
const path = (raw) => { const m = raw.match(/:\s*(.+?)\s*(?:\(.*)?$/); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null; };

// Each reader gets the choice text (lowercase, brackets removed) and the raw line, and returns the
// settings it found as { key: value }. An empty result means the line said nothing Fable can use.
const READERS = {
  format: (v) => { const f = first(v, { both: /\bboth\b/, horizontal: /\b(horizontal|16:9|landscape|youtube)\b/, vertical: /\b(vertical|9:16|portrait|reels?|tiktok|shorts?)\b/ }); return f ? { format: f } : {}; },
  captions: (v, raw) => {
    const out = {};
    const mode = first(v, { none: /^\s*(none|no|off|wala|walang)\b|\bno captions?\b/, word: /\b(word by word|one word|isang salita|one big)\b/, pills: /\bpills?\b/, subtitles: /\b(full[- ]sentences?|sentences?|subtitles?)\b/, bold: /\b(bold|key ?words?)\b/ });
    if (mode) out.captions = mode;
    Object.assign(out, READERS.position(v), READERS.captionColor(v, raw), READERS.size(v));
    return out;
  },
  position: (v) => { const p = first(v, POSITION); return p ? { position: p } : {}; },
  captionColor: (v) => { const c = colorIn(v); return c ? (/\b(highlight|accent|key)\b/.test(v) ? { accent: c } : { color: c }) : {}; },
  accent: (v) => { const c = colorIn(v); return c ? { accent: c } : {}; },
  size: (v, raw, style) => (/\b(bigger|larger|mas malaki)\b/.test(v) ? { scale: (style?.scale || 1) * 1.15 } : /\b(smaller|mas maliit)\b/.test(v) ? { scale: (style?.scale || 1) * 0.88 } : {}),
  hook: (v) => ({ hook: !NEVER.test(v) }),
  pace: (v) => { const p = first(v, { natural: /\b(natural|relaxed|slow|keep (the |short )?pauses)\b/, tight: /\b(tight|fast|mabilis|cut every)\b/ }); return p ? { pace: p } : {}; },
  graphics: (v) => { const g = first(v, { minimal: /\b(minimal|none|no|off|wala)\b/, heavy: /\b(heavy|lots|marami|maraming)\b/, some: /\bsome\b/ }); return g ? { graphics: g } : {}; },
  grade: (v) => { const g = first(v, { bw: /\b(black and white|b&w|monochrome)\b/, 'orange-teal': /\b(orange.{1,6}teal|teal.{1,6}orange)\b/, warm: /\bwarm\b/, cool: /\bcool\b/, natural: /\b(natural|as filmed)\b/ }); return g ? { grade: g } : {}; },
  sound: (v) => {
    if (/\b(voice only|no sound effects|no sfx)\b|^\s*(none|no|off|wala|walang)\b/.test(v)) return { sound: 'voice' };
    if (/\bmusic\b/.test(v) && !NEVER.test(v)) return { sound: 'music' };
    return /\b(light|some|sound effects|sfx)\b/.test(v) ? { sound: 'light' } : {};
  },
  voice: (v) => ({ voice: /\b(natural|raw|untouched|as recorded)\b/.test(v) ? 'natural' : 'level' }),
  copyTo: (v, raw) => { const p = path(raw); return p ? { copyTo: p } : {}; },
  saveTo: (v, raw) => { const p = path(raw); return p ? { saveTo: p } : {}; },
  retakes: (v) => ({ retakes: /\b(cut|remove|auto)\b/.test(v) && !NEVER.test(v) ? 'cut' : 'suggest' }),
  stutters: (v) => ({ stutters: /\b(suggest|ask|keep)\b/.test(v) || NEVER.test(v) ? 'suggest' : 'cut' }),
  privacy: (v) => ({ privacy: /\b(local|offline|stealth|only)\b/.test(v) && !/\b(no|off)\b/.test(v) ? 'local' : 'normal' }),
  broll: (v) => (NEVER.test(v) ? { broll: 'none' } : { broll: first(v, { lots: /\b(lots|heavy|marami|many|every)\b/ }) || 'some' }),
  font: (v, raw) => { const m = raw.match(/:\s*([A-Za-z][A-Za-z0-9 ]{2,30})/); return m ? { font: m[1].trim() } : {}; },
  hashtags: (v, raw, style) => ({ hashtags: [...new Set([...(style?.hashtags || []), ...(raw.match(/#[\p{L}\p{N}_]+/gu) || [])])] }),
  // Names are for the transcriber (knownNames in fable.mjs); they are read, just not a style setting.
  names: () => ({ names: true }),
};
// Labels, as people write them, to the reader that handles them.
const LABELS = [
  [/^(format|aspect( ratio)?|orientation)$/, 'format'],
  [/^(captions?|caption style|subtitles?)$/, 'captions'],
  [/^(caption |text )?(position|placement)$/, 'position'],
  [/^(caption|text) colou?r$/, 'captionColor'],
  [/^(accent|highlight)( colou?r)?$/, 'accent'],
  [/^(caption |text )?size$/, 'size'],
  [/^hook$/, 'hook'],
  [/^(pace|pacing|tempo|bilis)$/, 'pace'],
  [/^(graphics?|motion( graphics| cards)?)$/, 'graphics'],
  [/^(colou?r|grade|colou?r grade|look)$/, 'grade'],
  [/^(sound|audio|music|sfx|sound effects)$/, 'sound'],
  [/^voice$/, 'voice'],
  [/^(copy to|mirror( to)?|also save to)$/, 'copyTo'],
  [/^(save to|outbox)$/, 'saveTo'],
  [/^retakes?$/, 'retakes'],
  [/^stutters?$/, 'stutters'],
  [/^(privacy|stealth|offline)$/, 'privacy'],
  [/^(b-?roll|stock( footage| clips?)?)$/, 'broll'],
  [/^(caption )?font$/, 'font'],
  [/^hashtags?$/, 'hashtags'],
  [/^names?$/, 'names'],
];
// For a short line with no label: the topic word says which reader to try.
const TOPICS = [
  [/\b(captions?|subtitles?)\b/, 'captions'], [/\bhook\b/, 'hook'], [/\b(pace|pacing)\b/, 'pace'], [/\bgraphics?\b/, 'graphics'],
  [/\b(music|sound|sfx)\b/, 'sound'], [/\bb-?roll\b/, 'broll'], [/\b(vertical|horizontal|9:16|16:9)\b/, 'format'],
];

const PLAIN = { captionColor: 'caption color', copyTo: 'a second folder', saveTo: 'the outbox folder', broll: 'b-roll', grade: 'the color look', size: 'caption size' };
const show = (set) => Object.entries(set).filter(([k]) => k !== 'names').map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(' ') : v}`).join(', ');

// text: the file's contents. Returns the lines as read: [{ line, read, set, why }], where set is
// what the line changed ({} when nothing) and why says so in plain words when it was not used.
export function readRules(text, style, media = null) {
  const report = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*(#|<!--)/.test(raw)) continue;
    const entry = { line: raw.trim(), read: null, set: {}, why: null };
    report.push(entry);
    if (!ruleApplies(raw, media)) { entry.why = 'for another kind of video (its scope tag does not match this one)'; continue; }
    const body = raw.replace(/^\s*[-*]\s*/, '').replace(/\[(9:16|16:9|[<>]\d+s)\]\s*/g, '');
    const colon = body.match(/^([A-Za-z][A-Za-z \-]{0,28}?)\s*:\s*(.*)$/);
    let reader = null, value = body;
    if (colon) {
      const label = colon[1].toLowerCase().trim();
      reader = LABELS.find(([re]) => re.test(label))?.[1] || null;
      if (!reader) { entry.why = `"${colon[1].trim()}" is not a setting Fable reads: a note for your agent, not for the autopilot`; continue; }
      value = colon[2];
    } else {
      if (body.trim().split(/\s+/).length > 8) { entry.why = 'a sentence with no label: a note for your agent (start it with a label like "Captions:" to make it a rule)'; continue; }
      reader = TOPICS.find(([re]) => re.test(body.toLowerCase()))?.[1] || null;
      if (!reader) { entry.why = 'no label and no topic word Fable knows'; continue; }
    }
    // Commentary in brackets is not part of the choice.
    const choice = value.toLowerCase().replace(/\([^)]*\)?/g, ' ');
    const set = READERS[reader](choice, raw, style);
    entry.read = reader;
    if (!Object.keys(set).length) { entry.why = `about ${PLAIN[reader] || reader}, but no choice Fable knows in it: left to your agent`; continue; }
    entry.set = set;
    for (const [k, v] of Object.entries(set)) if (k !== 'names') style[k] = v;
  }
  return report;
}

// files: [{ name, text }] in order (style first, then rules, so rules win). Returns { style, report }.
export function parseStyle(files, media = null) {
  const style = { ...DEFAULT_STYLE }, report = [];
  for (const f of files) for (const r of readRules(f.text, style, media)) report.push({ file: f.name, ...r });
  return { style, report };
}

// The report as lines for the terminal: what each line was read as, then what was not used.
export function rulesReport({ style, report }) {
  const out = [];
  const used = report.filter((r) => Object.keys(r.set).length), unused = report.filter((r) => !Object.keys(r.set).length);
  const clip = (s) => (s.length > 90 ? `${s.slice(0, 87)}...` : s);
  out.push('Read by the autopilot:', '');
  for (const r of used) out.push(`  ${r.file}: ${clip(r.line)}`, `      -> ${r.set.names ? 'names for the transcriber' : show(r.set)}`);
  if (!used.length) out.push('  (nothing)');
  if (unused.length) {
    out.push('', 'Not used by the autopilot (your agent still reads these):', '');
    for (const r of unused) out.push(`  ${r.file}: ${clip(r.line)}`, `      -> ${r.why}`);
  }
  out.push('', 'What every edit starts from:', '', `  ${Object.entries(style).map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(' ') : v}`).join(', ')}`, '');
  return out;
}
