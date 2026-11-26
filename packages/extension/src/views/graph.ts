/**
 * 图谱 Webview：关系云图 + 剧情发展链
 * 自绘 SVG + 轻量力导向（节点 < 500 足够），零依赖，主题变量自动适配宣纸 / 夜墨
 */
import * as vscode from "vscode";
import type { ProjectStore } from "../store";

const KIND_COLOR: Record<string, string> = {
  character: "#C8402F",
  location: "#B7791F",
  faction: "#3A6EA5",
  item: "#3C8C5A",
  lore: "#7C5CBF",
  event: "#7C5CBF",
};
const KIND_COLOR_DARK: Record<string, string> = {
  character: "#E5695A",
  location: "#D9A04A",
  faction: "#7AA9DA",
  item: "#5DBA82",
  lore: "#A48BE0",
  event: "#A48BE0",
};
const CATEGORY_COLOR: Record<string, string> = { ally: "#3C8C5A", enemy: "#C8402F", family: "#3A6EA5", neutral: "#9A938A", causal: "#2F7D6B" };
const CATEGORY_COLOR_DARK: Record<string, string> = { ally: "#5DBA82", enemy: "#E5586B", family: "#7AA9DA", neutral: "#9A938A", causal: "#5CB8A6" };

let panel: vscode.WebviewPanel | undefined;
let currentStore: ProjectStore | undefined;

