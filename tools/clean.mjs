// Fable clean: what in a project folder can go without losing anything. The pure part lives here
// so it can be tested; fable.mjs walks the folders, prints the report, and deletes on --apply.
//
// A project keeps what cannot be made again: edit.json, the transcript, the plan, face data, a
// hand-edited index.html, B-roll downloads and their ledger, and anything Fable does not recognize.
// What goes is what the next rebuild writes anyway (cut footage, voice, mix, sound effects, fonts,
// caption files, review sheets, the small proxy), renders that are already in an outbox, and the
// working copy raw.mp4, but only while the original video is still where it was: the next
// rebuild makes the same copy again from it.

// Files every rebuild rewrites, by project kind. Paths are relative to the project, forward slashes.
const REBUILT = {
  edit: [/^assets\/(footage|footage-horizontal|footage-primary|proxy)\.mp4$/, /^assets\/(voice|mix)\.wav$/, /^assets\/captions\.ass$/, /^assets\/review-(open|shots)\.png$/,
    /^assets\/sfx\/[^/]+\.wav$/, /^assets\/fonts\/[^/]+\.ttf$/, /^assets\/broll\/b\d+-\d+x\d+\.mp4$/, /^assets\/[^/]+\.filter$/],
  caption: [/^assets\/cap\d+\.png$/, /^assets\/tag\.png$/, /^assets\/cards\.json$/, /^assets\/review-shots\.png$/, /^assets\/[^/]+\.filter$/],
  stitch: [/^assets\/caption\.ttf$/, /^assets\/review-shots\.png$/],
  hand: [],
};

// What kind of project a folder is, from the files at its top.
export function projectKind(names) {
  const has = (n) => names.includes(n);
  return has('edit.json') ? 'edit' : has('caption.json') ? 'caption' : has('stitch.json') ? 'stitch' : 'hand';
}

// files: [{ path, size }] relative to the project. ctx: { kind, delivered: Set of file names already
// in an outbox, sourceExists, settled } where settled means finished (a final is out) or idle long
// enough. Returns { remove: [{ path, size, why }], notes: [] }.
export function cleanTargets(files, ctx) {
  const remove = [], notes = [];
  if (ctx.kind === 'hand') return { remove, notes: ['hand-built project: nothing here is touched'] };
  const rules = REBUILT[ctx.kind] || [];
  for (const f of files) {
    const name = f.path.split('/').pop();
    if (rules.some((r) => r.test(f.path))) remove.push({ ...f, why: 'rebuilt on the next render' });
    else if (/^renders\/[^/]+\.mp4$/.test(f.path) && ctx.delivered.has(name)) remove.push({ ...f, why: 'already in the outbox' });
    else if (ctx.kind === 'edit' && f.path === 'assets/raw.mp4') {
      if (!ctx.settled) notes.push('working copy kept (still being edited)');
      else if (!ctx.sourceExists) notes.push('working copy kept: the original video is gone, so this is the only copy');
      else remove.push({ ...f, why: 'copied again from the original on the next rebuild' });
    }
  }
  return { remove, notes: [...new Set(notes)] };
}

export const mb = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
