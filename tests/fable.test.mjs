import test from 'node:test';
import assert from 'node:assert/strict';
import { planCuts, timeline, buildCaptions, hookCandidates, chooseHook, hookGate, insideSilence, untranscribed, layoutFor, ruleApplies } from '../fable.mjs';
import { buildAss, captionLayout } from '../tools/fast-render.mjs';

const W = (text, start, end) => ({ text, start, end });
const tight = { pace: 'tight', captions: 'word', position: 'upper', color: '#ffffff', accent: '#facc15', hook: true, format: 'vertical' };
const prayer = [W('In', 0.1, 0.3), W('the', 0.35, 0.5), W('name', 0.55, 0.8), W('of', 0.85, 0.95), W('the', 1.0, 1.1), W('Father.', 1.15, 1.6),
  W('Phi', 2.6, 2.9), W('Phi', 2.95, 3.2), W('pray', 3.25, 3.6), W('na.', 3.65, 3.9),
  W('In', 4.9, 5.1), W('the', 5.15, 5.3), W('name', 5.35, 5.6), W('of', 5.65, 5.75), W('the', 5.8, 5.9), W('Father,', 5.95, 6.4),
  W('the', 6.5, 6.6), W('Son.', 6.65, 7.0)];

test('a pause is only cut where the audio is actually quiet', () => {
  // Gap 1.6-2.6 holds untranscribed speech (no silence there); gap 3.9-4.9 is real silence.
  const silences = [{ start: 3.95, end: 4.85 }];
  const r = planCuts(prayer, 7.5, tight, silences);
  assert.ok(!r.deletes.some((d) => d.start < 2.6 && d.end > 1.6), 'kept the unquiet gap');
  assert.ok(r.deletes.some((d) => d.start >= 3.95 && d.end <= 4.85), 'cut inside the quiet gap');
  assert.equal(r.missed.length, 1);
  assert.ok(r.missed[0].start >= 1.6 && r.missed[0].end <= 2.6);
});

test('without silence data the transcript gap is trusted (legacy behaviour)', () => {
  const r = planCuts(prayer, 7.5, tight, null);
  assert.ok(r.deletes.some((d) => d.start > 1.6 && d.end < 2.6));
});

test('a repeated name is never cut as a stutter', () => {
  const r = planCuts(prayer, 7.5, tight, [{ start: 3.95, end: 4.85 }], ['Phi Phi']);
  assert.ok(!r.deletes.some((d) => /stutter/.test(d.reason)));
  assert.ok(r.suggestions.some((s) => s.kind === 'repeat kept'));
  // Capitalised pair mid-sentence is treated as a name even without my-rules.md.
  const r2 = planCuts([W('So', 0, 0.2), W('Phi', 0.4, 0.6), W('Phi', 0.65, 0.9), W('sits.', 1, 1.3)], 2, tight, null);
  assert.ok(!r2.deletes.some((d) => /stutter/.test(d.reason)));
});

