// Fable draft check: what a careful editor looks for before sending a draft, measured on the
// rendered file itself, start to end. The pure parts live here so they can be tested; fable.mjs
// runs FFmpeg and the face tracker and hands the numbers in.
//
//   the file     frame size and shape, sound present, video and sound the same length
//   the sound    loudness (apps play at about -14 LUFS), peaks that may clip, a silent track
//   the picture  black frames (worst on frame 0: that is the thumbnail), a frozen ending
//   the text     every caption, hook card and callout against the band the apps leave free
//                (below the top 14%, above the bottom 20%), and against the face as it is in
//                each moment of the finished video: zooms, crops and B-roll included
//
// Each finding is { level, text, at }: "fix" is wrong for a viewer, "look" needs a human eye,
// "ok" is a check that passed. Text boxes are { start, end, x0, y0, x1, y1, text, kind } in
// pixels of the output frame; each build saves its own, so the check never guesses where text is.
const r2 = (n) => Math.round(n * 100) / 100;
export const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const span = (a, b) => (b - a < 0.15 ? clock(a) : `${clock(a)}-${clock(b)}`);

// FFmpeg's blackdetect, freezedetect and ebur128 report on stderr; pull the numbers out.
export function parseDetect(stderr) {
  const black = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
  const freezes = [];
  let open = null;
  for (const m of stderr.matchAll(/freeze_(start|end): ([\d.]+)/g)) {
    if (m[1] === 'start') open = Number(m[2]);
    else if (open !== null) { freezes.push({ start: open, end: Number(m[2]) }); open = null; }
  }
  if (open !== null) freezes.push({ start: open, end: Infinity });
  const summary = stderr.slice(stderr.lastIndexOf('Integrated loudness'));
  const I = summary.match(/I:\s+(-?[\d.]+) LUFS/), peak = summary.match(/Peak:\s+(-?[\d.]+) dBFS/);
  return { black, freezes, loudness: I ? { I: Number(I[1]), peak: peak ? Number(peak[1]) : null } : null };
}

function fileFindings(probe) {
  const out = [], { width: w, height: h } = probe;
  const ratio = Math.max(w, h) / Math.min(w, h), short = Math.min(w, h);
  if (Math.abs(ratio - 16 / 9) > 0.02) out.push({ level: 'look', text: `the frame is ${w}x${h}, not 9:16 or 16:9: apps will add bars or crop it` });
  else if (short < 720) out.push({ level: 'look', text: `the frame is ${w}x${h}: under 720p looks soft on a phone` });
  else out.push({ level: 'ok', text: `frame ${w}x${h}` });
  if (!probe.hasAudio) out.push({ level: 'look', text: 'no sound track at all: some apps reject or mute-flag these; add a silent track or the sound' });
  else if (probe.audioDuration && Math.abs(probe.audioDuration - probe.duration) > 0.35) out.push({ level: 'look', text: `sound is ${r2(probe.audioDuration)} s but the picture is ${r2(probe.duration)} s: one of them ends early` });
  return out;
}

function soundFindings(probe, loudness) {
  if (!probe.hasAudio || !loudness) return [];
  const { I, peak } = loudness;
  if (I <= -50) return [{ level: 'look', text: 'the sound track is silent: fine if the sound is added in the app, wrong if a voice should be there' }];
  const out = [];
  if (I < -19) out.push({ level: 'look', text: `quiet: ${I} LUFS (apps play at about -14, so this will sound soft next to other videos)` });
  else if (I > -10) out.push({ level: 'look', text: `loud: ${I} LUFS (apps turn it down to about -14 and it can sound squashed)` });
  else out.push({ level: 'ok', text: `loudness ${I} LUFS` });
  if (peak !== null && peak > -0.3) out.push({ level: 'look', text: `peaks reach ${peak} dBFS: listen for crackle on the loudest word` });
  return out;
}

function pictureFindings(probe, black, freezes) {
  const out = [], d = probe.duration;
  const real = black.filter((b) => b.end - b.start >= 0.2);
  for (const b of real) {
    if (b.start < 0.1) out.push({ level: 'fix', text: `black at the very start (${r2(b.end - b.start)} s): frame 0 is the thumbnail and the hook`, at: [0] });
    else if (b.end - b.start >= 0.5) out.push({ level: 'fix', text: `black screen at ${span(b.start, b.end)}`, at: [(b.start + Math.min(b.end, d)) / 2] });
    else out.push({ level: 'look', text: `a flash of black at ${span(b.start, b.end)}`, at: [b.start] });
  }
  if (!real.length) out.push({ level: 'ok', text: 'no black frames' });
  // A picture that stops while the video runs on usually means the footage ended before the sound.
  const tail = freezes.find((f) => f.end >= d - 0.2 && d - f.start >= 1.5);
  if (tail) out.push({ level: 'look', text: `the picture is frozen for the last ${r2(d - tail.start)} s (from ${clock(tail.start)}): did the footage run out before the sound?`, at: [Math.min(d - 0.1, tail.start + 0.5)] });
  return out;
}

