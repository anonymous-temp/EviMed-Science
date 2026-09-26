import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const app = "/home/coder/workspace/EviMedScience/OpenScience/apps/web";
export default defineConfig({
  root: `${app}/.geo-preview`,
  plugins: [react()],
  resolve: {
    alias: {
      "@": `${app}/src`,
      "@ai4s/shared": "/home/coder/workspace/EviMedScience/OpenScience/packages/shared/src/index.ts",
      "@evimed/domain": "/home/coder/workspace/EviMedScience/OpenScience/packages/domain/index.mjs",
    },
  },
  css: { postcss: app },
  define: { "import.meta.env.VITE_OPEN_SCIENCE_API_URL": JSON.stringify("/api") },
  build: { outDir: `${app}/.geo-preview/dist`, emptyOutDir: true },
});
