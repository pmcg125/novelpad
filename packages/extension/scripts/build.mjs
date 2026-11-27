/**
 * 扩展打包：bundle @novelpad/core + 复制主题 / schema / 资源
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const watch = process.argv.includes("--watch");

// 以脚本自身位置定位包根，而不是 process.cwd()：
// 从仓库根目录执行时 cwd 会让 ../theme 解析到仓库外面去。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 源与目标的解析都相对包根，cwd 在哪都能跑 */
const fromRoot = (rel) => path.resolve(root, rel);

function copyAssets() {
  const pairs = [
    ["../theme/themes/novelpad-paper-color-theme.json", "themes/novelpad-paper-color-theme.json"],
    ["../theme/themes/novelpad-ink-color-theme.json", "themes/novelpad-ink-color-theme.json"],
    ["../schema/character-v1.json", "schemas/character-v1.json"],
    ["../schema/chapter-frontmatter-v1.json", "schemas/chapter-frontmatter-v1.json"],
    ["../schema/project-config.schema.json", "schemas/project-config.schema.json"],
  ];
  for (const [src, dst] of pairs) {
    const from = fromRoot(src);
    const to = fromRoot(dst);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  // 字体是随包资源，不进构建产物但必须存在——缺了就报错，别等壳里静默回退成系统字体
  const fontCss = fromRoot("media/fonts/lxgw-wenkai-screen-gb.css");
  const fontDir = fromRoot("media/fonts/files");
  if (!fs.existsSync(fontCss) || !fs.existsSync(fontDir)) {
    throw new Error(`字体资源缺失：${fontCss}\n见 docs/PLAN-UI.md §7`);
  }
  const subsets = fs.readdirSync(fontDir).filter((f) => f.endsWith(".woff2")).length;
  if (subsets < 90) throw new Error(`字体分片不完整：${subsets} 个（GB 子集应为 97 个）`);

  // CSS 引用的分片与磁盘上的文件必须双向一致：
  // 少了文件 → 浏览器 404 → 静默回退宋体；多了文件 → 白白撑大 vsix。
  const css = fs.readFileSync(fontCss, "utf8");
  const urls = [...css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1]);
  const missing = urls.filter((u) => !fs.existsSync(path.resolve(path.dirname(fontCss), u)));
  if (missing.length) {
    throw new Error(`字体 CSS 引用了不存在的分片：${missing.slice(0, 5).join(", ")}`);
  }

  console.log(`[novelpad] assets copied（字体 ${subsets} 片，CSS 引用 ${urls.length} 片）`);
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  absWorkingDir: root,
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
