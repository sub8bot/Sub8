#!/usr/bin/env python3
"""Draw a pointer crosshair onto a desktop screenshot (no edge rulers)."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def font(size):
    for name in ("DejaVuSans.ttf", "Arial.ttf", "Helvetica.ttc"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def annotate(src: Path, dest: Path, px: int, py: int) -> None:
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    f = font(11)
    # crosshair at pointer — do not paint edge rulers; those show on the human stream.
    if 0 <= px < w and 0 <= py < h:
        col = (255, 60, 120, 230)
        gap, arm = 6, 22
        d.line((px, py - arm, px, py - gap), fill=col, width=2)
        d.line((px, py + gap, px, py + arm), fill=col, width=2)
        d.line((px - arm, py, px - gap, py), fill=col, width=2)
        d.line((px + gap, py, px + arm, py), fill=col, width=2)
        d.ellipse((px - 3, py - 3, px + 3, py + 3), outline=col, width=2)
        label = f"{px},{py}"
        tx, ty = min(w - 64, px + 10), max(18, py - 18)
        d.rectangle((tx - 2, ty - 1, tx + 56, ty + 14), fill=(8, 8, 10, 180))
        d.text((tx, ty), label, fill=(255, 200, 220, 255), font=f)
    out = Image.alpha_composite(im, overlay).convert("RGB")
    dest.parent.mkdir(parents=True, exist_ok=True)
    out.save(dest, "PNG")


def main():
    if len(sys.argv) < 5:
        print("usage: annotate-shot.py SRC DEST X Y", file=sys.stderr)
        sys.exit(2)
    annotate(Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]))


if __name__ == "__main__":
    main()
