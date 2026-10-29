import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { meshHelpLine, needsScientificFallback, scientificFallbackMaterial } from "./meshMaterial";

describe("scientific mesh fallback", () => {
  it("gives uncoloured OBJ defaults visible neutral grey rather than white", () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshPhongMaterial());
    expect(needsScientificFallback(mesh, "obj")).toBe(true);
    const material = scientificFallbackMaterial();
    expect(material.color.getHex()).toBe(0x666666);
    expect(material.metalness).toBe(0);
    material.dispose();
  });
  it("preserves named materials, source colours and vertex classification colours", () => {
    const geometry = new THREE.BufferGeometry();
    const authored = new THREE.MeshPhongMaterial({ color: 0x2288cc });
    const mesh = new THREE.Mesh(geometry, authored);
    expect(needsScientificFallback(mesh, "obj")).toBe(false);
    authored.color.set(0xffffff); authored.name = "Source material";
    expect(needsScientificFallback(mesh, "obj")).toBe(false);
    geometry.setAttribute("color", new THREE.Float32BufferAttribute([1, 0, 0], 3));
    expect(needsScientificFallback(mesh, "ply")).toBe(false);
  });
});

describe("the viewer's help line", () => {
  it("states the face count only when the model has been read, never a placeholder for it", () => {
    expect(meshHelpLine(12345)).toBe("聚焦视图：方向键平移，Shift+方向键旋转，+ / - 缩放，0 重置。模型包含 12,345 个三角面。");
    expect(meshHelpLine(0)).toContain("模型包含 0 个三角面");
    for (const unread of [null, undefined, Number.NaN]) {
      expect(meshHelpLine(unread)).toBe("聚焦视图：方向键平移，Shift+方向键旋转，+ / - 缩放，0 重置。");
      expect(meshHelpLine(unread)).not.toMatch(/未知|个三角面/);
    }
  });
});
