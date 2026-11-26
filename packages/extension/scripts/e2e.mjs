/**
 * 在真实 VS Code 扩展宿主中端到端验证。
 *   node scripts/e2e.mjs
 * 需要：packages/extension 已构建（pnpm --filter novelpad run build）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, "..");
const demo = path.resolve(extRoot, "../../examples/demo-novel");

/** 在扩展宿主里执行的测试（序列化为字符串传入 runTests） */
const testScript = String.raw`
const vscode = require("vscode");
const path = require("path");

module.exports.run = async function () {
  const log = (ok, msg) => { console.log((ok ? "  [PASS] " : "  [FAIL] ") + msg); if (!ok) process.exitCode = 1; };
  const step = async (name, fn) => {
    if (typeof name === "object" && name.skip) { console.log("  [SKIP] " + name.name); return; }
    try { await fn(); } catch (e) { log(false, (name.name ?? name) + " — 异常: " + (e && e.message ? e.message.split("\n")[0] : String(e))); }
  };
  const skipIf = (s) => (n) => (s ? { skip: true, name: n } : n);
  const LLM_TEST = ${JSON.stringify(process.env.NOVLEPAD_LLM_TEST === "1")};

  // 1. 激活
  await step("激活", async () => {
    const ext = vscode.extensions.getExtension("novelpad.novelpad");
    log(!!ext, "扩展已安装到宿主");
    if (!ext) throw new Error("扩展未找到");
    await ext.activate();
    await new Promise(r => setTimeout(r, 1000));
    log(true, "扩展激活成功");
  });

  // 2. 命令
  await step("命令", async () => {
    const cmds = await vscode.commands.getCommands();
    for (const id of ["novelpad.initProject","novelpad.newChapter","novelpad.newCharacter","novelpad.exportTxt","novelpad.exportDocx","novelpad.check","novelpad.stats","novelpad.refresh"]) {
      log(cmds.includes(id), "命令已注册: " + id);
    }
  });

  // 3. 诊断
  await step("诊断", async () => {
    await vscode.commands.executeCommand("novelpad.check");
    await new Promise(r => setTimeout(r, 800));
    const all = vscode.languages.getDiagnostics();
    let n = 0;
    for (const [, ds] of all) for (const d of ds) if (d.source === "NovelPad") n++;
    log(n > 0, "Problems 面板收到 NovelPad 诊断 (" + n + " 条)");
  });

  // 4. 打开第 1 章
  const ch1 = vscode.Uri.file(path.join(${JSON.stringify(demo)}, "chapters/001.md"));
  const doc = await vscode.workspace.openTextDocument(ch1);
  const editor = await vscode.window.showTextDocument(doc);
  log(doc.getText().includes("雨是从傍晚开始下的"), "打开示例章节 001.md");

  // 4a. 悬浮
  await step("悬浮", async () => {
    const pos = doc.positionAt(doc.getText().indexOf("林晚"));
    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", ch1, pos);
    const text = (hovers?.[0]?.contents ?? []).map(c => c.value ?? String(c)).join("");
    log(text.includes("林晚") && text.includes("角色"), "悬浮显示角色卡");
  });

  // 4b. 定义跳转
  await step("定义跳转", async () => {
    const pos = doc.positionAt(doc.getText().indexOf("林晚"));
    const defs = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", ch1, pos);
    const f = defs?.[0]?.uri?.fsPath ?? "";
    log(f.endsWith("lin-wan.yaml"), "定义跳转到角色卡 " + path.basename(f));
  });

  // 4c. 文档链接
  await step("文档链接", async () => {
    const links = await vscode.commands.executeCommand("vscode.executeLinkProvider", doc.uri);
    const ok = (links ?? []).some(l => l.target?.fsPath?.endsWith("lin-wan.yaml"));
    log(ok, "双链 [[林晚]] 可点击跳转 (" + (links?.length ?? 0) + " 条)");
  });

  // 4d. 补全
  await step("补全", async () => {
    const lastLine = doc.lineCount - 1;
    const end = new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);
    await editor.edit(e => e.insert(end, "\n[["));
    await new Promise(r => setTimeout(r, 400));
    const comps = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", doc.uri, new vscode.Position(lastLine + 1, 2));
    const items = comps?.items ?? [];
    const names = items.map(i => (typeof i.label === "string" ? i.label : i.label?.label));
    log(names.includes("林晚") && names.includes("沈默") && names.includes("港口商会"), "[[ 补全包含角色与势力 (" + names.length + " 项: " + names.slice(0, 6).join(", ") + "…)");
    await vscode.commands.executeCommand("undo");
    await doc.save();
  });

  // 5. Copilot
  await step("Copilot 命令", async () => {
    const cmds = await vscode.commands.getCommands();
    for (const id of ["novelpad.copilot.continue","novelpad.copilot.continueDirect","novelpad.copilot.editSelection","novelpad.copilot.ask","novelpad.copilot.setApiKey","novelpad.copilot.testConnection","novelpad.copilot.draftCharacter"]) {
      log(cmds.includes(id), "Copilot 命令已注册: " + id);
    }
    const pkg = JSON.parse(require("fs").readFileSync(${JSON.stringify(path.join(extRoot, "package.json"))}, "utf8"));
    const kb = pkg.contributes.keybindings.find(k => k.command === "novelpad.copilot.continueDirect");
    log(kb && kb.key.length > 3 && kb.key.startsWith("alt+"), "手动续写快捷键已声明: " + (kb ? kb.key : "无"));
    const cfg = vscode.workspace.getConfiguration("novelpad.copilot");
    log(cfg.get("model") === "deepseek-v4.1-flash" && cfg.get("provider") === "custom", "默认配置: " + cfg.get("provider") + " / " + cfg.get("model"));
  });

  await step("Copilot CodeAction（选中文字出灯泡）", async () => {
    const text = doc.getText();
    const i = text.indexOf("雨是从傍晚开始下的");
    const start = doc.positionAt(i);
    const end = doc.positionAt(i + 30);
    editor.selection = new vscode.Selection(start, end);
    const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", doc.uri, editor.selection);
    const titles = (actions ?? []).map(a => a.title);
    const copilotTitles = titles.filter(t => t.includes("Copilot"));
    log(copilotTitles.some(t => t.includes("润色")) && copilotTitles.some(t => t.includes("扩写")) && copilotTitles.some(t => t.includes("换视角")), "灯泡提供 Copilot 改写动作 (" + copilotTitles.length + " 项)");
    editor.selection = new vscode.Selection(start, start);
  });

  await step(skipIf(!LLM_TEST)("Copilot 真实续写（扩展链路 → 127.0.0.1:8788，需 NOVLEPAD_LLM_TEST=1）"), async () => {
    // 通过扩展的内部测试钩子直接写 key，避免弹窗
    await vscode.commands.executeCommand("novelpad._test.setApiKey", process.env.NOVLEPAD_LLM_KEY ?? "");
    const before = doc.getText().length;
    const cursor = doc.positionAt(before);
    editor.selection = new vscode.Selection(cursor, cursor);
    await vscode.commands.executeCommand("novelpad._test.continueAtCursor");
    await new Promise(r => setTimeout(r, 1500));
    const added = editor.document.getText().slice(before).trim();
    log(added.length > 20, "续写插入了 " + added.length + " 字: " + added.slice(0, 40).replace(/\n/g, " ") + "…");
    await vscode.commands.executeCommand("undo");
    await editor.document.save();
    // 思考过程面板
    await vscode.commands.executeCommand("novelpad.copilot.showLastReasoning");
    await new Promise(r => setTimeout(r, 500));
    const reasonTitle = vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => t.label).find(l => l.includes("思考过程"));
    log(!!reasonTitle, "思考过程面板已打开: " + reasonTitle);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  // 6. RAG + 决策（需要 DashScope key）
  await step(skipIf(!LLM_TEST)("RAG 建索引（DashScope embedding）"), async () => {
    const c = vscode.workspace.getConfiguration();
    await c.update("novelpad.rag.apiKey", process.env.DASHSCOPE_API_KEY ?? "", vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("novelpad.rag.rebuild");
    await new Promise(r => setTimeout(r, 8000));
    let ok = false;
    let sizeKb = 0;
    try {
      const st = await vscode.workspace.fs.stat(vscode.Uri.joinPath(vscode.Uri.file(${JSON.stringify(demo)}), ".novelpad", "index", "vectors.json"));
      ok = st.type === vscode.FileType.File;
      sizeKb = Math.round(st.size / 1024);
    } catch { /* not created */ }
    log(ok, "索引文件已生成" + (ok ? " (" + sizeKb + " KB)" : ""));
    if (ok) {
      await vscode.commands.executeCommand("novelpad.decision.test");
      await new Promise(r => setTimeout(r, 3000));
      log(true, "决策模型连接测试已执行");
    }
  });

  // 7. 图谱
  await step("图谱", async () => {
    await vscode.commands.executeCommand("novelpad.graph.open");
    await new Promise(r => setTimeout(r, 2500));
    const t = vscode.window.tabGroups.all.flatMap(g => g.tabs).map(x => x.label).find(l => l.includes("图谱"));
    log(!!t, "图谱面板已打开: " + t);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });
};
`;

