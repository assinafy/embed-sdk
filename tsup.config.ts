import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "iife"],
  globalName: "Assinafy",
  clean: true,
  minify: true,
  sourcemap: true,
  target: "es2022",
  platform: "browser",
});

