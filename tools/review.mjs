// A second pair of eyes on a draft: Gemini watches the rendered video (frames and sound, not just
// the transcript) and returns notes with times on the draft, written to outbox/<slug>-review.md.
//
//   node fable.mjs review <slug | draft.mp4> [--model gemini-3.8-flash] [--dry-run]
//
// Free on Gemini's free tier: a key from https://aistudio.google.com/apikey as GEMINI_API_KEY in
// .env. The draft is uploaded to Google, reviewed, then deleted from their storage. Blocked in
// local-only privacy mode. This file has no import of fable.mjs (that would be a cycle with
// top-level await); fable.mjs passes readStyle and mirror in.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const API = 'https://generativelanguage.googleapis.com';
export const DEFAULT_MODEL = 'gemini-3.8-flash';
const KINDS = ['hook', 'pace', 'caption', 'framing', 'audio', 'cut', 'text', 'ending', 'other'];

export const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences: what a viewer understands this video is about.' },
    verdict: { type: 'string', enum: ['ready', 'small fixes', 'needs work'] },
    hook: {
      type: 'object',
      properties: {
        score: { type: 'integer', minimum: 1, maximum: 10, description: 'Would the first 2 seconds stop the scroll? 10 = certainly.' },
        why: { type: 'string' },
        better: { type: 'string', description: 'A stronger opening line built only from words actually said or shown, or empty if the current one is best.' },
      },
      required: ['score', 'why', 'better'],
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          at: { type: 'string', description: 'MM:SS on this draft.' },
          kind: { type: 'string', enum: KINDS },
          severity: { type: 'string', enum: ['fix', 'consider'] },
          what: { type: 'string', description: 'What is wrong, as the viewer experiences it.' },
          change: { type: 'string', description: 'The concrete edit that fixes it.' },
        },
        required: ['at', 'kind', 'severity', 'what', 'change'],
      },
    },
    keep: { type: 'array', items: { type: 'string' }, description: 'What works and must not be lost in the next version.' },
  },
  required: ['summary', 'verdict', 'hook', 'issues', 'keep'],
};

// The draft to review: a path, or the newest <slug>-vN.mp4 / <slug>-final.mp4 in the outbox.
export function findDraft(target, outbox) {
  if (existsSync(target) && statSync(target).isFile()) {
    const file = resolve(target);
    return { file, slug: basename(file).replace(/\.mp4$/i, '').replace(/-(v\d+|final)$/i, '') };
  }
  const slug = target.replace(/\.mp4$/i, '').replace(/-(v\d+|final)$/i, '');
  const re = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(v\\d+|final)\\.mp4$`, 'i');
  const drafts = existsSync(outbox) ? readdirSync(outbox).filter((f) => re.test(f)) : [];
  if (!drafts.length) return null;
  drafts.sort((a, b) => statSync(join(outbox, b)).mtimeMs - statSync(join(outbox, a)).mtimeMs);
  return { file: join(outbox, drafts[0]), slug };
}

// What the reviewer is told: the user's style and rules (minus file paths), and what Fable did.
export function buildPrompt({ styleText = '', rulesText = '', notesText = '' } = {}) {
  const rules = rulesText.split(/\r?\n/).filter((l) => !/^\s*-?\s*copy to:/i.test(l)).join('\n').trim();
  return [
    'You are reviewing a short social video draft for a creator before they post it. Watch the whole video with sound.',
    'Judge it as a viewer scrolling a phone feed would: does the opening stop the scroll, is it clear what the video is about',
    'with the sound off, does it drag anywhere, is any caption or text wrong, late, misspelled, or covering a face or mouth,',
    'is any cut jarring or inside a word, is the sound level uneven, does the ending land (or loop back cleanly if it is meant to loop).',
    'Only report problems you can actually see or hear, each with its time on this draft as MM:SS. Prefer a few sharp notes over many weak ones.',
    'Captions may be in English, Tagalog, or Taglish: that is intended, never flag the language itself. Names in the rules are spelled correctly there.',
    'Never suggest adding stock footage, music, or AI-generated footage that is not already in the video. Write in short plain words, no jargon.',
    styleText.trim() && `\nThe creator's style:\n${styleText.trim()}`,
    rules && `\nThe creator's standing rules (they win over the style):\n${rules}`,
    notesText.trim() && `\nThe editor's notes on this draft (what was cut and why):\n${notesText.trim().slice(0, 4000)}`,
  ].filter(Boolean).join('\n');
}

