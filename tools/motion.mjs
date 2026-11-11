// Fable motion: what the style line "Graphics: some motion cards" means in the fast renderer.
// Two things, both planned from the transcript and drawn by FFmpeg in the same pass as captions:
//
//   zooms  punch-ins on the lines that carry weight (a short punchy sentence, a number, a
//          question), held for the sentence and released at the next one. Static while held, so
//          they stay sharp; a 4-frame ease in and out unless the edge sits on a cut.
//   cards  a step label when the speaker counts a list ("first... second...", "tip number 2"),
//          and a number callout when a figure with its unit is said ("24 days", "7.2 trillion
//          pesos"): with word-by-word captions the figure shows as one bigger caption in the
//          accent color, where its separate words would have been. Always the speaker's own words.
//
// "minimal" plans nothing, "some" keeps both sparse, "heavy" allows them closer together.
// The plan lands in edit.json as "motion" so one zoom or card can be deleted by hand.
const FPS = 30;
const r3 = (n) => Math.round(n * 1000) / 1000;
const tok = (t) => (t || '').toLowerCase().replace(/^[^a-z0-9₱$%]+|[^a-z0-9%]+$/g, '');
const ends = (w) => /[.!?]["')\]]?$/.test(w.text);
const CHARGED = /^(never|always|secret|free|stop|mistake|wrong|best|worst|truth|nobody|everyone|only|biggest|wala|lahat|libre|sikreto|mali|totoo|pinaka)/i;
const MONTH = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|enero|pebrero|marso|abril|mayo|hunyo|hulyo|agosto|setyembre|oktubre|nobyembre|disyembre)$/i;
const MAGNITUDE = /^(hundred|thousand|million|billion|trillion|libo|milyon|bilyon)$/i;
const FILLER = new Set('a an and are as at be but by for from i if in is it of on or so that this to was we with you the then than they he she ang ng na sa si mga ay at'.split(' '));
const NUMBER_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, isa: 1, dalawa: 2, tatlo: 3, apat: 4, lima: 5 };
const ORDINAL = { first: 1, firstly: 1, second: 2, secondly: 2, third: 3, thirdly: 3, fourth: 4, fifth: 5, una: 1, pangalawa: 2, ikalawa: 2, pangatlo: 3, ikatlo: 3, pangapat: 4, 'pang-apat': 4, ikaapat: 4, panlima: 5, ikalima: 5 };
const STEP_WORD = /^(step|tip|rule|reason|lesson|part|hakbang|number|numero)$/i;
const LIMITS = {
  some: { zoom: 1.1, minGap: 3, maxWide: 10, share: 0.4, cardGap: 5 },
  heavy: { zoom: 1.14, minGap: 1.8, maxWide: 6, share: 0.5, cardGap: 2.5 },
};

// Sentences as the speaker said them: { i0, i1, start, end } on the output timeline.
function phrases(words, duration) {
  const out = [];
  let s = 0;
  for (let i = 0; i < words.length; i++) {
    if (!ends(words[i]) && i < words.length - 1) continue;
    out.push({ i0: s, i1: i, start: words[s].start });
    s = i + 1;
  }
  out.forEach((p, k) => { p.end = out[k + 1]?.start ?? duration; });
  return out;
}