/* 把测试脚本写到临时目录（extensionTestsPath 必须指向 .js 文件） */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "novelpad-e2e-"));
const testFile = path.join(tmp, "novelpad-e2e-tests.js");
fs.writeFileSync(testFile, testScript);

/* ---------- 本机 VS Code 探测 ---------- */
function pickLocalVSCode() {
  if (process.env.NOVLEPAD_USE_REMOTE_VSCODE) return undefined;
  const candidates = [
    process.env.VSCODE_EXECUTABLE,
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
    "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe",
    "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    "/usr/share/code/code",
    "/usr/bin/code",
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      console.log(`使用本机 VS Code: ${c}`);
      return c;
    }
  }
  console.log("未找到本机 VS Code，将下载测试版…");
  return undefined;
}

const localVSCode = pickLocalVSCode();

const runner = `
import { runTests } from "@vscode/test-electron";
await runTests({
  extensionDevelopmentPath: ${JSON.stringify(extRoot)},
  extensionTestsPath: ${JSON.stringify(testFile)},
  launchArgs: [${JSON.stringify(demo)}, "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"],
  ${localVSCode ? `vscodeExecutablePath: ${JSON.stringify(localVSCode)},` : ""}
});
`;

/* runner 写在扩展目录内，确保能解析 @vscode/test-electron */
const runnerFile = path.join(extRoot, ".e2e-runner.mjs");
fs.writeFileSync(runnerFile, runner);

console.log("启动 VS Code 测试宿主…");
const r = spawnSync(process.execPath, [runnerFile], {
  cwd: extRoot,
  encoding: "utf8",
  env: (() => {
    const env = { ...process.env };
    // 必须真正删除（而非设空），否则 Electron 以 Node 模式启动
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  })(),
  timeout: 600_000,
});const stdout = r.stdout ?? "";
const stderr = r.stderr ?? "";
// runTests 会把测试输出混在日志里，提取 ✓/✗ 行
const lines = stdout.split(/\r?\n/).filter((l) => /\[(PASS|FAIL|SKIP)\]/.test(l));
console.log(lines.length ? lines.join("\n") : "(未捕获到测试输出)");
if (r.status !== 0 || lines.some((l) => l.includes("[FAIL]"))) {
  console.error("\n---- 进程退出码:", r.status, "----");
  console.error(stderr.slice(-2000));
  fs.rmSync(runnerFile, { force: true });
  process.exit(1);
}
fs.rmSync(runnerFile, { force: true });
console.log("\n全部通过");
