import * as THREE from "three";

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
