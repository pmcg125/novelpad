/**
 * 扩展打包：bundle @novelpad/core + 复制主题 / schema / 资源
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const watch = process.argv.includes("--watch");
const root = process.cwd();

function copyAssets() {
  const pairs = [
    ["../theme/themes/novelpad-paper-color-theme.json", "themes/novelpad-paper-color-theme.json"],
    ["../theme/themes/novelpad-ink-color-theme.json", "themes/novelpad-ink-color-theme.json"],
    ["../schema/character-v1.json", "schemas/character-v1.json"],
    ["../schema/chapter-frontmatter-v1.json", "schemas/chapter-frontmatter-v1.json"],
    ["../schema/project-config.schema.json", "schemas/project-config.schema.json"],
  ];
  for (const [src, dst] of pairs) {
    const from = path.resolve(root, src);
    const to = path.resolve(root, dst);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  console.log("[novelpad] assets copied");
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

copyAssets();

if (watch) {
  const ctx = await esbuild.context({ ...options, plugins: [{
    name: "copy-on-rebuild",
    setup(b) { b.onEnd(() => copyAssets()); },
  }] });
  await ctx.watch();
  console.log("[novelpad] watching...");
} else {
  await esbuild.build(options);
}
