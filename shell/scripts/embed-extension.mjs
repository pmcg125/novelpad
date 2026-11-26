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

// vsix 就是 zip；用 PowerShell Expand-Archive 兼容 Windows runner，否则用 unzip
if (process.platform === "win32") {
  const tmp = path.join(path.dirname(vsix), ".vsix-extract");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, "e.zip");
  fs.copyFileSync(vsix, zip);
  execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Path '${zip}' -DestinationPath '${tmp}' -Force`], { stdio: "inherit" });
  // vsix 内 extension/ 目录才是扩展本体
  const inner = path.join(tmp, "extension");
  fs.cpSync(inner, extDir, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  fs.mkdirSync("/tmp/np-vsix", { recursive: true });
  execFileSync("unzip", ["-o", "-q", vsix, "-d", "/tmp/np-vsix"], { stdio: "inherit" });
  fs.cpSync("/tmp/np-vsix/extension", extDir, { recursive: true });
}

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
