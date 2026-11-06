"use client";

import { useRef, useCallback, useMemo, useEffect, Suspense, useState, type ComponentProps, type ComponentRef } from "react";
import { Canvas, useThree, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, TransformControls, useGLTF, PerspectiveCamera, ContactShadows, Environment, Html } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, HueSaturation, BrightnessContrast } from "@react-three/postprocessing";
import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { SceneObject } from "./scene-store";

// 面光源需要初始化
try { RectAreaLightUniformsLib.init(); } catch {}
import type { SceneSettings } from "./SettingsModal";

const SNAP_THRESHOLD = 0.15;

/* ── 计算包围盒（排除 hitbox 球体） ── */
function getModelBox(group: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  group.updateMatrixWorld(true);
  group.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mat = (child as THREE.Mesh).material as THREE.Material;
    if (mat && mat.opacity < 0.1) return; // 跳过 hitbox
    const mesh = child as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    const meshBox = mesh.geometry.boundingBox!.clone();
    meshBox.applyMatrix4(mesh.matrixWorld);
    box.union(meshBox);
  });
  if (box.isEmpty()) box.setFromObject(group);
  return box;
}

/* ── 纯包围盒吸附（AABB 面对面对齐，不用射线） ── */
function snapAABB(
  dragGroup: THREE.Object3D,
  otherGroups: THREE.Object3D[]
): void {
  if (otherGroups.length === 0) return;

  const _boxA = getModelBox(dragGroup);

  let bestY = Infinity, applyY = 0;
  let bestX = Infinity, applyX = 0;
  let bestZ = Infinity, applyZ = 0;

  for (const other of otherGroups) {
    const _boxB = getModelBox(other);

    // XZ 重叠 → 可以做 Y 吸附（放上面/下面）
    const hasXZ =
      _boxA.max.x > _boxB.min.x && _boxA.min.x < _boxB.max.x &&
      _boxA.max.z > _boxB.min.z && _boxA.min.z < _boxB.max.z;
    if (hasXZ) {
      const dyTop = _boxB.max.y - _boxA.min.y; // A底 贴 B顶
      if (Math.abs(dyTop) < SNAP_THRESHOLD && Math.abs(dyTop) < bestY) { bestY = Math.abs(dyTop); applyY = dyTop; }
      const dyBot = _boxB.min.y - _boxA.max.y; // A顶 贴 B底
      if (Math.abs(dyBot) < SNAP_THRESHOLD && Math.abs(dyBot) < bestY) { bestY = Math.abs(dyBot); applyY = dyBot; }
    }

    // YZ 重叠 → 可以做 X 吸附（左右贴合）
    const hasYZ =
      _boxA.max.y > _boxB.min.y && _boxA.min.y < _boxB.max.y &&
      _boxA.max.z > _boxB.min.z && _boxA.min.z < _boxB.max.z;
    if (hasYZ) {
      const dxR = _boxB.min.x - _boxA.max.x;
      if (Math.abs(dxR) < SNAP_THRESHOLD && Math.abs(dxR) < bestX) { bestX = Math.abs(dxR); applyX = dxR; }
      const dxL = _boxB.max.x - _boxA.min.x;
      if (Math.abs(dxL) < SNAP_THRESHOLD && Math.abs(dxL) < bestX) { bestX = Math.abs(dxL); applyX = dxL; }
    }

    // YX 重叠 → 可以做 Z 吸附（前后贴合）
    const hasYX =
      _boxA.max.y > _boxB.min.y && _boxA.min.y < _boxB.max.y &&
      _boxA.max.x > _boxB.min.x && _boxA.min.x < _boxB.max.x;
    if (hasYX) {
      const dzF = _boxB.min.z - _boxA.max.z;
      if (Math.abs(dzF) < SNAP_THRESHOLD && Math.abs(dzF) < bestZ) { bestZ = Math.abs(dzF); applyZ = dzF; }
      const dzB = _boxB.max.z - _boxA.min.z;
      if (Math.abs(dzB) < SNAP_THRESHOLD && Math.abs(dzB) < bestZ) { bestZ = Math.abs(dzB); applyZ = dzB; }
    }
  }

  const pos = dragGroup.position;
  if (bestY < Infinity) pos.y += applyY;
  if (bestX < Infinity) pos.x += applyX;
  if (bestZ < Infinity) pos.z += applyZ;
}

