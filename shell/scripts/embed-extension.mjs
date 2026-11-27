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
import { execFileSync } from "node:child_process";

const [appDir, vsix] = process.argv.slice(2);
if (!appDir || !vsix || !fs.existsSync(vsix)) {
  console.error("用法：embed-extension.mjs <resources/app 目录> <novelpad.vsix>");
  process.exit(2);
}
const log = (s) => console.log(`[embed] ${s}`);

const extDir = path.join(appDir, "extensions", "novelpad");
fs.rmSync(extDir, { recursive: true, force: true });
fs.mkdirSync(extDir, { recursive: true });

// vsix 就是 zip。用 bsdtar 解（Windows 10+/Server 2022 自带，Linux/mac 也有）；
// 不能用 PowerShell 5.1 的 Expand-Archive：其内部 .NET 重载在 runner 上不存在
const tmp = path.join(path.dirname(path.resolve(vsix)), ".vsix-extract");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
execFileSync("tar", ["-xf", path.resolve(vsix), "-C", tmp], { stdio: "inherit" });
// vsix 内 extension/ 目录才是扩展本体
const inner = path.join(tmp, "extension");
if (!fs.existsSync(inner)) {
  console.error(`vsix 里没有 extension/ 目录：${tmp}`);
  process.exit(3);
}
fs.cpSync(inner, extDir, { recursive: true });
fs.rmSync(tmp, { recursive: true, force: true });

// 注册为内置扩展：追加到 product.json 的 builtInExtensions
const productPath = path.join(appDir, "product.json");
const product = JSON.parse(fs.readFileSync(productPath, "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf8"));
product.builtInExtensions = [
  ...(product.builtInExtensions ?? []).filter((e) => e.name !== pkg.name),
  { name: pkg.name, version: pkg.version, path: "extensions/novelpad", msExecPath: `${path.basename(appDir)}/extensions/novelpad` },
];
fs.writeFileSync(productPath, JSON.stringify(product, null, 2) + "\n");
log(`内置扩展 ${pkg.name}@${pkg.version} → ${path.relative(appDir, extDir)}`);
log("完成");
