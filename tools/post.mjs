// Fable post package: what goes out with a finished video. A cover image (a sharp frame with the
// face in it and the title on it) and a post sheet (caption options, hashtags, a before-you-post
// list, and the words for the description). The pure parts live here so they can be tested;
// fable.mjs picks the frame, draws the cover, and writes the files.
//
// Nothing here is invented: caption options are lines the speaker said or the text on screen, and
// hashtags are the words used most plus the standing ones from my-rules.md ("Hashtags: #a #b").
// The agent, or the user, turns an option into the final caption in their own voice.
const FILLER = new Set(`a an and are as at be been but by can could did do does for from had has have he her here him his how i if in into is it its just
  like me more most my no not of on one only or our out over she so some than that the their them then there these they this those to too under up us very was we
  were what when where which who why will with would you your yours also about after again all any back because before being both come came each even ever every
  get got going gonna great have having know let lot made make many much need never now off okay really right said say says see should still such sure take thing
  things think time today want way well went yeah yes
  ang ng na sa si mga ay at ako ko mo ka ito iyan iyon yan yun yung din rin lang naman po opo pa ba kasi para pero hindi wala meron may mayroon tayo kami sila
  nila natin namin niya siya kayo ninyo dito doon diyan ganun ganito tapos kaya nga daw raw pala talaga sobra lahat isa dalawa tatlo kung nang nung noon ngayon
  mamaya bukas kahapon ano bakit paano sino saan kailan alin gusto ayaw puwede pwede dapat kailangan`.split(/\s+/).filter(Boolean));
