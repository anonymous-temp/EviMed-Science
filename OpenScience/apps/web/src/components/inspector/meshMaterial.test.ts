import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { needsScientificFallback, scientificFallbackMaterial } from "./meshMaterial";

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
