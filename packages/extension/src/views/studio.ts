/**
 * 书房（docs/PLAN-UI.md §6）：替代 VS Code 的 Welcome 页。
 *
 * 为什么要它：作者打开软件的第一眼不该是「最近打开的文件夹」和一排
 * 快捷键说明，那是在教他用 IDE。他要看到的是「写到哪里了、今天写了多少、
 * 有哪些线索还没收」。
 *
 * 两条硬约束：
 *   1. **只在没有编辑器时出现**。一旦打开任何文件立刻 dispose——它不该
 *      变成挡在正文前面的一个标签页。
 *   2. **零依赖、自绘 SVG**。与 graph.ts 同一范式，深浅主题靠 vscode 变量
 *      自动适配，装到标准 VS Code 里也不破相。
 */
import * as vscode from "vscode";
import fs from "node:fs";
import { groupByDay, loadIndex } from "@novelpad/core";
import type { ProjectStore } from "../store";
import {
  draftChapters,
  greeting,
  overdueForeshadows,
  progress,
  todayDelta,
  weekCurve,
} from "./studio-rules.js";

const PANEL_TITLE = "书房";
/** 记忆最近打开过的作品，最多 6 个 */
const RECENT_KEY = "novelpad.recentProjects";
const RECENT_MAX = 6;

let panel: vscode.WebviewPanel | undefined;
let currentStore: ProjectStore | undefined;
let currentContext: vscode.ExtensionContext | undefined;

/* ============================================================
 * 生命周期
 * ============================================================ */

/**
 * 启动时调用：没有可见编辑器才开书房。
 *
 * 延迟 700ms 是必要的——`onStartupFinished` 触发时，被恢复的编辑器
 * 有时还没挂到 tabGroups 上。立刻判断会误以为「空窗口」，于是作者的
 * 正文旁边莫名其妙多出一个书房标签。
 */
export function maybeOpenStudio(context: vscode.ExtensionContext, store: ProjectStore): void {
  currentStore = store;
  currentContext = context;
  if (!context.globalState.get<boolean>("novelpad.openStudioOnStartup", true)) return;

  setTimeout(() => {
    if (!hasVisibleEditor()) openStudio(context, store);
  }, 700);
}

/** 命令入口：作者想看就看，不管有没有编辑器 */
export function openStudio(context: vscode.ExtensionContext, store: ProjectStore): void {
  currentStore = store;
  currentContext = context;

  if (panel) {
    panel.reveal(vscode.ViewColumn.One, false);
    void pushAll(context, store);
    return;
  }

  panel = vscode.window.createWebviewPanel("novelpad.studio", PANEL_TITLE, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    // 书房里不显示编辑器工具栏上的那些按钮
    localResourceRoots: [],
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "assets", "book.svg");
  panel.webview.html = shell(panel.webview);
  panel.webview.onDidReceiveMessage((msg) => void onMessage(context, store, msg));
  panel.onDidDispose(() => {
    panel = undefined;
  });

  void pushAll(context, store);
}

/** 有正文可看时把书房关掉——它只在「没东西可看」时才有存在意义 */
export function closeStudioIfIdle(): void {
  if (!hasVisibleEditor()) return;
  panel?.dispose();
}

export function isStudioOpen(): boolean {
  return panel !== undefined;
}

/** 刷新（作品数据变化时） */
export function refreshStudio(): void {
  if (panel && currentContext && currentStore) void pushAll(currentContext, currentStore);
}

function hasVisibleEditor(): boolean {
  // 只看「真的打开了文件」的组：输出 / 调试 / 问题面板不算
  return vscode.window.tabGroups.all.some((g) =>
    g.tabs.some((t) => t.input instanceof vscode.TabInputText || t.input instanceof vscode.TabInputCustom),
  );
}

/* ============================================================
 * 数据
 * ============================================================ */

interface StudioData {
  title: string;
  hasProject: boolean;
  author?: string;
  chapters: { title: string; order: number; words: number; status: string; target?: number; volume?: string }[];
  totalWords: number;
  todayWords: number;
  /** 今日进度（在服务端算好，webview 只负责画） */
  todayDone: boolean;
  todayRatio: number;
  todayRemaining: number;
  /** 问候语按作者本地时间算，凌晨不说「早上好」 */
  greet: string;
  week: { day: string; total: number; delta: number }[];
  overdue: { id: string; note?: string; due: number; chapter: string }[];
  drafts: { title: string; order: number; words: number; volume?: string }[];
  recent: { title: string; path: string; exists: boolean }[];
  hasVersion: boolean;
  /** 今日目标，来自设置 */
  dailyTarget: number;
}