/* ── 收集所有其他物体 ref ── */
const groupRefs = new Map<string, THREE.Group>();

/* ── 面光源组件（命令式创建） ── */
function AreaLight({ color, intensity, width, height }: { color: string; intensity: number; width: number; height: number }) {
  const ref = useRef<THREE.Group>(null!);

  useEffect(() => {
    if (!ref.current) return;
    // 清理旧灯
    ref.current.children.forEach((c) => {
      if (c instanceof THREE.RectAreaLight) ref.current.remove(c);
    });
    const light = new THREE.RectAreaLight(color, intensity, width, height);
    ref.current.add(light);
    return () => { ref.current?.remove(light); light.dispose(); };
  }, [color, intensity, width, height]);

  return <group ref={ref} />;
}

/* ── 灯光场景物体 ── */
function LightSceneModel({
  obj,
  selected,
  onSelect,
  onPlace,
  placing,
  onTransformEnd,
}: {
  obj: SceneObject;
  selected: boolean;
  onSelect: () => void;
  onPlace: (point: [number, number, number]) => void;
  placing: boolean;
  onTransformEnd: (id: string, pos: [number, number, number], rot: [number, number, number], scale: [number, number, number]) => void;
}) {
  const groupRef = useRef<THREE.Group>(null!);
  const [mounted, setMounted] = useState(false);
  const light = obj.light!;

  useEffect(() => {
    if (groupRef.current) groupRefs.set(obj.id, groupRef.current);
    setMounted(true);
    return () => { groupRefs.delete(obj.id); };
  }, [obj.id]);

  // 灯光颜色对应的球体显示色
  const helperColor = light.color;

  return (
    <>
      <group
        ref={groupRef}
        position={obj.position}
        rotation={obj.rotation}
      >
        {/* 灯光本体 */}
        {light.type === "point" && (
          <pointLight color={light.color} intensity={light.intensity} distance={light.range} decay={2} />
        )}
        {light.type === "spot" && (
          <spotLight
            color={light.color}
            intensity={light.intensity}
            distance={light.range}
            angle={light.angle}
            penumbra={light.penumbra}
            decay={2}
          />
        )}
        {light.type === "area" && (
          <AreaLight color={light.color} intensity={light.intensity} width={light.width} height={light.height} />
        )}
        {light.type === "directional" && (
          <directionalLight color={light.color} intensity={light.intensity} />
        )}

        {/* 可视化小球（选中用） */}
        <mesh
          onClick={(e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation();
            if (placing) onPlace([e.point.x, e.point.y, e.point.z]);
            else onSelect();
          }}
          onPointerDown={(e: ThreeEvent<PointerEvent>) => e.stopPropagation()}
        >
          <sphereGeometry args={[0.15, 12, 8]} />
          <meshBasicMaterial color={helperColor} transparent opacity={selected ? 1 : 0.6} />
        </mesh>

        {/* 面光源可视化矩形 */}
        {light.type === "area" && (
          <mesh>
            <planeGeometry args={[light.width, light.height]} />
            <meshBasicMaterial color={helperColor} transparent opacity={0.15} side={THREE.DoubleSide} />
          </mesh>
        )}
      </group>

      {selected && groupRef.current && (
        <TransformControls
          object={groupRef.current}
          space="local"
          onMouseUp={() => {
            if (!groupRef.current) return;
            const p = groupRef.current.position;
            const r = groupRef.current.rotation;
            onTransformEnd(obj.id, [p.x, p.y, p.z], [r.x, r.y, r.z], [1, 1, 1]);
          }}
        />
      )}
    </>
  );
}

