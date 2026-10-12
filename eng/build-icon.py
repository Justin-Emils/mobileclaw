"""Turn the supplied logo into launcher assets.

The artwork is a **white line drawing with an outer glow, on black**. That makes two things true at
once, and both matter:

1. **The background is dark, so the drawing is bright.** The obvious approach — keep the picture and
   put a plate behind it — is wrong twice over: an opaque foreground hides the adaptive icon's
   background layer entirely (which is what made a previous icon show as solid black no matter what
   colour was configured), and a black plate is not what the drawing is meant to sit on.

   So the black is *removed* by flood-filling inwards from the border. Only black connected to the
   edge goes; the dark interior of the hand and leaves is enclosed by the outline and stays.

2. **A bright line drawing is legible on white**, which the previous artwork was not — it was cream
   (253,234,192) at about 4% contrast against white, so a white background made it disappear. That is
   why the background colour could not be white before and can be now.

The artwork is fitted inside the circle every Android launcher mask contains (66/108 of the canvas),
so no shape cuts it.
"""

from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SRC = Path(
    r"C:\Users\woshi\.dsh\attachments\v1\objects\95"
    r"\95b65782e57046a45a7175c51cbbf5117946a854c09d1b3328753b9a6b8cd79c"
)
ASSETS = Path(r"E:\code\mobileclaw\apps\mobile\assets")
PREVIEW = Path(r"E:\code\mobileclaw\.logs\icon-preview")
ASSETS.mkdir(parents=True, exist_ok=True)
PREVIEW.mkdir(parents=True, exist_ok=True)
for old in PREVIEW.glob("*.png"):
    old.unlink()

CANVAS = 1024
VISIBLE = 66 / 108

# Must match `android.adaptiveIcon.backgroundColor` in `app.config.ts`, and is chosen from the
# candidates this script renders. White is right for this drawing: the lines are white, so a white
# plate reads as the line art floating on nothing, which is how the source presents it.
ICON_BACKGROUND = (255, 255, 255)

# How much of the visible circle's diameter the artwork's longest side may span. By the longest
# *side*, not the diagonal: a diagonal fit is the conservative answer for a shape whose extremes sit
# opposite each other, and for a roughly circular logo it shrinks the result to about 43% of the
# canvas — visibly small beside every other icon on a launcher.
ART_IN_VISIBLE = 0.94

# How far from pure black still counts as background, and how far below opaque counts as nothing.
#
# The source is a JPEG, so its "black" is a gradient rather than a constant and its brightest areas
# carry a glow. The tolerance is generous because the only thing it can wrongly remove is dark pixels
# touching the edge, and the drawing's own dark areas (inside the hand, inside the leaves) are
# enclosed by the outline and unreachable from the border.
BACKGROUND_TOLERANCE = 90
ALPHA_FLOOR = 64
EDGE_EROSION = 1


def drop_dark_background(image: Image.Image) -> Image.Image:
    """Make black that touches the border transparent, and nothing else."""
    rgba = image.convert("RGBA")
    width, height = rgba.size
    pixels = rgba.load()

    def is_background(x: int, y: int) -> bool:
        r, g, b, a = pixels[x, y]
        if a == 0:
            return True
        return r < BACKGROUND_TOLERANCE and g < BACKGROUND_TOLERANCE and b < BACKGROUND_TOLERANCE

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

    # The glow is a *soft* brightening around each line, so its outer skirt is nearly black. Left
    # alone that skirt reads as a grey halo against a white plate. Cutting the weak pixels and
    # shaving the boundary removes it without touching the lines, which are solidly bright.
    alpha = rgba.split()[-1].point(lambda value: 0 if value < ALPHA_FLOOR else value)
    alpha = alpha.filter(ImageFilter.MinFilter(EDGE_EROSION * 2 + 1))
    rgba.putalpha(alpha.filter(ImageFilter.GaussianBlur(0.5)))
    return rgba


source = Image.open(SRC).convert("RGB")
art = drop_dark_background(source)
box = art.split()[-1].getbbox()
if box is None:
    raise SystemExit("the artwork is empty after removing the background")
art = art.crop(box)
print(f"source {source.size} -> artwork {art.size} after removing the black background")

diameter = CANVAS * VISIBLE
side = diameter * ART_IN_VISIBLE
scale = side / max(art.size)
scaled = art.resize(
    (max(1, round(art.width * scale)), max(1, round(art.height * scale))), Image.LANCZOS
)
print(f"artwork spans {ART_IN_VISIBLE:.0%} of the visible circle, scaled {scale:.2f}x")

# The foreground layer: transparent outside the artwork, so the adaptive icon's background layer
# shows through. An opaque foreground hides that layer completely -- which is what made a previous
# icon render as solid black whatever colour was configured.
foreground = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
foreground.paste(scaled, ((CANVAS - scaled.width) // 2, (CANVAS - scaled.height) // 2), scaled)

# The standalone square for launchers too old to composite layers, so it carries the colour itself.
flat = Image.new("RGB", (CANVAS, CANVAS), ICON_BACKGROUND)
flat.paste(foreground, (0, 0), foreground)

foreground.save(ASSETS / "adaptive-icon.png")
flat.save(ASSETS / "icon.png")
alpha = foreground.split()[-1].histogram()
total = sum(alpha)
print(
    f"adaptive-icon.png: {alpha[0] / total:.1%} transparent; "
    f"icon.png: opaque #{ICON_BACKGROUND[0]:02x}{ICON_BACKGROUND[1]:02x}{ICON_BACKGROUND[2]:02x}"
)

# --- previews, one per candidate background -----------------------------------
diameter_px = int(CANVAS * VISIBLE)
offset = (CANVAS - diameter_px) // 2


def masked_with(background: tuple[int, int, int]) -> Image.Image:
    """What a launcher shows: the background layer, the foreground over it, then the round mask."""
    plate = Image.new("RGB", (CANVAS, CANVAS), background)
    plate.paste(foreground, (0, 0), foreground)
    inner = plate.crop((offset, offset, offset + diameter_px, offset + diameter_px)).resize(
        (300, 300), Image.LANCZOS
    )
    circle = Image.new("L", (300, 300), 0)
    ImageDraw.Draw(circle).ellipse((0, 0, 299, 299), fill=255)
    out = Image.new("RGB", (300, 300), (140, 140, 140))
    out.paste(inner, (0, 0), circle)
    return out


candidates = [
    ("white", (255, 255, 255)),
    ("navy", (18, 24, 34)),
    ("brandblue", (0x1E, 0x5A, 0xAA)),
    ("mid", (90, 96, 110)),
]
sheet = Image.new("RGB", (len(candidates) * 320 + 20, 340), (255, 255, 255))
draw = ImageDraw.Draw(sheet)
for index, (name, colour) in enumerate(candidates):
    x = 20 + index * 320
    sheet.paste(masked_with(colour), (x, 20))
    draw.text((x + 4, 328), name, fill=(0, 0, 0))
sheet.save(PREVIEW / "options.png")
for name, colour in candidates:
    if colour == ICON_BACKGROUND:
        masked_with(colour).resize((420, 420), Image.LANCZOS).save(PREVIEW / "masked.png")
print(f"previews: options.png ({', '.join(name for name, _ in candidates)}), masked.png (chosen)")