// Text against the band the apps leave free. Vertical: below the top 14%, above the bottom 20%,
// 4% in from the sides. Horizontal: 5% in from every edge.
export function safeZoneFindings(boxes, W, H) {
  const vertical = H > W;
  const top = Math.round(H * (vertical ? 0.14 : 0.05)), bottom = Math.round(H * (vertical ? 0.80 : 0.95)), side = Math.round(W * (vertical ? 0.04 : 0.05));
  const bad = { top: [], bottom: [], side: [] };
  for (const b of boxes) {
    if (b.kind === 'tag') continue; // the AI tag sits in the corner on purpose
    if (b.y0 < top - 4) bad.top.push(b);
    if (b.y1 > bottom + 4) bad.bottom.push(b);
    if (b.x0 < side - 4 || b.x1 > W - side + 4) bad.side.push(b);
  }
  const say = (list, where, why) => {
    if (!list.length) return null;
    const first = list[0];
    return { level: 'fix', text: `${list.length === 1 ? 'text' : `${list.length} pieces of text`} ${where} (${why}), first at ${clock(first.start)}: "${first.text}"`, at: list.slice(0, 3).map((b) => (b.start + b.end) / 2) };
  };
  const out = [say(bad.top, `above the top ${top}px`, 'under the app header'), say(bad.bottom, `below ${bottom}px`, 'under the caption and buttons'), say(bad.side, 'too close to the side', 'cut off on narrow phones')].filter(Boolean);
  return out.length ? out : boxes.length ? [{ level: 'ok', text: `all text inside the free band (${top}..${bottom}px)` }] : [];
}

// Text against the face, moment by moment. faces: [{ t, cx, cy, top, chin, eyes, mouth }] as fractions
// of the output frame, sampled from the finished video. Text over the mouth is a fix; text on the
// eyes or cheeks is a look; text on the forehead or hair is how most captions sit and is fine.
export function faceFindings(boxes, faces, W, H) {
  if (!boxes.length) return [];
  if (!faces.length) return [{ level: 'ok', text: 'no face found in the video, so nothing for text to cover' }];
  const hits = [];
  for (const f of faces) {
    const faceH = (f.chin - f.top) * H, half = faceH * 0.75 / 2;
    // The face that matters starts at the brows: a little above the measured eye line (or, in
    // older face data without one, a little over a third of the way down the detector's box).
    const eyes = (f.eyes !== undefined ? f.eyes - 0.04 * (f.chin - f.top) : f.top + 0.36 * (f.chin - f.top)) * H, chin = f.chin * H, mouth = f.mouth * H;
    for (const b of boxes) {
      if (b.kind === 'tag' || f.t < b.start || f.t >= b.end) continue;
      if (b.x1 < f.cx * W - half || b.x0 > f.cx * W + half) continue;
      if (b.y1 <= eyes + 10 || b.y0 >= chin) continue;
      hits.push({ t: f.t, mouth: b.y0 <= mouth && b.y1 >= mouth, text: b.text });
    }
  }
  if (!hits.length) return [{ level: 'ok', text: `text clear of the face in all ${faces.length} moments measured` }];
  // Moments next to each other are one stretch.
  hits.sort((a, b) => a.t - b.t);
  const runs = [];
  for (const h of hits) {
    const last = runs.at(-1);
    if (last && h.t - last.end <= 0.75) { last.end = h.t; last.mouth = last.mouth || h.mouth; }
    else runs.push({ start: h.t, end: h.t, mouth: h.mouth, text: h.text });
  }
  const say = (list, level, what) => list.length ? [{
    level, text: `text ${what} at ${list.slice(0, 5).map((r) => `${span(r.start, r.end)} ("${r.text}")`).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}`,
    at: list.slice(0, 4).map((r) => (r.start + r.end) / 2),
  }] : [];
  return [...say(runs.filter((r) => r.mouth), 'fix', 'over the mouth'), ...say(runs.filter((r) => !r.mouth), 'look', 'on the face (eyes or cheeks)')];
}

// Everything together. measured: { probe, black, freezes, loudness, faces, boxes }; boxes null
// means the video was not built by Fable, so where its text sits is unknown.
export function checkFindings(m) {
  const { probe } = m, boxes = m.boxes || [];
  const out = [...fileFindings(probe), ...soundFindings(probe, m.loudness), ...pictureFindings(probe, m.black || [], m.freezes || [])];
  if (m.boxes) out.push(...safeZoneFindings(boxes, probe.width, probe.height), ...(m.faces ? faceFindings(boxes, m.faces, probe.width, probe.height) : [{ level: 'look', text: 'the face was not measured (pip install opencv-python-headless), so text over a face was not checked' }]));
  else out.push({ level: 'look', text: 'this video was not built by Fable, so where its text sits is not known: look at the sheet for text on a face or under the app buttons' });
  return out;
}

export function verdict(findings) {
  const fix = findings.filter((f) => f.level === 'fix').length, look = findings.filter((f) => f.level === 'look').length;
  return { fix, look, line: fix ? `${fix} to fix${look ? `, ${look} to look at` : ''}` : look ? `nothing to fix, ${look} to look at` : 'clean' };
}

// The notes section. Problems first, then one line of what passed.
export function checkLines(findings, sheet = null) {
  const v = verdict(findings), out = [`## Draft check: ${v.line}`, ''];
  for (const f of findings.filter((x) => x.level === 'fix')) out.push(`- FIX: ${f.text}`);
  for (const f of findings.filter((x) => x.level === 'look')) out.push(`- LOOK: ${f.text}`);
  const ok = findings.filter((x) => x.level === 'ok').map((f) => f.text);
  if (ok.length) out.push(`- ok: ${ok.join('; ')}`);
  if (sheet) out.push('', `Frames of the moments above: ${sheet}`);
  out.push('');
  return out;
}
