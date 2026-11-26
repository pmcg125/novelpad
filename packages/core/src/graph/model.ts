/**
 * 知识图谱：从 Project 构建节点 / 边，供云图与剧情链可视化。
 * 纯计算，不落盘——保存即刷新。
 */
import type { Chapter, Entity, Project } from "../types.js";
import { collectForeshadows } from "../rules/foreshadow.js";

export type GraphNodeKind = "character" | "location" | "faction" | "item" | "lore" | "event";

export interface GraphNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  /** 来源文件（点击跳转） */
  file?: string;
  /** 实体类型才有 */
  entity?: Entity;
  /** 出场章节 order 列表 */
  chapters: number[];
  /** 事件节点才有 */
  event?: { chapter: number; title: string; type: "scene" | "foreshadow-open" | "foreshadow-close"; text?: string };
}

export type EdgeKind = "relation" | "present" | "located" | "holds" | "causal" | "foreshadow";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** 关系类型文字 */
  label?: string;
  /** 关系分类（着色） */
  category?: "ally" | "enemy" | "family" | "neutral" | "causal";
  /** 来源：设定卡声明 / 正文推断 / 伏笔 */
  sourceKind: "card" | "ai" | "text" | "foreshadow";
  /** 首次出现章节 */
  chapter?: number;
  /** 互动次数（粗细） */
  weight?: number;
  /** AI 抽取未确认 */
  unconfirmed?: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 章节范围 */
  minOrder: number;
  maxOrder: number;
}

const ENTITY_KINDS: Entity["kind"][] = ["character", "location", "faction", "item"];