export function openGraph(store: ProjectStore, mode: "net" | "chain" = "net"): void {
  currentStore = store;
  if (!panel) {
    panel = vscode.window.createWebviewPanel("novelpad.graph", "NovelPad · 图谱", vscode.ViewColumn.Beside, {
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
  void pushData(store, mode);
}

/** 项目变化时刷新（若面板打开） */
export function refreshGraph(): void {
  if (panel && currentStore) void pushData(currentStore);
}

async function pushData(store: ProjectStore, mode?: "net" | "chain"): Promise<void> {
  if (!panel) return;
  const { buildGraph, buildStoryChain } = await import("@novelpad/core");
  const p = store.project;
  if (!p) {
    void panel.webview.postMessage({ type: "empty" });
    return;
  }
  const graph = buildGraph(p);
  const chain = buildStoryChain(p);
  void panel.webview.postMessage({ type: "data", mode, graph, chain, title: p.config.title, isDark: isDark() });
}

function isDark(): boolean {
  const k = vscode.window.activeColorTheme.kind;
  return k === vscode.ColorThemeKind.Dark || k === vscode.ColorThemeKind.HighContrast;
}

async function onMessage(store: ProjectStore, msg: { type: string; [k: string]: unknown }): Promise<void> {
  if (msg.type === "ready") {
    await pushData(store);
    return;
  }
  if (msg.type === "open" && typeof msg.file === "string") {
    const root = store.root;
    if (!root) return;
    const uri = vscode.Uri.joinPath(root, ...msg.file.split("/"));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    if (typeof msg.section === "string" && msg.section) {
      for (let i = 0; i < doc.lineCount; i++) {
        if (doc.lineAt(i).text.includes(msg.section)) {
          editor.selection = new vscode.Selection(i, 0, i, 0);
          editor.revealRange(new vscode.Range(i, 0, i + 8, 0), vscode.TextEditorRevealType.InCenter);
          break;
        }
      }
    }
    return;
  }
  if (msg.type === "range" && typeof msg.lo === "number" && typeof msg.hi === "number" && panel) {
    const { buildGraph } = await import("@novelpad/core");
    const p = store.project;
    if (!p) return;
    const graph = buildGraph(p, { chapters: [msg.lo, msg.hi] });
    void panel.webview.postMessage({ type: "graph", graph, isDark: isDark() });
    return;
  }
  if (msg.type === "ask" && typeof msg.name === "string") {
    // 问 Copilot 这个角色
    void vscode.commands.executeCommand("novelpad.copilot.ask");
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
  :root { --bg: var(--vscode-editor-background); --panel: var(--vscode-sideBar-background); --fg: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground); --faint: var(--vscode-disabledForeground); --border: var(--vscode-panel-border); --accent: var(--vscode-textLink-foreground); --input: var(--vscode-input-background); }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); height: 100vh; overflow: hidden; }
  .app { display: grid; grid-template-rows: 40px 1fr; height: 100vh; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--border); background: var(--panel); }
  .bar .title { font-weight: 600; }
  .seg { display: inline-flex; background: var(--input); border: 1px solid var(--border); border-radius: 6px; padding: 2px; margin-left: 8px; }
  .seg button { font: inherit; font-size: 12px; color: var(--muted); padding: 3px 12px; border: 0; background: none; border-radius: 4px; cursor: pointer; }
  .seg button.on { background: var(--vscode-list-activeSelectionBackground); color: var(--accent); }
  .bar .right { margin-left: auto; display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; }
  .bar input[type=range] { accent-color: var(--accent); }
  .stage { position: relative; overflow: hidden; }
  svg { width: 100%; height: 100%; display: block; cursor: grab; }
  svg:active { cursor: grabbing; }
  .grid { position: absolute; inset: 0; background-image: linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px); background-size: 40px 40px; opacity: .25; mask-image: radial-gradient(ellipse at center, #000 30%, transparent 80%); pointer-events: none; }
  .legend { position: absolute; left: 12px; top: 12px; background: var(--input); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 12px; max-width: 320px; }
  .legend label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; color: var(--fg); }
  .legend label.off { opacity: .35; text-decoration: line-through; }
  .legend i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .stats { position: absolute; left: 12px; bottom: 12px; background: var(--input); border: 1px solid var(--border); border-radius: 6px; padding: 4px 12px; font-size: 11.5px; color: var(--muted); }
  .stats b { color: var(--fg); font-weight: 500; }
  .detail { position: absolute; right: 0; top: 0; bottom: 0; width: 300px; background: var(--panel); border-left: 1px solid var(--border); display: none; flex-direction: column; }
  .detail.show { display: flex; }
  .detail .head { padding: 12px 14px 10px; border-bottom: 1px solid var(--border); }
  .detail .kind { font-size: 11px; color: var(--muted); display: flex; justify-content: space-between; }
  .detail h2 { font-size: 19px; margin-top: 2px; font-weight: 600; }
  .detail .aliases { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .detail .body { flex: 1; overflow: auto; padding: 12px 14px; }
  .detail .sec { margin-bottom: 14px; }
  .detail .t { font-size: 11px; color: var(--muted); letter-spacing: .06em; margin-bottom: 6px; display: flex; justify-content: space-between; }
  .detail .kv { display: flex; font-size: 12.5px; line-height: 1.8; }
  .detail .kv .k { width: 4em; color: var(--muted); flex: none; }
  .rel { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 5px 8px; border-radius: 4px; background: var(--input); border: 1px solid var(--border); margin-bottom: 4px; cursor: pointer; }
  .rel:hover { border-color: var(--accent); }
  .rel b { font-weight: 500; }
  .rel .dir { color: var(--muted); flex: 1; }
  .rel .type { font-size: 11px; padding: 0 6px; border-radius: 3px; }
  .rel .lm { font-size: 10px; padding: 0 5px; border-radius: 3px; background: var(--vscode-textCodeBlock-background); color: var(--accent); }
  .detail .foot { padding: 10px 14px; border-top: 1px solid var(--border); display: flex; gap: 6px; }
  .btn { font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--input); color: var(--fg); cursor: pointer; }
  .btn.pri { background: var(--accent); color: var(--vscode-button-foreground); border-color: transparent; flex: 1; }
  .btn:hover { border-color: var(--accent); }
  .empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); }
  /* SVG */
  .edge { stroke: var(--muted); stroke-opacity: .3; stroke-width: 1.2; fill: none; transition: stroke .12s; }
  .edge.causal { stroke-dasharray: 5 4; }
  .edge.foreshadow { stroke: #B7791F; stroke-opacity: .6; stroke-dasharray: 3 4; }
  .edge.hl { stroke: var(--accent); stroke-opacity: 1; stroke-width: 2; }
  .edge.dim { stroke-opacity: .05; }
  .elabel { font-size: 10px; fill: var(--muted); paint-order: stroke; stroke: var(--bg); stroke-width: 3px; pointer-events: none; }
  .node { cursor: pointer; }
  .node circle { stroke-width: 2; transition: filter .12s; }
  .node text { font-size: 12px; fill: var(--fg); text-anchor: middle; paint-order: stroke; stroke: var(--bg); stroke-width: 3px; pointer-events: none; }
  .node .role { font-size: 10px; fill: var(--faint); }
  .node:hover circle { filter: brightness(1.15); }
  .node .ring { fill: none; stroke: var(--accent); stroke-width: 1.5; opacity: 0; }
  .node.sel .ring { opacity: 1; }
  .node.sel text { font-weight: 600; }
  .node.dim { opacity: .15; }
  /* chain */
  .tl-lane { stroke: var(--border); stroke-dasharray: 2 6; }
  .tl-axis { stroke: var(--border); }
  .tl-label { font-size: 12px; fill: var(--muted); }
  .tl-ch { font-size: 10.5px; fill: var(--faint); text-anchor: middle; }
  .tl-link { stroke: var(--muted); stroke-opacity: .4; fill: none; stroke-width: 1.3; }
  .tl-link.causal { stroke: var(--accent); stroke-opacity: .7; stroke-dasharray: 4 4; }
  .tl-node rect { fill: var(--input); stroke: var(--border); rx: 6; }
  .tl-node:hover rect { stroke: var(--accent); stroke-width: 2; }
  .tl-node text { font-family: var(--vscode-font-family); }
  .tl-node .name { font-size: 12px; fill: var(--fg); }
  .tl-node .meta { font-size: 10px; fill: var(--muted); }
  .tl-node.open rect { stroke: #B7791F; stroke-dasharray: 4 3; }
  .tl-node.open .name { fill: #B7791F; }
</style></head><body>
<div class="app">
  <div class="bar">
    <span class="title" id="title">图谱</span>
    <div class="seg"><button id="m-net" class="on">关系云图</button><button id="m-chain">剧情发展链</button></div>
    <div class="right" id="rangeWrap">
      <span>第 <span id="lo">1</span> – <span id="hi">1</span> 章</span>
      <input type="range" id="range" min="1" max="1" value="1" style="width:140px">
      <span id="stat"></span>
    </div>
  </div>
  <div class="stage" id="stage">
    <div class="grid"></div>
    <div class="legend" id="legend"></div>
    <div class="stats" id="stats"></div>
    <svg id="svg"></svg>
    <div class="detail" id="detail"></div>
    <div class="empty" id="empty">还没有可绘制的关系。在角色卡里添加 relations，或在章节 frontmatter 里填 characters / locations。</div>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const KIND = ${JSON.stringify(KIND_COLOR)}, KIND_D = ${JSON.stringify(KIND_COLOR_DARK)};
const CAT = ${JSON.stringify(CATEGORY_COLOR)}, CAT_D = ${JSON.stringify(CATEGORY_COLOR_DARK)};
const KIND_LABEL = { character: "角色", location: "地点", faction: "势力", item: "物品", lore: "世界观", event: "伏笔事件" };
let G = null, C = null, mode = "net", dark = false, hidden = new Set(), sel = null, view = { x: 0, y: 0, k: 1 };
const svg = document.getElementById("svg"), stage = document.getElementById("stage");
const $ = (id) => document.getElementById(id);

window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.type === "empty") { $("empty").style.display = "grid"; return; }
  if (m.type === "data") { G = m.graph; C = m.chain; dark = m.isDark; $("title").textContent = "图谱 · " + m.title; $("empty").style.display = "none"; if (m.mode) mode = m.mode; setupRange(); render(); }
  if (m.type === "graph") { G = m.graph; dark = m.isDark; render(); }
});
$("m-net").onclick = () => { mode = "net"; render(); };
$("m-chain").onclick = () => { mode = "chain"; render(); };
$("range").oninput = (e) => {
  const hi = +e.target.value; $("hi").textContent = hi;
  vscode.postMessage({ type: "range", lo: G.minOrder, hi });
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape") select(null); });

function setupRange() {
  $("range").min = G.minOrder; $("range").max = G.maxOrder; $("range").value = G.maxOrder;
  $("lo").textContent = G.minOrder; $("hi").textContent = G.maxOrder;
}
function render() {
  $("m-net").classList.toggle("on", mode === "net"); $("m-chain").classList.toggle("on", mode === "chain");
  $("rangeWrap").style.visibility = mode === "net" ? "visible" : "hidden";
  $("legend").style.display = mode === "net" ? "flex" : "none";
  select(null);
  if (mode === "net") renderNet(); else renderChain();
}
function color(kind) { return (dark ? KIND_D : KIND)[kind] || "#888"; }

/* ---------- 关系云图：力导向 ---------- */
let sim = null, pos = new Map();
function renderNet() {
  const nodes = G.nodes.filter(n => !hidden.has(n.kind));
  const ids = new Set(nodes.map(n => n.id));
  const edges = G.edges.filter(e => ids.has(e.source) && ids.has(e.target));
  $("stat").textContent = nodes.length + " 节点 · " + edges.length + " 关系";
  renderLegend();
  if (!nodes.length) { svg.innerHTML = ""; return; }
  // 初始化：按类型环形分布，复用上次位置
  const W = stage.clientWidth, H = stage.clientHeight;
  const byKind = {}; nodes.forEach(n => (byKind[n.kind] = byKind[n.kind] || []).push(n));
  let k = 0; const kinds = Object.keys(byKind);
  for (const kind of kinds) { const arr = byKind[kind]; arr.forEach((n, i) => { if (!pos.has(n.id)) { const a = (i / arr.length) * Math.PI * 2 + k; const r = 120 + k * 70; pos.set(n.id, { x: W/2 + Math.cos(a) * r, y: H/2 + Math.sin(a) * r, vx: 0, vy: 0 }); } }); k++; }
  const degree = new Map(); edges.forEach(e => { degree.set(e.source, (degree.get(e.source) || 0) + 1); degree.set(e.target, (degree.get(e.target) || 0) + 1); });
  const radius = (n) => 10 + Math.min(16, (degree.get(n.id) || 0) * 2.2) + (n.chapters.length ? Math.min(6, n.chapters.length) : 0);

  // 力导向迭代（同步跑 300 步，节点数小）
  const N = nodes.length;
  for (let step = 0; step < 300; step++) {
    const alpha = 1 - step / 300;
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const a = pos.get(nodes[i].id), b = pos.get(nodes[j].id);
      let dx = a.x - b.x, dy = a.y - b.y, d2 = dx*dx + dy*dy || 1; const d = Math.sqrt(d2);
      const rep = 2400 / d2; dx /= d; dy /= d;
      const f = rep * alpha; a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const e of edges) {
      const a = pos.get(e.source), b = pos.get(e.target);
      let dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx*dx + dy*dy) || 1;
      const want = 110 - (e.weight || 1) * 6; const f = (d - want) * 0.01 * alpha; dx /= d; dy /= d;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of nodes) { const p = pos.get(n.id); p.vx += (W/2 - p.x) * 0.001 * alpha; p.vy += (H/2 - p.y) * 0.001 * alpha; p.vx *= 0.6; p.vy *= 0.6; p.x += p.vx; p.y += p.vy; }
  }
  // 自适应缩放
  const xs = nodes.map(n => pos.get(n.id).x), ys = nodes.map(n => pos.get(n.id).y);
  const minX = Math.min(...xs) - 60, maxX = Math.max(...xs) + 60, minY = Math.min(...ys) - 60, maxY = Math.max(...ys) + 60;
  const k0 = Math.min(W / (maxX - minX), H / (maxY - minY), 1.5);
  view = { k: k0, x: -minX * k0 + (W - (maxX - minX) * k0) / 2, y: -minY * k0 + (H - (maxY - minY) * k0) / 2 };

  drawNet(nodes, edges, radius);
  // 拖拽 / 缩放
  bindPanZoom(() => drawNet(nodes, edges, radius));
  bindDrag(nodes, () => drawNet(nodes, edges, radius));
}

