import test from 'node:test';
import assert from 'node:assert/strict';
import { planCuts, timeline, buildCaptions, hookCandidates, chooseHook, hookGate, insideSilence, untranscribed, layoutFor } from '../fable.mjs';
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
