"""Draws caption cards for `node fable.mjs caption`: white bold text with a black outline and a
soft shadow, color emoji, and *accent* words. One transparent PNG per card, cropped to the text,
plus where to put it. libass cannot draw color emoji, so these cards are drawn here.

    python tools/caption_cards.py <spec.json>      prints [{file, x, y, w, h}, ...] as JSON

spec: { W, H, centerY, maxW, font, serif, color, accent, size,
        cards: [{ out, lines, scale, color, serif, x?, y?, anchor? }] }
A card with x/y is placed there (anchor "ne" = top right, used for the AI tag); others are
centered on centerY.

Needs: pip install pillow
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

spec = json.load(open(sys.argv[1], encoding="utf-8"))
W, H = spec["W"], spec["H"]

# Color emoji fonts: Windows draws at any size; Apple and Noto are bitmap fonts with one fixed size.
EMOJI_FONTS = [
    ("C:/Windows/Fonts/seguiemj.ttf", None),
    ("/System/Library/Fonts/Apple Color Emoji.ttc", 160),
    ("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", 109),
    ("/usr/share/fonts/noto/NotoColorEmoji.ttf", 109),
    ("/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf", 109),
]
EMOJI = next(((p, s) for p, s in EMOJI_FONTS if os.path.exists(p)), None)
_emoji_cache = {}


def is_emoji(ch):
    o = ord(ch)
    return o >= 0x1F000 or 0x2190 <= o <= 0x21FF or 0x2600 <= o <= 0x27BF or 0x2B00 <= o <= 0x2BFF or o in (0xFE0F, 0x200D)


def emoji_image(text, size):
    """One emoji run as an RGBA image `size` pixels tall, or None when no emoji font exists."""
    if not EMOJI:
        return None
    key = (text, size)
    if key in _emoji_cache:
        return _emoji_cache[key]
    path, fixed = EMOJI
    try:
        font = ImageFont.truetype(path, fixed or size)
        box = font.getbbox(text)
        w, h = max(1, box[2] - box[0]), max(1, box[3] - box[1])
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(img).text((-box[0], -box[1]), text, font=font, embedded_color=True)
        if h != size:
            img = img.resize((max(1, round(w * size / h)), size), Image.LANCZOS)
    except Exception:
        img = None
    _emoji_cache[key] = img
    return img


def runs(text):
    """Split a line into ('text', s, accent) and ('emoji', s) runs. *stars* mark accent words."""
    out, accent = [], False
    for ch in text:
        if ch == "*":
            accent = not accent
            continue
        kind = ("emoji",) if is_emoji(ch) else ("text", accent)
        if out and out[-1][0] == kind:
            out[-1][1] += ch
        else:
            out.append([kind, ch])
    return out


def measure(parts, font, size, d):
    w = 0
    for kind, s in parts:
        if kind[0] == "emoji":
            img = emoji_image(s, round(size * 0.95))
            w += img.width if img else 0
        else:
            w += d.textlength(s, font=font)
    return w


def draw_card(card):
    face = spec["serif"] if card.get("serif") and spec.get("serif") else spec["font"]
    size = round(spec["size"] * card.get("scale", 1))
    max_w = card.get("maxW", spec["maxW"])
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    lines = [runs(t) for t in card["lines"]]
    # Shrink until the widest line fits; never wrap here (the script already chose the breaks).
    while True:
        font = ImageFont.truetype(face, size)
        stroke = max(2, round(size * 0.1))
        widths = [measure(p, font, size, probe) for p in lines]
        if max(widths) + 2 * stroke <= max_w or size <= 24:
            break
        size = max(24, int(size * max_w / (max(widths) + 2 * stroke)) - 1)
    gap = round(size * 0.2)
    line_h = size + gap
    pad = stroke + 10
    cw = int(max(widths) + 2 * pad)
    ch = int(line_h * len(lines) - gap + size * 0.3 + 2 * pad)
    img = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    base = card.get("color") or spec["color"]
    y = pad
    for parts, w in zip(lines, widths):
        x = (cw - w) / 2
        for kind, s in parts:
            if kind[0] == "emoji":
                em = emoji_image(s, round(size * 0.95))
                if em:
                    img.alpha_composite(em, (round(x), round(y + size * 0.12)))
                    x += em.width
                continue
            fill = spec["accent"] if kind[1] else base
            d.text((x + 4, y + 6), s, font=font, fill=(0, 0, 0, 150), stroke_width=stroke, stroke_fill=(0, 0, 0, 150))
            d.text((x, y), s, font=font, fill=fill, stroke_width=stroke, stroke_fill="black")
            x += d.textlength(s, font=font)
        y += line_h
    img.save(card["out"])
    if "x" in card:
        left = card["x"] - cw if card.get("anchor") == "ne" else card["x"]
        top = card["y"]
    else:
        left, top = (W - cw) / 2, spec["centerY"] - ch / 2
    return {"file": card["out"], "x": round(left), "y": round(max(0, min(H - ch, top))), "w": cw, "h": ch, "size": size}


print(json.dumps([draw_card(c) for c in spec["cards"]]))