function drawNet(nodes, edges, radius) {
  const parts = [];
  const P = (id) => pos.get(id);
  const T = (x, y) => [x * view.k + view.x, y * view.k + view.y];
  for (const e of edges) {
    const a = P(e.source), b = P(e.target); if (!a || !b) continue;
    const [ax, ay] = T(a.x, a.y), [bx, by] = T(b.x, b.y);
    const mx = (ax + bx) / 2 + 14, my = (ay + by) / 2 - 10;
    const cat = e.kind === "relation" && e.category ? (dark ? CAT_D : CAT)[e.category] : null;
    const cls = "edge" + (e.kind === "causal" ? " causal" : e.kind === "foreshadow" ? " foreshadow" : "") + (sel && (e.source === sel || e.target === sel) ? " hl" : "") + (sel && e.source !== sel && e.target !== sel ? " dim" : "");
    const w = e.kind === "relation" || e.kind === "present" ? 1 + Math.min(3, (e.weight || 1) * 0.5) : 1.2;
    parts.push('<path class="' + cls + '" d="M' + ax + ' ' + ay + ' Q ' + mx + ' ' + my + ' ' + bx + ' ' + by + '" stroke-width="' + w + '"' + (cat ? ' stroke="' + cat + '"' : '') + '/>');
    if (e.label && (e.kind === "relation" || e.kind === "holds") && view.k > 0.6) parts.push('<text class="elabel" x="' + mx + '" y="' + my + '">' + esc(e.label.length > 10 ? e.label.slice(0, 10) + "…" : e.label) + '</text>');
  }
  for (const n of nodes) {
    const p = P(n.id); const [x, y] = T(p.x, p.y); const r = radius(n) * view.k;
    const c = color(n.kind);
    const fill = n.kind === "event" ? "none" : c + "26";
    const dim = sel && sel !== n.id && !edges.some(e => (e.source === sel && e.target === n.id) || (e.target === sel && e.source === n.id));
    parts.push('<g class="node' + (sel === n.id ? " sel" : "") + (dim ? " dim" : "") + '" data-id="' + esc(n.id) + '"><circle class="ring" cx="' + x + '" cy="' + y + '" r="' + (r + 5) + '"/><circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + (n.kind === "event" ? (dark ? "#2A2418" : "#FBF3E0") : fill) + '" stroke="' + c + '"/>' +
      (n.kind === "event" ? '<text x="' + x + '" y="' + (y + 3) + '" style="font-size:' + (9 * view.k) + 'px;fill:' + c + '">⚑</text>' : '') +
      '<text x="' + x + '" y="' + (y + r + 13 * view.k) + '" style="font-size:' + (12 * Math.max(0.8, view.k)) + 'px">' + esc(n.label) + '</text></g>');
  }
  svg.innerHTML = parts.join("");
  svg.querySelectorAll(".node").forEach(el => el.addEventListener("click", () => select(el.dataset.id)));
}

