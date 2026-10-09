import { useEffect, useState } from "react";
import {
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { clampFraction, containRect, toFraction, type Point, type Size } from "@/ui/point-mapping";
import { strings } from "@/ui/strings";
import { theme } from "@/ui/theme";

/** Drawn size of the crosshair, in points. */
const MARKER_RADIUS = 12;

/**
 * Full-screen point picker.
 *
 * Deliberately not a panel inside the approval sheet: that sheet is capped at 520px wide,
 * and a 1080px screenshot scaled into it turns a 40px control into about 19px — too small
 * to reliably "tap the search box" on. This takes the whole screen instead.
 *
 * The model cannot see the screen, so this is where the coordinate comes from. Nothing
 * here guesses: until the user taps, there is no point to confirm.
 */
export function PointPicker({
  visible,
  image,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  image: string;
  /** Receives the point as a fraction of the picture, which is what the backend wants. */
  onConfirm: (point: Point) => void;
  onCancel: () => void;
}) {
  const [imageSize, setImageSize] = useState<Size>();
  const [box, setBox] = useState<Size>();
  const [picked, setPicked] = useState<Point>();

  useEffect(() => {
    if (!visible) return;
    setPicked(undefined);
    // The *picture's* size, which is downscaled and therefore not the display's. The
    // choice is made in the picture's pixels and scaled back afterwards.
    Image.getSize(
      image,
      (width, height) => setImageSize({ width, height }),
      () => setImageSize(undefined),
    );
  }, [visible, image]);

  const drawn = imageSize && box ? containRect(imageSize, box) : undefined;

  const onPress = (event: GestureResponderEvent): void => {
    if (!drawn) return;
    const point = toFraction(
      { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
      drawn,
    );
    // A touch on the letterbox returns nothing; leave the previous choice alone rather
    // than snapping the press to an edge the user did not aim at.
    if (point) setPicked(clampFraction(point));
  };

  // Where to draw the crosshair, back in the box's own coordinates.
  const marker = drawn && picked
    ? { x: drawn.x + picked.x * drawn.width, y: drawn.y + picked.y * drawn.height }
    : undefined;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.screen}>
        <Text style={styles.title}>{strings.automation.pickTitle}</Text>
        <Text style={styles.hint}>
          {imageSize ? strings.automation.pickHint : strings.automation.pickNoImage}
        </Text>

        <Pressable
          style={styles.canvas}
          onLayout={(event: LayoutChangeEvent) =>
            setBox({
              width: event.nativeEvent.layout.width,
              height: event.nativeEvent.layout.height,
            })
          }
          onPress={onPress}
        >
          <Image source={{ uri: image }} style={StyleSheet.absoluteFill} resizeMode="contain" />
          {marker ? (
            <View
              style={[
                styles.marker,
                { left: marker.x - MARKER_RADIUS, top: marker.y - MARKER_RADIUS },
              ]}
            />
          ) : null}
        </Pressable>

        <Text style={styles.readout}>
          {picked
            ? strings.automation.pickCoordinates(
                Math.round(picked.x * 100),
                Math.round(picked.y * 100),
              )
            : " "}
        </Text>

        <View style={styles.actions}>
          <Pressable style={[styles.button, styles.cancel]} onPress={onCancel}>
            <Text style={styles.cancelText}>{strings.automation.pickCancel}</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.confirm, picked ? null : styles.disabled]}
            disabled={!picked}
            onPress={() => picked && onConfirm(picked)}
          >
            <Text style={styles.confirmText}>{strings.automation.pickConfirm}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
    padding: theme.space(4),
    gap: theme.space(3),
  },
  title: { color: theme.colors.text, fontSize: 18, fontWeight: "600" },
  hint: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 19 },
  canvas: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    overflow: "hidden",
  },
  marker: {
    position: "absolute",
    width: MARKER_RADIUS * 2,
    height: MARKER_RADIUS * 2,
    borderRadius: MARKER_RADIUS,
    borderWidth: 2,
    borderColor: theme.colors.accent,
    backgroundColor: "rgba(255,255,255,0.25)",
  },
  readout: { color: theme.colors.text, fontSize: 13, fontFamily: theme.font.mono },
  actions: { flexDirection: "row", gap: theme.space(2), justifyContent: "flex-end" },
  button: {
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2.5),
    borderRadius: theme.radius.md,
  },
  cancel: { backgroundColor: theme.colors.surfaceAlt },
  cancelText: { color: theme.colors.text, fontWeight: "600" },
  confirm: { backgroundColor: theme.colors.accent },
  confirmText: { color: "#fff", fontWeight: "600" },
  disabled: { opacity: 0.4 },
});
