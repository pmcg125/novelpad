/**
 * 时间线 Webview：作者看到的「我的稿子改过什么」
 *
 * 设计原则（docs/PLAN-VERSIONING.md §4）：
 *   - 不出现 stage / commit / branch / ref 这些词。作者只关心「什么时候、
 *     改了多少字、改了哪几段」。
 *   - 默认只显示「值得看」的记录：里程碑和发布版全显示，
 *     自动存档按天折叠成一条摘要（否则一天几十条会把时间线刷满）。
 *   - 段落级 diff，连续未变段落折叠。
 *
 * 复用 graph.ts 的范式：纯 SVG/HTML 自绘、零依赖、只吃 --vscode-* 变量。
 */
import * as vscode from "vscode";
import type { ProjectStore } from "../store";

let panel: vscode.WebviewPanel | undefined;
let currentStore: ProjectStore | undefined;

export function openTimeline(store: ProjectStore): void {
  currentStore = store;
  if (!panel) {
    panel = vscode.window.createWebviewPanel("novelpad.timeline", "NovelPad · 时间线", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.webview.html = shell(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => void onMessage(store, msg));
    panel.onDidDispose(() => {
      panel = undefined;
      currentStore = undefined;
    });
  }
  panel.reveal(vscode.ViewColumn.Beside, false);
  void pushTimeline(store);
}

/** 供命令层打开时间线并直接切到「只看 AI」 */
export function openTimelineAIOnly(store: ProjectStore): void {
  openTimeline(store);
  setTimeout(() => void panel?.webview.postMessage({ type: "setFilter", onlyAI: true }), 300);
}

export function refreshTimeline(): void {
  if (panel && currentStore) void pushTimeline(currentStore);
}

export function isTimelineOpen(): boolean {
  return panel !== undefined;
}

/* ============================================================
 * 数据
 * ============================================================ */

/** 传给 webview 的扁平结构：不暴露 git 概念 */
interface TimelineItem {
  /** 稳定 id，用于选中 */
  id: string;
  /** 显示用的时间，如「今天 14:32」 */
  when: string;
  /** 归类：里程碑 / 发布 / 自动 */
  kind: "milestone" | "publish" | "auto";
  /** 里程碑与发布版有人类标签 */
  label?: string;
  note?: string;
  /** 本次字数变化 */
  delta?: number;
  total?: number;
  /** 改动涉及的文件 */
  files: string[];
  /** 是否由 AI 续写引入 */
  byAI: boolean;
  /** 自动存档折叠后包含的条数（1 = 未折叠） */
  count: number;
}

async function pushTimeline(store: ProjectStore): Promise<void> {
  if (!panel) return;
  const root = store.root?.fsPath;
  if (!root) {
    void panel.webview.postMessage({ type: "empty", reason: "尚未打开作品" });
    return;
  }

  const { loadIndex, overview, groupByDay } = await import("@novelpad/core");
  const idx = loadIndex(root);
  if (!idx.snapshots.length) {
    void panel.webview.postMessage({
      type: "empty",
      reason: "还没有存过版本。写作时每隔一会儿会自动存一版，也可以手动打一个里程碑。",
    });
    return;
  }

  const ov = overview(idx.snapshots);
  const groups = groupByDay(idx.snapshots);
  const items: TimelineItem[] = [];

  // 里程碑与发布版：逐条显示，它们是有意义的锚点
  for (const r of idx.snapshots) {
    if (r.kind === "auto") continue;
    items.push(toItem(r, 1));
  }

  // 自动存档：按「天 + 章节」折叠。一天一个章节通常有几十条，
  // 逐条显示会把里程碑冲掉，作者根本找不到自己要回的那个点。
  for (const g of groups) {
    const autos = g.records.filter((r) => r.kind === "auto");
    if (!autos.length) continue;
    const byChapter = new Map<string, typeof autos>();
    for (const r of autos) {
      const k = r.chapter ?? "";
      if (!byChapter.has(k)) byChapter.set(k, []);
      byChapter.get(k)!.push(r);
    }
    for (const [chapter, list] of byChapter) {
      // 取当天该章节的最后一条作为代表（累计字数最准）
      const last = list[0];
      const delta = list.reduce((s, r) => s + (r.words?.delta ?? 0), 0);
      items.push({
        ...toItem(last, list.length),
        delta,
        label: chapter ? `第 ${chapter} 章` : undefined,
      });
    }
  }

  items.sort((a, b) => (a.when < b.when ? 1 : -1));

  void panel.webview.postMessage({
    type: "data",
    title: store.project?.config.title ?? "未命名作品",
    overview: {
      total: ov.total,
      milestone: ov.milestone,
      publish: ov.publish,
      weekDelta: ov.weekDelta,
      lastWhen: ov.latest ? fmtWhen(ov.latest.time) : undefined,
    },
    items,
  });
}

type SnapshotRecord = Awaited<ReturnType<typeof import("@novelpad/core")["loadIndex"]>>["snapshots"][number];

function toItem(r: SnapshotRecord, count: number): TimelineItem {
  return {
    id: r.id,
    when: fmtWhen(r.time),
    kind: r.kind,
    label: r.label,
    note: r.note,
    delta: r.words?.delta,
    total: r.words?.total,
    files: r.files,
    byAI: r.origin.kind === "ai",
    count,
  };
}

/** 「今天 14:32」「昨天 09:05」「11月25日 20:10」——作者关心的是这个 */
function fmtWhen(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000);
  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  if (days === 0) return `今天 ${hm}`;
  if (days === 1) return `昨天 ${hm}`;
  if (days < 7) return `${days} 天前 ${hm}`;
  return `${t.getMonth() + 1}月${t.getDate()}日 ${hm}`;
}

