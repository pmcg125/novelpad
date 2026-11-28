#!/usr/bin/env node
/**
 * 检查 workflow 里 `run:` 步骤对 shell 的隐式依赖。
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
 * ── 为什么不用 js-yaml ──
 *
 * 第一版用 js-yaml 解析 workflow，结果在 patch-check 里跑不起来：
 * 那个 job 的 `pnpm install` 排在所有检查**之后**（为了省时间，前面的
 * 检查都是零依赖的），执行时根本没有 node_modules。
 *
 * 让守卫依赖一个可选包，等于给它加了一个「环境不对就红」的失败模式。
 * 所以这里手写一个只认 workflow 结构的极简扫描器：按缩进切出
 * job → step → run 块。它不需要完整 YAML 语义，只需要「哪个 job 跑在
 * 哪个平台、这一步有没有声明 shell、run 正文是什么」。
 *
 * ── 判据 ──
 *
 *   A. 反斜杠续行 + job 可能跑在 windows 上 + 没声明 shell   → 必错
 *   B. bash 专有语法 + job 可能跑在 windows 上 + 没声明 shell → 必错
 *   C. 多行块里有未引用的 Windows 盘符路径                    → 仅提示
 *
 * 注意 A/B 都要求「可能跑在 windows 上」。只在 ubuntu 上跑的 job 默认
 * 就是 bash，`\` 续行完全正常——判据写宽了会误报，而误报多了守卫会被
 * 无视，比没有守卫更糟。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/* ============================================================
 * 极简 workflow 扫描器
 *
 * 只回答三件事：
 *   · 这个文件里有哪些 job，各自的 runs-on 是什么
 *   · 每个 job 的 steps 里，哪些是 run 步骤
 *   · 某个 run 步骤有没有显式 shell
 *
 * 做法：按行处理，用缩进判断层级。
 *   jobs:                      (0)
 *     <jobId>:                 (2)
 *       runs-on: ubuntu-...    (4)
 *       steps:                 (4)
 *         - name: xxx          (6)
 *           shell: bash        (8)
 *           run: |             (8)
 *             <正文>            (10+)
 * ============================================================ */

/** 数缩进（空格数；tab 按 2 个空格算，workflow 里一般不用 tab） */
function indentOf(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 2;
    else break;
  }
  return n;
}

