/**
 * Turning a touch on a displayed screenshot into a point on the real screen.
 *
 * Two things make this easy to get wrong in a way that still looks right:
 *
 *  1. the picture is drawn with `resizeMode="contain"`, so it is letterboxed inside its
 *     box — the painted rectangle is smaller than the box and offset from its corner;
 *  2. the picture is downscaled, so a point on it is not a pixel of the display, and
 *     nobody in the chain knows the display's size: the person is looking at the
 *     picture, and the model has never seen the screen.
 *
 * So the output is a **fraction**, which is the only thing that survives the trip, and
 * the backend resolves it against the real display when the tap runs. Getting the
 * letterbox wrong produces a press that lands slightly off target, which reads as the
 * target app being slow rather than as a bug — hence pure functions with tests.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rectangle `resizeMode="contain"` actually paints inside a box. */
export function containRect(image: Size, box: Size): Rect {
  if (image.width <= 0 || image.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/**
 * Where a touch inside the painted picture lands, as a fraction of that picture.
 *
 * Undefined when the touch was on the letterbox — the empty margin. That is a miss, not
 * a point at the edge: clamping it would send the press somewhere the user did not
 * choose, and on a tall phone the margins are wide enough to hit by accident.
 */
export function toFraction(touch: Point, drawn: Rect): Point | undefined {
  if (drawn.width <= 0 || drawn.height <= 0) return undefined;
  if (touch.x < drawn.x || touch.y < drawn.y) return undefined;
  if (touch.x > drawn.x + drawn.width || touch.y > drawn.y + drawn.height) return undefined;

  return {
    x: (touch.x - drawn.x) / drawn.width,
    y: (touch.y - drawn.y) / drawn.height,
  };
}

/**
 * Keep a fraction in range.
 *
 * A touch on the very edge comes back as exactly 1, which the backend would turn into a
 * coordinate one past the last pixel — a tap that the system silently drops.
 */
export function clampFraction(point: Point): Point {
  return {
    x: Math.min(Math.max(point.x, 0), 1),
    y: Math.min(Math.max(point.y, 0), 1),
  };
}