async function collect(context: vscode.ExtensionContext, store: ProjectStore): Promise<StudioData> {
  const cfg = vscode.workspace.getConfiguration("novelpad");
  const dailyTarget = Math.max(100, cfg.get<number>("studio.dailyTarget", 2000));
  const recent = readRecent(context);

  const root = store.root?.fsPath;
  const project = store.project;
  if (!root || !project) {
    return {
      title: "",
      hasProject: false,
      chapters: [],
      totalWords: 0,
      todayWords: 0,
      todayDone: false,
      todayRatio: 0,
      todayRemaining: dailyTarget,
      greet: greeting(),
      week: [],
      overdue: [],
      drafts: [],
      recent,
      hasVersion: false,
      dailyTarget,
    };
  }

  const chapters = project.chapters.map((c) => ({
    title: c.frontmatter.title,
    order: c.frontmatter.order,
    words: c.wordCount,
    status: c.frontmatter.status ?? "draft",
    target: c.frontmatter.targetWords,
    volume: c.frontmatter.volume,
  }));
  const totalWords = chapters.reduce((s, c) => s + c.words, 0);

  /* ---- 今日字数 / 近七天曲线：都从存档的 delta 算 ---- */
  let today = 0;
  let week: StudioData["week"] = [];
  let hasVersion = false;
  try {
    const idx = loadIndex(root);
    hasVersion = idx.snapshots.length > 0;
    if (hasVersion) {
      const groups = groupByDay(idx.snapshots).map((g) => ({ day: g.day, delta: g.delta }));
      // 今日字数必须是「今天这一天存过的 delta 之和」，不能用
      // session.startWords：那个值记的是「这次打开软件时」的字数，
      // 作者昨天开着没关，今天看到的就会是 0。
      today = todayDelta(groups);
      // 曲线必须补齐空白天，否则「昨天没写」会变成两点直连。
      week = weekCurve(groups).map((p) => ({ day: p.day, total: 0, delta: p.delta }));
    }
  } catch {
    /* 没有版本库（还没存过档）是常态，不是错误 */
  }

  const p = progress(today, dailyTarget);

  /* ---- 伏笔：due 已过且没被任何一章 resolves ---- */
  const overdue = overdueForeshadows(project).map((f) => ({
    id: f.id,
    note: f.note,
    due: f.due,
    chapter: f.plantedIn,
  }));

  const drafts = draftChapters(project.chapters).map((c) => ({
    title: c.title,
    order: c.order,
    words: c.words,
    volume: c.volume,
  }));

  // 把当前作品顶到最近列表最前，下次启动时它就在第一张卡上
  const merged = [
    { title: project.config.title, path: root, exists: true },
    ...recent.filter((r) => samePath(r.path, root) === false),
  ].slice(0, RECENT_MAX);

  return {
    title: project.config.title,
    hasProject: true,
    author: project.config.author,
    chapters,
    totalWords,
    todayWords: today,
    todayDone: p.done,
    todayRatio: p.ratio,
    todayRemaining: p.remaining,
    greet: greeting(),
    week,
    overdue,
    drafts,
    recent: merged,
    hasVersion,
    dailyTarget,
  };
}

async function pushAll(context: vscode.ExtensionContext, store: ProjectStore): Promise<void> {
  if (!panel) return;
  const data = await collect(context, store);
  // 每打开一次书房就把最近作品记下来。存绝对路径是为了能真的打开它，
  // 所以同时存 exists——盘符变了/文件夹被挪走时要如实标出来，不能点了没反应。
  await writeRecent(context, data.recent);
  void panel.webview.postMessage({ type: "data", data, isDark: isDark() });
}

function readRecent(context: vscode.ExtensionContext): StudioData["recent"] {
  const raw = context.globalState.get<{ title: string; path: string }[]>(RECENT_KEY, []);
  return raw.map((r) => ({ ...r, exists: dirExists(r.path) }));
}

