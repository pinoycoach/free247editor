"""Which frame makes the best cover? Samples a video three times a second and scores each sample:
a confident, front-on face that is sharp (not mid-move, not motion blurred) wins. Without a face in
the video, the sharpest frame wins. Prints the pick and two alternates as JSON.

    python tools/pick_cover.py <video> [start end]

    {"pick": {"t": 12.33, "face": {"cx":..,"cy":..,"top":..,"chin":..,"eyes":..,"mouth":..}}, "alternates": [..]}

Times are seconds into the video; face values are fractions of the frame. The first 0.4 s and the
last 0.6 s are skipped (fades, the hand reaching for the phone).

Needs: pip install opencv-python-headless
"""
import json
import sys
from pathlib import Path

import cv2

video = sys.argv[1]
model = str(Path(__file__).resolve().parent.parent / "fable" / "models" / "face_detection_yunet_2023mar.onnx")
cap = cv2.VideoCapture(video)
if not cap.isOpened():
    sys.exit(f"cannot open {video}")
fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
total = cap.get(cv2.CAP_PROP_FRAME_COUNT) / fps if cap.get(cv2.CAP_PROP_FRAME_COUNT) else 0
W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
# Only this part of the video was used (a trimmed clip): pick inside it.
lo = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
hi = float(sys.argv[3]) if len(sys.argv) > 3 else (total or 1e9)
step = max(1, round(fps / 3))
iw = 360
ih = max(2, round(H * iw / W))
det = cv2.FaceDetectorYN.create(model, "", (iw, ih), 0.65, 0.3, 5)
samples, i = [], 0
while True:
    if i % step:
        if not cap.grab():
            break
        i += 1
        continue
    ok, frame = cap.read()
    if not ok:
        break
    t = i / fps
    i += 1
    if t < lo + 0.4 or t > hi - 0.6:
        continue
    small = cv2.resize(frame, (iw, ih), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    _, faces = det.detect(small)
    face, region, score = None, gray, 0.0
    if faces is not None and len(faces):
        f = max(faces, key=lambda r: r[2] * r[3])
        x, y, w, h = [int(v) for v in f[:4]]
        x0, y0, x1, y1 = max(0, x), max(0, y), min(iw, x + w), min(ih, y + h)
        if x1 - x0 > 8 and y1 - y0 > 8:
            region = gray[y0:y1, x0:x1]
            # Front-on: the nose sits midway between the eyes. A turned head scores lower.
            eye_gap = abs(float(f[6] - f[4])) or 1.0
            turn = abs(float(f[8]) - float(f[4] + f[6]) / 2) / eye_gap
            score = float(f[14]) * max(0.3, 1.0 - turn)
            face = {
                "cx": round(float(x + w / 2) / iw, 3), "cy": round(float(y + h / 2) / ih, 3),
                "top": round(float(y) / ih, 3), "chin": round(float(y + h) / ih, 3),
                "eyes": round(float((f[5] + f[7]) / 2) / ih, 3), "mouth": round(float((f[11] + f[13]) / 2) / ih, 3),
            }
    sharp = float(cv2.Laplacian(region, cv2.CV_64F).var())
    samples.append({"t": round(t, 2), "face": face, "score": score, "sharp": sharp})
cap.release()
if not samples:
    sys.exit("no frames to pick from")

# Sharpness is relative to this video; a face counts for more than a sharp wall.
top_sharp = max(s["sharp"] for s in samples) or 1.0
for s in samples:
    s["rank"] = (s["sharp"] / top_sharp) * (0.35 + s["score"])
ranked = sorted(samples, key=lambda s: -s["rank"])
picks = []
for s in ranked:
    if all(abs(s["t"] - p["t"]) >= 1.5 for p in picks):
        picks.append(s)
    if len(picks) == 3:
        break
out = [{"t": p["t"], "face": p["face"]} for p in picks]
print(json.dumps({"pick": out[0], "alternates": out[1:], "faces": sum(1 for s in samples if s["face"]), "sampled": len(samples)}))