/* ── 单个场景物体 ── */
function SceneModel({
  obj,
  selected,
  allObjects,
  placing,
  settings,
  onSelect,
  onPlace,
  onTransformEnd,
  onLoaded,
  characterLabel,
  onCharacterTap,
  motionEnabled,
}: {
  obj: SceneObject;
  selected: boolean;
  allObjects: SceneObject[];
  placing: boolean;
  settings: SceneSettings;
  onSelect: () => void;
  onPlace: (point: [number, number, number]) => void;
  onTransformEnd: (id: string, pos: [number, number, number], rot: [number, number, number], scale: [number, number, number]) => void;
  /** 角色化身：头顶名牌文字 */
  characterLabel?: string;
  /** 点击名牌 → 弹角色简介卡 */
  onCharacterTap?: () => void;
  /** 化身漫步（有动画 + 设置开启 + 同屏配额内） */
  motionEnabled?: boolean;
  onLoaded: (id: string) => void;
}) {
  const { scene, animations } = useGLTF(obj.modelUrl);
  // 含骨骼动画的模型必须用 SkeletonUtils.clone（普通 clone 不会重映射骨骼引用）
  const clone = useMemo(
    () => (animations?.length ? (skeletonClone(scene) as THREE.Group) : scene.clone(true)),
    [scene, animations],
  );

  useEffect(() => {
    onLoaded(obj.id);
  }, [obj.id, onLoaded, scene]);

  useEffect(() => {
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = settings.shadows;
        child.receiveShadow = settings.shadows;
        const mat = (child as THREE.Mesh).material;
        if (mat && !Array.isArray(mat)) {
          (mat as THREE.Material).side = settings.doubleSide ? THREE.DoubleSide : THREE.FrontSide;
        }
      }
    });
  }, [clone, settings.shadows, settings.doubleSide]);
  const groupRef = useRef<THREE.Group>(null!);
  const tcRef = useRef<ComponentRef<typeof TransformControls> | null>(null);

  // 计算包围盒，用作透明点击热区
  const hitBox = useMemo(() => {
    const box = new THREE.Box3().setFromObject(clone);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // 至少 0.3 保证小物体也能点到
    size.x = Math.max(size.x, 0.3);
    size.y = Math.max(size.y, 0.3);
    size.z = Math.max(size.z, 0.3);
    return { size, center };
  }, [clone]);

  const [mounted, setMounted] = useState(false);
  const wanderActive = !!motionEnabled && !!animations?.length && !selected && !placing;

  // 注册/注销 ref + 强制二次渲染让 TransformControls 出现
  useEffect(() => {
    if (groupRef.current) groupRefs.set(obj.id, groupRef.current);
    setMounted(true);
    return () => { groupRefs.delete(obj.id); };
  }, [obj.id]);

  // 拖拽时实时吸附
  useEffect(() => {
    if (!selected || !tcRef.current || !settings.snap) return;
    const tc = tcRef.current as unknown as {
      addEventListener: (type: "objectChange", listener: () => void) => void;
      removeEventListener: (type: "objectChange", listener: () => void) => void;
    };
    const handleChange = () => {
      if (!groupRef.current) return;
      const others: THREE.Object3D[] = [];
      for (const [id, ref] of groupRefs) {
        if (id !== obj.id) others.push(ref);
      }
      snapAABB(groupRef.current, others);
    };
    tc.addEventListener("objectChange", handleChange);
    return () => tc.removeEventListener("objectChange", handleChange);
  }, [selected, obj.id, settings.snap]);

  return (
    <>
      <group
        ref={groupRef}
        position={obj.position}
        rotation={obj.rotation}
        scale={obj.scale}
      >
        {/* 漫步是纯视觉偏移；选中/关闭漫步时由 R3F 按 props 归位 */}
        <primitive
          object={clone}
          onPointerDown={(e: ThreeEvent<PointerEvent>) => e.stopPropagation()}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation();
            if (placing) {
              onPlace([e.point.x, e.point.y, e.point.z]);
            } else {
              onSelect();
            }
          }}
        />
        {wanderActive && (
          <AvatarWanderer
            group={groupRef}
            clone={clone}
            animations={animations}
            home={obj.position}
          />
        )}
        {characterLabel && (
          <Html
            center
            distanceFactor={8}
            position={[hitBox.center.x, hitBox.center.y + hitBox.size.y / 2 + 0.22, hitBox.center.z]}
            zIndexRange={[10, 0]}
          >
            <button
              type="button"
              className="wb-avatar-tag"
              onClick={(e) => { e.stopPropagation(); onCharacterTap?.(); }}
            >
              {characterLabel}
            </button>
          </Html>
        )}
      </group>
      {selected && groupRef.current && (
        <TransformControls
          ref={tcRef}
          object={groupRef.current}
          space="local"
          onMouseUp={() => {
            if (!groupRef.current) return;
            const p = groupRef.current.position;
            const r = groupRef.current.rotation;
            const sc = groupRef.current.scale;
            onTransformEnd(obj.id, [p.x, p.y, p.z], [r.x, r.y, r.z], [sc.x, sc.y, sc.z]);
          }}
        />
      )}
    </>
  );
}