export function toMarkdown(review, { slug, draft, model }) {
  const order = { fix: 0, consider: 1 };
  const issues = [...(review.issues || [])].sort((a, b) => order[a.severity] - order[b.severity] || String(a.at).localeCompare(String(b.at)));
  const lines = [
    `# Review: ${slug}`, '',
    `Watched by ${model} (Gemini) on ${basename(draft)}. **Verdict: ${review.verdict}.**`, '',
    review.summary, '',
    `## Hook: ${review.hook?.score}/10`, '', review.hook?.why || '',
  ];
  if (review.hook?.better) lines.push('', `Stronger opening: "${review.hook.better}"`);
  lines.push('', '## Notes', '');
  if (!issues.length) lines.push('Nothing to fix.');
  for (const i of issues) lines.push(`- **${i.at}** ${i.severity === 'fix' ? 'Fix' : 'Consider'} (${i.kind}): ${i.what} → ${i.change}`);
  if (review.keep?.length) lines.push('', '## Keep', '', ...review.keep.map((k) => `- ${k}`));
  lines.push('', '---', 'These are suggestions from a model. Fable changes nothing until you say which ones to apply.',
    'The draft was uploaded to Google for this review and deleted from their storage afterwards.', '');
  return lines.join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(url, init, what) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    // The free tier answers busy (429/503) now and then; two short waits usually clear it.
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(10000 * (attempt + 1)); continue; }
    throw new Error(`${what} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

async function upload(file, key) {
  const bytes = readFileSync(file);
  const start = await call(`${API}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key, 'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length), 'X-Goog-Upload-Header-Content-Type': 'video/mp4',
    },
    body: JSON.stringify({ file: { display_name: basename(file) } }),
  }, 'upload start');
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('upload start returned no upload URL');
  const done = await call(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: bytes,
  }, 'upload');
  let { file: f } = await done.json();
  // Video is processed after upload; it can be used once its state is ACTIVE.
  for (let i = 0; f.state === 'PROCESSING' && i < 60; i++) {
    await sleep(3000);
    f = await (await call(`${API}/v1beta/${f.name}`, { headers: { 'x-goog-api-key': key } }, 'upload check')).json();
  }
  if (f.state !== 'ACTIVE') throw new Error(`Google could not process the video (state ${f.state})`);
  return f;
}

// Options: readStyle and mirror come from fable.mjs. Returns { out, review } or { dryRun }.
export async function review(target, { root, readStyle, mirror, model = process.env.GEMINI_REVIEW_MODEL || DEFAULT_MODEL, dryRun = false, log = console.log }) {
  const outbox = join(root, 'outbox');
  const found = findDraft(target, outbox);
  if (!found) throw new Error(`no draft found for "${target}" (give a slug from outbox/ or a path to an .mp4)`);
  const { file, slug } = found;
  const style = readStyle();
  if (style.privacy === 'local') throw new Error('local-only privacy mode is on, and a review uploads the draft to Google. Turn local-only off in my-rules.md to use it.');
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const prompt = buildPrompt({
    styleText: read(join(root, 'my-style.md')),
    rulesText: read(join(root, 'my-rules.md')),
    notesText: read(join(outbox, `${slug}-notes.md`)),
  });
  const mb = (statSync(file).size / 1e6).toFixed(1);
  if (dryRun) {
    log(`dry run: would upload ${basename(file)} (${mb} MB) to Google and ask ${model}. Prompt (${prompt.length} chars):`);
    log(prompt);
    return { dryRun: true, file, slug, prompt };
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey and put it in .env.');

  log(`uploading ${basename(file)} (${mb} MB) to Google for review`);
  const f = await upload(file, key);
  let body;
  try {
    log(`${model} is watching the draft`);
    const res = await call(`${API}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ file_data: { mime_type: 'video/mp4', file_uri: f.uri } }, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: SCHEMA },
      }),
    }, 'review');
    body = await res.json();
  } finally {
    // Files expire after 48 hours anyway; delete now so the draft is not kept there.
    await fetch(`${API}/v1beta/${f.name}`, { method: 'DELETE', headers: { 'x-goog-api-key': key } }).catch(() => {});
  }
  const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  let result;
  try { result = JSON.parse(text); } catch { throw new Error(`the review came back unreadable: ${(text || JSON.stringify(body)).slice(0, 300)}`); }

  const project = join(root, 'fable', 'video-projects', slug);
  if (existsSync(project)) {
    mkdirSync(join(project, 'assets'), { recursive: true });
    writeFileSync(join(project, 'assets', 'review.json'), JSON.stringify({ draft: basename(file), model, ...result }, null, 2));
  }
  const out = join(outbox, `${slug}-review.md`);
  writeFileSync(out, toMarkdown(result, { slug, draft: file, model }));
  const m = mirror?.(out, style);
  if (m) log(`copied to ${m}`);
  log(`review: ${out} (${result.verdict}, hook ${result.hook?.score}/10, ${result.issues?.length || 0} notes)`);
  return { out, review: result };
}
