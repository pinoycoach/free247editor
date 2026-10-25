// Script-aware captions: when the user wrote the words, the words win and the audio keeps the time.
// Aligns the transcript's words to the script's words (same order, small spelling differences
// allowed), so each caption shows the script's spelling at the moment the word was actually said.
// Words the model missed are inserted at interpolated times; words the model invented are dropped.

const norm = (t) => (t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9']/g, '');

// Characters-based similarity in 0..1 (1 = same). Cheap edit distance; words are short.
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[m][n] / Math.max(m, n);
}

export function scriptWords(text) {
  // Drop stage directions in [brackets] or (parentheses) on their own, keep spoken punctuation.
  return text.replace(/^\s*(hook|title)\s*:.*$/gim, '').replace(/\[[^\]]*\]/g, ' ').split(/\s+/).map((w) => w.trim()).filter((w) => norm(w));
}

export function hookFromScript(text) {
  const m = text.match(/^\s*hook\s*:\s*(.+)$/im);
  const line = (m ? m[1] : text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^\[/.test(l)) || '').trim();
  return line ? line.replace(/[.]+$/, '') : null;
}

// words: transcript [{text,start,end}] (any extra fields kept). Returns { fixes, extra, stats }.
// fixes: { "<index>": "script word" | "" }  extra: [{ text, start, end }] in the same time base.
export function alignScript(words, text, { minSim = 0.5 } = {}) {
  const s = scriptWords(text);
  const T = words.map((w) => norm(w.text)), S = s.map(norm);
  // Needleman-Wunsch style alignment maximizing matched similarity; gaps cost a little.
  const GAP = -0.4;
  const H = Array.from({ length: T.length + 1 }, () => new Float32Array(S.length + 1));
  const B = Array.from({ length: T.length + 1 }, () => new Int8Array(S.length + 1)); // 0 diag, 1 up (skip transcript), 2 left (skip script)
  for (let i = 1; i <= T.length; i++) { H[i][0] = i * GAP; B[i][0] = 1; }
  for (let j = 1; j <= S.length; j++) { H[0][j] = j * GAP; B[0][j] = 2; }
  for (let i = 1; i <= T.length; i++) {
    for (let j = 1; j <= S.length; j++) {
      const sim = similarity(T[i - 1], S[j - 1]);
      const diag = H[i - 1][j - 1] + (sim >= minSim ? sim : -1);
      const up = H[i - 1][j] + GAP, left = H[i][j - 1] + GAP;
      if (diag >= up && diag >= left) { H[i][j] = diag; B[i][j] = 0; } else if (up >= left) { H[i][j] = up; B[i][j] = 1; } else { H[i][j] = left; B[i][j] = 2; }
    }
  }
  const pairs = []; // [transcriptIndex | null, scriptIndex | null]
  let i = T.length, j = S.length;
  while (i > 0 || j > 0) {
    const b = i === 0 ? 2 : j === 0 ? 1 : B[i][j];
    if (b === 0) { pairs.push([i - 1, j - 1]); i--; j--; } else if (b === 1) { pairs.push([i - 1, null]); i--; } else { pairs.push([null, j - 1]); j--; }
  }
  pairs.reverse();
  const fixes = {}, extra = [];
  let matched = 0, changed = 0, dropped = 0;
  const timeOf = new Map(); // script index -> [start,end] for matched words
  pairs.forEach(([ti, si]) => {
    if (ti !== null && si !== null) {
      const sim = similarity(T[ti], S[si]);
      if (sim >= minSim) {
        matched++;
        timeOf.set(si, [words[ti].start, words[ti].end]);
        if (words[ti].text !== s[si]) { fixes[String(ti)] = s[si]; changed++; }
        return;
      }
      // Low similarity at a diagonal: treat as a substitution the script wins.
      fixes[String(ti)] = s[si]; changed++; timeOf.set(si, [words[ti].start, words[ti].end]);
      return;
    }
    if (ti !== null) { fixes[String(ti)] = ''; dropped++; }
  });
  // Script words with no transcript word: place them between their matched neighbours, by length.
  let run = [];
  const flush = (before, after) => {
    if (!run.length) return;
    let t0 = before ? timeOf.get(before)[1] : (after ? Math.max(0, timeOf.get(after)[0] - 0.4 * run.length) : 0);
    const t1 = after ? timeOf.get(after)[0] : t0 + 0.4 * run.length;
    // Neighbouring word times can overlap in a transcript; an inserted word must still come before
    // the word that follows it, so the gap is opened backwards when there is no room.
    if (after && t1 - t0 < 0.1 * run.length) t0 = Math.max(before ? timeOf.get(before)[0] + 0.05 : 0, t1 - 0.1 * run.length);
    if (after && t1 <= t0) t0 = Math.max(0, t1 - 0.1 * run.length);
    const total = run.reduce((a, k) => a + S[k].length, 0) || 1;
    let t = t0;
    for (const k of run) { const d = Math.max(0.12, (t1 - t0) * S[k].length / total); extra.push({ text: s[k], start: +t.toFixed(3), end: +(t + d).toFixed(3) }); t += d; }
    run = [];
  };
  let lastMatched = null;
  for (let k = 0; k < S.length; k++) {
    if (timeOf.has(k)) { flush(lastMatched, k); lastMatched = k; } else run.push(k);
  }
  flush(lastMatched, null);
  return { fixes, extra, stats: { script: S.length, transcript: T.length, matched, changed, inserted: extra.length, dropped } };
}