/** 化身漫步控制器：家半径内随机选点 → 转身 → 走过去 → 发呆，循环。
 *  只动 group 的视觉位置，不写回场景数据；卸载时 R3F 按 props 归位。 */
function AvatarWanderer({
  group,
  clone,
  animations,
  home,
}: {
  group: React.RefObject<THREE.Group>;
  clone: THREE.Object3D;
  animations: THREE.AnimationClip[];
  home: [number, number, number];
}) {
  const mixer = useMemo(() => new THREE.AnimationMixer(clone), [clone]);
  // 动作的启动/停止必须成对放在 effect 里：StrictMode 开发模式会挂载→卸载→
  // 再挂载，若 play 在 useMemo、stop 在 cleanup，重挂载后动作被停掉且无人
  // 重新 play——表现为化身滑步（平移但不播动画）。
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const state = useRef({
    mode: "idle" as "idle" | "walk",
    timer: 1 + Math.random() * 2,
    target: new THREE.Vector3(home[0], home[1], home[2]),
    walkStartTime: 0,
    pivoting: false,
  });

  useEffect(() => {
    const source = animations.find((c) => /walk/i.test(c.name)) ?? animations[0];
    if (!source) return;
    // 剥离根骨骼位移轨道（root motion）：Tripo 走路动画自带 Root.position
    // 前进位移，每个循环结束会瞬移回循环起点；位移改由漫步控制器全权负责。
    // clone 后过滤，避免污染 useGLTF 的共享缓存。
    const clip = source.clone();
    clip.tracks = clip.tracks.filter(
      (t) => !(t.name.endsWith(".position") && /(root|hips|pelvis|armature)/i.test(t.name)),
    );
    const a = mixer.clipAction(clip);
    // 关键机制：动作权重 < 1 时，混合器会用「绑定时的原始姿势」补足剩余权重——
    // 即模型静置的自然站姿（Tripo 绑骨用的立绘原姿态）。因此驻足 = fadeOut
    // 权重到 0（自动回到站姿），起步 = fadeIn（站姿平滑长出步态），不再需要
    // 暂停在某一帧的各种猜测。play 一次建立绑定（原始姿势在此刻被快照）。
    a.play();
    a.setEffectiveWeight(0);

    // 采样找一个双脚贴地的帧作为起步相位（从近似站姿开始迈步，fadeIn 更顺）
    let walkStartTime = 0;
    const feet: THREE.Object3D[] = [];
    clone.traverse((n) => { if (/foot/i.test(n.name) && feet.length < 2) feet.push(n); });
    if (feet.length === 2) {
      const fa = new THREE.Vector3();
      const fb = new THREE.Vector3();
      a.setEffectiveWeight(1);
      let best = Infinity;
      const steps = 48;
      for (let i = 0; i < steps; i++) {
        const t = (clip.duration * i) / steps;
        a.time = t;
        mixer.update(0);
        clone.updateMatrixWorld(true);
        feet[0].getWorldPosition(fa);
        feet[1].getWorldPosition(fb);
        const score = Math.max(fa.y, fb.y) + 0.3 * Math.hypot(fa.x - fb.x, fa.z - fb.z);
        if (score < best) { best = score; walkStartTime = t; }
      }
      // 采样结束：权重归零 + 应用一帧，骨骼回到原始站姿
      a.setEffectiveWeight(0);
      mixer.update(0);
    }
    state.current.walkStartTime = walkStartTime;
    actionRef.current = a;
    return () => {
      actionRef.current = null;
      a.stop();
      mixer.uncacheClip(clip);
    };
  }, [mixer, animations, clone]);

  const pickTarget = (st: typeof state.current) => {
    const angle = Math.random() * Math.PI * 2;
    const radius = 1.2 + Math.random() * 1.8;
    st.target.set(home[0] + Math.cos(angle) * radius, home[1], home[2] + Math.sin(angle) * radius);
  };

  useFrame((_, rawDelta) => {
    const g = group.current;
    if (!g) return;
    const delta = Math.min(rawDelta, 0.1); // 掉帧/切后台回来防瞬移
    mixer.update(delta);
    const st = state.current;
    const a = actionRef.current;

    if (st.mode === "idle") {
      st.timer -= delta;
      if (st.timer <= 0) {
        pickTarget(st);
        st.mode = "walk";
        st.pivoting = true; // 先站着把方向转过来再迈步
      }
      return;
    }

    // walk：朝目标转身 + 前进
    const pos = g.position;
    const dx = st.target.x - pos.x;
    const dz = st.target.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.15) {
      // 40% 概率不歇脚：直接选下一个目标继续走（边走边转），减少停顿次数
      if (Math.random() < 0.4) {
        pickTarget(st);
        return;
      }
      // 驻足：权重淡出 0.35s，骨骼自动混合回原始站姿
      if (a) a.fadeOut(0.35);
      st.mode = "idle";
      st.timer = 1.9 + Math.random() * 2.5;
      return;
    }
    const targetYaw = Math.atan2(dx, dz);
    let yawDiff = targetYaw - g.rotation.y;
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    // 起步转身：保持站姿快速把方向转过来（像真人先转身再走）
    if (st.pivoting) {
      const pivotTurn = 5 * delta;
      g.rotation.y += Math.max(-pivotTurn, Math.min(pivotTurn, yawDiff));
      if (Math.abs(yawDiff) < 0.45) {
        st.pivoting = false;
        if (a) {
          // 从双脚贴地相位起步，权重淡入：站姿平滑长出步态。
          // 注意：fadeIn 是在基础权重上乘 0→1 的系数，基础权重必须先恢复为 1
          //（挂载时用 setEffectiveWeight(0) 压到 0 了）；reset+play 重新激活动作。
          a.setEffectiveWeight(1);
          a.reset();
          a.time = st.walkStartTime;
          a.timeScale = 1;
          a.fadeIn(0.25);
          a.play();
        }
      }
      return;
    }
    const maxTurn = 3.5 * delta;
    g.rotation.y += Math.max(-maxTurn, Math.min(maxTurn, yawDiff));
    // 边转边走：前进速度按朝向对齐度缩放；腿速跟随移动速度
    const align = Math.max(0, Math.cos(yawDiff));
    const speed = 0.6 * align;
    if (a) a.timeScale = 0.35 + 0.75 * align;
    pos.x += (dx / dist) * speed * delta;
    pos.z += (dz / dist) * speed * delta;
  });

  return null;
}

