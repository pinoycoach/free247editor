// Fable long recordings: a live, a podcast, an hour of talking. Two jobs, both pure here so they
// can be tested; tools/transcribe.mjs and fable.mjs do the FFmpeg and network parts.
//
//   chunkPlan(duration, silences, maxLen)  where to split the sound so each piece fits the
//       transcriber's upload limit, always in a pause so no word is cut in two
//   findClips(words, options)              the stretches that would stand on their own as a short
//
// Finding clips is a selection problem over the speaker's own words, like the hook: nothing is
// rewritten or reordered. A good clip opens on a line that needs no context (a question, a claim,
// a number; not "And so..." or "hello, can you hear me"), stays on one subject, and ends on a
// finished thought with a pause after it, where the talk moves on. Each candidate says why it was
// picked, and the agent or the user chooses from the list and may move the edges.
const r3 = (n) => Math.round(n * 1000) / 1000;

// ---------- chunks for transcription ----------
// silences: [{ start, end }] in seconds. Returns [{ start, end }] covering 0..duration, each at
// most maxLen long, cut in the middle of the longest pause found in the last fifth of each piece.
export function chunkPlan(duration, silences = [], maxLen = 1200) {
  if (duration <= maxLen) return [{ start: 0, end: r3(duration) }];
  const chunks = [];
  let at = 0;
  while (duration - at > maxLen) {
    const lo = at + maxLen * 0.8, hi = at + maxLen;
    const pause = silences.filter((s) => s.start >= lo && s.end <= hi && s.end - s.start >= 0.25).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    const cut = pause ? (pause.start + pause.end) / 2 : hi;
    chunks.push({ start: r3(at), end: r3(cut) });
    at = cut;
  }
  chunks.push({ start: r3(at), end: r3(duration) });
  return chunks;
}
// Words from each chunk, moved to the whole recording's clock and kept in order.
export function mergeChunks(chunks, lists) {
  const out = [];
  chunks.forEach((c, i) => {
    for (const w of lists[i] || []) {
      const start = r3(w.start + c.start), end = r3(w.end + c.start);
      if (!w.text || end < start || start > c.end + 0.5) continue;
      if (out.length && start < out.at(-1).end) continue; // a word heard again across the seam
      out.push({ text: w.text, start, end });
    }
  });
  return out;
}

// The transcriber returns the words with their times and, separately, the full text. Sometimes
// the timed words come back bare ("miracle I read") while the text has the sentences
// ("miracle. I read"). Cuts, hooks and clips all need to know where sentences end, so the
// text's spelling of each word, punctuation and capitals included, is laid back onto the words.
export function restorePunctuation(words, text) {
  const tokens = (text || '').split(/\s+/).filter(Boolean), key = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let j = 0;
  return words.map((w) => {
    const k = key(w.text);
    if (!k) return w;
    // The same word a little further on: the text and the words can disagree by a token or two.
    for (let look = 0; look < 4 && j + look < tokens.length; look++) {
      if (key(tokens[j + look]) === k) { const text2 = tokens[j + look]; j += look + 1; return { ...w, text: text2 }; }
    }
    return w;
  });
}

// ---------- clips ----------
const FILLER = new Set(`a an and are as at be been but by can could did do does for from had has have he her here him his how i if in into is it its just
  like me more most my no not of on one only or our out over she so some than that the their them then there these they this those to too under up us very was we
  were what when where which who why will with would you your also about after again all any back because before being both come came each even ever every
  get got going gonna have having know let lot made make many much need never now off okay really right said say says see should still such sure take thing
  things think time today want way well went yeah yes
  ang ng na sa si mga ay at ako ko mo ka ito iyan iyon yan yun yung din rin lang naman po opo pa ba kasi para pero hindi wala meron may tayo kami sila
  nila natin namin niya siya kayo dito doon ganun ganito tapos kaya nga daw raw pala talaga lahat kung nang nung noon ngayon ano bakit paano sino saan`.split(/\s+/).filter(Boolean));
