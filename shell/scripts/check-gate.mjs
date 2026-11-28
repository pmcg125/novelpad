#!/usr/bin/env node
/**
 * 校验 shell-build.yml 里「这次要不要真跑 gulp」的闸门。
 *
 * 为什么要有这个文件：这段逻辑的正确性只能靠跑出来，读 YAML 读不出来。
 * 它曾经写成 `if: inputs.gulpBuild != false`，在 push / tag 事件下
 * inputs 不存在 → 求值为 null → GitHub 把 `null == false` 判为 true，
 * 于是每次 push 产出的都是几 MB 的空壳，却标记构建成功。
 * 这个 bug 在 CI 面板上完全看不出来（三步全绿）。
 *
 * 做法不是把 bash 抄一份到这边（那样测的是抄件），而是**从 YAML 里
 * 抠出 run 的正文**，用真实的 bash 执行。改 workflow 不用改这里。
 *
 *   node shell/scripts/check-gate.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = path.resolve(here, "../../.github/workflows/shell-build.yml");
const text = fs.readFileSync(workflow, "utf8");

/* ---------- 1. 从 YAML 里抠出闸门步骤 ---------- */

const STEP = "判断是否执行 gulp";
const at = text.indexOf(`- name: ${STEP}`);
if (at === -1) {
  console.error(`FAIL 找不到「${STEP}」这一步（workflow 被改名或删掉了？）`);
  process.exit(1);
}

/**
 * 取该步骤 `run: |` 之后的缩进正文。
 * 停在下一个 `- name:` / `- uses:` 之前。
 */
function extractRun(from) {
  const lines = text.slice(from).split(/\r?\n/);
  const runIdx = lines.findIndex((l) => /^\s*run:\s*\|/.test(l));
  if (runIdx === -1) throw new Error("该步骤没有 run: | 块");
  const indent = lines[runIdx].match(/^\s*/)[0].length + 2;
  const body = [];
  for (const l of lines.slice(runIdx + 1)) {
    if (l.trim() === "") {
      body.push("");
      continue;
    }
    const cur = l.match(/^\s*/)[0].length;
    if (cur < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

const script = extractRun(at);

/* ---------- 2. env 里的两个变量要来自 workflow 本身 ---------- */

const stepBlock = text.slice(at, text.indexOf("- name:", at + 10) > 0 ? text.indexOf("- name:", at + 10) : text.length);
const envVars = [...stepBlock.matchAll(/^\s{10}([A-Z]+):\s*\$\{\{\s*([^}\s]+)/gm)].map((m) => ({
  name: m[1],
  expr: m[2],
}));

let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    console.log(`OK   ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name} ${extra}`);
  }
};

check("抠出闸门正文", script.includes("GITHUB_OUTPUT"), script.slice(0, 60));
check(
  "闸门读的是 github.event_name 与 inputs.gulpBuild",
  envVars.some((e) => e.expr === "github.event_name") && envVars.some((e) => e.expr === "inputs.gulpBuild"),
  JSON.stringify(envVars),
);

// 关键：条件里不能再有裸的 inputs.gulpBuild != false
// 注意别写 matchAll(...).map(...)：迭代器 helper 要 Node 22+，
// CI 是 Node 20，本机 Node 26 会把这个问题完全盖住。
const gates = [...text.matchAll(/^\s*if:\s*(.+)$/gm)].map((m) => m[1].trim());
check(
  "三条 gulp 闸门都改用 needs.prepare.outputs.gulp",
  gates.filter((g) => /gulpBuild|outputs\.gulp/.test(g)).length === 3 &&
    gates.every((g) => !/gulpBuild\s*[!=]/.test(g)),
  JSON.stringify(gates.filter((g) => /gulp/i.test(g))),
);

/* ---------- 3. 用真实 bash 跑七种组合 ---------- */

const bash = process.platform === "win32" ? path.join(path.dirname(process.execPath), "..", "..", "Program Files", "Git", "bin", "bash.exe") : "bash";
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const shell = fs.existsSync(gitBash) ? gitBash : fs.existsSync(bash) ? bash : "bash";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "np-gate-"));
const scriptFile = path.join(tmp, "gate.sh");
fs.writeFileSync(scriptFile, script, "utf8");

function runGate(event, want) {
  const out = path.join(tmp, "out.txt");
  fs.writeFileSync(out, "");
  try {
    execFileSync(shell, [scriptFile], {
      env: { ...process.env, GITHUB_OUTPUT: out, EVENT: event, WANT: want ?? "" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return "ERROR " + (e.stderr || e.message);
  }
  return fs
    .readFileSync(out, "utf8")
    .trim()
    .split(/\r?\n/)
    .find((l) => l.startsWith("gulp="));
}

// workflow 里是 EVENT / WANT 两个 env；为了让同一份正文能被调用，
// 这里直接注入同名变量（真实运行时由 Actions 提供）
const cases = [
  // [event, inputs.gulpBuild 渲染值, 期望]
  ["push", "", "gulp=true"],
  ["push", undefined, "gulp=true"],
  ["create", "", "gulp=true"], // tag 触发的 create 事件
  ["workflow_dispatch", "true", "gulp=true"],
  ["workflow_dispatch", "True", "gulp=true"],
  ["workflow_dispatch", "false", "gulp=false"],
  ["workflow_dispatch", "False", "gulp=false"],
];

for (const [event, want, expect] of cases) {
  const got = runGate(event, want);
  check(`event=${event} gulpBuild=${JSON.stringify(want ?? null)} -> ${expect}`, got === expect, `实际 ${got}`);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: 构建闸门`);
process.exitCode = fail === 0 ? 0 : 1;