function planZooms(words, segments, duration, lim, hookEnd) {
  const zooms = [], lead = 2 / FPS;
  const cuts = segments.map((s) => s.out0);
  const onCut = (t) => t < 0.05 || t > duration - 0.05 || cuts.some((c) => Math.abs(c - t) <= 0.07);
  const list = phrases(words, duration);
  let last = hookEnd, tight = 0;
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    if (p.start < hookEnd + 0.2 || p.start - last < lim.minGap) continue;
    const ws = words.slice(p.i0, p.i1 + 1), len = p.end - p.start;
    const short = ws.length <= 4 && len <= 2.5;
    const emphasis = short || ws.some((w) => /\d/.test(w.text) || CHARGED.test(tok(w.text))) || /[!?]/.test(ws.at(-1).text);
    if (!emphasis && p.start - last < lim.maxWide) continue;
    // A one-second punch-in reads as a glitch: carry a short line through the next sentence.
    let end = p.end;
    if (end - p.start < 1.3 && list[k + 1] && list[k + 1].end - p.start <= 5) end = list[k + 1].end;
    end = Math.min(end, p.start + 5);
    if (duration - end < 0.6) end = duration;
    const start = Math.max(0, p.start - lead);
    if (end - start < 0.8 || (tight + end - start) / duration > lim.share) continue;
    zooms.push({ start: r3(start), end: r3(end), scale: lim.zoom, in: onCut(start) ? 0 : 0.13, out: onCut(end) ? 0 : 0.13, on: ws.slice(0, 5).map((w) => w.text).join(' ') });
    tight += end - start; last = end;
  }
  return zooms;
}

function stepCards(words) {
  const found = [];
  const fresh = (i) => i === 0 || ends(words[i - 1]) || words[i].start - words[i - 1].end >= 0.35;
  const num = (w) => { const t = tok(w?.text); return /^\d{1,2}$/.test(t) ? Number(t) : NUMBER_WORD[t] || null; };
  for (let i = 0; i < words.length; i++) {
    if (!fresh(i)) continue;
    const t = tok(words[i].text);
    if (STEP_WORD.test(t)) {
      // "step two", "tip number 3", "number one"
      const skip = /^(number|numero)$/i.test(tok(words[i + 1]?.text)) ? 2 : 1;
      const n = num(words[i + skip]);
      if (n) found.push({ n, label: /^(number|numero)$/i.test(t) ? `#${n}` : `${t.toUpperCase()} ${n}`, at: words[i].start, i });
    } else if (ORDINAL[t]) found.push({ n: ORDINAL[t], label: `#${ORDINAL[t]}`, at: words[i].start, i });
  }
  // One "first" is a figure of speech. A list counts up: keep the longest run of n, n+1, n+2...
  let best = [];
  for (let a = 0; a < found.length; a++) {
    const run = [found[a]];
    for (let b = a + 1; b < found.length; b++) if (found[b].n === run.at(-1).n + 1) run.push(found[b]);
    if (run.length > best.length) best = run;
  }
  return best.length >= 2 && best[0].n <= 2 ? best.map((s) => ({ kind: 'step', text: s.label, at: s.at })) : [];
}

function statCards(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const raw = words[i].text.trim(), core = raw.replace(/[.,!?;:]+$/, '');
    if (!/^[₱$]?\d[\d,.]*[%xXkKmM]?$/.test(core)) continue;
    if (/^(19|20)\d\d$/.test(core) || (i > 0 && MONTH.test(tok(words[i - 1].text)))) continue; // years and dates are not figures
    const parts = [core];
    let j = i, closed = /[.,!?;:]$/.test(raw);
    const near = (k) => words[k] && words[k].start - words[k - 1].end < 0.6;
    if (!closed && near(j + 1) && MAGNITUDE.test(tok(words[j + 1].text))) { j++; parts.push(words[j].text.replace(/[.,!?;:]+$/, '')); closed = /[.,!?;:]$/.test(words[j].text); }
    // The unit: the next word when it ends the phrase ("24 days."), or two words that do
    // ("10 heavenly stems,"). A number running on into the sentence ("10 riders and") is left alone.
    if (!closed) {
      const a = words[j + 1], b = words[j + 2];
      const word = (w) => w && /^[\p{L}-]+[.,!?;:]*$/u.test(w.text.trim()) && !FILLER.has(tok(w.text));
      if (near(j + 1) && word(a) && /[.,!?;:]$/.test(a.text)) { parts.push(a.text.replace(/[.,!?;:]+$/, '')); j += 1; closed = true; }
      else if (near(j + 1) && near(j + 2) && word(a) && word(b) && /[.,!?;:]$/.test(b.text)) { parts.push(a.text, b.text.replace(/[.,!?;:]+$/, '')); j += 2; closed = true; }
    }
    const symbol = /^[₱$]|[%xXkKmM]$/.test(core);
    if (parts.length < 2 && !symbol) continue;
    if (!closed && !symbol) continue;
    out.push({ kind: 'stat', text: parts.join(' ').toUpperCase(), at: words[i].start, until: words[j].end, next: words[j + 1]?.start ?? Infinity });
    i = j;
  }
  return out;
}

