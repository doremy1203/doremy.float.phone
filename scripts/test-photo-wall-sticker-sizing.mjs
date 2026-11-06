import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [canvas, exportSource, sizing, sticker, storage, app] = await Promise.all([
  readFile(new URL("../components/photo-wall/photo-wall-canvas.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/photo-wall-export.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/photo-wall-doodle-sizing.ts", import.meta.url), "utf8"),
  readFile(new URL("../components/photo-wall/photo-wall-sticker.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/photo-wall-storage.ts", import.meta.url), "utf8"),
  readFile(new URL("../components/photo-wall-app.tsx", import.meta.url), "utf8"),
]);

assert.match(sizing, /brushWidth \* 12/);
assert.match(sizing, /DEFAULT_WALL_STICKER_SIZE = 120/);
assert.match(sizing, /DEFAULT_PHOTO_STICKER_SIZE = 34/);
assert.match(canvas, /size: stickerSize/);
assert.match(canvas, /stickerSize: controlledStickerSize/);
assert.match(canvas, /resolveStickerSize\(doodle, DEFAULT_WALL_STICKER_SIZE\)/);
assert.match(canvas, /resolveStickerSize\(doodle, DEFAULT_PHOTO_STICKER_SIZE\) \* placement\.scale/);
assert.doesNotMatch(canvas, /wallWorld\?\.width[^\n]*0\.05/);
assert.doesNotMatch(canvas, /StickerGlyph|StickerMark/);
assert.match(sticker, /PhotoWallSticker/);
assert.match(storage, /size\?: number/);
assert.match(storage, /raw\.size/);
assert.match(exportSource, /resolveStickerSize\(doodle, DEFAULT_WALL_STICKER_SIZE\)/);
assert.match(exportSource, /resolveStickerSize\(doodle, DEFAULT_PHOTO_STICKER_SIZE\)/);
assert.doesNotMatch(exportSource, /frameWidth \* 0\.16|frameWidth \* 0\.18|width \* 0\.05/);
assert.match(app, /贴纸大小/);
assert.match(app, /stickerSizeFromBrushWidth\(width\)/);
assert.match(app, /wallStickerSize/);
assert.match(app, /stickerSize=\{wallStickerSize\}/);
assert.match(app, /if \(wallSticker\) setWallStickerSize\(next\)/);
assert.match(storage, /Math\.min\(64, Math\.max\(1, raw\.width\)\)/);

console.log("Photo-wall sticker sizing checks passed.");
