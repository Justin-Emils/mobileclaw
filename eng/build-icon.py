"""Produce the app icon assets from the photo.

Framing, measured from the source (722x828) and checked by rendering the adaptive-icon mask over
the candidate:

  * the head spans y=130..690, centred on the photo's own horizontal centre
  * a 722x722 square at y=49..771 is the largest square that stays inside the photo, so no padding
    is invented and nothing is cropped from the head
  * Android shows only the middle 66dp of an adaptive icon's 108dp canvas, so the square is scaled
    until the head fills ~80% of that visible circle: large enough to recognise at launcher size,
    small enough that the round mask does not cut the hair or chin

Outputs the two files Expo consumes, plus a preview of each.
"""

from pathlib import Path

from PIL import Image, ImageDraw

SRC = Path(
    r"C:\Users\woshi\.dsh\attachments\v1\objects\1c"
    r"\1cb11b4e124bdd70efc35aee6a22ad63c7bca8cd70411f7bf7441802ba8609bc"
)
ASSETS = Path(r"E:\code\mobileclaw\apps\mobile\assets")
PREVIEW = Path(r"E:\code\mobileclaw\.logs\icon-preview")
ASSETS.mkdir(parents=True, exist_ok=True)
PREVIEW.mkdir(parents=True, exist_ok=True)
for old in PREVIEW.glob("*.png"):
    old.unlink()

HEAD_TOP, HEAD_BOTTOM = 130, 690
HEAD_CY = (HEAD_TOP + HEAD_BOTTOM) / 2
HEAD_H = HEAD_BOTTOM - HEAD_TOP
VISIBLE = 66 / 108
ICON_SIZE = 1024

image = Image.open(SRC).convert("RGB")

# Largest square that fits the photo, centred on the head.
side = image.width
top = int(round(HEAD_CY - side / 2))
square = image.crop((0, top, side, top + side))
print(f"square {square.size} from y={top}")

# --- the legacy icon: the whole square, corner to corner ----------------------
square.resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS).save(ASSETS / "icon.png")
print(f"icon.png {ICON_SIZE}x{ICON_SIZE}")

# --- the adaptive foreground: a 108dp canvas whose middle 66dp is the visible circle ---
#
# The canvas is fixed at ICON_SIZE and the *content* is scaled into it, with the margin left
# transparent. The first attempt did the inverse -- scaled the canvas up and cropped the centre back
# to ICON_SIZE -- which magnified the head by 1/0.611 and pushed it outside the mask entirely. The
# two are easy to confuse and look identical in the file: 1024x1024 either way.
visible = ICON_SIZE * VISIBLE                      # 66dp of the 108dp canvas
head_in_icon = visible * 0.80                      # how much of the circle the head should fill
scale = head_in_icon / HEAD_H
inner = int(round(side * scale))
foreground = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))
background = Image.new("RGB", (ICON_SIZE, ICON_SIZE), (18, 24, 34))
offset = (ICON_SIZE - inner) // 2
# The square is cropped from a point that keeps the head centred, which is where it already is.
foreground.paste(square.resize((inner, inner), Image.LANCZOS), (offset, offset))
foreground.save(ASSETS / "adaptive-icon.png")
background.save(ASSETS / "adaptive-icon-background.png")
print(
    f"adaptive-icon.png {ICON_SIZE}x{ICON_SIZE}: content {inner}px, "
    f"visible circle {visible:.0f}px, head {head_in_icon:.0f}px ({head_in_icon / visible:.0%} of it)"
)

# --- previews ----------------------------------------------------------------
def masked_round(source: Image.Image, size: int = 420) -> Image.Image:
    """What a circular launcher mask shows of a 108dp canvas."""
    visible = int(size * VISIBLE)
    off = (size - visible) // 2
    inner = source.resize((size, size), Image.LANCZOS).crop((off, off, off + visible, off + visible))
    inner = inner.resize((size, size), Image.LANCZOS)
    circle = Image.new("L", (size, size), 0)
    ImageDraw.Draw(circle).ellipse((0, 0, size - 1, size - 1), fill=255)
    plate = Image.new("RGB", (size, size), (18, 24, 34))
    plate.paste(inner, (0, 0), circle)
    return plate


masked_round(Image.open(ASSETS / "adaptive-icon.png").convert("RGB")).save(PREVIEW / "masked.png")
Image.open(ASSETS / "icon.png").resize((256, 256), Image.LANCZOS).save(PREVIEW / "legacy.png")
print("previews: masked.png (launcher circle), legacy.png")
