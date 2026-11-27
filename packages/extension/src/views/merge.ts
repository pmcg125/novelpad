/**
 * 合并视图（共创 B：分工合写）。
 *
 * 设计原则（docs/PLAN-VERSIONING.md §5.2）：
 *   - 不出现 branch / merge / commit。作者看到的是「支线」「并回主稿」。
 *   - 按**章**决策，不按行。散文没有语法锚点，三路文本合并只会产出
 *     一堆 <<<<<<< 让作者手工重写。
 *   - 冲突章节显示两版全文，人工挑。不做左右并排双栏——散文上
 *     左右对照的实际效率低于直接读两遍。
 *
 * 复用 timeline.ts 的范式：纯 HTML 自绘、零依赖、只吃 --vscode-* 变量。
 */
import * as vscode from "vscode";
import type { ProjectStore } from "../store";
import type { BranchManager } from "../features/branches";
import type { MergeAction, MergePlanItem } from "@novelpad/core";

let panel: vscode.WebviewPanel | undefined;
let currentStore: ProjectStore | undefined;
let currentManager: BranchManager | undefined;
/** 当前正在看哪条支线 */
let currentSource: string | undefined;

export function openMergeView(store: ProjectStore, manager: BranchManager, source: string): void {
  currentStore = store;
  currentManager = manager;
  currentSource = source;

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "novelpad.merge",
      "NovelPad · 并回主稿",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = shell(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => void onMessage(manager, msg));
    panel.onDidDispose(() => {
      panel = undefined;
      currentStore = undefined;
      currentManager = undefined;
      currentSource = undefined;
    });
  }

  panel.title = "NovelPad · 并回主稿";
  panel.reveal(vscode.ViewColumn.Beside, false);
  void pushComparison(manager, source);
}

export function refreshMergeView(): void {
  if (panel && currentManager && currentSource) void pushComparison(currentManager, currentSource);
}

/* ============================================================
 * 数据
 * ============================================================ */

/** 传给 webview 的扁平结构：不暴露 git 概念 */
interface ChapterRow {
  file: string;
  title: string;
  /** take / keep / delete / ask */
  suggestion: "take" | "keep" | "delete" | "ask";
  /** 需要作者决定 */
  needsDecision: boolean;
  /** 一句话说明为什么这么建议 */
  why: string;
  targetChars: number;
  sourceChars: number;
  delta: number;
}

async function pushComparison(manager: BranchManager, source: string): Promise<void> {
  if (!panel) return;

  const cmp = await manager.compare(source);
  if (!cmp.ok) {
    void panel.webview.postMessage({ type: "error", message: cmp.message });
    return;
  }

  const rows: ChapterRow[] = cmp.chapters
    // 无需动作的不占位置：作者要看的只有「会有变化」的章
    .filter((c) => c.verdict !== "identical")
    .map((c) => ({
      file: c.file,
      title: c.title,
      suggestion: suggestionOf(c),
      needsDecision: c.needsDecision,
      why: whyOf(c),
      targetChars: c.targetChars,
      sourceChars: c.sourceChars,
      delta: c.delta,
    }));

  void panel.webview.postMessage({
    type: "data",
    source,
    base: cmp.base,
    conflicts: cmp.conflicts,
    takeable: cmp.takeable,
    totalDelta: cmp.totalDelta,
    rows,
  });
}

function suggestionOf(c: MergePlanItem): ChapterRow["suggestion"] {
  switch (c.verdict) {
    case "take-source":
      return "take";
    case "deleted-in-source":
      return "keep";
    default:
      return c.suggested === "take-source" ? "take" : "keep";
  }
}

/** 给作者一句人话，解释为什么会这样建议 */
function whyOf(c: MergePlanItem): string {
  switch (c.verdict) {
    case "take-source":
      return c.targetChars === 0 ? "这条线上的新章节" : "只有这条线改过";
    case "keep-target":
      return "只有主稿改过，这条线没碰";
    case "deleted-in-source":
      return "这条线上把这章删了";
    case "recreated":
      return "主稿删了这章，这条线还在写";
    case "conflict":
      return "两边都改过，需要你挑";
    case "identical":
      return "两边一样";
    default:
      return "";
  }
}

