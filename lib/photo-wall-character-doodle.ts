import { createPhotoWallId, type PhotoWallDoodle } from "@/lib/photo-wall-storage";
import { stickerSizeFromBrushWidth } from "@/lib/photo-wall-doodle-sizing";

const ALLOWED_STICKERS = new Set(["♡", "❤", "✦", "✿", "☾", "☘", "♪", "★", "❀", "✧"]);

type CharacterArtist = { id: string; name: string };

type CharacterDoodleResponse = {
  doodles: PhotoWallDoodle[];
  summary: string;
  createdAt: string;
};

/**
 * Validate the model's response before it can enter persistent photo-wall state.
 * Keep AI parsing out of the UI component so this boundary has one implementation.
 */
export function parseCharacterWallDoodles(response: string, artist: CharacterArtist): CharacterDoodleResponse {
  const raw = response.trim()
    .replace(/^\x60{3}(?:json)?\s*/i, "")
    .replace(/\s*\x60{3}$/, "");
  const parsed = JSON.parse(raw) as { elements?: unknown; doodles?: unknown; summary?: unknown };
  const candidates = Array.isArray(parsed.elements)
    ? parsed.elements
    : Array.isArray(parsed.doodles) ? parsed.doodles : [];
  const createdAt = new Date().toISOString();
  const clamp = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(0.98, Math.max(0.02, value)) : null;
  const doodles: PhotoWallDoodle[] = [];

  for (const candidate of candidates.slice(0, 8)) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as {
      kind?: unknown;
      content?: unknown;
      x?: unknown;
      y?: unknown;
      points?: unknown;
      color?: unknown;
      width?: unknown;
      size?: unknown;
    };
    const color = typeof item.color === "string" && /^#[0-9a-f]{6}$/i.test(item.color)
      ? item.color
      : "#d98ca3";
    const width = typeof item.width === "number" && Number.isFinite(item.width)
      ? Math.min(5, Math.max(1, item.width))
      : 2.5;

    if (item.kind === "sticker") {
      const x = clamp(item.x);
      const y = clamp(item.y);
      if (x === null || y === null || typeof item.content !== "string" || !ALLOWED_STICKERS.has(item.content)) continue;
      doodles.push({
        id: createPhotoWallId(),
        kind: "sticker",
        content: item.content,
        color,
        width,
        size: typeof item.size === "number" && Number.isFinite(item.size)
          ? Math.min(360, Math.max(8, item.size))
          : stickerSizeFromBrushWidth(3),
        points: [{ x, y }],
        createdAt,
        authorType: "character",
        authorId: artist.id,
        authorName: artist.name,
      });
      continue;
    }

    if (item.kind !== "stroke" || !Array.isArray(item.points)) continue;
    const points = item.points.slice(0, 18).flatMap(value => {
      if (!value || typeof value !== "object") return [];
      const point = value as { x?: unknown; y?: unknown };
      const x = clamp(point.x);
      const y = clamp(point.y);
      return x === null || y === null ? [] : [{ x, y }];
    });
    if (points.length < 3) continue;
    doodles.push({
      id: createPhotoWallId(),
      kind: "stroke",
      color,
      width,
      points,
      createdAt,
      authorType: "character",
      authorId: artist.id,
      authorName: artist.name,
    });
  }

  if (!doodles.length) throw new Error("角色返回的涂鸦格式不完整，请再试一次。");
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 300) : "";
  return { doodles, summary, createdAt };
}
