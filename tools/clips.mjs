// Clips mode: find the moments in a long recording that stand on their own as a short.
// Pure arithmetic on the transcript, the measured silences, and the retake notes; no model.
// Each candidate starts after a real pause, ends on a finished sentence, runs 25 to 60 s by
// default, and is scored on its opening, its ending, its pace, and whether it is clean.

// Strong openers earn the clip; soft ones only help when they lead.
const STRONG = /\b(here'?s why|here is why|the truth|truth is|secret|nobody tells|stop doing|never do|what if|how to|why do|why does|paano|bakit|alam mo ba|sikreto)\b|\?\s*$/i;
const SOFT = /\b(the mistake|most people|number one|step one|the problem|tandaan|eto ang|ito ang|huwag|ano ang)\b/i;
const PAYOFF = /\b(that'?s why|that is why|so if you|the lesson|bottom line|in short|try this|remember|the point is|which means|kaya kung|kaya dapat|yan ang|ganun lang|simple lang)\b/i;
const CONJ = /^(and|but|so|or|because|then|also|tapos|pero|kasi|at|saka|tsaka)\b/i;
const token = (t) => (t || '').toLowerCase().replace(/^[^a-z0-9$%]+|[^a-z0-9$%]+$/g, '');

export function phrasesOf(words, pause = 0.45) {
  const out = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    if (cur.length && words[i].start - cur.at(-1).end >= pause) { out.push(mk(cur, words[i].start - cur.at(-1).end)); cur = []; }
    cur.push(words[i]);
  }
  if (cur.length) out.push(mk(cur, 9));
  return out;
  function mk(ws, pauseAfter) {
    return { start: ws[0].start, end: ws.at(-1).end, n: ws.length, pauseAfter, text: ws.map((w) => w.text).join(' ').trim(), sentenceEnd: /[.!?]$/.test(ws.at(-1).text) };
  }
}

// words: [{text,start,end}] in source time. silences: [{start,end}]. dirty: [{start,end}] ranges to
// avoid (possible retakes, untranscribed speech). Returns the top candidates, earliest first.
export function scoreClips(words, { silences = [], dirty = [], min = 25, max = 60, count = 5 } = {}) {
  if (words.length < 30) return [];
  const ph = phrasesOf(words);
  const quietBefore = (t) => t <= 0.05 || silences.some((s) => s.start <= t + 0.02 && s.end >= t - 0.6) || true;
  const cands = [];
  for (let i = 0; i < ph.length; i++) {
    const pauseBefore = i === 0 ? 9 : ph[i].start - ph[i - 1].end;
    if (pauseBefore < 0.5 || CONJ.test(ph[i].text) || !quietBefore(ph[i].start)) continue;
    for (let j = i; j < ph.length; j++) {
      const start = ph[i].start, end = ph[j].end, dur = end - start;
      if (dur < min) continue;
      if (dur > max) break;
      const slice = ph.slice(i, j + 1);
      const spoken = slice.reduce((a, p) => a + (p.end - p.start), 0);
      const n = slice.reduce((a, p) => a + p.n, 0);
      const wps = n / Math.max(1, spoken);                   // words per spoken second
      const deadAir = 1 - spoken / dur;
      // Real speech, not a speech model guessing over music or silence: enough words, enough
      // different words, a human pace, and no single word making up a third of the window.
      const toks = slice.flatMap((p) => p.text.split(/\s+/).map(token)).filter(Boolean);
      const distinct = new Set(toks).size;
      const counts = new Map();
      for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
      const top = Math.max(0, ...counts.values());
      if (n < 30 || distinct < 20 || wps < 1.5 || wps > 5 || top > toks.length * 0.33) continue;
      const first = slice[0].text;
      let hook = STRONG.test(first) ? 26 : SOFT.test(first) ? 16 : STRONG.test(slice[1]?.text || '') ? 12 : 8;
      if (/\d/.test(first)) hook += 6;
      if (i === 0 || ph[i - 1].sentenceEnd) hook += 2;     // starts a thought, not mid-thought
      const closing = slice.at(-1);
      let payoff = PAYOFF.test(closing.text) ? 15 : 5;
      if (closing.sentenceEnd && closing.pauseAfter >= 0.6) payoff += 10;
      const pace = Math.max(0, 15 - Math.abs(wps - 2.8) * 6) + Math.max(0, 10 * (1 - deadAir * 2));
      const isDirty = dirty.some((d) => d.start < end && d.end > start);
      const clean = isDirty ? 0 : 20;
      const score = Math.round((hook + payoff + pace + clean) * 10) / 10;
      cands.push({ start: r2(start), end: r2(end), duration: r2(dur), score, wps: r2(wps),
        opening: slice[0].text.slice(0, 90), closing: closing.text.slice(-90),
        why: [STRONG.test(first) ? 'opens on a hook' : SOFT.test(first) ? 'opens on a claim' : 'plain opening', closing.sentenceEnd && closing.pauseAfter >= 0.6 ? 'ends on a finished line' : 'ending runs on', isDirty ? 'contains a possible retake' : 'clean'].join(', ') });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of cands) {
    const overlaps = picked.some((p) => Math.max(0, Math.min(c.end, p.end) - Math.max(c.start, p.start)) / Math.min(c.duration, p.duration) > 0.15);
    if (!overlaps) { picked.push(c); if (picked.length >= count * 2) break; }
  }
  return { top: picked.slice(0, count).sort((a, b) => a.start - b.start), runnersUp: picked.slice(count), considered: cands.length };
}
const r2 = (n) => Math.round(n * 100) / 100;
