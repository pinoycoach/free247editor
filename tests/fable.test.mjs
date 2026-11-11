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
