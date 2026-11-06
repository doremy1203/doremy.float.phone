import { loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { fallbackPlacement } from "@/components/photo-wall/photo-wall-canvas";
import { downloadFile } from "@/lib/download-utils";
import type { PhotoWallDoodle, PhotoWallFrameStyle, PhotoWallPhoto, PhotoWallPlacement, PhotoWallWorld } from "@/lib/photo-wall-storage";
import { DEFAULT_PHOTO_STICKER_SIZE, DEFAULT_WALL_STICKER_SIZE, resolveStickerSize } from "@/lib/photo-wall-doodle-sizing";

/**
 * 把整面照片墙绘制成一张 PNG。
 * 走 canvas 重绘而不是对 DOM 截图：避免受滚动位置、屏幕尺寸、PWA 缩放的干扰，
 * 导出结果始终是同一张高分辨率图。
 */

const BASE_PHOTO_RATIO = 0.1;

const FRAME_PADDING: Record<PhotoWallFrameStyle, { x: number; y: number; bottom: number }> = {
  polaroid: { x: 0.055, y: 0.045, bottom: 0.16 },
  thin: { x: 0.018, y: 0.018, bottom: 0.03 },
  wood: { x: 0.05, y: 0.05, bottom: 0.09 },
  tape: { x: 0.03, y: 0.03, bottom: 0.06 },
  none: { x: 0, y: 0, bottom: 0 },
};

const FRAME_BG: Record<PhotoWallFrameStyle, string> = {
  polaroid: "#fffdf8",
  thin: "#f6f1e6",
  wood: "#a97c52",
  tape: "#fbf6ea",
  none: "transparent",
};

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function drawCover(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
  if (!iw || !ih) return;
  const scale = Math.max(width / iw, height / ih), drawWidth = iw * scale, drawHeight = ih * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}
function drawContain(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
  if (!iw || !ih) return;
  const scale = Math.min(width / iw, height / ih), drawWidth = iw * scale, drawHeight = ih * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

/**
 * aspect：画布宽高比。无界墙扩容后世界不再是固定 4:5，
 * 导出要跟着世界比例走，否则照片会被横向压扁。
 */
function drawHeartSticker(context: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, rotation: number): void {
  context.save();
  context.translate(x, y);
  context.rotate((rotation * Math.PI) / 180);
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(0, size * 0.6);
  context.bezierCurveTo(-size * 0.14, size * 0.38, -size * 0.6, size * 0.1, -size * 0.6, -size * 0.2);
  context.bezierCurveTo(-size * 0.6, -size * 0.5, -size * 0.3, -size * 0.6, 0, -size * 0.4);
  context.bezierCurveTo(size * 0.3, -size * 0.6, size * 0.6, -size * 0.5, size * 0.6, -size * 0.2);
  context.bezierCurveTo(size * 0.6, size * 0.1, size * 0.14, size * 0.38, 0, size * 0.6);
  context.closePath();
  context.fill();
  context.restore();
}

export type ExportOptions = { width?: number; height?: number; /** Export resolution multiplier; defaults to 2x the wall's world dimensions. */ scale?: number; background?: string; aspect?: number; world?: PhotoWallWorld; backgroundRef?: string; backgroundBox?: PhotoWallWorld; wallDoodles?: PhotoWallDoodle[] };

/** 返回 PNG 的 dataURL；没有任何照片时返回 null。默认按世界尺寸的 2 倍导出。 */
async function renderPhotoWallCanvas(photos: PhotoWallPhoto[], options: ExportOptions = {}): Promise<HTMLCanvasElement | null> {
  if (!photos.length) return null;
  const worldWidth = options.world?.width && options.world.width > 0 ? options.world.width : 2400;
  const worldHeight = options.world?.height && options.world.height > 0 ? options.world.height : 3000;
  const aspect = typeof options.aspect === "number" && Number.isFinite(options.aspect) && options.aspect > 0.2 && options.aspect < 5
    ? options.aspect : worldWidth / worldHeight;
  // Keep exports genuinely high-resolution while avoiding mobile WebView canvas OOMs.
  // 32 MP is a conservative working limit for a canvas that also decodes source photos.
  const requestedScale = Number.isFinite(options.scale) ? Math.max(1, Math.min(4, options.scale!)) : 2;
  const desiredWidth = Math.max(1, Math.round(options.width ?? worldWidth * requestedScale));
  const desiredHeight = Math.max(1, Math.round(options.height ?? (options.width ? desiredWidth / aspect : worldHeight * requestedScale)));
  // Apply the safety cap after explicit width/height too, so custom export options cannot
  // accidentally bypass the mobile memory guard. Keep the requested aspect ratio intact.
  const outputScale = Math.min(
    1,
    10000 / desiredWidth,
    10000 / desiredHeight,
    Math.sqrt(32_000_000 / Math.max(1, desiredWidth * desiredHeight)),
  );
  const width = Math.max(1, Math.floor(desiredWidth * outputScale));
  const height = Math.max(1, Math.floor(desiredHeight * outputScale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  // 墙面底色 + 细微纹理
  context.fillStyle = options.background || "#f7f1e6";
  context.fillRect(0, 0, width, height);
  const glow = context.createRadialGradient(width * 0.5, height * 0.1, 0, width * 0.5, height * 0.1, width);
  glow.addColorStop(0, "rgba(255,255,255,.75)");
  glow.addColorStop(1, "rgba(232,222,205,.55)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
  if (options.backgroundRef) {
    let backgroundUrl = "";
    try {
      backgroundUrl = (await loadMediaObjectUrl(options.backgroundRef).catch(() => null)) ?? "";
      if (backgroundUrl) {
        const image = await loadImage(backgroundUrl), world = options.world, box = options.backgroundBox;
        if (image) {
          if (world && box && world.width > 0 && world.height > 0) context.drawImage(image, 0, 0, width * box.width / world.width, height * box.height / world.height);
          else drawCover(context, image, 0, 0, width, height);
        }
      }
    } finally { if (backgroundUrl) URL.revokeObjectURL(backgroundUrl); }
  }

  const ordered = photos.slice().sort((a, b) => (a.placement?.z ?? 0) - (b.placement?.z ?? 0));
  const placements: PhotoWallPlacement[] = ordered.map((photo, index) => photo.placement ?? fallbackPlacement(index));
  const frameRatio = options.world?.width && options.world.width > 0 ? 240 / options.world.width : BASE_PHOTO_RATIO;

  // 并行取图，失败的照片画一个占位框而不是整张导出失败
  const images = await Promise.all(ordered.map(async photo => {
    const url = await loadMediaObjectUrl(photo.mediaRef).catch(() => "");
    if (!url) return null;
    const image = await loadImage(url);
    URL.revokeObjectURL(url);
    return image;
  }));

  for (let index = 0; index < ordered.length; index += 1) {
    const photo = ordered[index];
    const placement = placements[index];
    const frame = placement.frame;
    const pad = FRAME_PADDING[frame];
    const frameWidth = frameRatio * placement.scale * width;
    // 相框高度 = 图片区（正方形）+ 上下留白
    const innerSize = frameWidth * (1 - pad.x * 2);
    const frameHeight = innerSize + frameWidth * (pad.y + pad.bottom);

    context.save();
    context.translate(placement.x * width, placement.y * height);
    context.rotate((placement.rotation * Math.PI) / 180);

    // 阴影
    context.shadowColor = "rgba(70,55,38,0.22)";
    context.shadowBlur = frameWidth * 0.08;
    context.shadowOffsetY = frameWidth * 0.03;

    // 相框底
    const frameColor = placement.frameColor || FRAME_BG[frame];
    if (frame === "none") {
      roundedRect(context, -innerSize / 2, -innerSize / 2, innerSize, innerSize, innerSize * 0.04);
    } else {
      roundedRect(context, -frameWidth / 2, -frameHeight / 2, frameWidth, frameHeight, frameWidth * 0.02);
      context.fillStyle = frameColor || "#fffdf8";
      context.fill();
    }
    context.shadowColor = "transparent";
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;

    // 图片
    const imageX = -innerSize / 2;
    const imageY = -frameHeight / 2 + frameWidth * pad.y;
    context.save();
    roundedRect(context, imageX, imageY, innerSize, innerSize, frame === "none" ? innerSize * 0.04 : 2);
    context.clip();
    context.fillStyle = "#e7dfd2";
    context.fillRect(imageX, imageY, innerSize, innerSize);
    const image = images[index];
    if (image) drawContain(context, image, imageX, imageY, innerSize, innerSize);
    else {
      context.fillStyle = "#b08d7a";
      context.font = `${Math.round(innerSize * 0.09)}px sans-serif`;
      context.textAlign = "center";
      context.fillText("图片无法显示", 0, imageY + innerSize / 2);
    }
    context.restore();

    // 宝丽来下缘标题
    if (frame === "polaroid" && photo.title) {
      context.fillStyle = "#8d7c66";
      context.font = `${Math.round(frameWidth * 0.055)}px serif`;
      context.textAlign = "center";
      context.fillText(photo.title.slice(0, 18), 0, frameHeight / 2 - frameWidth * pad.bottom * 0.45);
    }

    // 相框级涂鸦：坐标是相对整张相框的 0~1
    for (const doodle of photo.doodles ?? []) {
      if (doodle.kind === "stroke" && doodle.points.length > 1) {
        context.strokeStyle = doodle.color;
        context.lineWidth = doodle.width * (frameWidth / 260);
        context.lineCap = "round";
        context.lineJoin = "round";
        context.beginPath();
        doodle.points.forEach((point, pointIndex) => {
          const px = -frameWidth / 2 + point.x * frameWidth;
          const py = -frameHeight / 2 + point.y * frameHeight;
          if (pointIndex === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        });
        context.stroke();
      } else if (doodle.kind === "sticker" && doodle.content) {
        const point = doodle.points[0] ?? { x: 0.5, y: 0.5 };
        if (doodle.content === "heart" || doodle.content === "❤") {
          drawHeartSticker(context, -frameWidth / 2 + point.x * frameWidth, -frameHeight / 2 + point.y * frameHeight, resolveStickerSize(doodle, DEFAULT_PHOTO_STICKER_SIZE) * placement.scale * (width / worldWidth), doodle.color, doodle.rotation ?? 0);
        } else {
          context.fillStyle = doodle.color;
          context.font = `${Math.round(resolveStickerSize(doodle, DEFAULT_PHOTO_STICKER_SIZE) * placement.scale * (width / worldWidth))}px sans-serif`;
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillText(doodle.content, -frameWidth / 2 + point.x * frameWidth, -frameHeight / 2 + point.y * frameHeight);
          context.textBaseline = "alphabetic";
        }
      }
    }

    context.restore();
  }

  for (const doodle of options.wallDoodles ?? []) {
    if (doodle.kind === "stroke" && doodle.points.length > 1) {
      context.save(); context.strokeStyle = doodle.color;
      context.lineWidth = doodle.width * (width / Math.max(1, options.world?.width ?? 2400));
      context.lineCap = "round"; context.lineJoin = "round"; context.beginPath();
      doodle.points.forEach((point, index) => { if (index === 0) context.moveTo(point.x * width, point.y * height); else context.lineTo(point.x * width, point.y * height); });
      context.stroke(); context.restore();
    } else if (doodle.kind === "sticker" && doodle.content) {
      const px = (doodle.points[0]?.x ?? 0.5) * width;
      const py = (doodle.points[0]?.y ?? 0.5) * height;
      if (doodle.content === "heart" || doodle.content === "❤") {
        drawHeartSticker(context, px, py, resolveStickerSize(doodle, DEFAULT_WALL_STICKER_SIZE) * (width / worldWidth), doodle.color, doodle.rotation ?? 0);
      } else {
        context.save(); context.fillStyle = doodle.color; context.font = `${Math.max(8, Math.round(resolveStickerSize(doodle, DEFAULT_WALL_STICKER_SIZE) * (width / worldWidth)))}px sans-serif`;
        context.textAlign = "center"; context.textBaseline = "middle";
        context.fillText(doodle.content, px, py); context.restore();
      }
    }
  }
  return canvas;
}

/** 返回 PNG 的 dataURL；没有任何照片时返回 null。 */
export async function renderPhotoWallPng(photos: PhotoWallPhoto[], options: ExportOptions = {}): Promise<string | null> {
  const canvas = await renderPhotoWallCanvas(photos, options);
  if (!canvas) return null;
  try { return canvas.toDataURL("image/png"); }
  catch { return null; }
}

/** 导出并交给统一下载入口，兼容 Android 原生壳、浏览器与 iOS 分享兜底。 */
export async function downloadPhotoWallPng(photos: PhotoWallPhoto[], options: ExportOptions = {}): Promise<boolean> {
  const canvas = await renderPhotoWallCanvas(photos, options);
  if (!canvas) return false;
  // toBlob avoids a huge base64 dataURL copy on high-resolution mobile exports.
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  canvas.width = 1;
  canvas.height = 1;
  if (!blob?.size) throw new Error("生成的 PNG 文件为空，可能是画布超出设备可用内存。");
  const filename = `照片墙-${new Date().toISOString().slice(0, 10)}.png`;
  await downloadFile(blob, filename);
  return true;
}
