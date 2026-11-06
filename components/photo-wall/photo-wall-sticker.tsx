"use client";

import type { PhotoWallDoodle } from "@/lib/photo-wall-storage";

const HEART_STICKER_PATH = "M0,6 C-1.4,3.8 -6,1 -6,-2 C-6,-5 -3,-6 0,-4 C3,-6 6,-5 6,-2 C6,1 1.4,3.8 0,6 Z";

/** The single DOM renderer shared by wall-level and photo-level stickers. */
export function PhotoWallSticker({ doodle, size }: { doodle: PhotoWallDoodle; size: number }) {
  const x = doodle.points[0]?.x ?? 0.5;
  const y = doodle.points[0]?.y ?? 0.5;
  const isHeart = doodle.content === "heart" || doodle.content === "❤";
  return (
    <div
      style={{
        position: "absolute",
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: size,
        height: size,
        display: "grid",
        placeItems: "center",
        transform: `translate(-50%, -50%) rotate(${doodle.rotation ?? 0}deg)`,
        lineHeight: 1,
        color: doodle.color,
        pointerEvents: "none",
      }}
    >
      {isHeart
        ? <svg width="100%" height="100%" viewBox="-8 -8 16 16" aria-hidden="true"><path d={HEART_STICKER_PATH} fill={doodle.color} /></svg>
        : <span style={{ display: "block", maxWidth: "100%", maxHeight: "100%", fontSize: size, lineHeight: 1, color: doodle.color }}>{doodle.content || "✦"}</span>}
    </div>
  );
}
