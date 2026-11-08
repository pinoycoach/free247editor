import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findDraft, buildPrompt, toMarkdown, review, SCHEMA } from '../tools/review.mjs';

test('the newest draft of a slug is the one reviewed, a path is taken as given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fable-review-'));
  try {
    for (const [f, t] of [['cat-v1.mp4', 1000], ['cat-v2.mp4', 3000], ['cat-final.mp4', 2000], ['cat-notes.md', 4000], ['catnip-v9.mp4', 5000]]) {
      writeFileSync(join(dir, f), 'x');
      utimesSync(join(dir, f), t, t);
    }
    assert.equal(findDraft('cat', dir).file, join(dir, 'cat-v2.mp4'));
    assert.equal(findDraft('cat-v1', dir).slug, 'cat');
    assert.equal(findDraft(join(dir, 'cat-final.mp4'), dir).slug, 'cat');
    assert.equal(findDraft('dog', dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('with a save-to folder, the newest draft in either folder is reviewed', () => {
  const drive = mkdtempSync(join(tmpdir(), 'fable-drive-')), local = mkdtempSync(join(tmpdir(), 'fable-local-'));
  try {
    for (const [d, f, t] of [[drive, 'cat-v1.mp4', 1000], [drive, 'cat-v2.mp4', 3000], [local, 'cat-v3.mp4', 2000]]) {
      writeFileSync(join(d, f), 'x');
      utimesSync(join(d, f), t, t);
    }
    assert.equal(findDraft('cat', [drive, local]).file, join(drive, 'cat-v2.mp4'));
    assert.equal(findDraft('cat', [join(drive, 'missing'), local]).file, join(local, 'cat-v3.mp4'));
  } finally { for (const d of [drive, local]) rmSync(d, { recursive: true, force: true }); }
});

test('the prompt carries style and rules but never the Copy to or Save to folder', () => {
  const p = buildPrompt({
    styleText: '- Captions: word by word.',
    rulesText: '- Names: the dog is "Phi Phi".\n- Copy to: G:\\My Drive\\Stitcher\\outbox\n- Save to: G:\\My Drive\\Stitcher\\outbox',
    notesText: 'Cut 4 pauses.',
  });
  assert.match(p, /word by word/);
  assert.match(p, /Phi Phi/);
  assert.match(p, /Cut 4 pauses/);
  assert.doesNotMatch(p, /My Drive/);
  assert.match(p, /never flag the language/);
});

test('the review reads fixes first, then considers, and says it changed nothing', () => {
  const md = toMarkdown({
    summary: 'A dog prays.', verdict: 'small fixes',
    hook: { score: 6, why: 'Slow start.', better: 'Phi Phi, pray na.' },
    issues: [
      { at: '00:05', kind: 'pace', severity: 'consider', what: 'Pause.', change: 'Trim it.' },
      { at: '00:02', kind: 'caption', severity: 'fix', what: 'Caption over mouth.', change: 'Move it up.' },
    ],
    keep: ['The ending loop.'],
  }, { slug: 'dog', draft: '/x/dog-v2.mp4', model: 'gemini-3.8-flash' });
  assert.ok(md.indexOf('00:02') < md.indexOf('00:05'));
  assert.match(md, /Hook: 6\/10/);
  assert.match(md, /Stronger opening: "Phi Phi, pray na."/);
  assert.match(md, /Fable changes nothing/);
  assert.match(md, /dog-v2\.mp4/);
});

test('the schema requires every section the markdown reads', () => {
  assert.deepEqual(SCHEMA.required, ['summary', 'verdict', 'hook', 'issues', 'keep']);
});

test('local-only privacy blocks the upload; a missing key says where to get one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fable-root-'));
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    mkdirSync(join(root, 'outbox'));
    writeFileSync(join(root, 'outbox', 'cat-v1.mp4'), 'x');
    const opts = { root, mirror: () => null, log: () => {} };
    await assert.rejects(review('cat', { ...opts, readStyle: () => ({ privacy: 'local' }) }), /local-only/);
    await assert.rejects(review('cat', { ...opts, readStyle: () => ({}) }), /aistudio\.google\.com\/apikey/);
    const dry = await review('cat', { ...opts, readStyle: () => ({}), dryRun: true });
    assert.equal(dry.dryRun, true);
  } finally {
    if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
