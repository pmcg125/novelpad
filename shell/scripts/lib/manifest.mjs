/**
 * 扩展 manifest 校验。
 *
 * 为什么单独成一个模块：这些错误在 VS Code 里**不会报错**，只会静默不激活。
 * 命令全部「未找到」、扩展列表里看不到，但日志里也什么都没有——
 * 在别人机器上几乎无法排查。只能在打包时拦住。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 检查一个已解包的扩展目录是否可用。
 * @param {string} extDir 扩展根目录
 * @returns {string[]} 问题列表；空数组表示通过
 */
export function validateExtensionManifest(extDir) {
  const pkgPath = path.join(extDir, "package.json");
  if (!fs.existsSync(pkgPath)) return [`缺 package.json：${pkgPath}`];

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return [`package.json 不是合法 JSON：${pkgPath}`];
  }

  const problems = [];
  if (!pkg.name) problems.push("缺 name");
  if (!pkg.version) problems.push("缺 version");
  // 没有 publisher 时扩展 ID 会变成 `undefined.novelpad`，
  // 内置扩展不显示 ID，但一旦被引用（设置、激活事件）就全错
  if (!pkg.publisher) problems.push("缺 publisher（扩展 ID 会变成 undefined.xxx）");
  // 没有 engines.vscode 或版本不匹配时，扫描器直接跳过该扩展
  if (!pkg.engines?.vscode) problems.push("缺 engines.vscode（版本不匹配会被静默跳过）");

  if (!pkg.main) {
    // 纯声明式扩展（只有主题/语法）可以没有 main；
    // 但只要有命令或激活事件就必须有入口
    const declarativeOnly =
      !pkg.contributes?.commands?.length && !pkg.activationEvents?.length && !pkg.contributes?.configuration;
    if (!declarativeOnly) problems.push("缺 main（有命令/激活事件但无入口，全部命令都会「未找到」）");
  } else if (!fs.existsSync(path.join(extDir, pkg.main))) {
    problems.push(`main 指向不存在的文件：${pkg.main}`);
  }

  return problems;
}