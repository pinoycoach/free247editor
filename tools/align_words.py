"""Forced alignment: snap each transcript word's start and end to where the sound actually is.

Whisper places word boundaries from attention, so on soft speech it often starts a word on
the vowel and ends it before the trailing consonant. This runs a small CTC model (MMS-300M,
quantized ONNX, CPU) over the audio and finds the letters of each word frame by frame, then
moves the word's start and end to the acoustic onset and offset. Nothing leaves the computer.

    python tools/align_words.py <audio-or-video> <words.json> <out.json> [--max-shift 0.25] [--mode widen|replace]

widen (default): a word may only grow, so cuts get more room and nothing is clipped; replace:
take the aligned times as they are (tighter captions, riskier cuts).

words.json: { words: [{ text, start, end }, ...] } (Fable's raw.json). out.json: the same, with
start/end refined and, per word, the original times under "whisper".

Needs: pip install onnxruntime numpy  (model: fable/models/model.q8.onnx, 356 MB, downloaded
by setup on request; vocab: fable/models/aligner-vocab.json)
"""
import json
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

import numpy as np

try:
    import onnxruntime as ort
except ImportError:
    sys.exit("onnxruntime is not installed: pip install onnxruntime numpy")

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "fable" / "models" / "model.q8.onnx"
VOCAB = ROOT / "fable" / "models" / "aligner-vocab.json"
SR = 16000
FRAME = 0.02          # the model emits one frame per 320 samples at 16 kHz
WINDOW = 12.0         # seconds of speech per model call; keeps memory flat
MARGIN = 0.15         # audio kept around each window

if len(sys.argv) < 4:
    sys.exit(__doc__)
media, words_path, out_path = sys.argv[1:4]
max_shift = float(sys.argv[sys.argv.index("--max-shift") + 1]) if "--max-shift" in sys.argv else 0.25
mode = sys.argv[sys.argv.index("--mode") + 1] if "--mode" in sys.argv else "widen"   # widen | replace
if not MODEL.exists() or not VOCAB.exists():
    sys.exit(f"aligner model missing: {MODEL} (run node setup.mjs and accept the download)")

t0 = time.time()
vocab = json.loads(VOCAB.read_text(encoding="utf-8"))
blank = vocab.get("<blank>", 0)


def load_audio(path):
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(SR), "pipe:1"]
    return np.frombuffer(subprocess.check_output(cmd), dtype=np.float32)


