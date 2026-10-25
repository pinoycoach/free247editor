"""Where is the face? Samples a video at 2 fps with OpenCV's YuNet detector (230 KB model, CPU)
and writes face.json: per-sample face box, mouth line, and a summary Fable uses to keep captions
and the hook card off the face. Values are fractions of the frame width and height, 0..1.

    python tools/track_face.py <video> <out.json>

Needs: pip install opencv-python-headless
"""
import json
import sys
import time
from pathlib import Path

import cv2

video, out = sys.argv[1], sys.argv[2]
model = str(Path(__file__).resolve().parent.parent / "fable" / "models" / "face_detection_yunet_2023mar.onnx")
t0 = time.time()
cap = cv2.VideoCapture(video)
if not cap.isOpened():
    sys.exit(f"cannot open {video}")
fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
step = max(1, round(fps / 2))
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
    small = cv2.resize(frame, (iw, ih), interpolation=cv2.INTER_AREA)
    _, faces = det.detect(small)
    if faces is not None and len(faces):
        f = max(faces, key=lambda r: r[2] * r[3])  # the biggest face is the speaker
        x, y, w, h = f[:4]
        samples.append({
            "t": round(i / fps, 2),
            "cx": round(float(x + w / 2) / iw, 3), "cy": round(float(y + h / 2) / ih, 3),
            "top": round(float(y) / ih, 3), "chin": round(float(y + h) / ih, 3),
            "mouth": round(float((f[11] + f[13]) / 2) / ih, 3), "score": round(float(f[14]), 2),
        })
    i += 1
cap.release()
res = {"source": [W, H], "sampled": (i + step - 1) // step, "detections": len(samples), "seconds": round(time.time() - t0, 2), "timeline": samples}
if samples:
    def q(key, p):
        vals = sorted(s[key] for s in samples)
        return vals[min(len(vals) - 1, int(len(vals) * p))]
    res["summary"] = {"face_top_p10": q("top", 0.10), "mouth_min": q("mouth", 0.0), "mouth_median": q("mouth", 0.5),
                      "chin_p90": q("chin", 0.90), "cx_median": q("cx", 0.5), "cy_median": q("cy", 0.5),
                      "coverage": round(min(1.0, len(samples) / max(1, (i + step - 1) // step)), 2)}
Path(out).write_text(json.dumps(res, indent=1), encoding="utf-8")
print(json.dumps({k: v for k, v in res.items() if k != "timeline"}))
