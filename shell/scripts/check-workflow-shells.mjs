#!/usr/bin/env node
/**
 * 检查 workflow 里每个 `run:` 步骤对 shell 的隐式依赖。
 *
 *   node shell/scripts/check-workflow-shells.mjs [workflow 文件...]
 *
 * ── 为什么需要它 ──
 *
 * windows runner 默认 shell 是 **PowerShell**，ubuntu 是 bash。同一个
 * `run:` 块在两个平台行为不同，而且报错信息与真实意图看起来毫无关系：
 *
 *   run: |
 *     node script.mjs \
 *       "arg" \
 *       --flag
 *
 * 在 PowerShell 里得到：
 *
 *   ParserError: ...ps1:3
 *      3 |   "arg" \
 *        |          ~
 *        | Unexpected token '\' in expression or statement.
 *
 * 这和「跑一个 node 脚本」毫无关联，看到的人第一反应会去查脚本。
 * 而这处错误只在 **windows job 真跑到那一步** 才暴露——shell-build 一次
 * 35 分钟，gulp 编译占 30 分钟，前面全绿才轮到这里。
 *
 * 实测踩过：`内置中文语言包` 用了 bash 的 `\` 续行，gulp 编译成功之后
 * 才在 PowerShell 里炸掉。
 *
 * ── 判据 ──
 *
 *   A. 反斜杠续行 + job 可能跑在 windows 上 + 没声明 shell   → 必错
 *   B. bash 专有语法 + job 可能跑在 windows 上 + 没声明 shell → 必错
 *   C. 多行块里有未引用的 Windows 盘符路径                    → 仅提示
 *
 * 注意 A/B 都要求「可能跑在 windows 上」。只在 ubuntu 上跑的 job 默认
 * 就是 bash，`\` 续行完全正常——判据写宽了会误报，而误报多了守卫就会被
 * 无视，比没有守卫更糟。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** js-yaml 只在 pnpm 的虚拟目录里，走 createRequire 直接指过去 */
function loadYaml() {
  const req = createRequire(path.join(repoRoot, "package.json"));
  try {
    return req("js-yaml");
  } catch {
    /* 根 package.json 里没有这个依赖，退到 pnpm store */
  }
  const globs = fs.existsSync(path.join(repoRoot, "node_modules", ".pnpm"))
    ? fs.readdirSync(path.join(repoRoot, "node_modules", ".pnpm")).filter((d) => d.startsWith("js-yaml@"))
    : [];
  for (const g of globs) {
    try {
      return createRequire(path.join(repoRoot, "node_modules", ".pnpm", g, "node_modules", ""))("js-yaml");
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

const yaml = loadYaml();
if (!yaml) {
  console.error("找不到 js-yaml。先 pnpm install。");
  process.exit(2);
}

const args = process.argv.slice(2);
const files = args.length
  ? args
  : fs
      .readdirSync(path.join(repoRoot, ".github", "workflows"))
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => path.join(repoRoot, ".github", "workflows", f));

let problems = 0;
let notes = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`(跳过，不存在) ${path.basename(file)}`);
    continue;
  }
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`${path.basename(file)}: YAML 解析失败 ${e.message}`);
    problems++;
    continue;
  }
  console.log(`\n=== ${path.basename(file)} ===`);

  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    const jobShell = job.defaults?.run?.shell;
    const runsOn = String(job["runs-on"] ?? "");
    // 「可能跑在 windows 上」：写死 windows-* / 用矩阵且矩阵含 windows，
    // 或者用的是 self-hosted 这种不确定的
    const maybeWindows = /windows/i.test(runsOn) || /matrix|self-hosted/i.test(runsOn);

    for (const step of job.steps ?? []) {
      if (typeof step.run !== "string") continue;
      const body = step.run;
      const label = `${jobName} / ${step.name ?? "(未命名)"}`;
      const declared = step.shell ?? jobShell;
      const effective = declared ?? (maybeWindows ? "pwsh(默认)" : "bash(默认)");

      // A. 反斜杠续行
      if (/\\\r?\n/.test(body) && !declared && maybeWindows) {
        console.log(`  ✗ ${label}`);
        console.log(`      含 \\ 续行但未声明 shell（实际会用 ${effective}）`);
        console.log(`      → windows 上会报 ParserError: Unexpected token '\\'`);
        problems++;
        continue;
      }

      // B. bash 专有语法
      const bashish =
        /\[\s+"?\$/.test(body) ||
        /\$\{?[A-Za-z_]+\[@\]/.test(body) ||
        /command -v/.test(body) ||
        /^\s*(rm -rf|mv |cp |mkdir -p|ls -lh?)/m.test(body);
      if (bashish && !declared && maybeWindows) {
        console.log(`  ✗ ${label}`);
        console.log(`      bash 风格命令但未声明 shell（实际会用 ${effective}）`);
        problems++;
        continue;
      }

      // C. 未引用的盘符路径（只提示）
      if (/(^|\s)[A-Za-z]:\\/.test(body)) {
        console.log(`  · ${label}  含 Windows 盘符路径，确认已加引号`);
        notes++;
      }
    }
  }
}

console.log("");
if (problems) {
  console.error(`发现 ${problems} 处跨平台 shell 隐患。`);
  console.error("改法：显式写 shell: bash，或者把命令拼成单行 / 交给 .mjs 脚本处理。");
  process.exit(1);
}
console.log(`所有 run 步骤的 shell 依赖都安全${notes ? `（${notes} 条提示）` : ""}`);