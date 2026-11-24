#!/usr/bin/env python3
"""Pop-style edit: pulsing punch-in, scale-bounce text, colour lift, light pop sfx.
usage: tools/pop.py <config.json>   (see configs in reports/ or the batch runner)
"""
import json, subprocess, sys, os
from PIL import Image, ImageDraw, ImageFont

FONT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fable', 'video-projects',
                    'books-reading-2026-11-24', 'assets', 'fonts', 'Montserrat-ExtraBold.ttf')
W, H = 1080, 1920
YEL = (250, 204, 21, 255); WHT = (255, 255, 255, 255); BLK = (20, 20, 20, 255)


def text_png(path, lines, accent, cy):
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    sizes = []
    for i, t in enumerate(lines):
        size = 150 if i == accent else 112
        while ImageFont.truetype(FONT, size).getlength(t) > 920 and size > 40:
            size -= 4
        sizes.append(size)
    gap = 16
    total = sum(sizes) + gap * (len(lines) - 1)
    y = cy - total / 2
    for i, t in enumerate(lines):
        f = ImageFont.truetype(FONT, sizes[i]); x = (W - f.getlength(t)) / 2
        fill = YEL if i == accent else WHT
        d.text((x + 8, y + 10), t, font=f, fill=(0, 0, 0, 255), stroke_width=12, stroke_fill=(0, 0, 0, 255))
        d.text((x, y), t, font=f, fill=fill, stroke_width=12, stroke_fill=BLK)
        y += sizes[i] + gap
    img.save(path)


def probe(src):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


def build(cfg, tmp):
    src, out = cfg['src'], cfg['out']
    hold = cfg.get('hold', 0)
    dur = probe(src) + hold
    ev = cfg['events']; cy = cfg.get('cy', 1330); P = cfg.get('pulse', 2.4)
    keep_audio = cfg.get('audio', 'sfx') == 'keep'
    inputs = ['-i', src]; fc = []
    pre = f"scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880,fps=30"
    if hold:
        pre += f",tpad=stop_mode=clone:stop_duration={hold}"
    fc.append(f"[0:v]{pre},zoompan=z='1+0.07*exp(-7*mod(on/30,{P}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps=30,"
              f"eq=contrast=1.06:saturation=1.2,setsar=1[v0]")
    for k, e in enumerate(ev):
        p = os.path.join(tmp, f"t{k}.png")
        text_png(p, e['lines'], e.get('accent', len(e['lines']) - 1), cy)
        inputs += ['-loop', '1', '-framerate', '30', '-t', f"{dur:.3f}", '-i', p]
    for k, e in enumerate(ev):
        S, E = e['start'], min(e['end'], dur)
        fc.append(f"[{k+1}:v]format=rgba,fade=t=in:st={S}:d=0.1:alpha=1,fade=t=out:st={E-0.12:.3f}:d=0.12:alpha=1,"
                  f"scale=w='1080*(1+0.3*max(0,1-(t-{S})/0.22))':h=-1:eval=frame[tx{k}]")
        fc.append(f"[v{k}][tx{k}]overlay=x='540-540*w/1080':y='{cy}-{cy}*w/1080':enable='between(t,{S},{E:.3f})':eval=frame[v{k+1}]")
    vlab = f"[v{len(ev)}]"
    n = len(ev)
    # audio
    sfx_in = []
    for k, e in enumerate(ev):
        inputs += ['-f', 'lavfi', '-t', '0.3', '-i', "sine=f=900:d=0.07,afade=t=out:d=0.065:curve=exp"]
        idx = n + 1 + k
        ms = int(e['start'] * 1000)
        fc.append(f"[{idx}:a]volume={0.5 if keep_audio else 1.0},adelay={ms}|{ms}[s{k}]")
        sfx_in.append(f"[s{k}]")
    if keep_audio:
        fc.append(f"[0:a]loudnorm=I=-14:TP=-1.5,apad[ao]")
        fc.append(f"[ao]{''.join(sfx_in)}amix=inputs={n+1}:normalize=0:duration=first,atrim=0:{dur:.3f}[aout]")
    else:
        fc.append(f"anullsrc=r=48000:cl=stereo[sil]")
        fc.append(f"[sil]{''.join(sfx_in)}amix=inputs={n+1}:normalize=0:duration=first,atrim=0:{dur:.3f},aresample=48000[aout]")
    cmd = ['ffmpeg', '-y', '-v', 'error'] + inputs + ['-filter_complex', ';'.join(fc), '-map', vlab, '-map', '[aout]',
           '-t', f"{dur:.3f}", '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-b:a', '160k', out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print(r.stderr[-1500:]); sys.exit(1)
    print('ok', out, f"{dur:.1f}s")


if __name__ == '__main__':
    import tempfile
    for cfg in json.load(open(sys.argv[1])):
        with tempfile.TemporaryDirectory() as t:
            build(cfg, t)