function planCards(words, duration, lim, hookEnd, captions) {
  const lead = 2 / FPS, cards = [];
  const room = (c) => c.start >= hookEnd && c.end <= duration - 0.2 && cards.every((o) => c.start >= o.end + lim.cardGap || c.end <= o.start - lim.cardGap);
  // Steps first: they are structure. Numbers fill what room is left.
  for (const s of stepCards(words)) {
    const start = r3(Math.max(hookEnd, s.at - lead)), c = { kind: 'step', text: s.text, start, end: r3(start + 1.8) };
    if (c.start >= hookEnd && c.end <= duration - 0.2 && cards.every((o) => c.start >= o.end + 0.3)) cards.push(c);
  }
  // A number callout takes the place of the word captions for the figure ("24" then "DAYS" becomes
  // one bigger "24 DAYS" in the accent color), so it ends before the next word's caption starts.
  if (captions === 'word') for (const s of statCards(words)) {
    const start = r3(Math.max(0, s.at - lead)), c = { kind: 'stat', text: s.text, start, end: r3(Math.min(s.until + 0.45, s.next - lead)) };
    if (c.end - c.start >= 0.5 && room(c)) cards.push(c);
  }
  return cards.sort((a, b) => a.start - b.start);
}

// words and segments are on the output timeline (plan.words, plan.segments).
export function planMotion(words, segments, duration, style, hookEnd = 0) {
  const lim = LIMITS[style.graphics];
  if (!lim || !words.length) return { zooms: [], cards: [] };
  return { zooms: planZooms(words, segments, duration, lim, hookEnd), cards: planCards(words, duration, lim, hookEnd, style.captions) };
}

// The point that stays put while the picture grows: the edge of the face nearest the text, so a
// punch-in never pushes the forehead (or the chin) into the captions.
export function zoomAnchor(face, position) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if (!face) return { x: 0.5, y: 0.4 };
  const y = position === 'upper' ? face.face_top_p10 : position === 'lower' ? face.chin_p90 : face.cy_median;
  return { x: r3(clamp(face.cx_median ?? 0.5, 0.3, 0.7)), y: r3(clamp(y ?? 0.4, 0.15, 0.75)) };
}

// FFmpeg filters that turn [input] (w x h footage) into [output] with the zooms applied: the
// frame is scaled per frame and laid over a canvas so the anchor point stays where it was.
export function zoomFilter(zooms, w, h, anchor, duration, input, output) {
  if (!zooms.length) return [];
  const term = (z) => {
    const up = z.in > 0 ? `clip((t-${z.start})/${z.in},0,1)` : `gte(t,${z.start})`;
    const down = z.out > 0 ? `clip((${z.end}-t)/${z.out},0,1)` : `lt(t,${z.end})`;
    return `${r3(z.scale - 1)}*${up}*${down}`;
  };
  const Z = `(1+${zooms.map(term).join('+')})`;
  return [
    `${input}scale=w='2*trunc(${w}*${Z}/2)':h='2*trunc(${h}*${Z}/2)':eval=frame:flags=bicubic[zoomed]`,
    `color=c=black:s=${w}x${h}:r=${FPS}:d=${duration}[zoomcanvas]`,
    `[zoomcanvas][zoomed]overlay=x='-(w-${w})*${anchor.x}':y='-(h-${h})*${anchor.y}':eval=frame:shortest=1${output}`,
  ];
}
