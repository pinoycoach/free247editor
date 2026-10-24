"""Local word timestamps with faster-whisper. Prints [{text, start, end}] as JSON.

Called by transcribe.mjs --local. Uses the GPU when CUDA works, otherwise the CPU.
"""
import json
import sys

from faster_whisper import WhisperModel

video, model_name = sys.argv[1], sys.argv[2]
prompt = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None  # names and brand words


def transcribe(device, compute_type):
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    # vad_filter stays off: it drops soft or chanted speech, and Fable finds silence with FFmpeg instead.
    segments, _ = model.transcribe(video, word_timestamps=True, vad_filter=False, initial_prompt=prompt)
    return [
        {"text": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)}
        for s in segments
        for w in s.words
    ]


try:
    words = transcribe("cuda", "int8_float16")
except Exception as e:  # no CUDA, or CUDA 12 libraries missing
    print(f"GPU unavailable ({e}); using CPU", file=sys.stderr)
    words = transcribe("cpu", "int8")

print(json.dumps(words))
