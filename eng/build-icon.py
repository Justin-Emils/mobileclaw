"""Turn the supplied logo into launcher assets.

Three problems, all of them things the device showed rather than reasoning:

1. **The supplied file has a white background.** Left alone that is a white square on a launcher, and
   the corners are what the user saw as black wedges. The white is removed by flood-filling inwards
   from the border, so only white *connected to the edge* goes — the pale cream inside the wreath
   belongs to the drawing.

2. **The previous icon filled its canvas edge to edge.** A launcher applies its own mask, and artwork
   that touches the corners gets them cut into black wedges. Every mask shape Android uses — circle,
   squircle, rounded square — contains a circle of the standard 66/108 of the canvas, so the artwork
   is fitted inside that circle with margin.

3. **The artwork is cream on white**, so it needs a dark plate behind it to be legible at all. The
   background colour here is the same one `app.config.ts` gives the adaptive icon, and the foreground
   is composited over it rather than merely stacked: pre-compositing removes the light fringe that
   transparent edges leave against a dark launcher.

The source is small (186x230), so the upscale is computed and reported rather than hidden.
"""

from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SRC = Path(
    r"C:\Users\woshi\.dsh\attachments\v1\objects\d9"
    r"\d96f5ed25a04604c1c5b5f0c18f6d6528037947a714b226796e9c2a67c493884"
)
ASSETS = Path(r"E:\code\mobileclaw\apps\mobile\assets")
PREVIEW = Path(r"E:\code\mobileclaw\.logs\icon-preview")
ASSETS.mkdir(parents=True, exist_ok=True)
PREVIEW.mkdir(parents=True, exist_ok=True)
for old in PREVIEW.glob("*.png"):
    old.unlink()

CANVAS = 1024
VISIBLE = 66 / 108
ICON_BACKGROUND = (18, 24, 34)

# How much of the visible circle's diameter the artwork's longest side may span.
#
# Deliberately by the longest *side*, not the diagonal. Fitting the diagonal is the conservative
# answer for a shape whose extremes sit opposite each other, but this logo is roughly its own circle,
# and a diagonal fit shrank it to 43% of the canvas — visibly small next to every other icon on the
# screen, which is how it looked in the preview.
ART_IN_VISIBLE = 0.92

# How far from pure white still counts as background.
#
# The source is a JPEG whose "white" is a gradient, not a constant, so a tight tolerance leaves a
# speckled halo of near-white pixels that survive as opaque. Measured: the cream body is warm, with a
# channel spread of 61 (253,234,192), so a tolerance this wide cannot reach it — the spread test is
# what protects the drawing, not this number.
BACKGROUND_TOLERANCE = 70

# Alpha below this becomes fully transparent, and the edge is then eroded by this many pixels.
#
# Both exist for the same defect, seen in the preview: a ragged bright fringe around the artwork. The
# source is a JPEG whose background is a gradient rather than a constant, so pixels just off the fill
# threshold survive as opaque near-white and draw themselves as a halo. Cutting the weak ones and
# shaving the boundary removes it; the drawing is solidly painted, so neither touches its interior.
ALPHA_FLOOR = 96
EDGE_EROSION = 2


