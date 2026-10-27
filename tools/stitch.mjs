// Fable stitch: a folder of finished clips (an AI short, a multi-take sequence) joined in order with
// hard cuts, each clip's own audio, one fixed caption, nothing re-timed. The pure parts live here so
// they can be tested; fable.mjs does the probing and the FFmpeg pass.

// A brief is any .txt or .md beside the clips that names a caption or numbered clips. It is read for
// three things only: the clip order (by the durations it lists), the caption, and whether the footage
// is AI-made. Anything else in it (uploads, links) is for the person, not for Fable.
export function parseBrief(text) {
  const lines = text.split(/\r?\n/);
  const clips = [];
  for (const l of lines) {
    const m = l.match(/^\s*(\d+)[).]\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/i);
    if (m) clips.push({ n: Number(m[1]), seconds: Number(m[2]) });
  }
  clips.sort((a, b) => a.n - b.n);
  let caption = null;
  for (let i = 0; i < lines.length && !caption; i++) {
    const m = lines[i].match(/^\s*(?:on-?screen\s+)?caption\b[^:]*:\s*(.*)$/i);
    if (!m) continue;
    const same = m[1].trim();
    if (same) { caption = same; break; }
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (!/^style\s*:/i.test(t)) caption = t.replace(/^["“]|["”]$/g, '');
      break;
    }
  }
  const ai = /\b(higgsfield|kling|veo|sora|runway|pika|luma|hailuo|minimax|seedance|ai[- ]generated|ai video|generated (clip|footage|video))\b/i.test(text);
  return { clips, caption, ai };
}

// A stitched output saved back beside its clips (officiant_final.mp4, reel-v2.mp4) is not a clip.
export const isOutput = (name) => /[-_ ](final|v\d+|stitch(ed)?)\.[a-z0-9]+$/i.test(name);

// Order by the brief when every duration it lists picks out exactly one clip; other videos in the
// folder are left out and listed. Otherwise by file name (natural order, so clip-2 comes before
// clip-10). The notes always print the order used.
export function orderClips(clips, briefClips = [], tol = 0.35) {
  const byName = [...clips].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const fallback = { order: byName, by: 'file name', skipped: [] };
  if (!briefClips.length || briefClips.length > clips.length) return fallback;
  const used = new Set(), order = [];
  for (const b of briefClips) {
    const hits = clips.filter((c) => !used.has(c) && Math.abs(c.duration - b.seconds) <= tol);
    if (hits.length !== 1) return fallback;
    used.add(hits[0]); order.push(hits[0]);
  }
  return { order, by: 'brief durations', skipped: byName.filter((c) => !used.has(c)) };
}

// Balanced lines, three at most: the narrowest width that fits the caption in three lines.
export function wrapCaption(text, maxLines = 3) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const longest = Math.max(...words.map((w) => w.length));
  for (let width = Math.max(longest, 14, Math.ceil(text.length / maxLines)); ; width++) {
    const out = [];
    for (const w of words) {
      const last = out[out.length - 1];
      if (last && (last + ' ' + w).length <= width) out[out.length - 1] = last + ' ' + w;
      else out.push(w);
    }
    if (out.length <= maxLines || width > text.length) return out;
  }
}

// Standard frame for the clips' shape: 720p-class sources stay 720p, larger ones go to 1080p.
export function stitchFrame(width, height) {
  const even = (n) => Math.round(n / 2) * 2;
  if (height > width * 1.2) return width <= 800 ? { w: 720, h: 1280 } : { w: 1080, h: 1920 };
  if (width > height * 1.2) return height <= 800 ? { w: 1280, h: 720 } : { w: 1920, h: 1080 };
  return { w: even(width), h: even(height) };
}
