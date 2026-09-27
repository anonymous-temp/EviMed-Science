/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The browsers the build is written for, stated rather than inherited from
 * Vite's default (spec §34.3, appendix E #33): the feature floor is Chromium
 * 109 — 360 Secure Browser, QQ Browser and the Android WeChat webview lag the
 * current engine — and iOS 15.4. Below it a reader gets the upgrade page;
 * above it everything works and visuals may degrade.
 */
export const BUILD_TARGET = ["chrome109", "edge109", "firefox115", "safari15.4", "ios15.4"];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": r("./src"),
      "@ai4s/shared": r("../../packages/shared/src/index.ts"),
    },
  },
  build: {
    target: BUILD_TARGET,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