def drop_white_background(image: Image.Image) -> Image.Image:
    """Make white that touches the border transparent, and nothing else.

    A flood fill from the edges rather than "every white pixel": the drawing contains pale cream
    (253, 234, 192), which is bright enough that a global threshold would punch holes in it.
    """
    rgba = image.convert("RGBA")
    width, height = rgba.size
    pixels = rgba.load()

    def is_background(x: int, y: int) -> bool:
        r, g, b, a = pixels[x, y]
        if a == 0:
            return True
        bright = (
            r > 255 - BACKGROUND_TOLERANCE
            and g > 255 - BACKGROUND_TOLERANCE
            and b > 255 - BACKGROUND_TOLERANCE
        )
        # Desaturated as well: the cream is warm, so its blue channel sits far below its red one and
        # it fails this test even where it is bright.
        return bright and max(r, g, b) - min(r, g, b) < 18

    seen = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        for y in (0, height - 1):
            if not seen[y * width + x] and is_background(x, y):
                seen[y * width + x] = 1
                queue.append((x, y))
    for y in range(height):
        for x in (0, width - 1):
            if not seen[y * width + x] and is_background(x, y):
                seen[y * width + x] = 1
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        r, g, b, _ = pixels[x, y]
        pixels[x, y] = (r, g, b, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < width and 0 <= ny < height and not seen[ny * width + nx] and is_background(nx, ny):
                seen[ny * width + nx] = 1
                queue.append((nx, ny))

    # Cut the partly-decided pixels, erode the boundary, then soften what remains. Flood filling
    # decides per pixel, so the edge comes out stepped and carries a bright fringe; a minimum filter
    # shaves that off and a sub-pixel blur on the alpha channel alone restores a smooth outline,
    # without touching any colour.
    alpha = rgba.split()[-1].point(lambda value: 0 if value < ALPHA_FLOOR else value)
    alpha = alpha.filter(ImageFilter.MinFilter(EDGE_EROSION * 2 + 1))
    rgba.putalpha(alpha.filter(ImageFilter.GaussianBlur(0.6)))
    return rgba


source = Image.open(SRC).convert("RGB")
art = drop_white_background(source)
box = art.split()[-1].getbbox()
if box is None:
    raise SystemExit("the artwork is empty after removing the background")
art = art.crop(box)
print(f"source {source.size} -> artwork {art.size} after removing the white background")

diameter = CANVAS * VISIBLE
side = diameter * ART_IN_VISIBLE
scale = side / max(art.size)
scaled = art.resize(
    (max(1, round(art.width * scale)), max(1, round(art.height * scale))), Image.LANCZOS
)
print(f"artwork spans {ART_IN_VISIBLE:.0%} of the visible circle, upscaled {scale:.2f}x")

# Composited over the icon's own background colour, not merely stacked on top of it: an anti-aliased
# edge keeps a little of the white it was cut from, and stacking leaves that as a bright fringe
# against a dark launcher.
canvas = Image.new("RGB", (CANVAS, CANVAS), ICON_BACKGROUND)
canvas.paste(scaled, ((CANVAS - scaled.width) // 2, (CANVAS - scaled.height) // 2), scaled)

# The legacy icon is the same picture. It exists for launchers too old to use an adaptive icon, and
# they mask it the same way, so the same safe area applies -- which is what removes the corner wedges.
canvas.save(ASSETS / "icon.png")
canvas.convert("RGBA").save(ASSETS / "adaptive-icon.png")
print(f"icon.png and adaptive-icon.png: {CANVAS}x{CANVAS} on #{ICON_BACKGROUND[0]:02x}{ICON_BACKGROUND[1]:02x}{ICON_BACKGROUND[2]:02x}")

# --- previews ----------------------------------------------------------------
diameter_px = int(CANVAS * VISIBLE)
offset = (CANVAS - diameter_px) // 2

guide = canvas.copy()
ImageDraw.Draw(guide).ellipse(
    (offset, offset, offset + diameter_px, offset + diameter_px), outline=(255, 60, 60), width=4
)
guide.resize((420, 420), Image.LANCZOS).save(PREVIEW / "guide.png")

inner = canvas.crop((offset, offset, offset + diameter_px, offset + diameter_px)).resize((420, 420), Image.LANCZOS)
circle = Image.new("L", (420, 420), 0)
ImageDraw.Draw(circle).ellipse((0, 0, 419, 419), fill=255)
plate = Image.new("RGB", (420, 420), (70, 70, 70))
plate.paste(inner, (0, 0), circle)
plate.save(PREVIEW / "masked.png")
print("previews: guide.png (circle boundary on the canvas), masked.png (what a launcher shows)")