/* ============================================================
 * 消息
 * ============================================================ */

async function onMessage(store: ProjectStore, msg: { type: string; [k: string]: unknown }): Promise<void> {
  if (msg.type === "ready") {
    await pushTimeline(store);
    return;
  }

  if (msg.type === "diff" && typeof msg.id === "string") {
    // 段落级 diff：拿这一版与它同章节的上一版比
    const root = store.root?.fsPath;
    if (!root || !panel) return;
    try {
      const { loadIndex, diffParagraphs, foldBlocks, readSnapshotFile, changedFiles, nodeExec } = await import("@novelpad/core");
      const idx = loadIndex(root);
      const rec = idx.snapshots.find((s) => s.id === msg.id);
      if (!rec) {
        void panel.webview.postMessage({ type: "diffError", message: "找不到这条记录，可能已被清理" });
        return;
      }

      // 选哪个文件来比：
      //   1. 界面点名了某个文件 → 用它
      //   2. 本条记录记了 files → 用第一个
      //   3. 都没有（里程碑常常是全量快照）→ 反查提交真实改动的文件
      // 第三种不能省：里程碑快照的 `files` 可能为空，
      // 只靠 1、2 会报「这一版没有记录改动的文件」，而数据其实在。
      let file = typeof msg.file === "string" ? msg.file : undefined;
      if (!file) file = rec.files[0];
      if (!file) {
        const changed = await changedFiles(nodeExec, root, rec.commit);
        file = changed[0];
      }
      if (!file) {
        void panel.webview.postMessage({ type: "diffError", message: "这一版没有记录改动的文件" });
        return;
      }

      // 同一章节里比它稍早的一条
      const prev = idx.snapshots
        .filter((s) => s.chapter && s.chapter === rec.chapter && s.time < rec.time)
        .sort((a, b) => (a.time < b.time ? 1 : -1))[0];

      // 上一版里可能没有这个文件（新增文件），此时 before 为空串，
      // 整篇都会显示为新增 —— 这是正确结果，不是错误。
      const after = await readSnapshotFile(nodeExec, root, rec, file);
      const before = prev ? await readSnapshotFile(nodeExec, root, prev, file) : undefined;
      if (after === undefined && before === undefined) {
        void panel.webview.postMessage({ type: "diffError", message: `这一版里没有 ${file}` });
        return;
      }

      const diff = diffParagraphs(before ?? "", after ?? "");
      const folded = foldBlocks(diff.blocks, 3);
      void panel.webview.postMessage({
        type: "diff",
        id: rec.id,
        file,
        prevWhen: prev ? fmtWhen(prev.time) : undefined,
        stats: diff.stats,
        blocks: folded,
      });
    } catch (e) {
      void panel.webview.postMessage({ type: "diffError", message: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  if (msg.type === "open" && typeof msg.file === "string") {
    const root = store.root;
    if (!root) return;
    const uri = vscode.Uri.joinPath(root, ...msg.file.split("/"));
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    } catch {
      void vscode.window.showWarningMessage(`打不开 ${msg.file}，可能已被删除或改名`);
    }
    return;
  }

  if (msg.type === "milestone") {
    // 交给命令层：那里有字数统计与用户输入框
    void vscode.commands.executeCommand("novelpad.version.milestone");
    return;
  }

  if (msg.type === "undoAI" && typeof msg.id === "string") {
    const root = store.root?.fsPath;
    if (!root || !panel) return;
    const { loadIndex } = await import("@novelpad/core");
    const rec = loadIndex(root).snapshots.find((s) => s.id === msg.id);
    if (!rec) {
      void panel.webview.postMessage({ type: "undoResult", ok: false, message: "找不到这条记录" });
      return;
    }
    // 确认一次：这是删除正文，误点代价太大
    const ok = await vscode.window.showWarningMessage(
      "撤销这次续写？只删 AI 写进来的段落，你自己改过的地方会保留。\n（撤销前的现状会先存一版，随时能回来）",
      { modal: true },
      "撤销",
    );
    if (ok !== "撤销") {
      void panel.webview.postMessage({ type: "undoResult", ok: false, message: "已取消" });
      return;
    }

    const r = await vscode.commands.executeCommand<{ ok: boolean; message: string }>(
      "novelpad.version.undoAI",
      rec.id,
    );
    if (r) void panel.webview.postMessage({ type: "undoResult", ok: r.ok, message: r.message });
    await pushTimeline(store);
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
  --add: var(--vscode-gitDecoration-addedResourceForeground, #3C8C5A);
  --del: var(--vscode-gitDecoration-deletedResourceForeground, #C8402F);
  --sel: var(--vscode-list-activeSelectionBackground);
}
* { box-sizing: border-box; margin: 0; }
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); height: 100vh; overflow: hidden; }
.app { display: grid; grid-template-rows: auto auto 1fr; height: 100vh; }

/* ---------- 顶部统计 ---------- */
.head { padding: 14px 18px 12px; border-bottom: 1px solid var(--border); background: var(--panel); }
.head h1 { font-size: 15px; font-weight: 600; }
.head .sub { color: var(--muted); font-size: 12px; margin-top: 3px; }
.head .nums { display: flex; gap: 20px; margin-top: 10px; }
.head .n { font-size: 11px; color: var(--muted); }
.head .n b { display: block; font-size: 17px; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
.head .n.up b { color: var(--add); }
.head .acts { position: absolute; right: 18px; top: 16px; }

/* ---------- 主体：左列表右详情 ---------- */
.main { display: grid; grid-template-columns: 300px 1fr; overflow: hidden; }
.list { overflow: auto; border-right: 1px solid var(--border); }
.detail { overflow: auto; padding: 18px 22px; }

/* ---------- 列表项 ---------- */
.item { padding: 9px 14px 9px 30px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); cursor: pointer; position: relative; }
.item:hover { background: var(--input); }
.item.on { background: var(--sel); }
.item .t { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.item .l { font-size: 13px; margin-top: 2px; }
.item .meta { font-size: 11px; color: var(--faint); margin-top: 2px; }
/* 左侧竖线：时间线的视觉骨架 */
.item::before { content: ""; position: absolute; left: 14px; top: 0; bottom: 0; width: 1px; background: var(--border); }
.item .dot { position: absolute; left: 10.5px; top: 15px; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); border: 2px solid var(--bg); }
.item[data-kind=publish] .dot { background: var(--accent); width: 10px; height: 10px; left: 9.5px; }
.item[data-kind=milestone] .dot { background: var(--vscode-gitDecoration-modifiedResourceForeground, #B7791F); width: 10px; height: 10px; left: 9.5px; }
.item .fold { font-size: 11px; color: var(--faint); }
.item .ai { font-size: 10px; padding: 0 5px; border-radius: 3px; background: var(--vscode-textCodeBlock-background); color: var(--accent); }
/* AI 快照用青色竖线标记：作者一眼能看出「这段不是我自己写的」 */
.item.ai-src::before { background: var(--accent); }
.item.ai-src .dot { background: var(--accent); }
.delta.up { color: var(--add); }
.delta.down { color: var(--del); }

/* ---------- 筛选栏 ---------- */
.filters { display: flex; gap: 6px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--panel); }
.chip { font: inherit; font-size: 11.5px; padding: 2px 10px; border-radius: 10px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
.chip:hover { color: var(--fg); border-color: var(--muted); }
.chip.on { background: var(--btn); border-color: var(--btn); color: var(--btnFg); }
.chip .c { opacity: .75; margin-left: 4px; font-variant-numeric: tabular-nums; }

/* ---------- 详情 ---------- */
.detail .ph { color: var(--muted); font-size: 12.5px; line-height: 1.9; padding-top: 30px; }
.detail h2 { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.detail .file { font-size: 11.5px; color: var(--muted); margin-bottom: 14px; font-family: var(--vscode-editor-font-family); }
.detail .stat { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
.detail .stat b { color: var(--fg); font-variant-numeric: tabular-nums; }

/* 段落块 */
.blk { margin-bottom: 10px; padding: 8px 12px; border-radius: 5px; line-height: 1.85; font-size: 13.5px; border-left: 2px solid transparent; }
.blk p { margin: 0; }
.blk.added { background: color-mix(in srgb, var(--add) 9%, transparent); border-left-color: var(--add); }
.blk.removed { background: color-mix(in srgb, var(--del) 9%, transparent); border-left-color: var(--del); }
.blk.removed p { text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--del) 45%, transparent); color: var(--muted); }
.blk.changed { background: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, #B7791F) 7%, transparent); border-left-color: var(--vscode-gitDecoration-modifiedResourceForeground, #B7791F); }
.blk.fold { text-align: center; color: var(--faint); font-size: 11.5px; border: 1px dashed var(--border); padding: 5px; cursor: pointer; }
.blk.fold:hover { color: var(--muted); border-color: var(--muted); }
ins { background: color-mix(in srgb, var(--add) 28%, transparent); text-decoration: none; border-radius: 2px; }
del { background: color-mix(in srgb, var(--del) 22%, transparent); border-radius: 2px; }

.empty { padding: 40px; text-align: center; color: var(--muted); font-size: 13px; line-height: 1.9; grid-column: 1 / -1; }
.btn { font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--input); color: var(--fg); cursor: pointer; }
.btn:hover { border-color: var(--accent); }
.btn.danger { border-color: color-mix(in srgb, var(--del) 50%, var(--border)); color: var(--del); }
.btn.danger:hover { border-color: var(--del); background: color-mix(in srgb, var(--del) 10%, transparent); }
.err { color: var(--del); font-size: 12.5px; padding: 12px 0; }
.ok { color: var(--add); font-size: 12.5px; padding: 8px 0; }

/* ---------- 撤销这次续写 ---------- */
.undo { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; padding: 10px 12px; border-radius: 5px; background: color-mix(in srgb, var(--accent) 7%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent); }
.undo-hint { font-size: 11.5px; color: var(--muted); }
.undo-note { flex-basis: 100%; }
.undo-note:empty { display: none; }
</style></head><body>
<div class="app">
  <div class="head">
    <div class="acts"><button class="btn" id="mk">记录里程碑</button></div>
    <h1 id="title">时间线</h1>
    <div class="sub" id="sub">读取中…</div>
    <div class="nums" id="nums"></div>
  </div>
  <div class="filters" id="filters" hidden></div>
  <div class="main" id="main">
    <div class="list" id="list"></div>
    <div class="detail" id="detail"></div>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const $ = (s) => document.querySelector(s);
let DATA = null;
let SEL = null;
/** "" = 全部；"ai" = 只看 AI；"human" = 只看自己写的 */
let FILTER = "";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function num(n) {
  if (n === undefined || n === null) return "";
  return (n > 0 ? "+" : "") + n.toLocaleString("zh-CN");
}

/** 当前筛选下应该显示的条目 */
function visible() {
  if (!DATA) return [];
  if (FILTER === "ai") return DATA.items.filter((it) => it.byAI);
  if (FILTER === "human") return DATA.items.filter((it) => !it.byAI);
  return DATA.items;
}

function renderFilters() {
  const el = $("#filters");
  if (!DATA) { el.hidden = true; return; }
  const aiCount = DATA.items.filter((it) => it.byAI).length;
  // 没有 AI 记录时整条筛选栏都不出现——干净的时间线不该有装饰
  if (!aiCount) { el.hidden = true; return; }

  el.hidden = false;
  const chip = (key, label, count) =>
    '<button class="chip ' + (FILTER === key ? "on" : "") + '" data-f="' + key + '">' +
    label + '<span class="c">' + count + "</span></button>";
  el.innerHTML =
    chip("", "全部", DATA.items.length) +
    chip("ai", "只看 AI", aiCount) +
    chip("human", "只看我写的", DATA.items.length - aiCount);

  el.querySelectorAll(".chip").forEach((b) => {
    b.onclick = () => { FILTER = b.dataset.f; renderFilters(); renderList(); };
  });
}

function renderList() {
  const list = $("#list");
  const items = visible();
  if (!items.length) {
    list.innerHTML = '<div class="empty" style="padding:24px 16px">' +
      (FILTER === "ai" ? "还没有 AI 续写的记录。" : FILTER === "human" ? "还没有你自己写的记录。" : "没有记录。") +
      "</div>";
    return;
  }
  list.innerHTML = items.map((it) => {
    const cls = ["item", SEL === it.id ? "on" : "", it.byAI ? "ai-src" : ""].join(" ").trim();
    const d = it.delta ? '<span class="delta ' + (it.delta > 0 ? "up" : "down") + '">' + num(it.delta) + " 字</span>" : "";
    const fold = it.count > 1 ? '<span class="fold">' + it.count + " 次存档</span>" : "";
    const ai = it.byAI ? '<span class="ai">AI 续写</span>' : "";
    const label = it.label ? esc(it.label) : it.kind === "publish" ? "发布版" : it.kind === "milestone" ? "里程碑" : "自动存档";
    return '<div class="' + cls + '" data-id="' + esc(it.id) + '" data-kind="' + it.kind + '">' +
      '<span class="dot"></span>' +
      '<div class="t">' + esc(it.when) + fold + "</div>" +
      '<div class="l">' + label + "</div>" +
      '<div class="meta">' + d + ai + "</div>" +
      "</div>";
  }).join("");
  list.querySelectorAll(".item").forEach((el) => {
    el.onclick = () => { SEL = el.dataset.id; renderList(); vscode.postMessage({ type: "diff", id: SEL }); };
  });
}

function renderDetail() {
  $("#detail").innerHTML = '<div class="ph">从左侧选一条，看这一版改了什么。<br>对比的是同章节的上一版——段落级对比，改了几个字也能看清。</div>';
}

function blockHtml(b) {
  if (b.type === "fold") {
    return '<div class="blk fold" data-fold="' + b.count + '">… 中间 ' + b.count + " 段未改动 …</div>";
  }
  if (b.type === "added") return '<div class="blk added"><p>' + esc(b.after).replace(/\\n/g, "<br>") + "</p></div>";
  if (b.type === "removed") return '<div class="blk removed"><p>' + esc(b.before).replace(/\\n/g, "<br>") + "</p></div>";
  if (b.type === "changed") {
    const inner = b.inline.map((s) => s.op === "ins" ? "<ins>" + esc(s.text) + "</ins>" : s.op === "del" ? "<del>" + esc(s.text) + "</del>" : esc(s.text)).join("");
    return '<div class="blk changed"><p>' + inner.replace(/\\n/g, "<br>") + "</p></div>";
  }
  return "";
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "empty") {
    $("#main").innerHTML = '<div class="empty">' + esc(msg.reason) + "</div>";
    $("#sub").textContent = "";
    $("#nums").innerHTML = "";
    $("#filters").hidden = true;
    return;
  }
  if (msg.type === "setFilter") {
    FILTER = msg.onlyAI ? "ai" : "";
    if (DATA) { renderFilters(); renderList(); }
    return;
  }
  if (msg.type === "data") {
    DATA = msg;
    $("#title").textContent = msg.title;
    $("#sub").textContent = "共 " + msg.overview.total + " 个存档点";
    $("#nums").innerHTML =
      '<div class="n"><b>' + msg.overview.milestone + "</b>里程碑</div>" +
      '<div class="n"><b>' + msg.overview.publish + "</b>发布版</div>" +
      '<div class="n up"><b>' + num(msg.overview.weekDelta) + "</b>近 7 天净增</div>" +
      (msg.overview.lastWhen ? '<div class="n"><b style="font-size:13px">' + esc(msg.overview.lastWhen) + "</b>最近存档</div>" : "");
    // 筛选状态在新数据到来时保留：作者正在「只看 AI」，刷新后不该跳回去
    renderFilters();
    renderList();
    renderDetail();
    return;
  }
  if (msg.type === "diff") {
    renderDiff(msg);
    return;
  }
  if (msg.type === "diffError") {
    $("#detail").innerHTML = '<div class="err">' + esc(msg.message) + "</div>";
    return;
  }
  if (msg.type === "undoResult") {
    const note = $(".undo-note");
    if (note) {
      note.className = "undo-note " + (msg.ok ? "ok" : "err");
      note.textContent = msg.message;
    }
    return;
  }
});

/** 这一版是不是 AI 引入的（按钮只在这时出现） */
function recById(id) {
  return DATA && DATA.items.find((it) => it.id === id);
}

function renderDiff(msg) {
  const s = msg.stats;
  const it = recById(msg.id);
  const canUndo = it && it.byAI;

  $("#detail").innerHTML =
    "<h2>" + esc(msg.prevWhen ? "对比 " + msg.prevWhen + " 的版本" : "这一版的完整内容") + "</h2>" +
    '<div class="file">' + esc(msg.file) + "</div>" +
    '<div class="stat">' +
      "<span>新增 <b>" + s.added + "</b> 段</span>" +
      "<span>删除 <b>" + s.removed + "</b> 段</span>" +
      "<span>修改 <b>" + s.changed + "</b> 段</span>" +
      "<span>字数 <b style='color:var(--add)'>+" + s.wordsAdded + "</b> / <b style='color:var(--del)'>-" + s.wordsRemoved + "</b></span>" +
    "</div>" +
    (canUndo
      ? '<div class="undo"><button class="btn danger" id="undo">撤销这次续写</button>' +
        '<span class="undo-hint">只删 AI 写进来的段落，你自己改过的地方会保留</span>' +
        '<div class="undo-note"></div></div>'
      : "") +
    (msg.blocks.length ? msg.blocks.map(blockHtml).join("") : '<div class="ph">这一版与上一版没有文字差异。</div>');

  const btn = $("#undo");
  if (btn) btn.onclick = () => {
    btn.disabled = true;
    btn.textContent = "正在撤销…";
    vscode.postMessage({ type: "undoAI", id: msg.id });
  };
}

$("#mk").onclick = () => vscode.postMessage({ type: "milestone" });
vscode.postMessage({ type: "ready" });
</script></body></html>`;
}