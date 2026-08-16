#!/usr/bin/env python3
"""Build OctoBot app icons from the official purple octopus still."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "brand" / "octobot-icon-source.png"
BUILD = ROOT / "build"
ICONSET = BUILD / "icon.iconset"
PREVIEWS = ROOT / "docs" / "brand"
CORAL = (247, 76, 94, 255)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def fit_square(im, size, pad=0.07):
    """Scale the art onto a coral square with a little margin for the macOS mask."""
    canvas = Image.new("RGBA", (size, size), CORAL)
    inner = int(size * (1 - 2 * pad))
    art = im.copy().convert("RGBA")
    art.thumbnail((inner, inner), Image.Resampling.LANCZOS)
    x = (size - art.width) // 2
    y = (size - art.height) // 2
    canvas.alpha_composite(art, (x, y))
    return canvas


def face_crop(im):
    w, h = im.size
    return im.crop((int(w * 0.18), int(h * 0.08), int(w * 0.82), int(h * 0.68)))


def write_iconset(icon, src):
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
    face = face_crop(src)
    for px, name in specs:
        if px <= 32:
            tile = fit_square(face, px, pad=0.06)
        else:
            tile = icon.resize((px, px), Image.Resampling.LANCZOS)
        tile.save(ICONSET / name, "PNG")


def write_ico(icon):
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    icon.save(BUILD / "icon.ico", sizes=sizes)


def write_rounded(icon, size, radius_ratio=0.223):
    tile = icon.resize((size, size), Image.Resampling.LANCZOS)
    mask = rounded_mask(size, int(size * radius_ratio))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(tile, (0, 0))
    out.putalpha(mask)
    return out


def write_previews(icon):
    # Full-bleed master — macOS applies the squircle itself
    icon.save(BUILD / "icon.png", "PNG")
    icon.save(PREVIEWS / "octobot-icon.png", "PNG")
    # Rounded PNG for README / web
    rounded = write_rounded(icon, 1024)
    rounded.save(PREVIEWS / "octobot-icon-rounded.png", "PNG")
    write_rounded(icon, 256).save(PREVIEWS / "octobot-icon-256-rounded.png", "PNG")

    size = 1024
    preview = Image.new("RGBA", (size + 160, size + 160), (236, 237, 241, 255))
    shadow = Image.new("RGBA", preview.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((100, 110, 100 + size, 110 + size), radius=230, fill=(0, 0, 0, 80))
    shadow = shadow.filter(ImageFilter.GaussianBlur(22))
    preview.alpha_composite(shadow)
    preview.alpha_composite(write_rounded(icon, size), (80, 80))
    preview.convert("RGB").save(PREVIEWS / "octobot-icon-preview.png", "PNG")
    preview.resize((320, 320), Image.Resampling.LANCZOS).save(PREVIEWS / "octobot-icon-128-preview.png", "PNG")
    write_rounded(icon, 32).save(PREVIEWS / "octobot-icon-32.png", "PNG")


def main():
    BUILD.mkdir(parents=True, exist_ok=True)
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    src = Image.open(SOURCE).convert("RGBA")
    icon = fit_square(src, 1024, pad=0.06)
    write_iconset(icon, src)
    write_ico(icon)
    write_previews(icon)
    print("wrote", BUILD / "icon.png")
    print("wrote", BUILD / "icon.ico")
    print("wrote", ICONSET)


if __name__ == "__main__":
    main()