/* ============================================================
 * 消息
 * ============================================================ */

async function onMessage(
  manager: BranchManager,
  msg: { type: string; [k: string]: unknown },
): Promise<void> {
  if (msg.type === "ready") {
    if (currentSource) await pushComparison(manager, currentSource);
    return;
  }

  if (msg.type === "compare" && typeof msg.file === "string" && currentSource) {
    // 冲突章节：取两版全文
    const both = await manager.chapter(currentSource, msg.file);
    if (!both) {
      void panel?.webview.postMessage({ type: "compareError", message: "读不到这一章的两版内容" });
      return;
    }
    void panel?.webview.postMessage({
      type: "compare",
      file: msg.file,
      targetText: both.targetText,
      sourceText: both.sourceText,
    });
    return;
  }

  if (msg.type === "apply" && Array.isArray(msg.decisions) && currentSource) {
    const decisions = (msg.decisions as { file: string; action: MergeAction }[]).filter(
      (d) => d && typeof d.file === "string" && ["take-source", "keep-target", "delete"].includes(d.action),
    );
    if (!decisions.length) {
      void panel?.webview.postMessage({ type: "applied", ok: false, message: "没有任何改动" });
      return;
    }

    const r = await manager.merge(currentSource, decisions, `并回主稿（${currentSource}）`);
    void panel?.webview.postMessage({
      type: "applied",
      ok: r.ok,
      written: r.written,
      message: r.message,
    });
    if (r.ok) {
      // 重新读一遍：合并后大部分章节就没有差异了
      await pushComparison(manager, currentSource);
    }
    return;
  }

  if (msg.type === "open" && typeof msg.file === "string" && currentStore?.root) {
    const root = currentStore.root;
    const uri = vscode.Uri.joinPath(root, ...msg.file.split("/"));
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    } catch {
      void vscode.window.showWarningMessage(`打不开 ${msg.file}`);
    }
    return;
  }
}

/* ============================================================
 * HTML
 * ============================================================ */