function ModelLoadingPlaceholder({ obj }: { obj: SceneObject }) {
  return (
    <group position={obj.position}>
      <mesh>
        <sphereGeometry args={[0.18, 24, 16]} />
        <meshBasicMaterial color="#f5c668" transparent opacity={0.72} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <ringGeometry args={[0.32, 0.42, 36]} />
        <meshBasicMaterial color="#f5c668" transparent opacity={0.28} side={THREE.DoubleSide} />
      </mesh>
      <Html center distanceFactor={8} position={[0, 0.45, 0]}>
        <div className="wb-model-loading-label">正在加载 {obj.name}</div>
      </Html>
    </group>
  );
}

/**
 * 先把球占位画出一帧，再挂载真正的模型（开始加载/解析 GLB）。
 * 否则低配安卓上，模型加载会同步卡死主线程，占位那一帧来不及画出来，
 * 模型直接"啪"地出现——看不到加载过渡。延后 ~2 帧给浏览器一个绘制占位的窗口。
 */
function DeferredSceneModel(props: ComponentProps<typeof SceneModel>) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setReady(true)); });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, []);
  if (!ready) return <ModelLoadingPlaceholder obj={props.obj} />;
  return (
    <Suspense fallback={<ModelLoadingPlaceholder obj={props.obj} />}>
      <SceneModel {...props} />
    </Suspense>
  );
}