async function writeRecent(context: vscode.ExtensionContext, list: StudioData["recent"]): Promise<void> {
  await context.globalState.update(
    RECENT_KEY,
    list.map(({ title, path }) => ({ title, path })),
  );
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

function isDark(): boolean {
  const k = vscode.window.activeColorTheme.kind;
  return k === vscode.ColorThemeKind.Dark || k === vscode.ColorThemeKind.HighContrast;
}

/* ============================================================
 * 消息
 * ============================================================ */

async function onMessage(
  context: vscode.ExtensionContext,
  store: ProjectStore,
  msg: { type: string; [k: string]: unknown },
): Promise<void> {
  switch (msg.type) {
    case "ready":
      await pushAll(context, store);
      return;

    case "newProject":
      await vscode.commands.executeCommand("novelpad.initProject");
      await store.refresh();
      await pushAll(context, store);
      return;

    case "newChapter":
      await vscode.commands.executeCommand("novelpad.newChapter");
      await pushAll(context, store);
      return;

    case "openChapter": {
      const order = Number(msg.order);
      const ch = store.project?.chapters.find((c) => c.frontmatter.order === order);
      if (!ch) return;
      await vscode.window.showTextDocument(vscode.Uri.file(ch.path), { preview: false });
      return;
    }

    case "openRecent": {
      const p = typeof msg.path === "string" ? msg.path : "";
      if (!p) return;
      if (!dirExists(p)) {
        void vscode.window.showWarningMessage(`找不到这个文件夹：${p}。可能被移动或删除了。`);
        // 失效条目从最近列表里清掉，否则它会一直躺在书房里点不动
        await writeRecent(
          context,
          readRecent(context).filter((r) => r.path !== p),
        );
        await pushAll(context, store);
        return;
      }
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(p), { forceNewWindow: false });
      return;
    }

    case "openFolder": {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, openLabel: "打开作品" });
      if (!picked?.[0]) return;
      await vscode.commands.executeCommand("vscode.openFolder", picked[0], { forceNewWindow: false });
      return;
    }

    case "timeline":
      if (store.root) await vscode.commands.executeCommand("novelpad.timeline");
      return;

    case "graph":
      if (store.root) await vscode.commands.executeCommand("novelpad.graph.open");
      return;

    case "host":
      await vscode.commands.executeCommand("novelpad.host.status");
      return;

    case "stats":
      if (store.root) await vscode.commands.executeCommand("novelpad.stats");
      return;

    case "settings":
      await vscode.commands.executeCommand("workbench.action.openSettings", "novelpad");
      return;
  }
}

/* ============================================================
 * 视图
 * ============================================================ */

