#!/usr/bin/env python3
"""Build OctoBot app icons from the transparent mascot logo."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
LOGO = ROOT / "docs" / "brand" / "octobot-logo.png"
BUILD = ROOT / "build"
ICONSET = BUILD / "icon.iconset"
PREVIEWS = ROOT / "docs" / "brand"


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def make_square_icon(logo, size=1024, pad=0.13):
    bg = Image.new("RGB", (size, size), (255, 248, 236))
    # soft radial wash
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    cx = cy = size / 2
    for i in range(18, 0, -1):
        r = int(size * 0.18 * i)
        alpha = 10 if i > 8 else 16
        draw.ellipse((cx - r, cy - r * 0.92, cx + r, cy + r * 0.92), fill=(255, 229, 102, alpha))
    bg = bg.convert("RGBA")
    bg.alpha_composite(overlay)

    inner = int(size * (1 - 2 * pad))
    mascot = logo.copy()
    mascot.thumbnail((inner, inner), Image.Resampling.LANCZOS)
    x = (size - mascot.width) // 2
    y = (size - mascot.height) // 2 + int(size * 0.02)
    bg.alpha_composite(mascot, (x, y))
    return bg.convert("RGBA")


def face_icon(logo, size):
    """Tighter face crop so 16/32px still read as the octopus."""
    w, h = logo.size
    face = logo.crop((int(w * 0.16), int(h * 0.06), int(w * 0.84), int(h * 0.74)))
    return make_square_icon(face, size=size, pad=0.08)


def write_iconset(icon, logo):
    ICONSET.mkdir(parents=True, exist_ok=True)
    specs = [
        (16, "icon_16x16.png"),
        (32, "diana.v@example.org"),
        (32, "icon_32x32.png"),
        (64, "ivan.p@example.net"),
        (128, "icon_128x128.png"),
        (256, "wendy.h@example.net"),
        (256, "icon_256x256.png"),
        (512, "alice.j@example.com"),
        (512, "icon_512x512.png"),
        (1024, "walt.e@example.net"),
    ]
    for px, name in specs:
        src = face_icon(logo, px) if px <= 32 else icon.resize((px, px), Image.Resampling.LANCZOS)
        src.save(ICONSET / name, "PNG")


def write_ico(icon):
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    icon.save(BUILD / "icon.ico", sizes=sizes)


def write_previews(icon):
    # Full-bleed master (macOS applies the squircle)
    icon.save(BUILD / "icon.png", "PNG")
    icon.save(PREVIEWS / "octobot-icon.png", "PNG")
    # How it looks in the Dock / Finder
    size = 1024
    preview = Image.new("RGBA", (size + 160, size + 160), (236, 237, 241, 255))
    shadow = Image.new("RGBA", preview.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((100, 110, 100 + size, 110 + size), radius=230, fill=(0, 0, 0, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(22))
    preview.alpha_composite(shadow)
    mask = rounded_mask(size, 228)
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile.paste(icon, (0, 0))
    tile.putalpha(mask)
    preview.alpha_composite(tile, (80, 80))
    preview.convert("RGB").save(PREVIEWS / "octobot-icon-preview.png", "PNG")
    # 128px dock-scale check
    small = preview.resize((320, 320), Image.Resampling.LANCZOS)
    small.save(PREVIEWS / "octobot-icon-128-preview.png", "PNG")


def main():
    BUILD.mkdir(parents=True, exist_ok=True)
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    logo = Image.open(LOGO).convert("RGBA")
    icon = make_square_icon(logo)
    write_iconset(icon, logo)
    write_ico(icon)
    write_previews(icon)
    print("wrote", BUILD / "icon.png")
    print("wrote", BUILD / "icon.ico")
    print("wrote", ICONSET)


if __name__ == "__main__":
    main()
