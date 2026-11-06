import {
  DEFAULT_PHOTO_WALL_WORLD,
  type PhotoWallDoodle,
  type PhotoWallPlacement,
  type PhotoWallState,
  type PhotoWallWorld,
} from "@/lib/photo-wall-storage";

/**
 * 无界画布的扩容算法。
 *
 * 设计前提：照片和涂鸦的坐标一直是「占当前的世界的比例」（0~1），
 * 所以扩大世界时只要把比例按像素位置重算一遍，画面上什么都不会动——
 * 不需要迁移任何老数据，也不影响摆放模板和整墙导出。
 *
 * 只在「照片落点 / 一笔画完」时调用，拖动过程中不扩容：
 * 一来避免每帧重映射全部照片，二来扩容后落点会自动回到安全区，不会连环触发。
 */

/** 落点进入世界外圈这个比例时，就朝那一侧扩。 */
const EDGE_TRIGGER = 0.07;
/** 单次至少扩这么多像素，避免贴着边一点点挤。 */
const MIN_GROW_PX = 900;
/** 单次至少扩当前尺寸的这个比例。 */
const GROW_RATIO = 0.4;

export type WorldGrow = {
  world: PhotoWallWorld;
  /** 新增到左/上侧的像素。滚动位置要补偿这么多，画面才不会跳。 */
  left: number;
  top: number;
  prevWidth: number;
  prevHeight: number;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function wallWorldOf(state: PhotoWallState): PhotoWallWorld {
  return state.world ?? DEFAULT_PHOTO_WALL_WORLD;
}

/** 检查一组 0~1 的点是否贴边；需要扩容时返回新世界与偏移，否则返回 null。 */
export function planWorldGrow(world: PhotoWallWorld, points: readonly { x: number; y: number }[]): WorldGrow | null {
  if (!points.length) return null;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let seen = false;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    seen = true;
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  if (!seen) return null;

  const stepX = Math.max(MIN_GROW_PX, Math.round(world.width * GROW_RATIO));
  const stepY = Math.max(MIN_GROW_PX, Math.round(world.height * GROW_RATIO));
  const left = minX < EDGE_TRIGGER ? stepX : 0;
  const right = maxX > 1 - EDGE_TRIGGER ? stepX : 0;
  const top = minY < EDGE_TRIGGER ? stepY : 0;
  const bottom = maxY > 1 - EDGE_TRIGGER ? stepY : 0;
  if (!left && !right && !top && !bottom) return null;

  return {
    world: { width: world.width + left + right, height: world.height + top + bottom },
    left,
    top,
    prevWidth: world.width,
    prevHeight: world.height,
  };
}

function remapX(x: number, grow: WorldGrow): number {
  return clamp01((x * grow.prevWidth + grow.left) / grow.world.width);
}

function remapY(y: number, grow: WorldGrow): number {
  return clamp01((y * grow.prevHeight + grow.top) / grow.world.height);
}

/** 照片摆放跟着世界重映射；尺寸/旋转/层级不变。 */
export function remapPlacement(placement: PhotoWallPlacement, grow: WorldGrow): PhotoWallPlacement {
  return { ...placement, x: remapX(placement.x, grow), y: remapY(placement.y, grow) };
}

/** 整墙涂鸦重映射。照片自己的涂鸦是相对相框的，不受世界扩容影响。 */
export function remapDoodles(doodles: readonly PhotoWallDoodle[], grow: WorldGrow): PhotoWallDoodle[] {
  return doodles.map(doodle => ({
    ...doodle,
    points: doodle.points.map(point => ({ x: remapX(point.x, grow), y: remapY(point.y, grow) })),
  }));
}

/** 一次性把整个世界（尺寸 + 所有照片 + 整墙涂鸦）搬到扩容后的坐标系。 */
function legacyPlacement(index: number): PhotoWallPlacement {
  const col = index % 3, row = Math.floor(index / 3), wobble = ((index * 37) % 11) - 5;
  return { x: Math.min(0.88, Math.max(0.12, 0.2 + col * 0.3 + wobble * 0.004)), y: Math.min(0.9, Math.max(0.1, 0.14 + row * 0.27 + wobble * 0.003)), scale: 1, rotation: wobble, z: index + 1, frame: "polaroid", frameColor: "#fffdf8" };
}
export function applyWorldGrow(state: PhotoWallState, grow: WorldGrow): PhotoWallState {
  return {
    ...state, world: grow.world,
    photos: state.photos.map((photo, index) => ({ ...photo, placement: remapPlacement(photo.placement ?? legacyPlacement(index), grow) })),
    wallDoodles: state.wallDoodles ? remapDoodles(state.wallDoodles, grow) : state.wallDoodles,
  };
}

/**
 * 手动调整画布尺寸时，保持每张照片/每笔涂鸦的“世界像素位置”不变。
 *
 * 存储里的 x/y 是相对当前世界的 0~1 比例；直接改 world 会让所有内容
 * 按比例移动。这里按旧/新尺寸换算比例，视觉落点不动。
 */
export function resizeWorldPreservingPositions(
  state: PhotoWallState,
  nextWorld: PhotoWallWorld,
): PhotoWallState {
  const previous = wallWorldOf(state);
  if (previous.width === nextWorld.width && previous.height === nextWorld.height) return state;
  const scaleX = previous.width / Math.max(1, nextWorld.width);
  const scaleY = previous.height / Math.max(1, nextWorld.height);
  const remapPoint = (point: { x: number; y: number }) => ({ x: point.x * scaleX, y: point.y * scaleY });
  return {
    ...state,
    world: nextWorld,
    photos: state.photos.map((photo, index) => {
      const placement = photo.placement ?? legacyPlacement(index);
      return { ...photo, placement: { ...placement, x: placement.x * scaleX, y: placement.y * scaleY } };
    }),
    wallDoodles: state.wallDoodles?.map(doodle => ({ ...doodle, points: doodle.points.map(remapPoint) })),
  };
}
