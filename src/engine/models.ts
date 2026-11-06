import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';
import type { PointModel } from './types';

/**
 * Turns a 3D model (glTF / GLB) into a PointModel: points sampled evenly over its surface,
 * with normals, colours (material colour × texture × vertex colour) and a part label per point.
 *
 * Parts come from mesh / object names in the file. In Blender, name your objects
 * ("roof", "walls", "windows"…) and they become parts scenes can animate separately.
 */

const gltfCache = new Map<string, Promise<THREE.Object3D>>();
const sampleCache = new Map<string, PointModel>();

/** Forget cached copies of a model (after its file changed). */
export function invalidateModel(id: string) {
  for (const k of [...gltfCache.keys()]) if (k.startsWith(id + '|')) gltfCache.delete(k);
  for (const k of [...sampleCache.keys()]) if (k.startsWith(id + '|')) sampleCache.delete(k);
}

export async function loadPointModel(id: string, url: string, count: number): Promise<PointModel> {
  const key = `${id}|${url}|${count}`;
  const cached = sampleCache.get(key);
  if (cached) return cached;
  const gk = `${id}|${url}`;
  if (!gltfCache.has(gk)) {
    gltfCache.set(gk, new GLTFLoader().loadAsync(url).then((g) => g.scene));
    gltfCache.get(gk)!.catch(() => gltfCache.delete(gk));
  }
  const root = await gltfCache.get(gk)!;
  const model = samplePoints(id, root, count);
  sampleCache.set(key, model);
  return model;
}

/** Part name for a mesh: its own name, minus Blender/glTF suffixes like ".001" or "_1". */
function partName(o: THREE.Object3D): string {
  let n = o.name || o.parent?.name || 'part';
  n = n.replace(/\.\d{3}$/, '').replace(/_\d+$/, '');
  return n.toLowerCase() || 'part';
}

/** Mulberry32: deterministic sampling so a model looks the same every load. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pixels of a texture, read once through a canvas so we can look up colours by uv. */
const pixelCache = new WeakMap<object, ImageData | null>();
function texturePixels(tex: THREE.Texture | null | undefined): ImageData | null {
  const img = tex?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!img || !img.width) return null;
  if (pixelCache.has(img)) return pixelCache.get(img)!;
  let data: ImageData | null = null;
  try {
    const w = Math.min(1024, img.width), h = Math.min(1024, img.height);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, w, h);
    data = g.getImageData(0, 0, w, h);
  } catch { data = null; }
  pixelCache.set(img, data);
  return data;
}

interface Source {
  sampler: MeshSurfaceSampler;
  area: number;
  part: number;
  color: THREE.Color;          // material colour, sRGB 0..1
  pixels: ImageData | null;    // base colour texture
  flipY: boolean;
  hasVertexColor: boolean;
}

function samplePoints(id: string, root: THREE.Object3D, count: number): PointModel {
  root.updateMatrixWorld(true);
  const partNames: string[] = [];
  const sources: Source[] = [];
  const random = rng(1234567);

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return;
    const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const sampler = new MeshSurfaceSampler(new THREE.Mesh(geo));
    // setRandomGenerator exists at runtime but is missing from @types/three.
    (sampler as unknown as { setRandomGenerator(f: () => number): void }).setRandomGenerator(random);
    sampler.build();
    const dist = (sampler as unknown as { distribution: Float32Array }).distribution;
    const area = dist[dist.length - 1] ?? 0;
    if (!(area > 0)) return;

    const name = partName(mesh);
    let part = partNames.indexOf(name);
    if (part < 0) { part = partNames.length; partNames.push(name); }

    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const color = new THREE.Color(1, 1, 1);
    if (mat?.color) color.copy(mat.color).convertLinearToSRGB();
    sources.push({
      sampler, area, part, color,
      pixels: texturePixels(mat?.map),
      flipY: mat?.map?.flipY ?? false,
      hasVertexColor: !!geo.getAttribute('color'),
    });
  });
  if (!sources.length) throw new Error(`Model "${id}" has no meshes with surface area`);

  // Share points between meshes by surface area (largest-remainder rounding).
  const total = sources.reduce((s, x) => s + x.area, 0);
  const quotas = sources.map((s) => (s.area / total) * count);
  const counts = quotas.map(Math.floor);
  let left = count - counts.reduce((a, b) => a + b, 0);
  quotas.map((q, i) => [q - counts[i], i] as const).sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => { if (left-- > 0) counts[i]++; });

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const parts = new Uint8Array(count);
  const p = new THREE.Vector3(), n = new THREE.Vector3(), c = new THREE.Color(), uv = new THREE.Vector2();

  let k = 0;
  sources.forEach((s, si) => {
    for (let j = 0; j < counts[si]; j++, k++) {
      c.setRGB(1, 1, 1);
      s.sampler.sample(p, n, c, uv);
      let r = s.color.r, g = s.color.g, b = s.color.b;
      if (s.hasVertexColor) { r *= c.r; g *= c.g; b *= c.b; }
      if (s.pixels) {
        const { width: w, height: h, data } = s.pixels;
        const u = uv.x - Math.floor(uv.x), v = uv.y - Math.floor(uv.y);
        const px = Math.min(w - 1, Math.floor(u * w));
        const py = Math.min(h - 1, Math.floor((s.flipY ? 1 - v : v) * h));
        const o = (py * w + px) * 4;
        r *= data[o] / 255; g *= data[o + 1] / 255; b *= data[o + 2] / 255;
      }
      positions.set([p.x, p.y, p.z], k * 3);
      normals.set([n.x, n.y, n.z], k * 3);
      colors.set([r, g, b], k * 3);
      parts[k] = Math.min(255, s.part);
    }
  });

  // Shuffle so any prefix / stride of the points is spread over the whole model.
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    for (const [arr, w] of [[positions, 3], [normals, 3], [colors, 3]] as const) {
      for (let a = 0; a < w; a++) { const t = arr[i * w + a]; arr[i * w + a] = arr[j * w + a]; arr[j * w + a] = t; }
    }
    const t = parts[i]; parts[i] = parts[j]; parts[j] = t;
  }

  // Normalise: centre the bounding box on the origin, largest half-extent = 1.
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count * 3; i++) {
    const a = i % 3;
    if (positions[i] < min[a]) min[a] = positions[i];
    if (positions[i] > max[a]) max[a] = positions[i];
  }
  const centre = [0, 1, 2].map((a) => (min[a] + max[a]) / 2);
  const half = Math.max(...[0, 1, 2].map((a) => (max[a] - min[a]) / 2)) || 1;
  for (let i = 0; i < count * 3; i++) positions[i] = (positions[i] - centre[i % 3]) / half;
  const size: [number, number, number] = [0, 1, 2].map((a) => (max[a] - min[a]) / half) as [number, number, number];

  return { id, count, positions, normals, colors, parts, partNames, size };
}
