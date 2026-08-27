#!/usr/bin/env python3
"""Build a tight, rounded OctoBot logo with a crisp border."""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "docs" / "brand" / "octobot-logo.png"  # transparent 3D cutout
FALLBACK = ROOT / "docs" / "brand" / "octobot-icon-source.png"
OUT_DIR = ROOT / "docs" / "brand"
# Complementary gold-yellow to the logo purple (#b06dd1)
FILL = (245, 208, 74, 255)
RIM = (214, 168, 28, 255)
HI = 4096
OUT = 2048
# Apple-like corner, a hair tighter so the rim stays even
RADIUS = int(HI * 0.222)
PAD = 0.055
RIM_PX = 14  # ~3.5px at 1024, ~1.75px at 512 — stays crisp after downsample


def fit(im, size, pad):
    canvas = Image.new("RGBA", (size, size), FILL)
    inner = int(size * (1 - 2 * pad))
    art = im.convert("RGBA")
    scale = min(inner / art.width, inner / art.height)
    nw, nh = max(1, int(art.width * scale)), max(1, int(art.height * scale))
    art = art.resize((nw, nh), Image.Resampling.LANCZOS)
    x = (size - art.width) // 2
    y = (size - art.height) // 2
    canvas.alpha_composite(art, (x, y))
    return canvas


def rounded(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def rim_mask(size, radius, width):
    outer = rounded(size, radius)
    inner_r = max(0, radius - width)
    inset = Image.new("L", (size, size), 0)
    ImageDraw.Draw(inset).rounded_rectangle(
        (width, width, size - 1 - width, size - 1 - width),
        radius=inner_r,
        fill=255,
    )
    # ring = outer - inset
    return ImageChops.subtract(outer, inset)


def build():
    src_path = SRC if SRC.exists() else FALLBACK
    src = Image.open(src_path).convert("RGBA")
    # ignore dust/fringe so getbbox hugs the octopus
    solid = src.split()[-1].point(lambda a: 255 if a > 24 else 0)
    bbox = solid.getbbox()
    if bbox:
        src = src.crop(bbox)
    print("octopus crop", src.size)
    hi = fit(src, HI, PAD)
    mask = rounded(HI, RADIUS)
    tile = Image.new("RGBA", (HI, HI), (0, 0, 0, 0))
    tile.paste(hi, (0, 0))
    tile.putalpha(mask)

    rim = Image.new("RGBA", (HI, HI), (0, 0, 0, 0))
    rim.paste(RIM, (0, 0), rim_mask(HI, RADIUS, RIM_PX))
    tile.alpha_composite(rim)

    out = tile.resize((OUT, OUT), Image.Resampling.LANCZOS)
    dest = OUT_DIR / "octobot-logo-rounded.png"
    out.save(dest, "PNG")

    # previews for validation
    for px in (1024, 512, 256, 128, 64, 32):
        out.resize((px, px), Image.Resampling.LANCZOS).save(OUT_DIR / f"octobot-logo-rounded-{px}.png", "PNG")

    # also sit it on light / dark so we can inspect the edge
    for name, bg in (("light", (245, 246, 248, 255)), ("dark", (22, 22, 26, 255))):
        board = Image.new("RGBA", (OUT + 160, OUT + 160), bg)
        board.alpha_composite(out, (80, 80))
        board.convert("RGB").save(f"/tmp/octo-logo-round-{name}.png")

    print("wrote", dest, dest.stat().st_size)


if __name__ == "__main__":
    build()