function renderLegend() {
  const kinds = ["character", "location", "faction", "item", "event"].filter(k => G.nodes.some(n => n.kind === k));
  $("legend").innerHTML = kinds.map(k => '<label class="' + (hidden.has(k) ? "off" : "") + '" data-k="' + k + '"><input type="checkbox" style="display:none"><i style="background:' + color(k) + '"></i>' + KIND_LABEL[k] + '</label>').join("");
  $("legend").querySelectorAll("label").forEach(l => l.onclick = () => { const k = l.dataset.k; hidden.has(k) ? hidden.delete(k) : hidden.add(k); renderNet(); });
}

function select(id) {
  sel = id;
  const d = $("detail");
  if (!id) { d.classList.remove("show"); if (mode === "net") { svg.querySelectorAll(".node").forEach(g => g.classList.toggle("sel", false)); } return; }
  const n = G.nodes.find(x => x.id === id); if (!n) return;
  const e = n.entity;
  const rels = G.edges.filter(x => x.source === id || x.target === id);
  let html = '<div class="head"><div class="kind"><span style="color:' + color(n.kind) + '">● ' + (KIND_LABEL[n.kind] || n.kind) + '</span><span>' + (n.chapters.length ? "出场 " + n.chapters.length + " 章" : n.event ? "第 " + n.event.chapter + " 章" : "") + '</span></div><h2>' + esc(n.label) + '</h2>' + (e?.aliases?.length ? '<div class="aliases">别称 · ' + esc(e.aliases.join(" · ")) + '</div>' : "") + '</div><div class="body">';
  if (e?.summary || e?.attrs) {
    html += '<div class="sec"><div class="t"><span>属性</span></div>';
    if (e.summary) html += '<div style="font-size:12.5px;line-height:1.7;margin-bottom:6px">' + esc(e.summary) + '</div>';
    if (e.attrs) for (const [k, v] of Object.entries(e.attrs).slice(0, 8)) html += '<div class="kv"><span class="k">' + esc(k) + '</span><span>' + esc(String(v)) + '</span></div>';
    if (e.state) html += '<div class="kv" style="margin-top:4px"><span class="k">状态</span><span>' + esc([e.state.emotion, e.state.location, e.state.knows?.length ? "知晓 " + e.state.knows.join("、") : ""].filter(Boolean).join(" · ")) + '</span></div>';
    html += '</div>';
  }
  if (n.event) html += '<div class="sec"><div class="t"><span>伏笔</span><span>第 ' + n.event.chapter + ' 章</span></div><div style="font-size:12.5px;line-height:1.7">' + esc(n.event.text || n.event.title) + '</div></div>';
  if (rels.length) {
    html += '<div class="sec"><div class="t"><span>关系</span><span>' + rels.length + ' 条</span></div>';
    for (const r of rels.slice(0, 12)) {
      const other = G.nodes.find(x => x.id === (r.source === id ? r.target : r.source));
      const inward = r.target === id;
      const cat = r.category ? (dark ? CAT_D : CAT)[r.category] : null;
      html += '<div class="rel" data-id="' + esc(other?.id) + '"><b>' + esc(other?.label ?? "?") + '</b><span class="dir">' + (inward ? "← " : "→ ") + esc(r.label || r.kind) + '</span>' + (r.category ? '<span class="type" style="color:' + cat + ';background:' + cat + '22">' + esc(r.category) + '</span>' : "") + (r.unconfirmed ? '<span class="lm">AI</span>' : "") + '</div>';
    }
    html += '</div>';
  }
  if (n.chapters.length) html += '<div class="sec"><div class="t"><span>出场章节</span></div><div style="font-size:12px;color:var(--muted)">' + n.chapters.map(c => "第" + c + "章").join(" · ") + '</div></div>';
  html += '</div><div class="foot"><button class="btn pri" data-open="' + esc(n.file || "") + '">在正文中定位</button><button class="btn" data-ask="' + esc(n.label) + '">问 Copilot</button></div>';
  d.innerHTML = html; d.classList.add("show");
  d.querySelector("[data-open]").onclick = () => n.file && vscode.postMessage({ type: "open", file: n.file, section: e?.kind === "lore" ? n.label : undefined });
  d.querySelector("[data-ask]").onclick = () => vscode.postMessage({ type: "ask", name: n.label });
  d.querySelectorAll(".rel").forEach(el => el.onclick = () => select(el.dataset.id));
  svg.querySelectorAll(".node").forEach(g => g.classList.toggle("sel", g.dataset.id === id));
  // 高亮邻居
  drawNet(G.nodes.filter(x => !hidden.has(x.kind)), G.edges.filter(x => !hidden.has(G.nodes.find(n => n.id === x.source)?.kind) && !hidden.has(G.nodes.find(n => n.id === x.target)?.kind)), (x) => 10 + Math.min(16, (G.edges.filter(e => e.source === x.id || e.target === x.id).length) * 2.2) + (x.chapters.length ? Math.min(6, x.chapters.length) : 0));
}