const bare = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ends = (w) => /[.!?]["')\]]?$/.test(w.text);
// A line that leans on what came before cannot open a clip.
const LEANS = /^(and|but|so|because|then|also|or|which|that's why|that is why|anyway|meanwhile|kaya|tapos|pero|kasi|at saka)\b/i;
const POINTS_BACK = /^(it|that|they|them|he|she|those|these|this one|same)\b/i;
// Talk about the recording itself, not the subject.
const HOUSEKEEPING = /\b(hello|hi everyone|good (morning|afternoon|evening)|can you hear|bear with me|say hi|in the comments|where you'?re watching|thanks? (you )?for (watching|joining|tuning)|like and (subscribe|follow)|see you (next|tomorrow|soon)|stay (safe|dry)|take care|that'?s (it|all) for (today|now|tonight)|first time doing live|talking to a wall|is this (thing )?on|let me (check|fix|share)|one (second|sec|moment)|stay with me|i'?ll be right back|goodbye|bye)\b/i;
const CHARGED = /\b(never|always|secret|free|stop|mistake|wrong|best|worst|truth|nobody|everyone|only|biggest|honest|wala|lahat|libre|sikreto|mali|totoo|pinaka)\w*/i;
const OPENERS = /^(here'?s|this is|the|why|how|what|when|never|stop|don'?t|most|every|nobody|if you|there (is|are)|i (was|used|spent|wrote|learned)|let me (tell|show)|think of|now)\b/i;

function sentences(words) {
  const out = [];
  let s = 0;
  // A transcript that came back with few sentence ends (under one in forty words) is still usable:
  // a pause of 0.6 s or more is where a sentence ended, punctuated or not.
  const sparse = words.filter(ends).length < words.length / 40;
  const stops = (i) => ends(words[i]) || (sparse && words[i + 1] && words[i + 1].start - words[i].end >= 0.6);
  for (let i = 0; i < words.length; i++) {
    if (!stops(i) && i < words.length - 1) continue;
    const ws = words.slice(s, i + 1);
    out.push({ i0: s, i1: i, start: ws[0].start, end: ws.at(-1).end, text: ws.map((w) => w.text).join(' '), count: ws.length,
      content: new Set(ws.map((w) => bare(w.text)).filter((t) => t.length >= 4 && !FILLER.has(t))) });
    s = i + 1;
  }
  out.forEach((x, k) => { x.before = k ? x.start - out[k - 1].end : x.start; x.after = out[k + 1] ? out[k + 1].start - x.end : 9; });
  return out;
}
const union = (list) => { const u = new Set(); for (const s of list) for (const t of s.content) u.add(t); return u; };
const overlap = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const t of a) if (b.has(t)) n++; return n / Math.min(a.size, b.size); };

function openScore(s) {
  const why = [];
  let n = 0;
  if (HOUSEKEEPING.test(s.text)) return { n: -5, why };
  if (LEANS.test(s.text)) return { n: -3, why };
  if (POINTS_BACK.test(s.text)) n -= 1.5;
  if (/\?$/.test(s.text)) { n += 2; why.push('opens on a question'); }
  if (/\d/.test(s.text)) { n += 1.5; why.push('opens with a number'); }
  if (CHARGED.test(s.text)) { n += 1.5; why.push('opens on a strong word'); }
  if (/\b(you|your|ikaw|mo|ninyo)\b/i.test(s.text)) n += 0.7;
  if (OPENERS.test(s.text)) n += 1;
  if (s.count >= 4 && s.count <= 14) n += 0.8;
  if (s.before >= 0.8) { n += 0.7; why.push('starts after a pause'); }
  if (!why.length && n > 0) why.push('opens on a line that stands alone');
  return { n, why };
}
function closeScore(s, next) {
  const why = [];
  let n = 0;
  if (HOUSEKEEPING.test(s.text)) return { n: -4, why };
  // "Now the honest part." announces what comes next: it opens the next clip, it does not end this one.
  if (s.count <= 8 && /^(now|next|okay|so|here'?s|let'?s|let me|first|second|third)\b/i.test(s.text)) return { n: -3, why };
  if (s.after >= 1.2) { n += 1.6; why.push('ends before a long pause'); } else if (s.after >= 0.6) { n += 1; why.push('ends before a pause'); }
  if (s.count <= 8) { n += 0.8; why.push('ends on a short line'); }
  if (/\?$/.test(s.text)) n -= 0.8;
  if (next && LEANS.test(next.text)) n -= 1.5; // the thought runs on
  // A short line straight after, with no pause, is usually the punchline: do not stop one line early.
  if (next && next.count <= 5 && s.after < 0.6 && !HOUSEKEEPING.test(next.text)) n -= 1.2;
  if (next && (HOUSEKEEPING.test(next.text) || OPENERS.test(next.text))) n += 0.6;
  return { n, why };
}

// words: [{ text, start, end }] with sentence punctuation. Returns up to `count` clips, best
// first, none overlapping: { start, end, duration, score, opening, closing, text, topic, why }.
export function findClips(words, { count = 6, min = 20, max = 75 } = {}) {
  const S = sentences(words);
  if (!S.length) return [];
  // How rare a word is across the talk: a clip's subject is the words it uses that the rest does not.
  const df = new Map();
  for (const s of S) for (const t of s.content) df.set(t, (df.get(t) || 0) + 1);
  const opens = S.map(openScore);
  const all = [];
  for (let a = 0; a < S.length; a++) {
    if (opens[a].n < 1) continue;
    for (let b = a + 1; b < S.length; b++) {
      const dur = S[b].end - S[a].start;
      if (dur < min) continue;
      if (dur > max) break;
      const close = closeScore(S[b], S[b + 1]);
      if (close.n < 0) continue;
      const inside = S.slice(a, b + 1), mid = a + Math.ceil(inside.length / 2);
      // One subject: the two halves share words; a real boundary: the talk before and after does not.
      const cohesion = overlap(union(S.slice(a, mid)), union(S.slice(mid, b + 1)));
      const after = 1 - overlap(union(S.slice(Math.max(a, b - 2), b + 1)), union(S.slice(b + 1, b + 4)));
      const before = 1 - overlap(union(S.slice(a, a + 3)), union(S.slice(Math.max(0, a - 3), a)));
      const chatter = Math.min(3, inside.filter((s) => HOUSEKEEPING.test(s.text)).length);
      const length = dur >= 25 && dur <= 60 ? 1 : 0.4;
      const score = 2 * opens[a].n + 1.5 * close.n + 3 * cohesion + 1.5 * after + 1 * before + length - 1.5 * chatter;
      all.push({ a, b, dur, score, cohesion, why: [...opens[a].why, ...close.why] });
    }
  }
  all.sort((x, y) => y.score - x.score);
  const picked = [];
  for (const c of all) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.min(p.b, c.b) - Math.max(p.a, c.a) >= 0)) continue; // shares a sentence with a better one
    picked.push(c);
  }
  return picked.map((c) => {
    const inside = S.slice(c.a, c.b + 1);
    const tf = new Map();
    for (const s of inside) for (const t of s.content) tf.set(t, (tf.get(t) || 0) + 1);
    const topic = [...tf.entries()].map(([t, n]) => [t, n * Math.log(1 + S.length / df.get(t))]).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t]) => t);
    const why = [...c.why];
    if (c.cohesion >= 0.3) why.push(`stays on one subject (${topic.join(', ')})`);
    return { start: r3(S[c.a].start), end: r3(S[c.b].end), duration: r3(c.dur), score: Math.round(c.score * 10) / 10,
      opening: S[c.a].text, closing: S[c.b].text, text: inside.map((s) => s.text).join(' '), topic, why, sentences: inside.length };
  });
}

// A short file-safe name from a clip's subject words: "kong-wang-horses".
export const clipName = (clip) => (clip.topic.length ? clip.topic : clip.opening.split(/\s+/).map(bare).filter((t) => t.length >= 4).slice(0, 2)).join('-').slice(0, 30) || 'clip';
