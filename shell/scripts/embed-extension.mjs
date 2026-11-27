#!/usr/bin/env node
/**
 * 壳构建第二步：把 NovelPad 扩展塞进构建产物，作为内置扩展。
 *
 *   node shell/scripts/embed-extension.mjs <built-app-dir> <novelpad.vsix>
 *
 * built-app-dir 例：upstream/../VSCode-win32-x64/resources/app
 */
import fs from "node:fs";
import path from "node:path";
import { extractZip } from "./lib/zip.mjs";
import { validateExtensionManifest } from "./lib/manifest.mjs";

const [appDir, vsix] = process.argv.slice(2);
if (!appDir || !vsix || !fs.existsSync(vsix)) {
  console.error("用法：embed-extension.mjs <resources/app 目录> <novelpad.vsix>");
  process.exit(2);
}
const log = (s) => console.log(`[embed] ${s}`);

const extDir = path.join(appDir, "extensions", "novelpad");
fs.rmSync(extDir, { recursive: true, force: true });
fs.mkdirSync(extDir, { recursive: true });

// vsix 就是 zip。用自带的纯 JS 解压器，不调系统 tar：
// Windows 的 `tar` 是 bsdtar 能读 zip，Linux 的 GNU tar 不能，
// 一律报 "This does not look like a tar archive"。
const tmp = path.join(path.dirname(path.resolve(vsix)), ".vsix-extract");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const { files } = extractZip(path.resolve(vsix), tmp);
// vsix 内 extension/ 目录才是扩展本体
const inner = path.join(tmp, "extension");
if (!fs.existsSync(inner)) {
  console.error(`vsix 里没有 extension/ 目录：${tmp}`);
  process.exit(3);
}
fs.cpSync(inner, extDir, { recursive: true });
fs.rmSync(tmp, { recursive: true, force: true });

// 不再往 product.json 写 builtInExtensions。
//
// 核实过 1.85.0 源码（extensionsScannerService.ts:403）：
//   const devSystemExtensionsList = this.environmentService.isBuilt ? [] : productService.builtInExtensions;
// 发行版里 isBuilt 为真，这个字段被直接丢掉，只用于开发模式下的 .build/builtInExtensions。
// 运行时真正扫描的是 environmentService.builtinExtensionsPath，
// 即 resources/app/../extensions（environmentService.ts:114-121）。
// 所以「放进 extensions/ 目录」本身就是注册，不需要也不应该动 product.json。
//
// 顺带一提：`msExecPath` 在 1.85.0 源码里一处都不存在，那个字段是凭空写出来的。
const productPath = path.join(appDir, "product.json");
if (!fs.existsSync(productPath)) throw new Error(`产物里没有 product.json：${productPath}`);

// 校验 manifest：manifest 有问题时 VS Code 不会报错，只会静默不激活——
// 命令全部「未找到」却没有任何日志，在别人机器上几乎无法排查。
const problems = validateExtensionManifest(extDir);
if (problems.length) {
  throw new Error(`扩展装进去也不会工作：\n  - ${problems.join("\n  - ")}`);
}
const pkg = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf8"));

log(`内置扩展 ${pkg.name}@${pkg.version} → ${path.relative(appDir, extDir)}（${files} 个文件）`);
log("完成（内置扩展靠目录被扫描，无需登记 product.json）");;