/* ---------- 剧情发展链：泳道时间线 ---------- */
function renderChain() {
  if (!C || !C.nodes.length) { svg.innerHTML = ""; $("stat").textContent = ""; return; }
  $("stat").textContent = C.nodes.length + " 事件 · " + C.lanes.length + " 泳道";
  const W = Math.max(stage.clientWidth, 900), laneH = 86, top = 50, left = 70;
  const H = top + C.lanes.length * laneH + 40;
  const chs = C.chapters; const xOf = (o) => left + ((o - chs[0] + 0.5) / Math.max(1, chs.length)) * (W - left - 30);
  const laneOf = (chars) => { for (const c of chars) { const i = C.lanes.indexOf(c); if (i >= 0) return i; } return C.lanes.length - 1; };
  // 同章同泳道多个事件纵向堆叠
  const slot = new Map(); const posC = new Map();
  for (const n of C.nodes) {
    const li = laneOf(n.characters); const key = li + ":" + n.chapter; const s = slot.get(key) || 0; slot.set(key, s + 1);
    posC.set(n.id, { x: xOf(n.chapter), y: top + li * laneH + 28 + s * 34, li });
  }
  const parts = [];
  parts.push('<line class="tl-axis" x1="' + left + '" y1="' + (top - 18) + '" x2="' + (W - 30) + '" y2="' + (top - 18) + '"/>');
  for (const o of chs) parts.push('<text class="tl-ch" x="' + xOf(o) + '" y="' + (top - 26) + '">第' + o + '章</text>');
  C.lanes.forEach((l, i) => { parts.push('<text class="tl-label" x="14" y="' + (top + i * laneH + 32) + '">' + esc(l) + '</text><line class="tl-lane" x1="' + left + '" y1="' + (top + i * laneH + 42) + '" x2="' + (W - 30) + '" y2="' + (top + i * laneH + 42) + '"/>'); });
  for (const l of C.links) {
    const a = posC.get(l.source), b = posC.get(l.target); if (!a || !b) continue;
    parts.push('<path class="tl-link' + (l.kind === "causal" ? " causal" : "") + '" d="M' + a.x + ' ' + (a.y - 14) + ' C ' + a.x + ' ' + (a.y - 30) + ', ' + b.x + ' ' + (b.y - 30) + ', ' + b.x + ' ' + (b.y - 14) + '"/>');
  }
  for (const n of C.nodes) {
    const p = posC.get(n.id); const c = color(n.kind === "scene" ? "character" : "event");
    const w = 104, h = 26;
    parts.push('<g class="tl-node' + (n.kind === "foreshadow-open" ? " open" : "") + '" data-file="' + esc(n.file || "") + '" data-sec="' + esc(n.title) + '"><rect x="' + (p.x - w/2) + '" y="' + (p.y - h/2) + '" width="' + w + '" height="' + h + '" rx="6" stroke="' + c + '"/><text class="name" x="' + p.x + '" y="' + (p.y - 1) + '" text-anchor="middle">' + esc(n.title.length > 9 ? n.title.slice(0, 9) + "…" : n.title) + '</text><text class="meta" x="' + p.x + '" y="' + (p.y + 10) + '" text-anchor="middle">第' + n.chapter + '章</text></g>');
  }
  svg.innerHTML = parts.join("");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H); svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.querySelectorAll(".tl-node").forEach(el => el.addEventListener("click", () => vscode.postMessage({ type: "open", file: el.dataset.file, section: el.dataset.sec })));
}