/* ── 透明点击面（仅用于放置，不阻止射线穿透到物体） ── */
function Ground({ onClickGround }: { onClickGround: (point: [number, number, number]) => void }) {
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.01, 0]}
      onClick={(e) => {
        // 不 stopPropagation — 让物体的 onClick 优先
        onClickGround([e.point.x, 0, e.point.z]);
      }}
    >
      <planeGeometry args={[500, 500]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Controls() {
  return (
    <OrbitControls
      makeDefault
      enableDamping
      dampingFactor={0.1}
      minPolarAngle={Math.PI / 8}
      maxPolarAngle={Math.PI / 2.05}
      minDistance={3}
      maxDistance={80}
    />
  );
}

/* ── 主视口 ── */
export default function SceneViewport({
  objects,
  selectedId,
  placingModel,
  settings,
  onSelect,
  onPlace,
  onTransformEnd,
  onSceneMounted,
  characterNameById,
  onCharacterTap,
}: {
  objects: SceneObject[];
  selectedId: string | null;
  placingModel: { url: string; name: string } | null;
  settings: SceneSettings;
  onSelect: (id: string | null) => void;
  onPlace: (position: [number, number, number]) => void;
  onTransformEnd: (id: string, pos: [number, number, number], rot: [number, number, number], scale: [number, number, number]) => void;
  onSceneMounted?: () => void;
  /** 角色化身名牌：characterId → 名字 */
  characterNameById?: Map<string, string>;
  onCharacterTap?: (characterId: string) => void;
}) {
  const loadedObjectIdsRef = useRef(new Set<string>());
  const [loadingObjects, setLoadingObjects] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!onSceneMounted) return;
    const frame = window.requestAnimationFrame(onSceneMounted);
    return () => window.cancelAnimationFrame(frame);
  }, [onSceneMounted]);

  useEffect(() => {
    const liveIds = new Set(objects.map((obj) => obj.id));
    for (const id of Array.from(loadedObjectIdsRef.current)) {
      if (!liveIds.has(id)) loadedObjectIdsRef.current.delete(id);
    }
    setLoadingObjects((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const obj of objects) {
        if (obj.light || loadedObjectIdsRef.current.has(obj.id)) continue;
        next[obj.id] = obj.name;
        if (prev[obj.id] !== obj.name) changed = true;
      }
      if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
      return changed ? next : prev;
    });
  }, [objects]);

  const handleModelLoaded = useCallback((id: string) => {
    loadedObjectIdsRef.current.add(id);
    setLoadingObjects((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const handleClickGround = useCallback(
    (point: [number, number, number]) => {
      if (placingModel) {
        onPlace(point);
      } else {
        onSelect(null);
      }
    },
    [placingModel, onPlace, onSelect]
  );

  const loadingModelNames = Object.values(loadingObjects);

  return (
    <div className="wb-viewport" style={{
      cursor: placingModel ? "crosshair" : "default",
      background: settings.theme,
    }}>
      <Canvas
        // 限制像素比：高分屏手机默认 DPR=3 → 帧缓冲 9 倍像素，弱机显存顶爆闪退。
        // 钳到 1.5 后约 1/4 负载，3D 画面仅略软，是防闪退最关键的一刀（对所有设备生效）。
        dpr={[1, 1.5]}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2, alpha: true }}
        shadows={settings.shadows}
        onPointerMissed={() => onSelect(null)}
      >
        <PerspectiveCamera makeDefault fov={40} position={[8, 6, 8]} />
        <Controls />

        {/* ── 灯光（受全局亮度/色温影响） ── */}
        <ambientLight
          intensity={0.4 * settings.globalBrightness}
          color={new THREE.Color().lerpColors(
            new THREE.Color("#ccdaff"), new THREE.Color("#ffcc88"),
            (settings.globalWarmth + 1) / 2
          )}
        />
        <hemisphereLight args={[
          new THREE.Color().lerpColors(
            new THREE.Color("#aabbff"), new THREE.Color("#ffd5aa"),
            (settings.globalWarmth + 1) / 2
          ),
          "#665544",
          0.3 * settings.globalBrightness
        ]} />
        <directionalLight
          position={[5, 8, 5]}
          intensity={2.0 * settings.globalBrightness}
          color={new THREE.Color().lerpColors(
            new THREE.Color("#cce0ff"), new THREE.Color("#ffe0aa"),
            (settings.globalWarmth + 1) / 2
          )}
          castShadow={settings.shadows}
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-far={50}
          shadow-camera-left={-20}
          shadow-camera-right={20}
          shadow-camera-top={20}
          shadow-camera-bottom={-20}
          shadow-bias={-0.0003}
        />
        <directionalLight position={[-4, 4, 2]} intensity={0.5 * settings.globalBrightness} color="#eee8e0" />

        {/* HDRI 仅用于 PBR 反射 */}
        {settings.hdri && (
          <Suspense fallback={null}>
            <Environment files="/hdri/park.hdr" />
          </Suspense>
        )}

        {/* ── 地面 ── */}
        <Ground onClickGround={handleClickGround} />

        {/* 后处理 */}
        {settings.bloom && (
          <EffectComposer enableNormalPass={false}>
            <Bloom luminanceThreshold={0.8} intensity={0.2} mipmapBlur />
          </EffectComposer>
        )}

        {(() => {
          // 性能配额：同屏最多 3 个化身漫步，其余保持手办状态
          const motionQuota = new Set(
            objects.filter((o) => o.characterId && !o.light).slice(0, 3).map((o) => o.id)
          );
          return objects.map((obj) => (
          obj.light ? (
            <LightSceneModel
              key={obj.id}
              obj={obj}
              selected={obj.id === selectedId}
              placing={!!placingModel}
              onSelect={() => onSelect(obj.id)}
              onPlace={handleClickGround}
              onTransformEnd={onTransformEnd}
            />
          ) : (
            <DeferredSceneModel
              key={obj.id}
              obj={obj}
              selected={obj.id === selectedId}
              allObjects={objects}
              placing={!!placingModel}
              settings={settings}
              onSelect={() => onSelect(obj.id)}
              onPlace={handleClickGround}
              onTransformEnd={onTransformEnd}
              onLoaded={handleModelLoaded}
              characterLabel={obj.characterId ? (characterNameById?.get(obj.characterId) ?? "未知角色") : undefined}
              onCharacterTap={obj.characterId ? () => onCharacterTap?.(obj.characterId!) : undefined}
              motionEnabled={settings.avatarMotion !== false && motionQuota.has(obj.id)}
            />
          )
        ));
        })()}
      </Canvas>

      {placingModel && (
        <div className="wb-placing-hint">
          点击地面放置「{placingModel.name}」· 按 Esc 取消
        </div>
      )}
      {loadingModelNames.length > 0 && (
        <div className="wb-model-loading-toast" role="status" aria-live="polite">
          <span className="wb-thumb-loading" aria-hidden="true" />
          <span>
            正在加载「{loadingModelNames[0]}」
            {loadingModelNames.length > 1 ? ` 等 ${loadingModelNames.length} 个模型` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