/** 构建完整图谱 */
export function buildGraph(project: Project, opts: { chapters?: [number, number]; includeEvents?: boolean } = {}): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const [lo, hi] = opts.chapters ?? [-Infinity, Infinity];
  const chapters = project.chapters.filter((c) => c.frontmatter.order >= lo && c.frontmatter.order <= hi);

  const nameToEntity = new Map<string, Entity>();
  for (const e of project.entities) {
    nameToEntity.set(e.name, e);
    for (const a of e.aliases ?? []) nameToEntity.set(a, e);
  }

  // ---- 实体节点 ----
  for (const e of project.entities) {
    if (!ENTITY_KINDS.includes(e.kind)) continue;
    const present = chapters.filter((c) => mentions(c, e, nameToEntity)).map((c) => c.frontmatter.order);
    nodes.set(e.id, { id: e.id, label: e.name, kind: e.kind as GraphNodeKind, file: e.relativePath, entity: e, chapters: present });
  }

  // ---- 显式关系边（设定卡） ----
  for (const e of project.entities) {
    for (const r of e.relations ?? []) {
      const t = nameToEntity.get(r.target);
      if (!t || !nodes.has(e.id) || !nodes.has(t.id)) continue;
      // 关系两端至少一端在范围内出场
      const a = nodes.get(e.id)!.chapters;
      const b = nodes.get(t.id)!.chapters;
      if (!a.length && !b.length) continue;
      const key = `rel:${[e.id, t.id].sort().join("-")}`;
      const existing = edges.get(key);
      const edge: GraphEdge = existing ?? {
        id: key,
        source: e.id,
        target: t.id,
        kind: "relation",
        label: r.type,
        category: r.category,
        sourceKind: r.source === "ai" ? "ai" : "card",
        chapter: a[0] ?? b[0],
        weight: 1,
        unconfirmed: r.source === "ai" && !r.confirmed,
      };
      if (existing) {
        existing.weight = (existing.weight ?? 1) + 1;
        existing.label = `${existing.label} / ${r.type}`;
      }
      edges.set(key, edge);
    }
  }

  // ---- 物品持有 ----
  for (const e of project.entities) {
    if (e.kind !== "item" || !e.holder) continue;
    const h = nameToEntity.get(e.holder);
    if (!h || !nodes.has(h.id) || !nodes.has(e.id)) continue;
    edges.set(`hold:${e.id}`, { id: `hold:${e.id}`, source: h.id, target: e.id, kind: "holds", label: "持有", sourceKind: "card", weight: 1 });
  }

  // ---- 正文推断：出场（角色↔地点 / 角色↔角色） ----
  const cooccur = new Map<string, number>();
  for (const c of chapters) {
    const chars = (c.frontmatter.characters ?? []).map((n) => nameToEntity.get(n)).filter((x): x is Entity => !!x && x.kind === "character" && nodes.has(x.id));
    const locs = (c.frontmatter.locations ?? []).map((n) => nameToEntity.get(n)).filter((x): x is Entity => !!x && x.kind === "location" && nodes.has(x.id));
    for (const ch of chars) for (const l of locs) {
      const key = `loc:${ch.id}-${l.id}`;
      const ex = edges.get(key);
      if (ex) { ex.weight = (ex.weight ?? 1) + 1; ex.chapter = Math.min(ex.chapter ?? 9999, c.frontmatter.order); }
      else edges.set(key, { id: key, source: ch.id, target: l.id, kind: "located", label: "在场", sourceKind: "text", chapter: c.frontmatter.order, weight: 1 });
    }
    for (let i = 0; i < chars.length; i++) for (let j = i + 1; j < chars.length; j++) {
      const a = chars[i]!, b = chars[j]!;
      const k = [a.id, b.id].sort().join("-");
      cooccur.set(k, (cooccur.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of cooccur) {
    const [a, b] = k.split("-");
    if (edges.has(`rel:${k}`)) continue; // 已有显式关系
    edges.set(`co:${k}`, { id: `co:${k}`, source: a!, target: b!, kind: "present", label: `同场 ${n}`, sourceKind: "text", weight: n });
  }

  // ---- 事件节点 + 伏笔边 ----
  if (opts.includeEvents !== false) {
    const all = collectForeshadows(project.chapters);
    const openNodes: GraphNode[] = [];
    for (const c of chapters) {
      const order = c.frontmatter.order;
      for (const f of c.frontmatter.foreshadows ?? []) {
        const id = `ev:open:${f.id}`;
        nodes.set(id, { id, label: `伏笔 ${f.id}`, kind: "event", file: c.relativePath, chapters: [order], event: { chapter: order, title: `埋下 ${f.id}`, type: "foreshadow-open", text: f.note } });
        openNodes.push(nodes.get(id)!);
        // 伏笔 → 本章出场角色（谁埋的 / 谁牵涉）
        for (const name of c.frontmatter.characters ?? []) {
          const e = nameToEntity.get(name);
          if (e && nodes.has(e.id)) edges.set(`fs:${f.id}->${e.id}`, { id: `fs:${f.id}->${e.id}`, source: id, target: e.id, kind: "foreshadow", label: "牵涉", sourceKind: "foreshadow", chapter: order, weight: 1 });
        }
        const r = all.get(f.id)?.resolvedIn;
        if (r && r.frontmatter.order >= lo && r.frontmatter.order <= hi) {
          const rid = `ev:close:${f.id}`;
          nodes.set(rid, { id: rid, label: `回收 ${f.id}`, kind: "event", file: r.relativePath, chapters: [r.frontmatter.order], event: { chapter: r.frontmatter.order, title: `回收 ${f.id}`, type: "foreshadow-close" } });
          edges.set(`causal:${f.id}`, { id: `causal:${f.id}`, source: id, target: rid, kind: "causal", label: f.due ? `due ${f.due}` : "因果", sourceKind: "foreshadow", chapter: r.frontmatter.order, weight: 2 });
        }
      }
    }
    void openNodes;
  }

  // 清理孤立节点（无任何边且未出场的实体）
  const connected = new Set<string>();
  for (const e of edges.values()) { connected.add(e.source); connected.add(e.target); }
  const finalNodes = [...nodes.values()].filter((n) => connected.has(n.id) || n.chapters.length > 0 || n.kind === "event");

  const orders = chapters.map((c) => c.frontmatter.order);
  return { nodes: finalNodes, edges: [...edges.values()], minOrder: orders.length ? Math.min(...orders) : 0, maxOrder: orders.length ? Math.max(...orders) : 0 };
}

function mentions(c: Chapter, e: Entity, idx: Map<string, Entity>): boolean {
  if ((c.frontmatter.characters ?? []).includes(e.name) || (c.frontmatter.locations ?? []).includes(e.name)) return true;
  for (const [name, ent] of idx) {
    if (ent.id === e.id && c.content.includes(name)) return true;
  }
  return false;
}

/* ============================================================
 * 剧情发展链：按章节时间轴排列的事件（场景 + 伏笔开合）
 * ============================================================ */

export interface ChainNode {
  id: string;
  chapter: number;
  title: string;
  kind: "scene" | "foreshadow-open" | "foreshadow-close";
  /** 涉及角色（决定泳道） */
  characters: string[];
  text?: string;
  file?: string;
}

export interface ChainLink {
  source: string;
  target: string;
  kind: "sequence" | "causal" | "foreshadow";
}

export interface StoryChain {
  nodes: ChainNode[];
  links: ChainLink[];
  /** 泳道：主要角色（按出场次数） */
  lanes: string[];
  chapters: number[];
}

export function buildStoryChain(project: Project, opts: { lanes?: number } = {}): StoryChain {
  const nodes: ChainNode[] = [];
  const links: ChainLink[] = [];
  const all = collectForeshadows(project.chapters);
  const chapterCount = new Map<string, number>();
  for (const c of project.chapters) for (const n of c.frontmatter.characters ?? []) chapterCount.set(n, (chapterCount.get(n) ?? 0) + 1);
  const lanes = [...chapterCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.lanes ?? 4).map(([n]) => n);

  const sceneIds: string[] = [];
  for (const c of project.chapters) {
    const order = c.frontmatter.order;
    const chars = (c.frontmatter.characters ?? []).filter((n) => lanes.includes(n));
    const id = `s:${order}`;
    nodes.push({ id, chapter: order, title: c.frontmatter.title, kind: "scene", characters: chars.length ? chars : [c.frontmatter.pov ?? lanes[0] ?? ""], file: c.relativePath });
    sceneIds.push(id);
    for (const f of c.frontmatter.foreshadows ?? []) {
      const fid = `o:${f.id}`;
      nodes.push({ id: fid, chapter: order, title: `埋 ${f.id}`, kind: "foreshadow-open", characters: chars.length ? chars : [c.frontmatter.pov ?? ""], text: f.note, file: c.relativePath });
      links.push({ source: id, target: fid, kind: "sequence" });
    }
    for (const r of c.frontmatter.resolves ?? []) {
      const f = all.get(r);
      if (!f) continue;
      const cid = `c:${r}`;
      nodes.push({ id: cid, chapter: order, title: `收 ${r}`, kind: "foreshadow-close", characters: chars.length ? chars : [c.frontmatter.pov ?? ""], file: c.relativePath });
      links.push({ source: `o:${r}`, target: cid, kind: "causal" });
    }
  }
  for (let i = 1; i < sceneIds.length; i++) links.push({ source: sceneIds[i - 1]!, target: sceneIds[i]!, kind: "sequence" });

  return { nodes, links, lanes, chapters: project.chapters.map((c) => c.frontmatter.order) };
}