def letters(text):
    s = unicodedata.normalize("NFKD", text.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").replace("’", "'")
    return [c for c in s if c in vocab and not c.startswith("<")]


def viterbi(logp, tokens):
    """CTC alignment of a token sequence to log-probabilities (T, V). Returns per-token (start, end) frames."""
    S = 2 * len(tokens) + 1
    ext = np.full(S, blank, dtype=np.int64)
    ext[1::2] = tokens
    T = logp.shape[0]
    if T < len(tokens):
        return None
    emit = logp[:, ext]                                   # (T, S)
    # Allowed skip (s-2 -> s) only into a non-blank token different from the previous token.
    skip_ok = np.zeros(S, dtype=bool)
    skip_ok[2:] = (ext[2:] != blank) & (ext[2:] != ext[:-2])
    score = np.full(S, -np.inf, dtype=np.float32)
    score[0] = emit[0, 0]
    if S > 1:
        score[1] = emit[0, 1]
    back = np.zeros((T, S), dtype=np.int16)              # 0 stay, 1 from s-1, 2 from s-2
    for t in range(1, T):
        stay = score
        prev1 = np.concatenate(([-np.inf], score[:-1]))
        prev2 = np.concatenate(([-np.inf, -np.inf], score[:-2]))
        prev2 = np.where(skip_ok, prev2, -np.inf)
        best = np.maximum(np.maximum(stay, prev1), prev2)
        choice = np.where(best == prev2, 2, np.where(best == prev1, 1, 0))
        back[t] = choice
        score = best + emit[t]
    s = S - 1 if score[S - 1] >= score[S - 2] else S - 2
    path = np.empty(T, dtype=np.int64)
    for t in range(T - 1, -1, -1):
        path[t] = s
        s -= back[t, s]
    spans = []
    for k in range(len(tokens)):
        frames = np.flatnonzero(path == 2 * k + 1)
        spans.append((int(frames[0]), int(frames[-1]) + 1) if frames.size else None)
    return spans


audio = load_audio(media)
doc = json.loads(Path(words_path).read_text(encoding="utf-8"))
words = doc.get("words", [])
opts = ort.SessionOptions()
opts.intra_op_num_threads = 4
opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
sess = ort.InferenceSession(str(MODEL), sess_options=opts, providers=["CPUExecutionProvider"])
inp = sess.get_inputs()[0].name

# Windows: consecutive words up to WINDOW seconds long, split at the biggest gap near the limit.
windows, cur = [], []
for w in words:
    if cur and (w["end"] - cur[0]["start"] > WINDOW):
        windows.append(cur)
        cur = []
    cur.append(w)
if cur:
    windows.append(cur)

moved, shifts = 0, []
for win in windows:
    a = max(0.0, win[0]["start"] - MARGIN)
    b = min(len(audio) / SR, win[-1]["end"] + MARGIN)
    seg = audio[int(a * SR):int(b * SR)]
    if seg.size < SR // 4:
        continue
    seg = (seg - seg.mean()) / np.sqrt(((seg - seg.mean()) ** 2).mean() + 1e-7)
    feed = {inp: seg[np.newaxis, :].astype(np.float32)}
    for i in sess.get_inputs()[1:]:
        if i.name == "attention_mask":
            feed[i.name] = np.ones((1, seg.size), dtype=np.int64)
    logits = sess.run(None, feed)[0][0]
    logp = logits - np.log(np.exp(logits - logits.max(axis=-1, keepdims=True)).sum(axis=-1, keepdims=True)) - logits.max(axis=-1, keepdims=True)
    tokens, ranges = [], []
    for w in win:
        ch = letters(w["text"])
        if not ch:
            ranges.append(None)
            continue
        ranges.append((len(tokens), len(tokens) + len(ch)))
        tokens.extend(vocab[c] for c in ch)
    if not tokens:
        continue
    spans = viterbi(logp, tokens)
    if spans is None:
        continue
    for w, r in zip(win, ranges):
        if r is None:
            continue
        found = [spans[i] for i in range(r[0], r[1]) if spans[i]]
        if not found:
            continue
        start = round(a + found[0][0] * FRAME, 3)
        end = round(a + found[-1][1] * FRAME, 3)
        w.setdefault("whisper", {"start": w["start"], "end": w["end"]})
        ok_start = abs(start - w["start"]) <= max_shift
        ok_end = abs(end - w["end"]) <= max_shift and end > (start if ok_start else w["start"])
        if mode == "widen":
            # Safe for cutting: a word may only grow. The earlier start and the later end win.
            ok_start = ok_start and start < w["start"]
            ok_end = ok_end and end > w["end"]
        if ok_start:
            shifts.append(start - w["start"])
            w["start"] = start
        if ok_end:
            shifts.append(end - w["end"])
            w["end"] = end
        if ok_start or ok_end:
            moved += 1

# Never let a widened word run into its neighbour.
for prev, nxt in zip(words, words[1:]):
    if nxt["start"] < prev["end"]:
        mid = round((prev["end"] + nxt["start"]) / 2, 3) if prev.get("whisper") and nxt.get("whisper") else nxt["start"]
        prev["end"], nxt["start"] = min(prev["end"], mid), max(nxt["start"], mid)

doc["aligned"] = {"model": "mms-300m-1130-forced-aligner q8", "mode": mode, "words_moved": moved, "of": len(words),
                  "median_shift_ms": int(round(float(np.median(np.abs(shifts))) * 1000)) if shifts else 0,
                  "max_shift_ms": int(round(float(np.max(np.abs(shifts))) * 1000)) if shifts else 0,
                  "seconds": round(time.time() - t0, 1)}
Path(out_path).write_text(json.dumps(doc, indent=2), encoding="utf-8")
print(json.dumps(doc["aligned"]))
