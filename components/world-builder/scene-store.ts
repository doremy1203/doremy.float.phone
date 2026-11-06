/**
 * 筑境 — 场景状态管理
 * 纯 React state，不引入额外状态库
 */
import * as THREE from "three";
import { GLTFLoader } from "three-stdlib";

type LoadedGLTF = Awaited<ReturnType<GLTFLoader["loadAsync"]>>;

export interface SceneObject {
  id: string;
  modelUrl: string;
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  light?: LightData;
  /** 角色化身：绑定的角色 id（头顶名牌 + 点击简介卡） */
  characterId?: string;
}

export type LightType = "point" | "spot" | "area" | "directional";

export interface LightData {
  type: LightType;
  color: string;
  intensity: number;
  range: number;       // 点光源/射灯 照射范围
  angle: number;       // 射灯 锥角 (弧度)
  penumbra: number;    // 射灯 边缘柔和度 0-1
  width: number;       // 面光源 宽
  height: number;      // 面光源 高
}

export function createDefaultLight(type: LightType): LightData {
  return {
    type,
    color: type === "point" ? "#ffcc66" : "#ffffff",
    intensity: type === "area" ? 5 : type === "directional" ? 1.5 : 10,
    range: 15,
    angle: Math.PI / 6,
    penumbra: 0.5,
    width: 2,
    height: 2,
  };
}

export interface PresetModel {
  name: string;
  url: string;
  category: "结构" | "家具" | "装饰" | "道具" | "地形" | "灯光";
}

export const PRESET_MODELS: PresetModel[] = [
  // 地形（待补充精致模型）
  // 结构
  { name: "红砖墙", url: "/models/tavern/lowpoly/红砖墙面板glb.glb", category: "结构" },
  { name: "木地板", url: "/models/tavern/lowpoly/木地板面板第二版.glb", category: "结构" },
  { name: "木墙板", url: "/models/tavern/lowpoly/单块木墙板.glb", category: "结构" },
  { name: "木质横梁", url: "/models/tavern/lowpoly/木质横梁.glb", category: "结构" },
  { name: "木质护墙板", url: "/models/tavern/lowpoly/木质护墙板.glb", category: "结构" },
  { name: "砖柱", url: "/models/tavern/lowpoly/砖柱.glb", category: "结构" },
  { name: "拱形砖门框", url: "/models/tavern/lowpoly/拱形砖门框.glb", category: "结构" },
  { name: "木门板", url: "/models/tavern/lowpoly/古典木质门板.glb", category: "结构" },
  // 家具
  { name: "圆桌", url: "/models/tavern/lowpoly/圆形桌子.glb", category: "家具" },
  { name: "吧台柜台", url: "/models/tavern/lowpoly/木制吧台柜台.glb", category: "家具" },
  { name: "酒馆椅子", url: "/models/tavern/lowpoly/木制酒馆椅子.glb", category: "家具" },
  { name: "吧台椅", url: "/models/tavern/lowpoly/吧台椅.glb", category: "家具" },
  { name: "方椅子", url: "/models/tavern/lowpoly/带椅背方椅子.glb", category: "家具" },
  { name: "竖式钢琴", url: "/models/tavern/lowpoly/竖式钢琴.glb", category: "家具" },
  { name: "壁炉", url: "/models/tavern/lowpoly/壁炉.glb", category: "家具" },
  { name: "酒瓶陈列架", url: "/models/tavern/lowpoly/酒瓶陈列架.glb", category: "家具" },
  // 装饰
  { name: "吊灯", url: "/models/tavern/lowpoly/工业风吊灯.glb", category: "装饰" },
  { name: "蜡烛灯", url: "/models/tavern/lowpoly/立式蜡烛灯.glb", category: "装饰" },
  { name: "招牌木板", url: "/models/tavern/lowpoly/酒馆招牌木板.glb", category: "装饰" },
  { name: "装饰边框", url: "/models/tavern/lowpoly/装饰木质边框.glb", category: "装饰" },
  { name: "装饰面板", url: "/models/tavern/lowpoly/木质复古装饰面板.glb", category: "装饰" },
  { name: "酒桶", url: "/models/tavern/lowpoly/重叠的酒桶.glb", category: "装饰" },
  // 道具
  { name: "左轮手枪", url: "/models/tavern/lowpoly/左轮手枪.glb", category: "道具" },
  { name: "威士忌酒瓶", url: "/models/tavern/lowpoly/威士忌酒瓶.glb", category: "道具" },
  { name: "扑克牌", url: "/models/tavern/lowpoly/扑克牌.glb", category: "道具" },
  // 现代结构件
  { name: "护墙板", url: "/models/modern/木质护墙板.glb", category: "结构" },
  // 灯光
  { name: "暖黄灯泡", url: "light://point-warm", category: "灯光" },
  { name: "冷白灯泡", url: "light://point-cool", category: "灯光" },
  { name: "聚光灯", url: "light://spot", category: "灯光" },
  { name: "方向光", url: "light://directional", category: "灯光" },
];

// 模型包围盒缓存
const boxCache = new Map<string, THREE.Vector3>();

export async function getModelSize(url: string): Promise<[number, number, number]> {
  if (url.startsWith("primitive://") || url.startsWith("light://")) {
    return [1, 1, 1];
  }
  if (boxCache.has(url)) {
    const s = boxCache.get(url)!;
    return [s.x, s.y, s.z];
  }
  const loader = new GLTFLoader();
  const gltf: LoadedGLTF = await new Promise<LoadedGLTF>((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  boxCache.set(url, size);
  // 清理
  gltf.scene.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
  return [size.x, size.y, size.z];
}

let _idCounter = 0;
export function createSceneObject(modelUrl: string, name: string, position?: [number, number, number], characterId?: string): SceneObject {
  const obj: SceneObject = {
    id: `obj_${++_idCounter}_${Date.now()}`,
    modelUrl,
    name,
    position: position ?? [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    ...(characterId ? { characterId } : {}),
  };

  // 灯光对象自动附带灯光数据
  if (modelUrl.startsWith("light://")) {
    const map: Record<string, LightType> = {
      "light://point-warm": "point",
      "light://point-cool": "point",
      "light://spot": "spot",
      "light://area": "area",
      "light://directional": "directional",
    };
    const type = map[modelUrl] || "point";
    const light = createDefaultLight(type);
    if (modelUrl === "light://point-cool") light.color = "#ffffff";
    obj.light = light;
  }

  return obj;
}
