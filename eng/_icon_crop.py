"""Locate the face and produce square icon crops for review.

The icon must be square, and Android adaptive icons additionally only show the middle ~66dp of a
108dp canvas, so the crop has to leave room around the head or the face gets clipped by the mask.
Rather than guess at the framing, the face is detected and the crop is derived from it.
"""

from pathlib import Path

import cv2
from PIL import Image

SRC = Path(
    r"C:\Users\woshi\.dsh\attachments\v1\objects\1c"
    r"\1cb11b4e124bdd70efc35aee6a22ad63c7bca8cd70411f7bf7441802ba8609bc"
)
OUT = Path(r"E:\code\mobileclaw\.logs\icon-preview")
OUT.mkdir(parents=True, exist_ok=True)

image = Image.open(SRC).convert("RGB")
width, height = image.size
print(f"source {width}x{height}")

# Haar needs greyscale. Equalising the histogram makes the detection work on a photo lit unevenly.
grey = cv2.cvtColor(cv2.imread(str(SRC)), cv2.COLOR_BGR2GRAY)
grey = cv2.equalizeHist(grey)
cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
faces = cascade.detectMultiScale(grey, scaleFactor=1.08, minNeighbors=4, minSize=(80, 80))

if len(faces) == 0:
    print("no face detected; falling back to a centred square")
    fx, fy, fw, fh = width * 0.2, height * 0.05, width * 0.6, width * 0.6
else:
    # Largest face wins: a photo taken in a room can pick up people in the background.
    fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])
    print(f"face at x={fx} y={fy} w={fw} h={fh}")

cx, cy = fx + fw / 2, fy + fh / 2

# The square is sized from the face, with headroom for hair above and a little background on the
# sides. `scale` is how many face-widths the canvas spans.
for scale in (1.9, 2.3, 2.8):
    side = fw * scale
    left = cx - side / 2
    # The face centre sits slightly above the canvas centre: a portrait reads better with more room
    # under the chin than above the head, and it keeps the hair off the top edge.
    top = cy - side * 0.52
    box = (int(left), int(top), int(left + side), int(top + side))
    crop = image.crop(box).resize((432, 432), Image.LANCZOS)
    crop.save(OUT / f"crop-{scale}.png")

    # What an adaptive icon actually shows: the middle 61% of the canvas.
    inner = int(432 * 66 / 108)
    off = (432 - inner) // 2
    crop.crop((off, off, off + inner, off + inner)).resize((432, 432), Image.LANCZOS).save(
        OUT / f"adaptive-visible-{scale}.png"
    )
    print(f"  scale={scale} window={box}")

print(f"previews in {OUT}")