const bare = (t) => (t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const ends = (w) => /[.!?]["')\]]?$/.test(w.text);
export const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// The speaker's sentences, as strings, in order.
export function sentences(words) {
  const out = [];
  let cur = [];
  for (const w of words) { cur.push(w.text.trim()); if (ends(w)) { out.push(cur.join(' ')); cur = []; } }
  if (cur.length) out.push(cur.join(' '));
  return out.filter(Boolean);
}

// Text on screen as words, for the hashtags: emoji and accent stars dropped, and every line its
// own sentence, so a capital at the start of a line is not mistaken for a name.
export function screenWords(lines) {
  return lines.flatMap((line) => {
    const ws = line.replace(/\*/g, '').split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
    if (ws.length && !/[.!?]$/.test(ws.at(-1))) ws[ws.length - 1] += '.';
    return ws.map((text) => ({ text }));
  });
}

// Hashtags: the standing ones first, then only what the video is really about. A word earns its
// place by being said twice, by being a name (capitalized mid-sentence), or by being in the title;
// two words that keep coming together become one tag ("flood control" -> #floodcontrol). A word
// said once in passing is not a topic, so a short video may get only one or two: better than noise.
export function hashtags(words, standing = [], max = 6, title = []) {
  const score = new Map(), shown = new Map(), pairs = new Map();
  const titled = new Set(title.flatMap((l) => l.split(/\s+/)).map(bare).filter(Boolean));
  const ok = (t) => t.length >= 4 && !FILLER.has(t) && !/^\d+$/.test(t);
  words.forEach((w, i) => {
    const t = bare(w.text);
    if (!ok(t)) return;
    const name = /^[A-Z][a-z]/.test(w.text.replace(/^[^A-Za-z]+/, '')) && i > 0 && !ends(words[i - 1]);
    score.set(t, (score.get(t) || 0) + 1 + (name ? 1.5 : 0));
    if (!shown.has(t)) shown.set(t, i);
    const next = words[i + 1] && !ends(w) ? bare(words[i + 1].text) : '';
    if (ok(next)) pairs.set(`${t} ${next}`, (pairs.get(`${t} ${next}`) || 0) + 1);
  });
  for (const t of titled) if (score.has(t)) score.set(t, score.get(t) + 1.5);
  // A pair said together at least twice replaces its two words.
  for (const [pair, n] of pairs) {
    if (n < 2) continue;
    const [x, y] = pair.split(' ');
    score.set(x + y, Math.max(score.get(x) || 0, score.get(y) || 0) + 0.5);
    shown.set(x + y, shown.get(x));
    score.delete(x); score.delete(y);
  }
  const picked = [...score.entries()].filter(([, n]) => n >= 2).sort((p, q) => q[1] - p[1] || shown.get(p[0]) - shown.get(q[0])).map(([t]) => `#${t}`);
  const first = standing.map((t) => `#${bare(t)}`).filter((t) => t.length > 1);
  return [...new Set([...first, ...picked])].slice(0, Math.max(max, first.length));
}

// Caption options from what was said: the title on the cover, the opening line, the closing line
// (often the takeaway), each only once.
export function captionOptions({ title = null, said = [] }) {
  const options = [];
  const add = (text, why) => { const t = (text || '').replace(/\s+/g, ' ').trim(); if (t.length >= 6 && !options.some((o) => bare(o.text) === bare(t))) options.push({ text: t, why }); };
  const sentence = (s) => s.replace(/(^|[.!?]\s+)([a-z])/g, (m, lead, ch) => lead + ch.toUpperCase());
  if (title && title.join(' ').split(/\s+/).length >= 3) add(sentence(title.join(' ').toLowerCase()).replace(/\bi\b/g, 'I'), 'the title on the cover');
  if (said.length) add(said.slice(0, said[0].split(' ').length < 5 && said[1] ? 2 : 1).join(' '), 'the opening line');
  if (said.length > 2) add(said.at(-1).split(' ').length < 5 ? said.slice(-2).join(' ') : said.at(-1), 'the closing line, often the takeaway');
  return options;
}

// Where the title goes on the cover, as a fraction of the height: under the chin when there is
// room, else above the forehead, and always inside the middle of the frame, because profile grids
// crop a 9:16 cover to its center.
export function coverCenter(face, blockFrac = 0.14) {
  const half = blockFrac / 2, lo = 0.2 + half, hi = 0.8 - half;
  if (!face) return Math.min(hi, 0.68);
  const under = face.chin + 0.04 + half, over = face.top - 0.03 - half;
  if (under <= hi) return Math.max(lo, under);
  if (over >= lo) return over;
  return hi;
}

// The post sheet. p: { slug, video, duration, frame, cover, coverAt, title, said, onScreen, words,
// standing, tag, quiet, checkLine, titled } (title: the words; titled: they are drawn on the cover)
export function postSheet(p) {
  const options = captionOptions({ title: p.title, said: p.said?.length ? p.said : p.onScreen || [] });
  const tags = hashtags(p.words || [], p.standing || [], 6, p.title || []);
  const todo = [
    p.cover ? `[ ] Upload ${p.cover} as the cover (TikTok: "Edit cover", Reels: "Edit cover" then "Add from camera roll").` : null,
    p.tag ? `[ ] Turn on the app's AI-generated label. This video carries the "${p.tag}" tag, and the apps ask for theirs too.` : null,
    p.quiet ? `[ ] Add the sound in the app: the video's own track is ${p.quiet}.` : null,
    '[ ] Read the caption out loud once. Does it sound like you?',
    p.checkLine ? `[ ] Draft check: ${p.checkLine}.` : null,
  ].filter(Boolean);
  const body = p.said?.length ? ['WHAT IS SAID (for the description, alt text, or a pinned comment)', '', p.said.join(' ')] : p.onScreen?.length ? ['WHAT IS ON SCREEN', '', ...p.onScreen] : [];
  return [
    `POST PACKAGE: ${p.slug}`, '',
    `Video:  ${p.video}${p.duration ? ` (${p.duration.toFixed(1)} s${p.frame ? `, ${p.frame}` : ''})` : ''}`,
    p.cover ? `Cover:  ${p.cover}${p.coverAt !== undefined ? ` (the frame at ${clock(p.coverAt)}${p.titled ? ', with the title on it' : ''})` : ''}` : 'Cover:  none made',
    '',
    'CAPTION (pick one, then make it yours)', '',
    ...(options.length ? options.map((o, i) => `${i + 1}. ${o.text}\n   (${o.why})`) : ['(no words to draw from: write one line that says what the viewer gets)']),
    '',
    'HASHTAGS', '',
    tags.length ? tags.join(' ') : '(no word is said often enough to be a topic: add two or three of your own)',
    `(${p.standing?.length ? 'your standing tags first, then ' : ''}only what this video keeps coming back to${tags.length < 3 ? '; add your own topic tags' : ''}. Always-on tags go in my-rules.md as "Hashtags: #one #two".)`,
    '',
    'BEFORE YOU POST', '',
    ...todo,
    '',
    ...body,
    '',
  ].join('\n');
}
