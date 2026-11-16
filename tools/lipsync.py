#!/usr/bin/env python3
"""Lip sync to music: measure a take against the song, then retime it.

  python tools/lipsync.py sheets <reference> <take> [--out DIR] [--from S] [--to S]
                                 [--ref-crop x,y,w,h] [--take-crop x,y,w,h]
  python tools/lipsync.py retime <take> <map.txt> <out.mp4> [--check <reference>]

sheets  One JPEG per 1.5 s: the reference's spectrogram (100-5000 Hz) on top, a strip of the
        reference performer under it, a strip of the take under that, one thumbnail per frame,
        all on the same clock. A white line every 6 frames. The file name is the first frame
        (sync-0132.jpg starts at frame 132); frame = first + x / 48.
retime  Rebuild the take so chosen source frames land on chosen output frames. map.txt has one
        anchor per line, "<output frame> <source frame>", "blend" after it to cross-fade the
        stretch that follows (use on a slowed stretch that has movement). Between anchors the
        take is sped up (frames dropped) or slowed (frames repeated). Writes a silent track;
        --check also writes <out>-SYNC-CHECK-not-for-posting.mp4 with the reference's sound.

Crops are fractions of the frame (left, top, width, height). Both videos must share a frame
rate and start on the same beat. Nothing is uploaded. Needs ffmpeg; numpy only for "blend".
Frames go through a pipe two at a time, so it runs on a laptop with little memory free.
"""
import argparse
import math
import os
import subprocess
import sys

COLS = 36          # frames per sheet
TILE = 48          # px per frame


def probe(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries',
         'stream=width,height,r_frame_rate,nb_read_packets', '-of', 'csv=p=0', path],
        capture_output=True, text=True, check=True).stdout.strip().split(',')
    w, h = int(out[0]), int(out[1])
    num, den = out[2].split('/')
    return w, h, float(num) / float(den), int(out[3])


def crop_filter(spec):
    x, y, w, h = [float(v) for v in spec.split(',')]
    return f'crop=iw*{w}:ih*{h}:iw*{x}:ih*{y}'


