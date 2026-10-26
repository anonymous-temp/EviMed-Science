import * as THREE from "three";
import { formatNumber } from "@/lib/format";

/** Only uncoloured loader defaults receive neutral shading; authored materials keep their colours. */
export function needsScientificFallback(mesh: THREE.Mesh, ext: string): boolean {
  if (mesh.geometry.getAttribute("color")) return false;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (!materials.length || materials.every((material) => !material)) return true;
  if (ext === "stl" || ext === "ply") return true;
  return ext === "obj" && materials.every((material) => {
    const shaded = material as THREE.MeshPhongMaterial;
    return !material.name && !shaded.map && !shaded.vertexColors && shaded.color?.getHex() === 0xffffff;
  });
}

/** Neutral grey, independent of brand and source classification palettes. */
export function scientificFallbackMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0, roughness: 0.8, side: THREE.DoubleSide });
}

/** The viewer's keyboard help, and — only once the model has loaded and its faces are counted — how many it has. */
export function meshHelpLine(triangles: number | null | undefined): string {
  const keys = "聚焦视图：方向键平移，Shift+方向键旋转，+ / - 缩放，0 重置。";
  return typeof triangles === "number" && Number.isFinite(triangles) ? `${keys}模型包含 ${formatNumber(triangles)} 个三角面。` : keys;
}