/* ---------- 平移缩放 / 拖拽 ---------- */
function bindPanZoom(redraw) {
  svg.onmousedown = (e) => { if (e.target.closest(".node")) return; const s = { x: e.clientX - view.x, y: e.clientY - view.y }; const mv = (ev) => { view.x = ev.clientX - s.x; view.y = ev.clientY - s.y; redraw(); }; const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); }; window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up); };
  svg.onwheel = (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const f = e.deltaY < 0 ? 1.12 : 1 / 1.12; view.x = mx - (mx - view.x) * f; view.y = my - (my - view.y) * f; view.k = Math.max(0.2, Math.min(4, view.k * f)); redraw(); };
}
function bindDrag(nodes, redraw) {
  svg.querySelectorAll(".node").forEach(el => {
    el.addEventListener("mousedown", (e) => {
      e.stopPropagation(); const n = nodes.find(x => x.id === el.dataset.id); if (!n) return;
      const r = svg.getBoundingClientRect(); const p = pos.get(n.id);
      const off = { x: (e.clientX - r.left - view.x) / view.k - p.x, y: (e.clientY - r.top - view.y) / view.k - p.y };
      const mv = (ev) => { p.x = (ev.clientX - r.left - view.x) / view.k - off.x; p.y = (ev.clientY - r.top - view.y) / view.k - off.y; redraw(); };
      const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    });
  });
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
vscode.postMessage({ type: "ready" });
</script></body></html>`;
}