test('a plain stutter in silence is cut; a chanted run collapses to one note', () => {
  const r = planCuts([W('the', 0.5, 0.6), W('the', 0.9, 1.0), W('cat', 1.1, 1.4)], 2, tight, null);
  assert.ok(r.deletes.some((d) => /stutter "the"/.test(d.reason)));
  const na = Array.from({ length: 8 }, (_, i) => W('na', 1 + i * 0.2, 1.15 + i * 0.2));
  const r2 = planCuts([W('Okay', 0, 0.3), ...na, W('done.', 3, 3.3)], 4, tight, null);
  // Eight 'na' in a row are one deliberate repeat, listed once, never cut.
  assert.equal(r2.suggestions.filter((s) => /"na/.test(s.reason)).length, 1);
  assert.ok(!r2.deletes.some((d) => /stutter/.test(d.reason)));
});

test('a short retake is suggested by the four-word match, never cut by default', () => {
  const r = planCuts(prayer, 7.5, tight, null);
  const retakes = r.suggestions.filter((s) => s.kind === 'possible retake');
  assert.equal(retakes.length, 1);
  assert.ok(Math.abs(retakes[0].start - 0.1) < 0.01 && Math.abs(retakes[0].end - 4.9) < 0.01);
  assert.ok(!r.deletes.some((d) => /retake/.test(d.reason)));
  const auto = planCuts(prayer, 7.5, { ...tight, retakes: 'cut' }, null);
  assert.ok(auto.deletes.some((d) => /retake/.test(d.reason)), 'opt-in auto cut');
});

test('timeline keeps a word that a cut only nicked and reports words that fell inside cuts', () => {
  const keeps = [{ src0: 0, src1: 0.45 }, { src0: 2.0, src1: 4.0 }];
  const tl = timeline(keeps, prayer);
  assert.ok(tl.words.some((w) => w.text === 'the' && w.i === 1), 'the (0.35-0.5) is kept: more than half inside');
  // 'name' (0.55-0.8) is wholly inside the removed part: meant to go, not reported. 'the' (0.35-0.5) is nicked.
  assert.ok(!tl.dropped.some((d) => d.text === 'name'));
  const nick = timeline([{ src0: 0, src1: 0.38 }], prayer);
  assert.ok(nick.dropped.some((d) => d.text === 'the' && d.at === 0.35), 'a word a cut edge clipped is reported');
  assert.ok(tl.words.every((w, i) => !i || w.start >= tl.words[i - 1].start));
});

test('fast words group into chunks of up to three, never across a pause', () => {
  const words = prayer.map((w, i) => ({ ...w, i }));
  const caps = buildCaptions(words, tight, 0, 8);
  assert.ok(caps.some((c) => c.text === 'IN THE NAME'));
  assert.ok(caps.every((c) => c.text.split(' ').length <= 3));
  assert.ok(caps.every((c) => c.end > c.start));
  // No chunk spans the 1 s pause between Father. and Phi.
  assert.ok(!caps.some((c) => c.start < 1.6 && c.end > 2.6));
});

test('hook candidates come from the speaker, and a mis-typed end is repaired', () => {
  const words = prayer.map((w, i) => ({ ...w, i }));
  const c = hookCandidates(words, 'x');
  assert.ok(c.length >= 1 && c[0].pattern === 'claim' && c[0].source.length > 0);
  const ms = chooseHook({ hook: { lines: ['A', 'B'], end: 2200 } }, words, tight).hook;
  assert.equal(ms.end, 2.2);
  const str = chooseHook({ hook: { lines: ['A'], end: '2.2s' } }, words, tight).hook;
  assert.equal(str.end, 2.2);
  const none = chooseHook({ hook: null }, words, tight).hook;
  assert.equal(none, null);
});

test('hook and captions sit below the top 14% and clear of each other, in both renderers', () => {
  const lay = layoutFor('vertical', { width: 1080, height: 1920 });
  const L = captionLayout(lay, tight);
  assert.ok(L.hookY - L.hookBlock / 2 >= Math.round(0.14 * 1920));
  assert.ok(L.capY - L.word * 0.7 >= L.hookY + L.hookBlock / 2);
  const plan = { duration: 5, words: [W('How', 0.1, 0.3), W('does', 0.35, 0.5), W('Phi', 0.55, 0.7), W('Phi', 0.75, 0.9), W('pray?', 0.95, 1.3)], captions: [{ kind: 'word', text: 'HOW', start: 0.1 - 2 / 30, end: 0.5 }], hook: { lines: ['HOW DOES', 'PHI PHI PRAY?'], end: 2.2, pattern: 'question', source: [1] } };
  const gate = hookGate(plan, tight, lay);
  assert.ok(gate.every((g) => g.pass), JSON.stringify(gate.filter((g) => !g.pass)));
  const ass = buildAss({ ...plan, slug: 't', segments: [] }, lay, tight);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:02\.20,Hook/);
  assert.match(ass, /\pos\(540,(3[89]\d|4\d\d)\)/);
});

test('untranscribed speech is the voiced time with no words in it', () => {
  const m = untranscribed([W('a', 0, 1)], [{ start: 1, end: 2 }, { start: 4, end: 10 }], 10);
  assert.deepEqual(m, [{ start: 2, end: 4 }]);
  assert.equal(insideSilence(0, 1, [{ start: 5, end: 6 }]), null);
});

test('a scoped rule fires only for the media it names', () => {
  const reel = { vertical: true, duration: 25 }, tutorial = { vertical: false, duration: 600 };
  assert.equal(ruleApplies('- [9:16] Hook: always', reel), true);
  assert.equal(ruleApplies('- [9:16] Hook: always', tutorial), false);
  assert.equal(ruleApplies('- [16:9] [>90s] Captions: subtitles', tutorial), true);
  assert.equal(ruleApplies('- [16:9] [>90s] Captions: subtitles', { vertical: false, duration: 30 }), false);
  assert.equal(ruleApplies('- [<90s] Pace: tight', reel), true);
  assert.equal(ruleApplies('- Pace: tight', tutorial), true);
  assert.equal(ruleApplies('- [9:16] Hook: always', null), true);
});

test('script-aware captions: the script spelling wins, missed words are inserted, guesses dropped', async () => {
  const { alignScript, hookFromScript } = await import('../tools/script-align.mjs');
  // Transcript heard "Stevie" for "Phi Phi", merged "pray na" into "prayna", missed "Amen", added a stray "uh".
  const heard = [W('How', 0, 0.3), W('does', 0.35, 0.5), W('Stevie', 0.55, 0.9), W('pray?', 0.95, 1.3), W('uh', 1.4, 1.5), W('In', 2.0, 2.2), W('the', 2.25, 2.4), W('name', 2.45, 2.7), W('of', 2.75, 2.85), W('the', 2.9, 3.0), W('Father.', 3.05, 3.5), W('Ayaw.', 5.0, 5.4)];
  const script = 'Hook: How does Phi Phi pray?\nHow does Phi Phi pray?\nIn the name of the Father. Amen.\nAyaw.';
  const r = alignScript(heard, script);
  const fixed = heard.map((w, i) => r.fixes[String(i)] ?? w.text).filter((t) => t !== '');
  const shown = [...fixed, ...r.extra.map((x) => x.text)];
  assert.ok(shown.filter((t) => t === 'Phi').length === 2 && !shown.includes('Stevie'), 'name taken from the script, in place of the guess');
  assert.ok(!shown.includes('uh'), 'stray guess dropped');
  const phi = r.extra.filter((x) => x.text === 'Phi');
  if (phi.length) assert.ok(phi.every((x) => x.start >= 0.5 && x.end <= 0.95), 'inserted name sits where the guess was');
  assert.ok(r.extra.some((x) => x.text === 'Amen.' && x.start >= 3.5 && x.end <= 5.0), 'Amen inserted between Father and Ayaw');
  assert.ok(r.stats.matched >= 9);
  assert.equal(hookFromScript(script), 'How does Phi Phi pray?');
  assert.equal(hookFromScript('Line one here.\nLine two.'), 'Line one here');
});

test('stitch: the brief sets clip order and caption; saved outputs are not clips', async () => {
  const { parseBrief, orderClips, wrapCaption, isOutput } = await import('../tools/stitch.mjs');
  const b = parseBrief('Kling 3.0 short\n\nCLIPS (in order):\n1) 4s — "Welcome"\n2) 5s — "Exits"\n3) 6s — "Seated"\n\nCAPTION (on screen the whole video):\nFormer flight attendant\'s first day as a wedding officiant\nStyle: white bold\n');
  assert.deepEqual(b.clips.map((c) => c.seconds), [4, 5, 6]);
  assert.equal(b.caption, "Former flight attendant's first day as a wedding officiant");
  assert.ok(b.ai);
  assert.equal(parseBrief('Caption: Hello there').caption, 'Hello there');
  const clips = [{ name: 'All-guests.mp4', duration: 6.04 }, { name: 'The-officiant-in.mp4', duration: 4.04 }, { name: 'The-officiant-keeps.mp4', duration: 5.04 }, { name: 'extra.mp4', duration: 9 }];
  const r = orderClips(clips, b.clips);
  assert.equal(r.by, 'brief durations');
  assert.deepEqual(r.order.map((c) => c.name), ['The-officiant-in.mp4', 'The-officiant-keeps.mp4', 'All-guests.mp4']);
  assert.deepEqual(r.skipped.map((c) => c.name), ['extra.mp4']);
  // Two clips the same length: the brief cannot tell them apart, so file name order.
  assert.equal(orderClips([{ name: 'b.mp4', duration: 4 }, { name: 'a.mp4', duration: 4 }], [{ seconds: 4 }, { seconds: 4 }]).order[0].name, 'a.mp4');
  assert.deepEqual(orderClips([{ name: 'clip-10.mp4', duration: 1 }, { name: 'clip-2.mp4', duration: 1 }]).order.map((c) => c.name), ['clip-2.mp4', 'clip-10.mp4']);
  const lines = wrapCaption(b.caption);
  assert.ok(lines.length <= 3 && lines.join(' ') === b.caption);
  assert.ok(isOutput('officiant_final.mp4') && isOutput('reel-v2.mp4') && !isOutput('The-officiant-in.mp4'));
});

test('caption script: timed lines, open ends, tags, directives, and reading-speed warnings', async () => {
  const { parseCaptionScript, captionCenter } = await import('../tools/caption-script.mjs');
  const s = parseCaptionScript([
    '# a comment', 'position: lower', 'tag: AI-generated', 'audio: mute', '',
    '0-1.3  [title] [serif] KA-VOGUE,',
    '1.3    ang laki ng next / water bill mo.',
    "2.9-4  I don't care. 🙂",
    '0:06   [big] *Nasaan?* 👀',
  ].join('\n'), 10);
  assert.deepEqual(s.problems, []);
  assert.equal(s.position, 'lower');
  assert.equal(s.tag, 'AI-generated');
  assert.equal(s.audio, 'mute');
  assert.deepEqual(s.captions.map((c) => [c.start, c.end]), [[0, 1.3], [1.3, 2.9], [2.9, 4], [6, 10]]);
  assert.deepEqual(s.captions[0].tags, ['title', 'serif']);
  assert.deepEqual(s.captions[1].lines, ['ang laki ng next', 'water bill mo.']);
  assert.deepEqual(s.captions[3].lines, ['*Nasaan?* 👀']);
  // A line with no time, an unknown tag, and a bad trim are problems, each with its line number.
  const bad = parseCaptionScript('hello there\n2 [huge] hi\ntrim: 9-3', 10);
  assert.equal(bad.problems.length, 3);
  assert.match(bad.problems[0], /^line 1:/);
  // Too many words for the time is a warning, not a stop; so is an end that runs into the next line.
  const fast = parseCaptionScript('0-1 one two three four five six seven\n0.5-2 ok', 10);
  assert.equal(fast.problems.length, 0);
  assert.ok(fast.warnings.some((w) => /too fast to read/.test(w)));
  // Trim: times count from the trim start, and the last open line ends with the trimmed video.
  const t = parseCaptionScript('trim: 5-9\n0 hello\n2 world', 30);
  assert.deepEqual(t.captions.map((c) => [c.start, c.end]), [[0, 2], [2, 4]]);
  // Long text without a hand break is balanced over up to three lines.
  const w = parseCaptionScript('0-6 This is the only flood control project that really works', 10);
  assert.ok(w.captions[0].lines.length >= 2 && w.captions[0].lines.length <= 3);
  // Default spot: under the chin when the face was measured, always inside the free band.
  const face = { face_top_p10: 0.3, chin_p90: 0.55 };
  assert.ok(captionCenter(null, face, 0.1) >= 0.55 + 0.03 + 0.05 - 1e-9);
  assert.ok(captionCenter(null, null, 0.1) > 0.5 && captionCenter(0.99, null, 0.1) <= 0.75 + 1e-9);
  assert.ok(captionCenter('upper', face, 0.1) < 0.3);
});

test('motion: punch-ins on the lines that carry weight, number callouts, step labels only for a real list', async () => {
  const { planMotion, zoomFilter, zoomAnchor } = await import('../tools/motion.mjs');
  const say = (text, t0, gap = 0.3) => text.split(' ').map((w, i) => W(w, r(t0 + i * gap), r(t0 + i * gap + 0.25)));
  const r = (n) => Math.round(n * 1000) / 1000;
  const words = [
    ...say('Here is the thing about the trial that nobody mentions out loud.', 0.2),
    ...say('It stopped for 24 days.', 4.5),
    ...say('The senate moved on to the budget and kept going like nothing happened at all.', 6.5),
    ...say("Don't lend it.", 12.0),
    ...say('They spent 7.2 trillion pesos, and that was only the start of it.', 13.5),
    ...say('October 16, they came back to the floor.', 18.0),
  ];
  const segments = [{ out0: 0, out1: 12 }, { out0: 12, out1: 21 }];
  const some = planMotion(words, segments, 21, { graphics: 'some', captions: 'word' }, 2.4);
  // Nothing during the hook; every zoom starts on a sentence and never overlaps another.
  assert.ok(some.zooms.length >= 2);
  assert.ok(some.zooms.every((z) => z.start >= 2.4 && z.end > z.start && z.scale === 1.1));
  for (let i = 1; i < some.zooms.length; i++) assert.ok(some.zooms[i].start >= some.zooms[i - 1].end + 3 - 1e-6);
  // The short punchy line is punched in, hard because it sits on a cut.
  const lend = some.zooms.find((z) => /lend/.test(z.on));
  assert.ok(lend && lend.in === 0);
  // Figures with their unit become callouts; a date ("October 16") does not.
  assert.deepEqual(some.cards.map((c) => c.text), ['24 DAYS', '7.2 TRILLION PESOS']);
  assert.ok(some.cards.every((c) => c.kind === 'stat' && c.end > c.start));
  // Callouts stand in for word captions, so other caption modes get none.
  assert.equal(planMotion(words, segments, 21, { graphics: 'some', captions: 'subtitles' }, 2.4).cards.length, 0);
  // minimal plans nothing; heavy allows more than some.
  assert.deepEqual(planMotion(words, segments, 21, { graphics: 'minimal', captions: 'word' }, 2.4), { zooms: [], cards: [] });
  assert.ok(planMotion(words, segments, 21, { graphics: 'heavy', captions: 'word' }, 2.4).zooms.length >= some.zooms.length);
  // One "first" is a figure of speech; a list that counts up gets step labels.
  const once = planMotion(say('First I thought it was a joke and I laughed about it.', 3), [{ out0: 0, out1: 9 }], 9, { graphics: 'some', captions: 'word' }, 0);
  assert.equal(once.cards.length, 0);
  const list = [...say('Here are the rules I follow every single day now.', 0.2), ...say('Rule number one, drink water before coffee.', 4), ...say('Rule number two, walk after every meal you eat.', 8), ...say('Third, sleep by ten.', 13)];
  const steps = planMotion(list, [{ out0: 0, out1: 16 }], 16, { graphics: 'some', captions: 'word' }, 0).cards.filter((c) => c.kind === 'step');
  assert.deepEqual(steps.map((c) => c.text), ['RULE 1', 'RULE 2', '#3']);
  // The filter: nothing without zooms; with them, a per-frame scale laid over a canvas at the anchor.
  assert.deepEqual(zoomFilter([], 1080, 1920, { x: 0.5, y: 0.4 }, 10, '[0:v]', '[z]'), []);
  const f = zoomFilter([{ start: 2, end: 4, scale: 1.1, in: 0.13, out: 0 }], 1080, 1920, { x: 0.5, y: 0.2 }, 10, '[0:v]', '[z]').join(';');
  assert.match(f, /eval=frame/);
  assert.match(f, /clip\(\(t-2\)\/0\.13,0,1\)\*lt\(t,4\)/);
  assert.match(f, /\[z\]$/);
  // The anchor keeps the edge of the face nearest the text where it was.
  const face = { face_top_p10: 0.2, chin_p90: 0.6, cx_median: 0.55, cy_median: 0.4 };
  assert.equal(zoomAnchor(face, 'upper').y, 0.2);
  assert.equal(zoomAnchor(face, 'lower').y, 0.6);
  assert.deepEqual(zoomAnchor(null, 'upper'), { x: 0.5, y: 0.4 });
});

test('motion in the fast renderer: a callout replaces the word captions under it', () => {
  const lay = layoutFor('vertical', { width: 1080, height: 1920 });
  const plan = { slug: 't', duration: 6, segments: [], hook: null, words: [],
    captions: [{ kind: 'word', text: 'FOR', start: 1, end: 1.4, key: false }, { kind: 'word', text: '24', start: 1.4, end: 1.8, key: true }, { kind: 'word', text: 'DAYS', start: 1.8, end: 2.3, key: true }, { kind: 'word', text: 'THEN', start: 2.6, end: 3, key: false }],
    motion: { zooms: [], cards: [{ kind: 'stat', text: '24 DAYS', start: 1.4, end: 2.5 }, { kind: 'step', text: 'RULE 1', start: 4, end: 5.8 }] } };
  const ass = buildAss(plan, lay, tight);
  const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(lines.filter((l) => /,Stat,/.test(l) && /24 DAYS$/.test(l)).length, 1);
  assert.equal(lines.filter((l) => /,Step,/.test(l) && /RULE 1$/.test(l) && /\move/.test(l)).length, 1);
  assert.equal(lines.filter((l) => /,Word,/.test(l)).length, 2); // FOR and THEN; 24 and DAYS are the callout
});

test('clean: only what a rebuild writes again goes; the working copy goes only while the original exists', async () => {
  const { cleanTargets, projectKind } = await import('../tools/clean.mjs');
  assert.equal(projectKind(['edit.json', 'assets']), 'edit');
  assert.equal(projectKind(['caption.json', 'captions.txt']), 'caption');
  assert.equal(projectKind(['stitch.json']), 'stitch');
  assert.equal(projectKind(['build.py', 'assets']), 'hand');
  const f = (path, size = 100) => ({ path, size });
  const files = [f('edit.json'), f('index.html'), f('assets/raw.mp4', 5000), f('assets/raw.json'), f('assets/plan.json'), f('assets/face.json'),
    f('assets/footage.mp4', 3000), f('assets/voice.wav'), f('assets/mix.wav'), f('assets/proxy.mp4'), f('assets/captions.ass'), f('assets/review-open.png'),
    f('assets/sfx/pop.wav'), f('assets/fonts/Montserrat-Bold.ttf'), f('assets/broll/pexels-123.mp4'), f('assets/broll/b0-1080x1920.mp4'), f('assets/broll/ledger.json'),
    f('renders/talk-v2.mp4'), f('renders/talk-final.mp4'), f('renders/archive/old.mp4'), f('assets/my-own-graphic.png')];
  const delivered = new Set(['talk-final.mp4']);
  const paths = (r) => r.remove.map((x) => x.path).sort();
  const done = cleanTargets(files, { kind: 'edit', delivered, sourceExists: true, settled: true });
  // Kept: every decision and measurement, the hand-edited page, B-roll downloads, a render that is
  // not in the outbox, and files Fable does not recognize.
  for (const keep of ['edit.json', 'index.html', 'assets/raw.json', 'assets/plan.json', 'assets/face.json', 'assets/broll/pexels-123.mp4', 'assets/broll/ledger.json', 'renders/talk-v2.mp4', 'renders/archive/old.mp4', 'assets/my-own-graphic.png']) assert.ok(!paths(done).includes(keep), keep);
  for (const gone of ['assets/raw.mp4', 'assets/footage.mp4', 'assets/voice.wav', 'assets/mix.wav', 'assets/proxy.mp4', 'assets/captions.ass', 'assets/review-open.png', 'assets/sfx/pop.wav', 'assets/fonts/Montserrat-Bold.ttf', 'assets/broll/b0-1080x1920.mp4', 'renders/talk-final.mp4']) assert.ok(paths(done).includes(gone), gone);
  // The original is gone: the working copy is the only copy, so it stays and the notes say why.
  const orphan = cleanTargets(files, { kind: 'edit', delivered, sourceExists: false, settled: true });
  assert.ok(!paths(orphan).includes('assets/raw.mp4') && /only copy/.test(orphan.notes.join(' ')));
  // Still being edited (--all): the working copy stays so the next rebuild is not slowed down.
  assert.ok(!paths(cleanTargets(files, { kind: 'edit', delivered, sourceExists: true, settled: false })).includes('assets/raw.mp4'));
  // Hand-built projects are never touched, whatever is in them.
  assert.deepEqual(cleanTargets(files, { kind: 'hand', delivered, sourceExists: true, settled: true }).remove, []);
  // Caption and stitch projects give back their drawn cards and font copy, not their lines.
  const cap = cleanTargets([f('caption.json'), f('captions.txt'), f('assets/cap00.png'), f('assets/tag.png'), f('assets/face.json'), f('assets/review-shots.png')], { kind: 'caption', delivered, settled: true });
  assert.deepEqual(paths(cap), ['assets/cap00.png', 'assets/review-shots.png', 'assets/tag.png']);
  assert.deepEqual(paths(cleanTargets([f('stitch.json'), f('assets/caption.ttf'), f('assets/caption.txt')], { kind: 'stitch', delivered, settled: true })), ['assets/caption.ttf']);
});

test('draft check: the file, the sound, the picture, and text against the app buttons and the face', async () => {
  const { parseDetect, checkFindings, safeZoneFindings, faceFindings, verdict, checkLines } = await import('../tools/check.mjs');
  const stderr = [
    '[blackdetect @ 0x1] black_start:0 black_end:0.4 black_duration:0.4',
    '[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 27.5',
    '[Parsed_ebur128_0 @ 0x3] Summary:', '', '  Integrated loudness:', '    I:         -25.2 LUFS', '    Threshold: -35.5 LUFS', '', '  Loudness range:', '    LRA:         2.7 LU', '', '  True peak:', '    Peak:       -0.1 dBFS',
  ].join('\n');
  const d = parseDetect(stderr);
  assert.deepEqual(d.black, [{ start: 0, end: 0.4 }]);
  assert.deepEqual(d.freezes, [{ start: 27.5, end: Infinity }]);
  assert.deepEqual(d.loudness, { I: -25.2, peak: -0.1 });
  const probe = { width: 1080, height: 1920, duration: 30, fps: 30, hasAudio: true, audioDuration: 30 };
  const box = (text, start, end, y0, y1, x0 = 240, x1 = 840) => ({ kind: 'caption', text, start, end, x0, y0, x1, y1 });
  // A face in the middle of the frame: brows near 40%, mouth at 52%, chin at 58%.
  const faces = Array.from({ length: 60 }, (_, i) => ({ t: i / 2, cx: 0.5, cy: 0.46, top: 0.34, chin: 0.58, eyes: 0.42, mouth: 0.52 }));
  // Text on the forehead is how captions usually sit: fine. On the eyes: look. Over the mouth: fix.
  assert.equal(faceFindings([box('FOREHEAD', 0, 5, 620, 740)], faces, 1080, 1920)[0].level, 'ok');
  assert.equal(faceFindings([box('EYES', 0, 5, 760, 880)], faces, 1080, 1920)[0].level, 'look');
  const mouth = faceFindings([box('MOUTH', 2, 4, 940, 1040)], faces, 1080, 1920);
  assert.equal(mouth[0].level, 'fix');
  assert.match(mouth[0].text, /00:02\.0-00:03\.5 \("MOUTH"\)/);
  // Text beside the face, or shown when no face is on screen, is not a problem.
  assert.equal(faceFindings([box('SIDE', 0, 5, 940, 1040, 40, 300)], faces, 1080, 1920)[0].level, 'ok');
  assert.equal(faceFindings([box('LATER', 40, 45, 940, 1040)], faces, 1080, 1920)[0].level, 'ok');
  // The band the apps leave free: below the top 14%, above the bottom 20%. The AI tag is exempt.
  assert.equal(safeZoneFindings([box('FINE', 0, 2, 400, 520)], 1080, 1920)[0].level, 'ok');
  assert.match(safeZoneFindings([box('HIGH', 0, 2, 120, 240)], 1080, 1920)[0].text, /above the top 269px/);
  assert.match(safeZoneFindings([box('LOW', 0, 2, 1500, 1620)], 1080, 1920)[0].text, /below 1536px/);
  assert.equal(safeZoneFindings([{ ...box('AI', 0, 30, 250, 290), kind: 'tag' }], 1080, 1920)[0].level, 'ok');
  // Everything together: black on frame 0 is a fix; quiet sound, hot peaks and a frozen ending are looks.
  const all = checkFindings({ probe, ...d, faces, boxes: [box('MOUTH', 2, 4, 940, 1040)] });
  const v = verdict(all);
  assert.equal(v.fix, 2);
  assert.ok(all.some((f) => f.level === 'fix' && /black at the very start/.test(f.text)));
  assert.ok(all.some((f) => f.level === 'look' && /quiet: -25.2 LUFS/.test(f.text)));
  assert.ok(all.some((f) => f.level === 'look' && /peaks reach -0.1/.test(f.text)));
  assert.ok(all.some((f) => f.level === 'look' && /frozen for the last 2.5 s/.test(f.text)));
  const lines = checkLines(all, 'assets/check-moments.jpg');
  assert.match(lines[0], /^## Draft check: 2 to fix, 3 to look at$/);
  assert.ok(lines.indexOf(lines.find((l) => l.startsWith('- FIX'))) < lines.indexOf(lines.find((l) => l.startsWith('- LOOK'))));
  // A clean draft says so, and a video Fable did not build is honest about what it cannot know.
  const clean = checkFindings({ probe, black: [], freezes: [], loudness: { I: -14, peak: -1.5 }, faces, boxes: [box('FOREHEAD', 0, 5, 620, 740)] });
  assert.equal(verdict(clean).line, 'clean');
  assert.ok(checkFindings({ probe, black: [], freezes: [], loudness: { I: -14, peak: -1.5 }, faces, boxes: null }).some((f) => /not built by Fable/.test(f.text)));
  // A silent track and a missing one are different things.
  assert.ok(checkFindings({ probe, black: [], freezes: [], loudness: { I: -70, peak: -90 }, faces, boxes: [] }).some((f) => /silent/.test(f.text)));
  assert.ok(checkFindings({ probe: { ...probe, hasAudio: false }, black: [], freezes: [], loudness: null, faces, boxes: [] }).some((f) => /no sound track/.test(f.text)));
});

test('text boxes follow the same layout the renderer draws with', async () => {
  const { textBoxes } = await import('../tools/fast-render.mjs');
  const lay = layoutFor('vertical', { width: 1080, height: 1920 });
  const plan = { hook: { lines: ['24 DAYS.', 'NO TRIAL.'], end: 3 }, captions: [{ kind: 'word', text: 'FOR', start: 3, end: 3.4 }, { kind: 'word', text: '24', start: 3.4, end: 3.8 }, { kind: 'word', text: 'THEN', start: 4.6, end: 5 }],
    motion: { zooms: [], cards: [{ kind: 'stat', text: '24 DAYS', start: 3.4, end: 4.5 }] } };
  const boxes = textBoxes(plan, lay, tight);
  const L = captionLayout(lay, tight);
  assert.deepEqual(boxes.map((b) => b.kind), ['hook', 'stat', 'caption', 'caption']); // "24" is the callout, not a caption
  const hook = boxes[0], cap = boxes[2];
  assert.ok(hook.y0 < L.hookY && hook.y1 > L.hookY && hook.end === 3);
  assert.ok(cap.y0 < L.capY && cap.y1 > L.capY && cap.x0 >= 0 && cap.x1 <= 1080);
  assert.ok(hook.y1 <= cap.y0 + 40); // the card sits above the caption line
});

test('post package: captions and hashtags come from the words in the video, never invented', async () => {
  const { sentences, hashtags, captionOptions, coverCenter, postSheet, screenWords } = await import('../tools/post.mjs');
  const say = (text) => text.split(' ').map((t, i) => W(t, i * 0.3, i * 0.3 + 0.25));
  const words = say("Does any of this decide anything? No. For 24 days, the Senate kept silence. It's their stalemate, not yours. When the Senate is hollow, flood control waits. Flood control is the test. A time to keep silence, a time to speak.");
  assert.equal(sentences(words).length, 7);
  assert.equal(sentences(words)[0], 'Does any of this decide anything?');
  // Only what the video keeps coming back to: a name, a repeated word, a repeated pair, the title.
  const tags = hashtags(words, [], 6, ['THEIR STALEMATE,', 'NOT YOURS']);
  assert.ok(tags.includes('#senate') && tags.includes('#silence') && tags.includes('#floodcontrol') && tags.includes('#stalemate'));
  assert.ok(!tags.includes('#flood') && !tags.includes('#control')); // the pair replaced its words
  assert.ok(!tags.includes('#decide') && !tags.includes('#hollow') && !tags.includes('#time')); // said once, or a filler
  // Standing tags from my-rules.md come first and are never dropped.
  assert.deepEqual(hashtags(words, ['#Pinoy', '#fyp'], 3).slice(0, 2), ['#pinoy', '#fyp']);
  // Caption options: the title (when it is a phrase), the opening line, the closing line; no repeats.
  const opts = captionOptions({ title: ['24 DAYS.', 'NO TRIAL.'], said: sentences(words) });
  assert.deepEqual(opts.map((o) => o.text), ['24 days. No trial.', 'Does any of this decide anything?', 'A time to keep silence, a time to speak.']);
  assert.equal(captionOptions({ title: ['KA-VOGUE'], said: [] }).length, 0); // one word is a name, not a caption
  // Text on screen: emoji and stars dropped, each line its own sentence (a line's first capital is not a name).
  const sw = screenWords(['*Nasaan?* 👀', 'Ghost project pala. 👻', 'Buwis ko']);
  assert.deepEqual(sw.map((w) => w.text), ['Nasaan?', 'Ghost', 'project', 'pala.', 'Buwis', 'ko.']);
  assert.deepEqual(hashtags(sw), []); // nothing repeated: no tags rather than noise
  // The title sits under the chin when there is room, above the face when the face is low, mid-frame always.
  assert.ok(Math.abs(coverCenter({ top: 0.2, chin: 0.5 }, 0.14) - 0.61) < 1e-9);
  assert.ok(coverCenter({ top: 0.45, chin: 0.8 }, 0.14) < 0.45);
  for (const f of [null, { top: 0.1, chin: 0.9 }, { top: 0.2, chin: 0.5 }]) { const c = coverCenter(f, 0.14); assert.ok(c >= 0.27 - 1e-9 && c <= 0.73 + 1e-9); }
  // The sheet: reminders only when they apply.
  const sheet = postSheet({ slug: 'talk', video: 'talk-final.mp4', duration: 37, frame: '1080x1920', cover: 'talk-cover.jpg', coverAt: 10.6, title: ['THEIR STALEMATE,', 'NOT YOURS'], titled: true,
    said: sentences(words), words, standing: ['#pinoy'], tag: 'AI-generated', quiet: 'silent', checkLine: 'clean' });
  assert.match(sheet, /Cover: {2}talk-cover\.jpg \(the frame at 00:10\.6, with the title on it\)/);
  assert.match(sheet, /1\. Their stalemate, not yours/);
  assert.match(sheet, /#pinoy #/);
  assert.match(sheet, /AI-generated label/);
  assert.match(sheet, /Add the sound in the app: the video's own track is silent/);
  assert.match(sheet, /WHAT IS SAID/);
  const plain = postSheet({ slug: 'clip', video: 'clip-final.mp4', cover: 'clip-cover.jpg', onScreen: ['Line one', 'Line two'], words: [] });
  assert.ok(!/AI-generated label|Add the sound/.test(plain));
  assert.match(plain, /WHAT IS ON SCREEN/);
});

test('beats: tempo and phase from an onset envelope, and cuts that land on them', async () => {
  const { beatGrid, snapToBeat, snapPieces, gridFromBpm, ENV_FPS } = await import('../tools/beats.mjs');
  // An envelope with a jump every 0.5 s starting at 0.2 s, some weaker off-beats, and a little noise.
  const make = (period, first, seconds, noise = 0.05) => {
    const n = Math.round(seconds * ENV_FPS), env = new Float64Array(n);
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < n; i++) env[i] = noise * rand();
    for (let t = first; t < seconds; t += period) { env[Math.round(t * ENV_FPS)] += 1; const off = Math.round((t + period / 2) * ENV_FPS); if (off < n) env[off] += 0.3; }
    return env;
  };
  const g = beatGrid(make(0.5, 0.2, 20));
  assert.ok(Math.abs(g.bpm - 120) < 0.5, `bpm ${g.bpm}`);
  // The grid passes within 20 ms of the true beats (which one is called "first" does not matter).
  const off = (t, grid) => { const k = Math.round((t - grid.first) / grid.period); return Math.abs(grid.first + k * grid.period - t); };
  for (const t of [0.2, 5.2, 12.7, 19.2]) assert.ok(off(t, g) < 0.035, `beat at ${t} is ${off(t, g)} off`);
  assert.ok(g.confidence >= 4);
  const slow = beatGrid(make(60 / 96, 0.1, 25));
  assert.ok(Math.abs(slow.bpm - 96) < 0.5, `bpm ${slow.bpm}`);
  // Noise has no beat worth trusting; silence and a too-short clip have none at all.
  const noise = beatGrid(make(0.5, 0.2, 20, 0.05).map((v, i) => ((i * 7919) % 97) / 97));
  assert.ok(noise.confidence < 4, `noise confidence ${noise.confidence}`);
  assert.equal(beatGrid(new Float64Array(2000)), null);
  assert.equal(beatGrid(new Float64Array(50).fill(1)), null);
  // Snapping: onto the beat when one is close, left alone when not.
  const grid = { period: 0.5, first: 0.1 };
  assert.equal(snapToBeat(2.05, grid), 2.1);
  assert.equal(snapToBeat(2.35, grid, 0.1), 2.35);
  // Kept parts start and end on beats, at least one beat long, and never run past the end.
  const pieces = snapPieces([{ start: 0.0, end: 2.0 }, { start: 3.2, end: 3.3 }, { start: 9.4, end: 10.4 }], grid, 10.2);
  assert.deepEqual(pieces.map((p) => [p.src0, p.src1, p.beats]), [[0.1, 2.1, 4], [3.1, 3.6, 1], [9.6, 10.1, 1]]);
  assert.deepEqual(pieces.map((p) => [p.out0, p.out1]), [[0, 2], [2, 2.5], [2.5, 3]]);
  // Without a beat the parts are joined exactly as written.
  assert.deepEqual(snapPieces([{ start: 1, end: 2.3 }, { start: 5, end: 6 }], null).map((p) => [p.src0, p.src1, p.out0, p.out1]), [[1, 2.3, 0, 1.3], [5, 6, 1.3, 2.3]]);
  const fixed = gridFromBpm(120, 4);
  assert.equal(fixed.period, 0.5);
  assert.equal(fixed.beats[2], 1);
});

test('caption script: keep, beat, and @part times', async () => {
  const { parseCaptionScript } = await import('../tools/caption-script.mjs');
  const text = ['beat: song.mp3', 'keep: 0-2.1, 6.9-8', 'keep: 20.6-23', '', '@1 First part', '@2 [big] Second', '@3 Third part here', '@3+1 a bit into the third'].join('\n');
  // First reading: the directives, with the @ lines waiting for the parts.
  const first = parseCaptionScript(text, 30);
  assert.deepEqual(first.problems, []);
  assert.deepEqual(first.keep, [{ start: 0, end: 2.1 }, { start: 6.9, end: 8 }, { start: 20.6, end: 23 }]);
  assert.deepEqual(first.beat, { kind: 'file', file: 'song.mp3' });
  assert.equal(first.captions.length, 0);
  // Second reading: each @ line starts with its part; the last one ends with the video.
  const pieces = [{ out0: 0, out1: 2 }, { out0: 2, out1: 3 }, { out0: 3, out1: 5.5 }];
  const s = parseCaptionScript(text, 30, { pieces });
  assert.deepEqual(s.problems, []);
  assert.deepEqual(s.captions.map((c) => [c.start, c.end]), [[0, 2], [2, 3], [3, 4], [4, 5.5]]);
  assert.match(parseCaptionScript('keep: 0-2\n@4 nope', 30, { pieces }).problems[0], /@4 but there are 3 kept parts/);
  // A tempo, the clip's own sound, and off.
  assert.deepEqual(parseCaptionScript('beat: 116 bpm\n0 hi', 10).beat, { kind: 'bpm', bpm: 116 });
  assert.deepEqual(parseCaptionScript('beat: own\n0 hi', 10).beat, { kind: 'own' });
  assert.equal(parseCaptionScript('beat: none\n0 hi', 10).beat, null);
  assert.ok(parseCaptionScript('beat: 999\n0 hi', 10).problems.length);
  // Times move onto the beat when one is close; trim and keep together is a problem.
  const snapped = parseCaptionScript('0 one\n2.05 two\n4.4 three', 10, { snap: (t) => (Math.abs(t - Math.round(t)) <= 0.2 ? Math.round(t) : t) });
  assert.deepEqual(snapped.captions.map((c) => c.start), [0, 2, 4.4]);
  assert.ok(parseCaptionScript('trim: 0-5\nkeep: 1-2\n0 hi', 10).problems.some((p) => /not both/.test(p)));
});

test('style reader: a line is read by its label, as whole words, and the first choice wins', async () => {
  const { parseStyle, rulesReport, DEFAULT_STYLE } = await import('../tools/style.mjs');
  const read = (text, media = null) => parseStyle([{ name: 'my-rules.md', text }], media);
  // The two misfires this replaced. "breath" in an explanation is not "natural pace"...
  assert.equal(read('- Pace: tight. Cut every breath, pause, and mistake.').style.pace, 'tight');
  // ...and a note that mentions captions and "stop the scroll" does not move captions to the top.
  const note = '- [9:16] Benta-serye: a selling skit. The cut has to stop the scroll: a title card in the caption slot, no music, natural pace.';
  const mixed = read(`- Caption position: lower third\n- Sound: music bed\n- Pace: tight\n${note}`);
  assert.equal(mixed.style.position, 'lower');
  assert.equal(mixed.style.sound, 'music');
  assert.equal(mixed.style.pace, 'tight');
  assert.match(mixed.report.at(-1).why, /"Benta-serye" is not a setting Fable reads/);
  // Every choice the style setup offers, as the skill tells agents to write them.
  const full = read(['- Format: horizontal 16:9', '- Captions: key-word pills, lower third, #ff3366 highlight, bigger', '- Hook: never', '- Pace: natural, keep short pauses',
    '- Graphics: heavy motion graphics', '- Color: orange and teal', '- Sound: sound effects plus a quiet music bed', '- B-roll: lots of stock clips', '- Voice: natural',
    '- Retakes: cut them', '- Stutters: ask first', '- Privacy: local only', '- Font: Bebas Neue', '- Copy to: D:\\\\Backup\\\\outbox (the NAS)', '- Hashtags: #pinoy #fyp'].join('\n')).style;
  assert.deepEqual([full.format, full.captions, full.position, full.accent, full.hook, full.pace, full.graphics, full.grade, full.sound, full.broll, full.voice, full.retakes, full.stutters, full.privacy, full.font],
    ['horizontal', 'pills', 'lower', '#ff3366', false, 'natural', 'heavy', 'orange-teal', 'music', 'lots', 'natural', 'cut', 'suggest', 'local', 'Bebas Neue']);
  assert.ok(Math.abs(full.scale - 1.15) < 1e-9);
  assert.equal(full.copyTo, 'D:\\\\Backup\\\\outbox');
  assert.deepEqual(full.hashtags, ['#pinoy', '#fyp']);
  // Whole words only: "stop" is not "top", "snow" is not "no", "bottomless" is not "bottom".
  assert.equal(read('- Caption position: stop putting them so high').style.position, DEFAULT_STYLE.position);
  assert.equal(read('- Hook: snow scenes first').style.hook, true);
  // The first choice wins; brackets are commentary; a color can be a name.
  assert.equal(read('- Caption position: lower third, not the top').style.position, 'lower');
  assert.equal(read('- Sound: light sound effects (was: voice only, changed 2026-11-01)').style.sound, 'light');
  assert.equal(read('- Caption color: yellow with shadow').style.color, '#facc15');
  assert.equal(read('- Sound: light effects, no music').style.sound, 'light');
  assert.equal(read('- Sound: voice only').style.sound, 'voice');
  // Rules come after style and win; scope tags keep a Reel rule off a long horizontal video.
  const both = parseStyle([{ name: 'my-style.md', text: '- Captions: word by word\n- Pace: tight' }, { name: 'my-rules.md', text: '- [16:9] [>90s] Captions: subtitles\n- Pace: natural' }], { vertical: true, duration: 30 });
  assert.equal(both.style.captions, 'word');
  assert.equal(both.style.pace, 'natural');
  assert.match(both.report.find((r) => /subtitles/.test(r.line)).why, /another kind of video/);
  assert.equal(parseStyle([{ name: 'r', text: '- [16:9] [>90s] Captions: subtitles' }], { vertical: false, duration: 300 }).style.captions, 'subtitles');
  // A short line without a label is read by its topic word; a long sentence without one is a note.
  assert.equal(read('bigger captions').style.scale, 1.15);
  assert.equal(read('no hook').style.hook, false);
  const prose = read('The user said the captions should feel like a friend talking, never like the top of a news show.');
  assert.deepEqual(prose.style, DEFAULT_STYLE);
  assert.match(prose.report[0].why, /no label/);
  // A known label with nothing Fable can use says so instead of guessing.
  const vague = read('- Captions: when the user gives the exact words, those words win over the transcript.');
  assert.deepEqual(vague.style, DEFAULT_STYLE);
  assert.match(vague.report[0].why, /about captions, but no choice/);
  // The report names what was read and what was not.
  const lines = rulesReport(mixed).join('\n');
  assert.match(lines, /position = lower/);
  assert.match(lines, /Not used by the autopilot/);
  assert.match(lines, /pace = tight/);
});

test('long recordings: sound split in pauses, pieces joined on one clock, punctuation laid back on', async () => {
  const { chunkPlan, mergeChunks, restorePunctuation } = await import('../tools/long.mjs');
  // Short enough: one piece. Longer: each at most maxLen, cut in the longest pause near the end of each.
  assert.deepEqual(chunkPlan(900, [], 1200), [{ start: 0, end: 900 }]);
  const silences = [{ start: 1000, end: 1000.3 }, { start: 1100, end: 1102 }, { start: 1190, end: 1190.4 }, { start: 2250, end: 2251 }];
  const plan = chunkPlan(3000, silences, 1200);
  assert.deepEqual(plan.map((c) => c.start), [0, 1101, 2250.5]);
  assert.equal(plan.at(-1).end, 3000);
  assert.ok(plan.every((c, i) => c.end - c.start <= 1200 && (i === 0 || c.start === plan[i - 1].end)));
  // No pause to cut in: a hard cut at the limit, still covering everything.
  assert.deepEqual(chunkPlan(2500, [], 1200).map((c) => [c.start, c.end]), [[0, 1200], [1200, 2400], [2400, 2500]]);
  // Words come back on each piece's own clock; joined, they are on the recording's.
  const merged = mergeChunks([{ start: 0, end: 10 }, { start: 10, end: 20 }], [[W('one', 1, 1.4), W('two', 9.5, 9.9)], [W('two', -0.4, 0), W('three', 0.5, 0.9), W('four', 5, 5.5)]]);
  assert.deepEqual(merged.map((w) => [w.text, w.start]), [['one', 1], ['two', 9.5], ['three', 10.5], ['four', 15]]);
  // Bare timed words take the full text's punctuation and capitals, across a small mismatch.
  const bare = [W('it', 0, 0.2), W('came', 0.3, 0.6), W("that's", 1, 1.3), W('the', 1.4, 1.5), W('whole', 1.6, 1.9), W('method', 2, 2.5), W('where', 3.2, 3.5), W('was', 3.6, 3.8), W('i', 3.9, 4), W('off', 4.1, 4.4)];
  const fixed = restorePunctuation(bare, "It came. That's the whole method. Uh, where was I off?");
  assert.deepEqual(fixed.map((w) => w.text), ['It', 'came.', "That's", 'the', 'whole', 'method.', 'where', 'was', 'I', 'off?']);
  assert.deepEqual(fixed.map((w) => w.start), bare.map((w) => w.start));
  assert.deepEqual(restorePunctuation(bare, '').map((w) => w.text), bare.map((w) => w.text));
});

test('clips: stretches of a long talk that stand on their own', async () => {
  const { findClips, clipName } = await import('../tools/long.mjs');
  // A talk: greeting, a self-contained story, a second subject, a sign-off. Sentences are a few
  // words a second, with a longer pause where the subject changes.
  let t = 0;
  const words = [];
  const say = (text, pauseAfter = 0.3) => { for (const w of text.split(' ')) { words.push(W(w, Math.round(t * 100) / 100, Math.round((t + 0.3) * 100) / 100)); t += 0.4; } t += pauseAfter; };
  say('Hello hello, can you hear me?'); say('Say hi in the comments.', 1.5);
  const story = ['Why does the old calendar run in sixty days?', 'Think of ten riders and twelve horses.', 'Every ten days you saddle ten horses.', 'Then you run out of riders.', 'Two horses stand in the stable with empty saddles.',
    'Those two horses are called the void.', 'The riders change, the horses wait.', 'Every stable has two horses nobody rides.', 'That is the whole trick of the calendar.', 'Two empty saddles.'];
  const storyStart = t;
  story.forEach((s, i) => say(s, i === story.length - 1 ? 1.6 : 0.3));
  const storyEnd = t - 1.6;
  const budget = ['Now the budget.', 'The senate moved seven trillion pesos in one week.', 'And nobody asked where the flood money went.', 'The budget is the way out for everyone in that room.', 'Seven trillion pesos buys a lot of silence.',
    'So the trial waits and the budget moves.', 'That is how a budget becomes a hiding place.', 'Watch the budget, not the speeches.'];
  budget.forEach((s, i) => say(s, i === budget.length - 1 ? 1.5 : 0.3));
  say('Thanks for watching, see you next week.');
  const clips = findClips(words, { count: 3, min: 15, max: 45 });
  assert.ok(clips.length >= 2);
  // The best clip is the story, whole: it opens on its question, not on the greeting, and ends on its last line.
  const best = clips[0];
  assert.equal(best.opening, 'Why does the old calendar run in sixty days?');
  assert.equal(best.closing, 'Two empty saddles.');
  assert.ok(Math.abs(best.start - storyStart) < 0.01 && Math.abs(best.end - storyEnd) < 0.5);
  assert.ok(best.topic.includes('horses'));
  assert.match(best.why.join('; '), /question/);
  assert.match(clipName(best), /horses/);
  // No clip opens or closes on talk about the stream itself, opens on "And..." or "Now the budget.", or overlaps another.
  for (const c of clips) {
    assert.ok(!/hello|comments|thanks for watching/i.test(c.opening + c.closing), c.opening);
    assert.ok(!/^(and|so|then)\b/i.test(c.opening), c.opening);
    assert.ok(c.duration >= 15 && c.duration <= 45);
  }
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end);
  // A transcript with no punctuation at all still yields clips: pauses stand in for sentence ends.
  const bare = words.map((w) => ({ ...w, text: w.text.replace(/[.,!?]/g, '') }));
  assert.ok(findClips(bare, { count: 3, min: 15, max: 60 }).length >= 1);
  assert.deepEqual(findClips([], {}), []);
});

test('voice care: the recording is measured and gets only what it needs', async () => {
  const { voiceChain, levels } = await import('../tools/voice.mjs');
  // A phone live in a noisy room: rumble, room noise 26 dB under the voice, a little muddy.
  const live = voiceChain({ noise: -39.1, speech: -13, peak: -0.2, sub: -25.6, lowmid: -19.2, presence: -29.5, air: -29.3 });
  assert.match(live.filter, /^highpass=f=80,highpass=f=95,/);                 // steeper rumble cut
  assert.match(live.filter, /afftdn=nr=11:nf=-39:tn=1/);                       // noise down 11 dB, tracked
  assert.match(live.filter, /equalizer=f=220:t=q:w=0\.9:g=-1\.8,equalizer=f=3000:t=q:w=1\.1:g=1\.8/);
  assert.ok(!/deesser/.test(live.filter));                                     // a small lift needs no de-esser
  // The leveller is told where the room sits, so it does not lift the pauses.
  assert.match(live.filter, /speechnorm=e=4:c=2:t=0\.025:/);
  assert.ok(live.filter.indexOf('afftdn') < live.filter.indexOf('speechnorm')); // clean first, then level
  assert.equal(live.did.length, 4);
  assert.match(live.did.join(' '), /room noise between words turned down by about 11 dB/);
  // A clean studio take: nothing but the standard rumble filter and levelling.
  const studio = voiceChain({ noise: -68, speech: -16, peak: -3, sub: -45, lowmid: -22, presence: -28, air: -33 });
  assert.equal(studio.filter, 'highpass=f=80,acompressor=threshold=-22dB:ratio=2.5:attack=8:release=140:makeup=2,speechnorm=e=4:c=2:r=0.0005:l=1,alimiter=limit=0.95:level=0');
  assert.deepEqual(studio.did, ['soft phrases lifted']);
  // Very loud noise and very muddy sound are still treated gently: caps on every move.
  const rough = voiceChain({ noise: -22, speech: -12, peak: 0, sub: -15, lowmid: -14, presence: -34, air: -40 });
  assert.match(rough.filter, /afftdn=nr=12:nf=-30:/);
  assert.match(rough.filter, /g=-4,equalizer=f=3000:t=q:w=1\.1:g=4,deesser=i=0\.25/);
  assert.match(rough.filter, /t=0\.04:/);
  // Not measured: the chain Fable always used.
  assert.match(voiceChain(null).filter, /^highpass=f=80,acompressor/);
  // Room and voice level from the sound itself: digital silence (an app's noise gate) is not the room.
  const rate = 8000, sec = (n) => n * rate, s = new Int16Array(sec(20));
  for (let i = 0; i < s.length; i++) {
    const t = i / rate, phase = t % 2;                      // 1.2 s of speech, 0.5 s of room, 0.3 s gated to nothing
    const amp = phase < 1.2 ? 8000 : phase < 1.7 ? 300 : 0;
    s[i] = Math.round(amp * Math.sin(2 * Math.PI * 220 * t));
  }
  const lv = levels(s, rate);
  assert.ok(lv.speech > -17 && lv.speech < -13, `speech ${lv.speech}`);
  assert.ok(lv.noise > -46 && lv.noise < -40, `noise ${lv.noise}`);
  assert.deepEqual(levels(new Int16Array(100), rate), { noise: -90, speech: -90 });
});