function shell(wv: vscode.Webview): string {
  const csp = `default-src 'none'; style-src ${wv.cspSource} 'unsafe-inline'; script-src ${wv.cspSource} 'unsafe-inline'; img-src ${wv.cspSource} data:;`;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
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
  --hover: var(--vscode-list-hoverBackground);
  --add: var(--vscode-gitDecoration-addedResourceForeground, #3C8C5A);
  --warn: var(--vscode-editorWarning-foreground, #B7791F);
  /* 正文用楷体：书房是「翻开一本书」的第一页，不是控制台 */
  --serif: "LXGW WenKai Screen", "LXGW WenKai", "Kaiti SC", "STKaiti", serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: 13px; color: var(--fg); background: var(--bg);
  height: 100vh; overflow: auto;
}
.sheet { max-width: 980px; margin: 0 auto; padding: 46px 40px 64px; }

/* ---------- 页头 ---------- */
.top { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 34px; }
.top .greet { font-size: 12px; color: var(--muted); letter-spacing: .1em; }
.top h1 { font-family: var(--serif); font-size: 30px; font-weight: 600; letter-spacing: .02em; margin-top: 6px; line-height: 1.3; }
.top h1 .num { font-size: 15px; color: var(--muted); font-family: var(--vscode-font-family); margin-left: 10px; letter-spacing: 0; }
.top .author { font-size: 12px; color: var(--muted); margin-top: 6px; }

/* 一条细横线当作「扉页」分隔，比卡片边框安静 */
.rule { height: 1px; background: var(--border); margin: 0 0 30px; }

/* ---------- 上半：进度环 + 本周曲线 ---------- */
.duo { display: grid; grid-template-columns: 220px 1fr; gap: 28px; margin-bottom: 36px; align-items: start; }
.ring { text-align: center; }
.ring svg { display: block; margin: 0 auto; }
.ring .cap { font-size: 11.5px; color: var(--muted); margin-top: 10px; letter-spacing: .04em; }
.ring .big { font-size: 15px; color: var(--fg); }
.ring .big b { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }

.curve .h { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.curve .h .t { font-size: 12px; color: var(--muted); letter-spacing: .06em; }
.curve .h .v { font-size: 12px; color: var(--muted); }
.curve .h .v b { color: var(--add); font-variant-numeric: tabular-nums; }
.curve svg { width: 100%; height: 118px; display: block; }
.curve .none { font-size: 12px; color: var(--faint); padding: 40px 0; text-align: center; }

/* ---------- 分区 ---------- */
.sec { margin-bottom: 34px; }
.sec > .h { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.sec > .h .t { font-size: 12px; color: var(--muted); letter-spacing: .1em; text-transform: uppercase; }
.sec > .h .c { font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
.sec > .h .more { margin-left: auto; font-size: 11.5px; color: var(--muted); cursor: pointer; background: none; border: 0; font-family: inherit; }
.sec > .h .more:hover { color: var(--accent); }

/* ---------- 最近作品卡 ---------- */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.card {
  display: flex; gap: 12px; align-items: center; text-align: left;
  padding: 12px 14px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--input); cursor: pointer; font-family: inherit; color: inherit;
  transition: border-color 120ms ease-out, transform 120ms ease-out;
}
.card:hover { border-color: var(--accent); transform: translateY(-1px); }
.card .cover {
  width: 40px; height: 52px; flex: none; border-radius: 3px;
  display: grid; place-items: center;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  font-family: var(--serif); font-size: 19px; color: var(--accent);
}
.card .n { font-size: 13px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .p { font-size: 10.5px; color: var(--faint); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.card.gone { opacity: .55; }
.card.gone .cover { color: var(--faint); border-color: var(--border); background: transparent; }

/* ---------- 章节 / 伏笔列表 ---------- */
.rows { border-top: 1px solid var(--border); }
.row {
  display: flex; align-items: center; gap: 12px;
  padding: 9px 4px; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  cursor: pointer; background: none; border-left: 0; border-right: 0; border-top: 0;
  width: 100%; text-align: left; font-family: inherit; color: inherit;
}
.row:hover { background: var(--hover); }
.row .idx { font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; width: 26px; flex: none; }
.row .ttl { font-family: var(--serif); font-size: 14.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .vol { font-size: 11px; color: var(--faint); flex: none; }
.row .wc { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
.row .tag { font-size: 10.5px; padding: 1px 7px; border-radius: 9px; flex: none; }
.row .tag.draft { color: var(--muted); border: 1px solid var(--border); }
.row .tag.warn { color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); }
.row .note { font-size: 11.5px; color: var(--muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 伏笔的左侧竖线用警示色：它是「欠着读者的债」 */
.row.debt { position: relative; padding-left: 14px; }
.row.debt::before { content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 2px; border-radius: 2px; background: color-mix(in srgb, var(--warn) 65%, transparent); }

/* ---------- 空态 ---------- */
.empty { text-align: center; padding: 26px 20px; color: var(--muted); font-size: 12.5px; line-height: 2; }
.empty b { color: var(--fg); font-weight: 500; }

/* ---------- 底部动作 ---------- */
.acts { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
.btn {
  font: inherit; font-size: 12.5px; padding: 7px 16px; border-radius: 5px;
  border: 1px solid var(--border); background: var(--input); color: var(--fg); cursor: pointer;
}
.btn:hover { border-color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--vscode-button-foreground, #fff); }
.btn.primary:hover { filter: brightness(1.08); }
.btn.quiet { border-color: transparent; background: none; color: var(--muted); }
.btn.quiet:hover { color: var(--fg); }

/* 一段手写体的题记，纯装饰但让页面不像仪表盘 */
.epigraph { font-family: var(--serif); font-size: 13px; color: var(--faint); line-height: 1.9; margin-top: 40px; text-align: center; }

@media (max-width: 760px) {
  .sheet { padding: 30px 22px 48px; }
  .duo { grid-template-columns: 1fr; }
  .top h1 { font-size: 24px; }
}
</style></head>
<body>
<div class="sheet" id="root"></div>
<script>
const vscode = acquireVsCodeApi();
const $ = (s) => document.querySelector(s);
let DATA = null;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const nf = (n) => (n ?? 0).toLocaleString("zh-CN");

/** 进度环：没有第三方图表库，就是两段圆弧。比例在服务端算好。 */
function ring(done, target, ratio, isDone) {
  const pct = ratio;
  const r = 56, c = 2 * Math.PI * r;
  const on = c * pct;
  const hot = isDone;
  return \`<svg width="140" height="140" viewBox="0 0 140 140">
    <circle cx="70" cy="70" r="\${r}" fill="none" stroke="var(--border)" stroke-width="7"/>
    <circle cx="70" cy="70" r="\${r}" fill="none"
      stroke="\${hot ? "var(--add)" : "var(--accent)"}" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="\${on} \${c - on}" transform="rotate(-90 70 70)"/>
    <text x="70" y="66" text-anchor="middle" fill="var(--fg)" font-size="26" font-weight="600"
      font-family="var(--vscode-font-family)" style="font-variant-numeric:tabular-nums">\${nf(done)}</text>
    <text x="70" y="86" text-anchor="middle" fill="var(--muted)" font-size="11">/ \${nf(target)} 字</text>
  </svg>\`;
}

/** 本周曲线：只画有数据的日子，缺的那天用 0 补齐 */
function curve(week) {
  if (!week.length) {
    return '<div class="none">还没有存档记录。今天写的字，明天这里会有曲线。</div>';
  }
  const W = 560, H = 118, pad = 8;
  const vals = week.map((d) => Math.max(0, d.delta));
  const max = Math.max(1, ...vals);
  const step = vals.length > 1 ? (W - pad * 2) / (vals.length - 1) : 0;
  const pts = vals.map((v, i) => {
    const x = pad + step * i;
    const y = H - pad - (v / max) * (H - pad * 2 - 16);
    return [x, y];
  });
  const line = pts.map(([x, y], i) => (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1)).join(" ");
  const area = line + \` L \${pts[pts.length - 1][0].toFixed(1)} \${H - pad} L \${pts[0][0].toFixed(1)} \${H - pad} Z\`;
  const dots = pts.map(([x, y]) => \`<circle cx="\${x.toFixed(1)}" cy="\${y.toFixed(1)}" r="2.5" fill="var(--accent)"/>\`).join("");
  const labels = week.map((d, i) => {
    const x = pad + step * i;
    const dt = new Date(d.day + "T00:00:00");
    const lab = (dt.getMonth() + 1) + "/" + dt.getDate();
    return \`<text x="\${x.toFixed(1)}" y="\${H - 1}" text-anchor="middle" fill="var(--faint)" font-size="9.5">\${lab}</text>\`;
  }).join("");
  return \`<svg viewBox="0 0 \${W} \${H}" preserveAspectRatio="none">
    <path d="\${area}" fill="color-mix(in srgb, var(--accent) 10%, transparent)"/>
    <path d="\${line}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"/>
    \${dots}\${labels}
  </svg>\`;
}

function render() {
  const d = DATA;
  if (!d) return;

  if (!d.hasProject) {
    renderWelcome(d);
    return;
  }

  const totalDelta = d.week.reduce((s, x) => s + (x.delta || 0), 0);
  const inProgress = d.chapters.filter((c) => c.status !== "final");

  $("#root").innerHTML = \`
    <div class="top">
      <div>
        <div class="greet">\${esc(d.greet)}</div>
        <h1>《\${esc(d.title)}》<span class="num">\${nf(d.totalWords)} 字 · \${d.chapters.length} 章</span></h1>
        \${d.author ? '<div class="author">' + esc(d.author) + "</div>" : ""}
      </div>
      <div>
        \${d.hasVersion ? '<button class="btn quiet" data-a="timeline">看时间线</button>' : ""}
      </div>
    </div>
    <div class="rule"></div>

    <div class="duo">
      <div class="ring">
        \${ring(d.todayWords, d.dailyTarget, d.todayRatio, d.todayDone)}
        <div class="cap">\${d.todayDone ? "今天达标了" : "今日已写"}</div>
      </div>
      <div class="curve">
        <div class="h">
          <span class="t">近七天</span>
          <span class="v">\${totalDelta >= 0 ? "净增" : "净减"} <b>\${totalDelta >= 0 ? "+" : ""}\${nf(totalDelta)}</b> 字</span>
        </div>
        \${curve(d.week)}
      </div>
    </div>

    \${d.overdue.length ? \`
    <div class="sec">
      <div class="h"><span class="t">欠着读者</span><span class="c">\${d.overdue.length} 条线索到期未收</span></div>
      <div class="rows">
        \${d.overdue.map((f) => \`
          <div class="row debt">
            <span class="idx">\${f.due}</span>
            <span class="ttl">\${esc(f.note || f.id)}</span>
            <span class="note">\${esc(f.chapter)}埋下</span>
            <span class="tag warn">该收了</span>
          </div>\`).join("")}
      </div>
    </div>\` : ""}

    <div class="sec">
      <div class="h"><span class="t">未完成</span><span class="c">\${inProgress.length} 章</span></div>
      \${d.chapters.length ? \`
      <div class="rows">
        \${inProgress.slice(0, 8).map((c) => \`
          <button class="row" data-order="\${c.order}">
            <span class="idx">\${c.order}</span>
            <span class="ttl">\${esc(c.title)}</span>
            \${c.volume ? '<span class="vol">' + esc(c.volume) + "</span>" : ""}
            <span class="wc">\${nf(c.words)}\${c.target ? " / " + nf(c.target) : ""}</span>
            <span class="tag \${c.status === "draft" ? "draft" : ""}">\${c.status === "draft" ? "初稿" : "修改中"}</span>
          </button>\`).join("")}
      </div>\` : '<div class="empty">还没有章节。<b>新建第一章</b>，从这里开始。</div>'}
    </div>

    <div class="actions">
      <button class="btn primary" data-a="newChapter">写新一章</button>
      \${d.hasVersion ? '<button class="btn quiet" data-a="stats">字数明细</button>' : ""}
      <button class="btn quiet" data-a="graph">看人物关系</button>
      <button class="btn quiet" data-a="host">云端备份</button>
      <button class="btn quiet" data-a="settings">设置</button>
    </div>
    <div class="epigraph">每天写一点，故事就会自己往前走。</div>
  \`;
  bind();
}

function renderWelcome(d) {
  $("#root").innerHTML = \`
    <div class="top">
      <div>
        <div class="greet">\${esc(d.greet)}</div>
        <h1>NovelPad</h1>
      </div>
    </div>
    <div class="rule"></div>
    <div class="empty" style="padding:40px 20px">
      <b>还没有打开作品</b><br>
      选一个文件夹开始写，或者建一个新的。
    </div>
    <div class="acts" style="justify-content:center">
      <button class="btn primary" data-a="newProject">新建作品</button>
      <button class="btn" data-a="openFolder">打开文件夹</button>
    </div>
    \${d.recent.length ? \`
    <div class="sec" style="margin-top:46px">
      <div class="h"><span class="t">最近</span></div>
      <div class="cards">
        \${d.recent.map((r) => \`
          <button class="card \${r.exists ? "" : "gone"}" data-recent="\${esc(r.path)}">
            <span class="cover">\${esc((r.title || "?").slice(0, 1))}</span>
            <span style="min-width:0">
              <span class="n" style="display:block">\${esc(r.title)}</span>
              <span class="p" style="display:block">\${r.exists ? esc(r.path) : "文件夹不在了"}</span>
            </span>
          </button>\`).join("")}
      </div>
    </div>\` : ""}
    <div class="epigraph">把设定当代码管，把稿子当作品写。</div>
  \`;
  bind();
}

function bind() {
  document.querySelectorAll("[data-a]").forEach((el) => {
    el.onclick = () => vscode.postMessage({ type: el.dataset.a });
  });
  document.querySelectorAll("[data-order]").forEach((el) => {
    el.onclick = () => vscode.postMessage({ type: "openChapter", order: Number(el.dataset.order) });
  });
  document.querySelectorAll("[data-recent]").forEach((el) => {
    el.onclick = () => vscode.postMessage({ type: "openRecent", path: el.dataset.recent });
  });
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "data") {
    DATA = msg.data;
    render();
  }
});

vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}