def sheets(a):
    _, _, fps, n_ref = probe(a.reference)
    _, _, fps_take, n_take = probe(a.take)
    if abs(fps - fps_take) > 0.01:
        sys.exit(f'Frame rates differ ({fps:g} vs {fps_take:g}). Convert the take first: '
                 f'ffmpeg -i take.mp4 -r {fps:g} take-{fps:g}.mp4')
    os.makedirs(a.out, exist_ok=True)
    n = min(n_ref, n_take)
    first = int((a.start or 0) * fps) // COLS * COLS
    last = min(n, int(math.ceil((a.to or n / fps) * fps)))
    lines = ','.join(f'drawbox=x={TILE * 6 * i}:w=1:h=ih:c=white' for i in range(1, COLS // 6))
    made = []
    for s in range(first, last, COLS):
        dst = os.path.join(a.out, f'sync-{s:04d}.jpg')
        strip = f'scale={TILE}:54,tile={COLS}x1'
        graph = (
            f'[0:a]showspectrumpic=s={COLS * TILE}x360:legend=0:scale=log:start=100:stop=5000,{lines}[sp];'
            f'[1:v]trim=start_frame={s}:end_frame={s + COLS},{crop_filter(a.ref_crop)},{strip}[a];'
            f'[2:v]trim=start_frame={s}:end_frame={s + COLS},{crop_filter(a.take_crop)},{strip}[b];'
            f'[sp][a][b]vstack=inputs=3[o]')
        r = subprocess.run(
            ['ffmpeg', '-v', 'error', '-y', '-ss', f'{s / fps:.4f}', '-t', f'{COLS / fps:.4f}',
             '-i', a.reference, '-threads', '1', '-i', a.reference, '-threads', '1', '-i', a.take,
             '-filter_complex', graph, '-map', '[o]', '-frames:v', '1', '-q:v', '3', dst])
        if r.returncode == 0:
            made.append(dst)
    print(f'{len(made)} sheets in {a.out}: frames {first}-{last} at {fps:g} fps, '
          f'{COLS} frames per sheet, {TILE} px per frame.')
    print('Top: spectrogram of the reference. Middle: reference. Bottom: the take.')


def read_map(path):
    anchors = []
    for raw in open(path, encoding='utf8'):
        line = raw.split('#')[0].split()
        if len(line) >= 2:
            anchors.append((int(line[0]), int(line[1]), len(line) > 2 and line[2].lower() == 'blend'))
    anchors.sort()
    if len(anchors) < 2:
        sys.exit('The map needs at least two anchors: "<output frame> <source frame>" per line.')
    for (o0, s0, _), (o1, s1, _) in zip(anchors, anchors[1:]):
        if o1 <= o0 or s1 < s0:
            sys.exit(f'Anchors must move forward: {o0} {s0} then {o1} {s1}.')
    return anchors


def retime(a):
    w, h, fps, n = probe(a.take)
    anchors = read_map(a.map)
    if anchors[-1][1] >= n:
        sys.exit(f'The map asks for source frame {anchors[-1][1]}, the take has {n}.')
    try:
        import numpy as np
    except Exception:
        np = None
    total = anchors[-1][0] + 1
    pos = []
    for o in range(total):
        for (o0, s0, b), (o1, s1, _) in zip(anchors, anchors[1:]):
            if o0 <= o <= o1:
                s = s0 + (s1 - s0) * (o - o0) / (o1 - o0)
                pos.append((s, True) if b else (float(math.floor(s + 0.5)), False))
                break
        else:
            pos.append((float(anchors[0][1]), False))
    video = a.out + '.video.mp4'
    size = w * h * 3 // 2
    dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-threads', '1', '-i', a.take, '-f', 'rawvideo',
                            '-pix_fmt', 'yuv420p', '-'], stdout=subprocess.PIPE)
    enc = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', f'{w}x{h}',
         '-r', f'{fps:g}', '-i', '-', '-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast',
         '-threads', '2', '-x264-params', 'rc-lookahead=8:ref=2', '-pix_fmt', 'yuv420p', video],
        stdin=subprocess.PIPE)

    def read():
        b = dec.stdout.read(size)
        return b if len(b) == size else None

    cur, idx, nxt = read(), 0, read()
    blended = skipped = 0
    for s, blend in pos:
        while idx < int(math.floor(s)) and nxt is not None:
            cur, nxt, idx = nxt, read(), idx + 1
        frac = s - idx
        frame = cur
        if blend and frac > 0.05 and nxt is not None:
            try:
                k = int(round(frac * 256))
                x = np.frombuffer(cur, np.uint8).astype(np.uint16)
                x *= (256 - k)
                y = np.frombuffer(nxt, np.uint8).astype(np.uint16)
                y *= k
                x += y
                x >>= 8
                frame = x.astype(np.uint8).tobytes()
                blended += 1
            except (MemoryError, AttributeError):
                frame = nxt if frac >= 0.5 else cur
                skipped += 1
        enc.stdin.write(frame)
    enc.stdin.close()
    enc.wait()
    dec.kill()
    if enc.returncode != 0:
        sys.exit('The encoder failed. A full disk is the usual reason: node fable.mjs clean')
    mux = ['-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart']
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', video, '-f', 'lavfi', '-i',
                    'anullsrc=r=44100:cl=stereo', *mux, '-b:a', '64k', a.out], check=True)
    print(f'{a.out}: {total} frames, silent track ({blended} blended frames'
          + (f', {skipped} not blended: no memory or no numpy' if skipped else '') + ').')
    if a.check:
        root, ext = os.path.splitext(a.out)
        chk = f'{root}-SYNC-CHECK-not-for-posting{ext}'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', video, '-i', a.check, '-map', '0:v',
                        '-map', '1:a', *mux, '-b:a', '128k', chk], check=True)
        print(f'{chk}: same picture with the reference sound, for judging only.')
    os.remove(video)


def main():
    p = argparse.ArgumentParser(description='Lip sync to music: measure, then retime.')
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('sheets')
    s.add_argument('reference')
    s.add_argument('take')
    s.add_argument('--out', default='sync-sheets')
    s.add_argument('--from', dest='start', type=float)
    s.add_argument('--to', type=float)
    s.add_argument('--ref-crop', default='0,0.08,1,0.5')
    s.add_argument('--take-crop', default='0.28,0.27,0.44,0.28')
    s.set_defaults(run=sheets)
    r = sub.add_parser('retime')
    r.add_argument('take')
    r.add_argument('map')
    r.add_argument('out')
    r.add_argument('--check')
    r.set_defaults(run=retime)
    a = p.parse_args()
    a.run(a)


if __name__ == '__main__':
    main()
