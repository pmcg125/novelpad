/**
 * 把 docs/design/mockups 下的 HTML 稿渲染成 PNG，输出到 docs/design/preview。
 *
 * 设计稿是 HTML（见 docs/DESIGN.md：视觉先做，直接用浏览器画，不用图像生成）。
 * 但 GitHub 上 README 没法嵌 HTML，所以渲染一份位图给它用。
 *
 * 为什么不用 playwright / puppeteer：只为 5 张图不值得装一个几百 MB 的浏览器依赖。
 * Windows / macOS 自带 Edge / Chrome 就能截图；找不到浏览器时给出明确提示，不静默失败。
 *
 * 用法：
 *   node shell/scripts/shot-mockups.mjs
 *   node shell/scripts/shot-mockups.mjs --width 1440 --height 900
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const srcDir = path.join(repoRoot, "docs/design/mockups");
const outDir = path.join(repoRoot, "docs/design/preview");

const args = process.argv.slice(2);
const pick = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const width = pick("width", 1600);
const height = pick("height", 1000);

/** 依次找可用的 Chromium 系浏览器 */
function findBrowser() {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ]
        : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((p) => fs.existsSync(p));
}

const browser = findBrowser();
if (!browser) {
  console.error("找不到 Chromium 系浏览器（Edge / Chrome），无法截图。");
  process.exit(1);
}

/** mockup 文件名 → PNG 文件名，命名写死，便于 README 稳定引用 */
const SHOTS = [
  ["studio.html", "studio-light.png"],
  ["studio-dark.html", "studio-dark.png"],
  ["compare.html", "compare.png"],
  ["lore.html", "lore.png"],
  ["graph.html", "graph.png"],
];

fs.mkdirSync(outDir, { recursive: true });

let failed = 0;
for (const [srcName, outName] of SHOTS) {
  const src = path.join(srcDir, srcName);
  if (!fs.existsSync(src)) {
    console.log(`skip ${srcName}（文件不存在）`);
    continue;
  }
  const dst = path.join(outDir, outName);
  const url = "file:///" + src.replace(/\\/g, "/");
  try {
    execFileSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        `--window-size=${width},${height}`,
        // 设计稿没有异步数据，留 4s 让字体与 CSS 变量落定即可
        "--virtual-time-budget=4000",
        "--allow-file-access-from-files",
        `--screenshot=${dst}`,
        url,
      ],
      { stdio: "pipe", timeout: 90_000 },
    );
  } catch (e) {
    console.log(`✗ ${outName}：${String(e.message).slice(0, 120)}`);
    failed++;
    continue;
  }
  const bytes = fs.existsSync(dst) ? fs.statSync(dst).size : 0;
  if (bytes < 2000) {
    // 空图 / 纯白几乎必然是渲染失败，尺寸过小直接判失败
    console.log(`✗ ${outName}：产物仅 ${bytes} 字节，疑似渲染失败`);
    failed++;
    continue;
  }
  console.log(`✓ ${outName}  ${(bytes / 1024).toFixed(0)} KB`);
}

if (failed) {
  console.error(`\n${failed} 张截图失败`);
  process.exit(1);
}
console.log(`\n全部完成，输出到 ${path.relative(repoRoot, outDir)}`);