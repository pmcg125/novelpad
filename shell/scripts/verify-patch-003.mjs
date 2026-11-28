#!/usr/bin/env node
/**
 * 在临时目录里真跑一遍 `git apply`，验证 003 补丁能落地且改对了。
 *
 * 为什么不能只靠 `git apply --numstat`：那只解析 hunk 头，不校验上下文
 * 是否真的匹配。上下文对不上时 CI 才会炸，而那时已经烧掉半小时构建。
 *
 * 除了「能 apply」，还要检查三处改动的**语义**是否对：
 *   1. argv 模板里新增的是字符串数组元素（写成裸对象属性会让主进程
 *      SyntaxError，弹窗「A JavaScript error occurred in the main process」）
 *   2. bootstrap 调用必须早于 getUserDefinedLocale
 *   3. 信任开关改成 false，而「空窗口默认可信」那条 default: true 必须保留
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const TAG = "1.85.0";
const RAW = `https://raw.githubusercontent.com/microsoft/vscode/${TAG}`;
const PATCH = "shell/patches/003-shell-defaults.patch";
const files = [
  "src/main.js",
  "src/vs/workbench/services/themes/common/workbenchThemeService.ts",
  "src/vs/workbench/contrib/workspace/browser/workspace.contribution.ts",
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "np-apply-"));

for (const f of files) {
  const r = await fetch(`${RAW}/${f}`);
  if (!r.ok) throw new Error(`下载失败 ${f}: ${r.status}`);
  const dest = path.join(root, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, await r.text(), "utf8");
}

execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });

const patchAbs = path.resolve(PATCH);
try {
  execFileSync("git", ["apply", "--check", patchAbs], { cwd: root, stdio: "pipe" });
  console.log("OK   git apply --check 通过");
  execFileSync("git", ["apply", patchAbs], { cwd: root, stdio: "pipe" });
  console.log("OK   git apply 落地成功");
} catch (e) {
  console.error("FAIL", (e.stderr ?? "").toString().slice(0, 1200));
  process.exit(1);
}

const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
const ws = fs.readFileSync(path.join(root, files[2]), "utf8");
const themeSrc = fs.readFileSync(path.join(root, files[1]), "utf8");

/* ---------- 语义检查 ---------- */
const checks = [
  // 1. argv 模板：locale 必须作为**数组元素**存在，即形如
  //    '\t"locale": "zh-cn",'
  // 用「行首是引号或单引号、且该行以 ', 结尾」判定，避免转义层级写错。
  // 真正的验证在下面的「抽出数组求值」里（那个才是硬的）。
  [
    "argv 模板里 locale 是字符串数组元素",
    main.split("\n").some((l) => {
      const s = l.trim();
      return /^['"]\\t["']?locale/.test(s) || /^['"]\\t\\?"locale\\?"/.test(s) || (s.startsWith("'\\t") && s.includes("locale") && s.endsWith("',"));
    }),
  ],
  // 反例：裸对象属性会让主进程崩（实测弹窗「A JavaScript error occurred in
  // the main process」，窗口永不出现）
  ["没有写成裸对象属性", !/^\s*"locale":\s*"zh-cn",$/m.test(main)],
  // 2. bootstrap
  ["bootstrap 函数已插入", main.includes("function ensureNovelPadBootstrapSync()")],
  ["bootstrap 复用上游路径逻辑", main.includes("const argvFile = getArgvConfigPath();")],
  // 关键：userDataPath 在这一步还没声明（第 57 行），必须自己算，
  // 且用的函数与参数要和第 57 行一致。
  [
    "bootstrap 自行计算 userDataPath（不依赖尚未声明的变量）",
    /function ensureNovelPadBootstrapSync\(\)[\s\S]*?getUserDataPath\(args,\s*product\.nameShort/.test(main),
  ],
  ["bootstrap 会补 argv.json", main.includes("if (!fs.existsSync(argvFile)) {")],
  ["bootstrap 会补 languagepacks.json", main.includes("const targetFile = path.join(userDataPath, 'languagepacks.json');")],
  ["翻译路径运行时拼绝对路径", main.includes("translations[id] = path.join(appRoot, pack.translations[id]);")],
  // 时序：必须早于 argvConfig 求值（那一行内部就读 argv.json），
  // 也早于 locale 解析与 NLS 解析
  [
    "bootstrap 调用早于 argvConfig 求值",
    main.indexOf("ensureNovelPadBootstrapSync();") < main.indexOf("const argvConfig = configureCommandlineSwitchesSync(args);"),
  ],
  [
    "bootstrap 调用早于 locale 解析",
    main.indexOf("ensureNovelPadBootstrapSync();") < main.indexOf("const locale = getUserDefinedLocale(argvConfig);"),
  ],
  // 只该有一个调用点：两处调用会让 argv.json 被写两次（第二次已存在，无害
  // 但没必要），也说明补丁被重复应用了
  ["bootstrap 只有一个调用点", main.split("ensureNovelPadBootstrapSync();").length - 1 === 1],
  // 3. 信任
  ["信任机制默认关闭", /\[WORKSPACE_TRUST_ENABLED\][\s\S]{0,900}?default: false,/.test(ws)],
  ["「空窗口默认可信」未被误改", (ws.match(/default:\s*true,/g) ?? []).length === 1],
  // 4. 平台级默认颜色主题
  //
  // 这是「第一默认主题」的唯一正确落点：ThemeSettingDefaults 被三个配置项
  // 引用（colorTheme / preferredDark / preferredLight），改这两个常量
  // 等于从平台默认值层面就换成自有主题，不依赖扩展运行时写设置。
  ["默认深色主题换成夜墨", /COLOR_THEME_DARK = '夜墨 · NovelPad Ink',/.test(themeSrc)],
  ["默认浅色主题换成宣纸", /COLOR_THEME_LIGHT = '宣纸 · NovelPad Paper',/.test(themeSrc)],
  // 反例：这两个值不能再作为「默认」出现。注意不能整文件搜——文件里还有
  // COLOR_THEME_DARK_OLD = 'Default Dark+' 等历史常量，那些必须保留。
  // 只检查这两个具体的常量定义行是否还指向蓝色主题。
  ["默认深色不再是 Default Dark Modern", !/COLOR_THEME_DARK = 'Default Dark Modern'/.test(themeSrc)],
  ["默认浅色不再是 Default Light Modern", !/COLOR_THEME_LIGHT = 'Default Light Modern'/.test(themeSrc)],
  // 历史常量原样保留（别为了「去蓝色」把上游的兼容值也删了）
  ["历史常量 COLOR_THEME_DARK_OLD 保留", /COLOR_THEME_DARK_OLD = 'Default Dark\+'/.test(themeSrc)],
  // HC 主题必须原样保留：高对比度是可达性功能，不能拿产品视觉主张覆盖
  ["高对比度主题未被改动", /COLOR_THEME_HC_DARK = 'Default High Contrast',/.test(themeSrc) && /COLOR_THEME_HC_LIGHT = 'Default High Contrast Light',/.test(themeSrc)],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) bad++;
}

/* ---------- 语法自检 ---------- */
try {
  execFileSync(process.execPath, ["--check", path.join(root, "src/main.js")], { stdio: "pipe" });
  console.log("OK   main.js 语法可解析（node --check）");
} catch (e) {
  console.error("FAIL main.js 语法坏了\n", (e.stderr ?? "").toString().slice(0, 1200));
  bad++;
}

/* ---------- 端到端：抽出 argv 模板数组并求值 ---------- */
const start = main.indexOf("const defaultArgvConfigContent = [");
if (start < 0) {
  console.error("FAIL 找不到 argv 模板数组");
  bad++;
} else {
  const endMark = "\n\t\t];";
  let end = main.indexOf(endMark, start);
  if (end < 0) end = main.indexOf("\n    ];", start);
  const snippet = main.slice(start, end + endMark.length);
  const tmpFile = path.join(root, "argv-tpl.cjs");
  fs.writeFileSync(tmpFile, `${snippet}\nmodule.exports = defaultArgvConfigContent;\n`, "utf8");
  try {
    const arr = JSON.parse(execFileSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(tmpFile)})))`], { encoding: "utf8" }));
    const text = arr.join("\n");
    // 上游用 stripComments 解析，允许注释与尾逗号
    const parsed = JSON.parse(
      text
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/([\[{,]\s*)\/\/[^\n]*/g, "$1")
        .replace(/,\s*([}\]])/g, "$1"),
    );
    const ok = parsed.locale === "zh-cn";
    console.log(`${ok ? "OK  " : "FAIL"} 生成的 argv.json 里 locale = ${JSON.stringify(parsed.locale)}`);
    if (!ok) bad++;
  } catch (e) {
    console.error(`FAIL argv 模板求值失败：${e.message}`);
    bad++;
  }
}

fs.rmSync(root, { recursive: true, force: true });
if (bad) {
  console.error(`\n补丁验证失败 ${bad} 项`);
  process.exit(1);
}
console.log("\n全部通过");