const isBlank = (line) => /^\s*(#.*)?$/.test(line);

/** 从 `jobs:` 之后切出 job 块 */
function parseWorkflow(text) {
  const lines = text.split(/\r?\n/);
  const jobs = [];
  let inJobs = false;
  let jobsIndent = -1;
  let cur = null;
  let curJobIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    const ind = indentOf(line);
    const trimmed = line.trim();

    if (!inJobs) {
      if (/^jobs:\s*$/.test(trimmed) && ind === 0) {
        inJobs = true;
        jobsIndent = 0;
      }
      continue;
    }

    // 回到 job 级
    if (ind <= jobsIndent && trimmed && !trimmed.startsWith("#")) {
      inJobs = false;
      continue;
    }

    // 新的 job：`<id>:` 且缩进比 jobs 深一层
    if (cur === null || (ind === curJobIndent && /^[\w-]+:\s*$/.test(trimmed))) {
      if (/^[\w-]+:\s*$/.test(trimmed)) {
        cur = { id: trimmed.replace(/:$/, "").trim(), runsOn: "", defaultShell: "", steps: [] };
        jobs.push(cur);
        curJobIndent = ind;
        continue;
      }
    }
    if (!cur) continue;

    // job 级字段
    if (ind === curJobIndent + 2 || ind === curJobIndent + 4) {
      const mRun = /^runs-on:\s*(.+)$/.exec(trimmed);
      if (mRun) cur.runsOn = mRun[1].trim();
      const mShell = /^shell:\s*(.+)$/.exec(trimmed);
      if (mShell && !cur.inSteps) cur.defaultShell = mShell[1].trim();
    }

    // steps
    if (/^steps:\s*$/.test(trimmed)) {
      cur.inSteps = true;
      cur.stepsIndent = ind;
      continue;
    }
    if (!cur.inSteps) continue;

    // 新 step 开始
    if (trimmed.startsWith("- ") && ind >= (cur.stepsIndent ?? 0) + 2 - 2) {
      // 只认与上一个 step 同级的（或第一个）
      const stepIndent = ind;
      if (cur.curStep && stepIndent < cur.curStep.indent) {
        cur.curStep = null;
      }
      if (!cur.curStep || stepIndent <= cur.curStep.indent) {
        cur.curStep = { indent: stepIndent, name: "", shell: null, run: null, runIndent: -1 };
        cur.steps.push(cur.curStep);
        const rest = trimmed.slice(2).trim();
        const mName = /^name:\s*(.*)$/.exec(rest);
        if (mName) cur.curStep.name = mName[1].trim().replace(/^["']|["']$/g, "");
        const mRun = /^run:\s*(.*)$/.exec(rest);
        if (mRun) {
          cur.curStep.run = mRun[1] === "|" || mRun[1] === ">" ? "" : mRun[1];
          cur.curStep.runIndent = stepIndent + 2;
        }
        continue;
      }
    }

    if (!cur.curStep) continue;

    // step 字段
    const mName = /^name:\s*(.*)$/.exec(trimmed);
    if (mName && ind <= cur.curStep.indent + 4) {
      cur.curStep.name = mName[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const mShell = /^shell:\s*(.+)$/.exec(trimmed);
    if (mShell && ind <= cur.curStep.indent + 4) {
      cur.curStep.shell = mShell[1].trim();
      continue;
    }
    const mRun = /^run:\s*(.*)$/.exec(trimmed);
    if (mRun && ind <= cur.curStep.indent + 4) {
      cur.curStep.run = mRun[1] === "|" || mRun[1] === ">" ? "" : mRun[1];
      cur.curStep.runIndent = ind + 2;
      continue;
    }
    // run 的多行正文
    if (cur.curStep.run !== null && ind >= cur.curStep.runIndent) {
      cur.curStep.run += (cur.curStep.run ? "\n" : "") + line.slice(Math.min(ind, cur.curStep.runIndent));
      continue;
    }
  }

  return jobs;
}

/* ============================================================
 * 判据
 * ============================================================ */

const args = process.argv.slice(2);
const wfDir = path.join(repoRoot, ".github", "workflows");
const files = args.length
  ? args
  : fs.existsSync(wfDir)
    ? fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(wfDir, f))
    : [];

if (!files.length) {
  console.error("找不到 workflow 文件");
  process.exit(2);
}

let problems = 0;
let notes = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`(跳过，不存在) ${path.basename(file)}`);
    continue;
  }
  const jobs = parseWorkflow(fs.readFileSync(file, "utf8"));
  console.log(`\n=== ${path.basename(file)}（${jobs.length} 个 job）===`);

  if (!jobs.length) {
    console.log("  ⚠ 没解析出任何 job，扫描器可能不认这个文件的写法");
    problems++;
    continue;
  }

  for (const job of jobs) {
    const maybeWindows = /windows/i.test(job.runsOn) || /matrix|self-hosted/i.test(job.runsOn);

    for (const step of job.steps) {
      if (step.run === null) continue;
      const body = step.run;
      const label = `${job.id} / ${step.name || "(未命名)"}`;
      const declared = step.shell ?? job.defaultShell ?? null;
      const effective = declared ?? (maybeWindows ? "pwsh(默认)" : "bash(默认)");

      // A. 反斜杠续行
      if (/\\[ \t]*\r?\n/.test(body) && !declared && maybeWindows) {
        console.log(`  ✗ ${label}`);
        console.log(`      含 \\ 续行但未声明 shell（实际会用 ${effective}）`);
        console.log(`      → windows 上会报 ParserError: Unexpected token '\\'`);
        problems++;
        continue;
      }

      // B. bash 专有语法
      const flat = body.replace(/\n/g, " ");
      const bashish =
        /\[\s+"?\$/.test(flat) ||
        /\$\{?[A-Za-z_]+\[@\]/.test(flat) ||
        /command -v/.test(flat) ||
        /(^|\s)(rm -rf|mv |cp |mkdir -p|ls -lh?)\s/.test(flat);
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