function shell(wv: vscode.Webview): string {
  const csp = `default-src 'none'; style-src ${wv.cspSource} 'unsafe-inline'; script-src ${wv.cspSource} 'unsafe-inline';`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root {
  --bg: var(--vscode-editor-background);
  --panel: var(--vscode-sideBar-background);
  --fg: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground);
  --faint: var(--vscode-disabledForeground);
  --border: var(--vscode-panel-border);
  --accent: var(--vscode-textLink-foreground);
  --input: var(--vscode-input-background);
  --btn: var(--vscode-button-background);
  --btnFg: var(--vscode-button-foreground);
  --add: var(--vscode-gitDecoration-addedResourceForeground, #3C8C5A);
  --del: var(--vscode-gitDecoration-deletedResourceForeground, #C8402F);
  --warn: var(--vscode-gitDecoration-modifiedResourceForeground, #B7791F);
}
* { box-sizing: border-box; margin: 0; }
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); height: 100vh; overflow: hidden; }
.app { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }

/* ---------- 顶部 ---------- */
.head { padding: 14px 18px 12px; border-bottom: 1px solid var(--border); background: var(--panel); }
.head h1 { font-size: 15px; font-weight: 600; }
.head .sub { color: var(--muted); font-size: 12px; margin-top: 3px; }
.nums { display: flex; gap: 22px; margin-top: 10px; }
.nums .n { font-size: 11px; color: var(--muted); }
.nums .n b { display: block; font-size: 17px; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
.nums .n.up b { color: var(--add); }
.nums .n.warn b { color: var(--warn); }

/* ---------- 主体 ---------- */
.body { display: grid; grid-template-columns: minmax(280px, 40%) 1fr; overflow: hidden; }
.list { overflow: auto; border-right: 1px solid var(--border); }
.detail { overflow: auto; padding: 18px 22px; }

.row { padding: 10px 14px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); cursor: pointer; }
.row:hover { background: var(--input); }
.row.on { background: var(--vscode-list-activeSelectionBackground); }
.row .title { font-size: 13px; display: flex; align-items: center; gap: 6px; }
.row .file { font-size: 11px; color: var(--faint); font-family: var(--vscode-editor-font-family); margin-top: 2px; }
.row .meta { font-size: 11.5px; color: var(--muted); margin-top: 3px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.delta.up { color: var(--add); }
.delta.down { color: var(--del); }

.tag { font-size: 10.5px; padding: 0 5px; border-radius: 3px; border: 1px solid currentColor; }
.tag.take { color: var(--add); }
.tag.keep { color: var(--muted); }
.tag.delete { color: var(--del); }
.tag.ask { color: var(--warn); }

/* ---------- 选择按钮 ---------- */
.opts { display: flex; gap: 6px; margin-top: 7px; }
.opt { font: inherit; font-size: 11.5px; padding: 2px 9px; border-radius: 4px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
.opt:hover { border-color: var(--accent); color: var(--fg); }
.opt.on { background: var(--btn); border-color: var(--btn); color: var(--btnFg); }
.opt.on.keep { background: var(--input); border-color: var(--muted); color: var(--fg); }

/* ---------- 详情：两版全文 ---------- */
.detail h2 { font-size: 14px; font-weight: 600; margin-bottom: 3px; }
.detail .file { font-size: 11.5px; color: var(--muted); margin-bottom: 14px; font-family: var(--vscode-editor-font-family); }
.pick { display: flex; gap: 8px; margin-bottom: 14px; }
.ver { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.ver.one { grid-template-columns: 1fr; }
.col { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.col header { padding: 7px 12px; background: var(--panel); border-bottom: 1px solid var(--border); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; }
.col.pre header { color: var(--accent); }
.col.post header { color: var(--warn); }
.col .text { padding: 12px 14px; font-size: 13.5px; line-height: 1.95; white-space: pre-wrap; word-break: break-word; max-height: calc(100vh - 300px); overflow: auto; font-family: var(--vscode-editor-font-family); }
.col.pre .text { background: color-mix(in srgb, var(--accent) 4%, transparent); }
.col.post .text { background: color-mix(in srgb, var(--warn) 4%, transparent); }
.col .text:empty::before { content: "（这一版没有这一章）"; color: var(--faint); }

/* ---------- 底部 ---------- */
.foot { padding: 11px 18px; border-top: 1px solid var(--border); background: var(--panel); display: flex; align-items: center; gap: 12px; }
.foot .sum { color: var(--muted); font-size: 12px; flex: 1; }
.btn { font: inherit; font-size: 12px; padding: 5px 16px; border-radius: 4px; border: 1px solid var(--border); background: var(--input); color: var(--fg); cursor: pointer; }
.btn:hover { border-color: var(--accent); }
.btn.main { background: var(--btn); border-color: var(--btn); color: var(--btnFg); }
.btn.main:disabled { opacity: 0.5; cursor: default; }

.empty { padding: 44px 30px; text-align: center; color: var(--muted); font-size: 13px; line-height: 1.9; }
.empty b { color: var(--fg); }
.err { color: var(--del); font-size: 12.5px; padding: 12px 0; }
.ok { color: var(--add); font-size: 12.5px; }
.ph { color: var(--muted); font-size: 12.5px; line-height: 1.9; padding-top: 30px; }
</style></head><body>
<div class="app">
  <div class="head">
    <h1 id="title">并回主稿</h1>
    <div class="sub" id="sub">读取中…</div>
    <div class="nums" id="nums"></div>
  </div>
  <div class="body">
    <div class="list" id="list"></div>
    <div class="detail" id="detail">
      <div class="ph">从左侧选一章看两版内容。<br>只有两边都改过的章节才需要你挑。</div>
    </div>
  </div>
  <div class="foot">
    <span class="sum" id="sum"></span>
    <button class="btn" id="allTake">全部采用</button>
    <button class="btn main" id="apply" disabled>并回主稿</button>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const $ = (s) => document.querySelector(s);

let DATA = null;
/** file → "take" | "keep" | "delete" */
let PICK = {};
let SEL = null;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function num(n) {
  if (n === undefined || n === null) return "";
  return (n > 0 ? "+" : "") + n.toLocaleString("zh-CN");
}
function tagOf(v) {
  if (v === "take") return '<span class="tag take">采用这条线</span>';
  if (v === "delete") return '<span class="tag delete">删掉这章</span>';
  if (v === "ask") return '<span class="tag ask">需要你挑</span>';
  return '<span class="tag keep">保留主稿</span>';
}

function actionOf(row) {
  return PICK[row.file] || (row.needsDecision ? "keep" : row.suggestion);
}

function renderList() {
  if (!DATA) return;
  const list = $("#list");
  if (!DATA.rows.length) {
    list.innerHTML = '<div class="empty">这条线和主稿<B>没有差别</B>。<br>没有需要并过来的内容。</div>';
    return;
  }
  list.innerHTML = DATA.rows.map((r) => {
    const act = actionOf(r);
    const cls = ["row", SEL === r.file ? "on" : ""].join(" ");
    const d = r.delta ? '<span class="delta ' + (r.delta > 0 ? "up" : "down") + '">' + num(r.delta) + " 字</span>" : "";
    const act2 = r.targetChars === 0 ? "新章" : r.targetChars.toLocaleString() + " 字";
    const act3 = r.sourceChars === 0 ? "无" : r.sourceChars.toLocaleString() + " 字";
    return '<div class="' + cls + '" data-file="' + esc(r.file) + '">' +
      '<div class="title">' + esc(r.title) + tagOf(act) + "</div>" +
      '<div class="file">' + esc(r.file) + "</div>" +
      '<div class="meta"><span>主稿 ' + act2 + "</span><span>→</span><span>这条线 " + act3 + "</span>" + d + "</div>" +
      '<div class="opts">' +
        '<button class="opt ' + (act === "take" ? "on" : "") + '" data-pick="take">采用</button>' +
        '<button class="opt ' + (act === "keep" ? "on keep" : "") + '" data-pick="keep">保留主稿</button>' +
        '<button class="opt ' + (act === "delete" ? "on" : "") + '" data-pick="delete">删掉</button>' +
      "</div>" +
    "</div>";
  }).join("");

  list.querySelectorAll(".row").forEach((el) => {
    el.onclick = (e) => {
      const pick = e.target && e.target.getAttribute && e.target.getAttribute("data-pick");
      if (pick) {
        e.stopPropagation();
        PICK[el.dataset.file] = pick;
        SEL = el.dataset.file;
        renderList();
        renderDetail(el.dataset.file);
        updateFoot();
        return;
      }
      SEL = el.dataset.file;
      renderList();
      renderDetail(SEL);
    };
  });
}

function renderDetail(file) {
  if (!DATA) return;
  const row = DATA.rows.find((r) => r.file === file);
  if (!row) {
    $("#detail").innerHTML = '<div class="ph">从左侧选一章看两版内容。</div>';
    return;
  }

  const act = actionOf(row);
  const needBoth = row.needsDecision;

  $("#detail").innerHTML =
    "<h2>" + esc(row.title) + "</h2>" +
    '<div class="file">' + esc(row.file) + " · " + esc(row.why) + "</div>" +
    '<div class="pick">' +
      '<button class="btn' + (act === "take" ? " main" : "") + '" data-pick="take">用这条线的版本</button>' +
      '<button class="btn' + (act === "keep" ? " main" : "") + '" data-pick="keep">保留主稿</button>' +
      '<button class="btn' + (act === "delete" ? " main" : "") + '" data-pick="delete">删掉这章</button>' +
    "</div>" +
    '<div class="ver' + (needBoth ? "" : " one") + '" id="ver"><div class="ph">正在读取两版内容…</div></div>';

  $("#detail").querySelectorAll("[data-pick]").forEach((b) => {
    b.onclick = () => {
      PICK[row.file] = b.getAttribute("data-pick");
      renderList();
      renderDetail(row.file);
      updateFoot();
    };
  });

  vscode.postMessage({ type: "compare", file: row.file });
}

function renderVersions(msg) {
  const el = $("#ver");
  if (!el) return;
  const row = DATA && DATA.rows.find((r) => r.file === msg.file);
  const both = row && row.needsDecision;
  const pre =
    '<div class="col pre"><header><span>主稿</span><span>' + (msg.targetText ? msg.targetText.length.toLocaleString() + " 字符" : "无") + "</span></header>" +
    '<div class="text">' + esc(msg.targetText) + "</div></div>";
  if (!both) {
    el.innerHTML = pre;
    return;
  }
  el.innerHTML = pre +
    '<div class="col post"><header><span>这条线</span><span>' + (msg.sourceText ? msg.sourceText.length.toLocaleString() + " 字符" : "无") + "</span></header>" +
    '<div class="text">' + esc(msg.sourceText) + "</div></div>";
}

function updateFoot() {
  if (!DATA) return;
  const rows = DATA.rows;
  const chosen = rows.map(actionOf);
  const take = chosen.filter((a) => a === "take").length;
  const keep = chosen.filter((a) => a === "keep").length;
  const del = chosen.filter((a) => a === "delete").length;

  const willWrite = take + del;
  $("#sum").textContent = rows.length
    ? "采用 " + take + " 章 · 保留 " + keep + " 章 · 删除 " + del + " 章"
    : "";
  $("#apply").disabled = willWrite === 0;
  $("#apply").textContent = willWrite ? "并回主稿（" + willWrite + " 章）" : "并回主稿";
}

$("#apply").onclick = () => {
  if (!DATA) return;
  const decisions = DATA.rows.map((r) => ({ file: r.file, action: actionOf(r) }));
  $("#apply").disabled = true;
  $("#apply").textContent = "正在并…";
  vscode.postMessage({ type: "apply", decisions });
};

$("#allTake").onclick = () => {
  if (!DATA) return;
  DATA.rows.forEach((r) => { PICK[r.file] = "take"; });
  renderList();
  if (SEL) renderDetail(SEL);
  updateFoot();
};

window.addEventListener("message", (e) => {
  const msg = e.data;

  if (msg.type === "data") {
    DATA = msg;
    PICK = {};
    $("#title").textContent = "并回主稿";
    $("#sub").textContent = "从「" + msg.source + "」并回「" + msg.base + "」";
    $("#nums").innerHTML =
      '<div class="n"><b>' + msg.rows.length + "</b>章有变化</div>" +
      (msg.conflicts ? '<div class="n warn"><b>' + msg.conflicts + "</b>章需要挑</div>" : "") +
      '<div class="n up"><b>' + num(msg.totalDelta) + "</b>字数变化</div>";
    renderList();
    updateFoot();
    if (msg.rows.length && !SEL) {
      SEL = msg.rows[0].file;
      renderList();
      renderDetail(SEL);
    }
    return;
  }

  if (msg.type === "compare") {
    renderVersions(msg);
    return;
  }

  if (msg.type === "compareError") {
    const el = $("#ver");
    if (el) el.innerHTML = '<div class="err">' + esc(msg.message) + "</div>";
    return;
  }

  if (msg.type === "applied") {
    if (msg.ok) {
      $("#apply").textContent = "已并回";
      $("#sum").innerHTML = '<span class="ok">已并回 ' + (msg.written || 0) + " 章" + (msg.message ? "（" + esc(msg.message) + "）" : "") + "</span>";
    } else {
      $("#apply").disabled = false;
      $("#apply").textContent = "重试";
      $("#sum").innerHTML = '<span class="err">' + esc(msg.message || "合并失败") + "</span>";
    }
    return;
  }

  if (msg.type === "error") {
    $("#list").innerHTML = '<div class="err">' + esc(msg.message) + "</div>";
    $("#sub").textContent = "";
    return;
  }
});

vscode.postMessage({ type: "ready" });
</script></body></html>`;
}