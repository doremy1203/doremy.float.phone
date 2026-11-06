import * as THREE from "three";
import { GLTFLoader } from "three-stdlib";

type LoadedGLTF = Awaited<ReturnType<GLTFLoader["loadAsync"]>>;

const cache = new Map<string, string>();
let renderer: THREE.WebGLRenderer | null = null;

function getRenderer() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(80, 80);
    renderer.setClearColor(0x2a2520, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 2;
  }
  return renderer;
}

export async function getThumbnail(url: string): Promise<string> {
  if (cache.has(url)) return cache.get(url)!;

  const r = getRenderer();
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 2));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(1, 2, 3);
  scene.add(dir);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);

  let object: THREE.Object3D;
  let isPrimitive = false;

  if (url.startsWith("light://")) {
    // 灯光缩略图：彩色小球
    const colors: Record<string, number> = {
      "light://point-warm": 0xffcc66,
      "light://point-cool": 0xffffff,
      "light://spot": 0xffeedd,
      "light://area": 0xffffff,
      "light://directional": 0xfffff0,
    };
    const geo = new THREE.SphereGeometry(0.8, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ color: colors[url] || 0xffffff });
    object = new THREE.Mesh(geo, mat);
    scene.add(object);
    camera.position.set(1.5, 1, 1.5);
    camera.lookAt(0, 0, 0);
    r.render(scene, camera);
    const dataUrl = r.domElement.toDataURL();
    scene.remove(object);
    geo.dispose();
    mat.dispose();
    cache.set(url, dataUrl);
    return dataUrl;
  }

  if (url.startsWith("primitive://")) {
    isPrimitive = true;
    const geo = new THREE.BoxGeometry(2, 2, 2);
    let color = 0xffffff;
    switch (url) {
      case "primitive://grass-block": color = 0xadd8a4; break;
      case "primitive://sand-block": color = 0xfdf8f0; break;
      case "primitive://rock-block": color = 0xe2e5e8; break;
      case "primitive://water-block": color = 0x60c5f1; break;
      case "primitive://wood-block": color = 0xd2a87a; break;
    }
    const mat = url === "primitive://water-block" 
      ? new THREE.MeshPhysicalMaterial({ color, roughness: 0.1, transmission: 0.9, transparent: true, opacity: 0.8 })
      : new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    object = new THREE.Mesh(geo, mat);
  } else {
    const loader = new GLTFLoader();
    const gltf: LoadedGLTF = url.startsWith("blob:")
      ? await (async () => {
      // blob URL → fetch 二进制 → parse
      const res = await fetch(url);
      const buffer = await res.arrayBuffer();
      return await new Promise<LoadedGLTF>((resolve, reject) => {
        loader.parse(buffer, "", resolve, reject);
      });
      })()
      : await new Promise<LoadedGLTF>((resolve, reject) => {
          loader.load(url, resolve, undefined, reject);
        });
    object = gltf.scene;
  }

  scene.add(object);

  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length() || 1;

  object.position.sub(center);
  camera.position.set(size * 0.7, size * 0.5, size * 1.1);
  camera.lookAt(0, 0, 0);

  r.render(scene, camera);
  const dataUrl = r.domElement.toDataURL();

  scene.remove(object);
  
  if (isPrimitive) {
    (object as THREE.Mesh).geometry.dispose();
    ((object as THREE.Mesh).material as THREE.Material).dispose();
  } else {
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => material.dispose());
    });
  }

  cache.set(url, dataUrl);
  return dataUrl;
}
