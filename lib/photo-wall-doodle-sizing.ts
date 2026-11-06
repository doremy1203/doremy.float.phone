/**
 * Photo-wall sticker sizing uses one stable world-space unit.
 * Canvas zoom scales stickers naturally with the wall; changing the wall's
 * dimensions does not silently change an existing sticker's size.
 */
export const DEFAULT_WALL_STICKER_SIZE = 120;
export const DEFAULT_PHOTO_STICKER_SIZE = 34;

export function stickerSizeFromBrushWidth(brushWidth: number): number {
  return Math.max(12, Math.min(144, Math.round(brushWidth * 12)));
}

export function resolveStickerSize(
  doodle: { size?: number },
  legacyDefault: number,
): number {
  return typeof doodle.size === "number" && Number.isFinite(doodle.size)
    ? Math.max(8, Math.min(360, doodle.size))
    : legacyDefault;
}
