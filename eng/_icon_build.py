"""Build the app icon from the photo, and show what an adaptive icon mask will keep.

Sizing decisions, measured from the photo (722x828):

  * the head spans roughly y=130 (top of the hair) to y=690 (chin), centred on x=361
  * an adaptive icon only shows the middle 66dp of its 108dp canvas, i.e. the central 61%

So the source is scaled so the *whole head* lands inside that 61% window, with margin — otherwise
the circular mask cuts the hair off at the top and the chin at the bottom.
"""

from pathlib import Path

from PIL import Image, ImageDraw

SRC = Path(
    r"C:\Users\woshi\.dsh\attachments\v1\objects\1c"
    r"\1cb11b4e124bdd70efc35aee6a22ad63c7bca8cd70411f7bf7441802ba8609bc"
)
OUT = Path(r"E:\code\mobileclaw\.logs\icon-preview")
OUT.mkdir(parents=True, exist_ok=True)

CANVAS = 1024
# Android's adaptive-icon mask: 108dp canvas, 66dp of it visible.
VISIBLE_FRACTION = 66 / 108

image = Image.open(SRC).convert("RGB")
head_left, head_top, head_right, head_bottom = 90, 130, 640, 690
head_cy = (head_top + head_bottom) / 2
head_cx = (head_left + head_right) / 2
head_h = head_bottom - head_top

# How much of the canvas the head should span. Under `VISIBLE_FRACTION` leaves a margin inside the
# mask; at 0.95 of it the head nearly fills what is shown without touching the cut.
head_share = VISIBLE_FRACTION * 0.95

for target_head_share in (head_share, head_share * 0.85):
    # Canvas size in source pixels: how wide the full 108dp square is, given the head's width there.
    canvas_src = head_h / target_head_share
    left = head_cx - canvas_src / 2
    top = head_cy - canvas_src / 2

    # Crop, padding with the nearest edge pixel when the square runs past the photo.
    box = (int(round(left)), int(round(top)), int(round(left + canvas_src)), int(round(top + canvas_src)))
    padded = Image.new("RGB", (box[2] - box[0], box[3] - box[1]))
    crop = image.crop(
        (
            max(0, box[0]),
            max(0, box[1]),
            min(image.width, box[2]),
            min(image.height, box[3]),
        )
    )
    padded.paste(crop, (max(0, -box[0]), max(0, -box[1])))

    icon = padded.resize((CANVAS, CANVAS), Image.LANCZOS)
    tag = f"{int(target_head_share * 100)}"
    icon.save(OUT / f"icon-{tag}.png")

    # What the launcher actually shows: the central 66/108, inside a circle.
    visible = int(CANVAS * VISIBLE_FRACTION)
    offset = (CANVAS - visible) // 2
    masked = icon.crop((offset, offset, offset + visible, offset + visible)).resize((480, 480), Image.LANCZOS)
    circle = Image.new("L", (480, 480), 0)
    ImageDraw.Draw(circle).ellipse((0, 0, 479, 479), fill=255)
    plate = Image.new("RGB", (480, 480), (18, 24, 34))
    plate.paste(masked, (0, 0), circle)
    plate.save(OUT / f"masked-{tag}.png")

    print(f"  head share {target_head_share:.3f} -> canvas {canvas_src:.0f}px in source, box {box}")

print(f"previews in {OUT}")
