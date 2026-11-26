/**
 * 上下文组装：光标位置 → AI 应该知道的信息。
 * 纯函数，零 vscode 依赖。
 */
import type { Chapter, Entity, Project } from "../types.js";
import { collectForeshadows } from "../rules/foreshadow.js";

export interface ContextOptions {
  /** 当前章节 */
  chapter: Chapter;
  /** 光标前已写的正文（去掉 frontmatter），默认整章 */
  textBeforeCursor?: string;
  /** 前文回忆：当前章光标前保留的最大字符数 */
  maxRecentChars?: number;
  /** 上一章末尾保留的最大字符数 */
  maxPrevChapterTail?: number;
  /** 文风样本：最近 N 章的开头 */
  styleSampleChapters?: number;
  /** 每章文风样本字符数 */
  styleSampleChars?: number;
  /** 最多注入多少个角色卡 */
  maxCharacters?: number;
}

export interface AssembledContext {
  /** 本书标题 */
  title: string;
  /** 当前章节信息 */
  chapter: { title: string; order: number; volume?: string; pov?: string };
  /** 出场角色卡（含关系、状态） */
  characters: CharacterContext[];
  /** 出场地点摘要 */
  locations: string[];
  /** 相关伏笔：本章声明的 + 即将到期的 */
  foreshadows: { id: string; note?: string; due?: number; declaredIn: number; status: "open" | "due-soon" | "overdue" }[];
  /** 上一章末尾 */
  prevChapterTail: string;
  /** 当前章光标前的最近内容 */
  recentText: string;
  /** 文风样本 */
  styleSamples: string[];
  /** 禁止事项（由角色状态推出） */
  constraints: string[];
  /** 估算 token（中文 ≈ 1 字 1 token） */
  estimatedTokens: number;
}

export interface CharacterContext {
  name: string;
  role?: string;
  summary?: string;
  attrs?: Record<string, string | number | boolean>;
  state?: { emotion?: string; location?: string; knows?: string[] };
  /** 与本章其他出场角色的关系 */
  relationsWithPresent: { target: string; type: string }[];
  /** 别名 */
  aliases?: string[];
}

const DEFAULTS = {
  maxRecentChars: 1500,
  maxPrevChapterTail: 500,
  styleSampleChapters: 2,
  styleSampleChars: 300,
  maxCharacters: 6,
};

/**
 * 从正文里识别出现的实体名（名称 + 别称），返回去重后的实体。
 * 长名优先匹配，避免「林」匹配到「林晚」前缀。
 */
export function detectEntities(text: string, index: Map<string, Entity>, limit?: number): Entity[] {
  const found: Entity[] = [];
  const seen = new Set<string>();
  const names = [...index.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (!text.includes(name)) continue;
    const e = index.get(name)!;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    found.push(e);
    if (limit && found.length >= limit) break;
  }
  return found;
}

/** 组装上下文 */
export function assembleContext(project: Project, opts: ContextOptions): AssembledContext {
  const o = { ...DEFAULTS, ...opts };
  const { chapter } = opts;
  const fm = chapter.frontmatter;
  const chapters = project.chapters;
  const idx = new Map<string, Entity>();
  for (const e of project.entities) {
    idx.set(e.name, e);
    for (const a of e.aliases ?? []) idx.set(a, e);
  }

  const textBefore = opts.textBeforeCursor ?? chapter.content;
  const recentText = takeTail(stripAuthorNotes(textBefore), o.maxRecentChars);

  // ---- 角色：frontmatter 声明 ∪ 正文检测 ----
  const declared = new Set(fm.characters ?? []);
  const detected = detectEntities(textBefore, idx);
  const present = new Map<string, Entity>();
  for (const e of detected) if (e.kind === "character") present.set(e.id, e);
  for (const name of declared) {
    const e = idx.get(name);
    if (e?.kind === "character") present.set(e.id, e);
  }
  const presentIds = new Set(present.keys());
  const characters: CharacterContext[] = [...present.values()].slice(0, o.maxCharacters).map((e) => ({
    name: e.name,
    role: e.kind === "character" ? e.role : undefined,
    summary: e.summary,
    attrs: e.attrs,
    state: e.kind === "character" ? e.state : undefined,
    aliases: e.aliases,
    relationsWithPresent: (e.relations ?? [])
      .filter((r) => {
        const t = idx.get(r.target);
        return t ? presentIds.has(t.id) : [...present.values()].some((p) => p.name === r.target);
      })
      .map((r) => ({ target: r.target, type: r.type })),
  }));

  // ---- 地点 ----
  const locations = (fm.locations ?? []).filter(Boolean);

  // ---- 伏笔：本章声明 + 全书未回收（标注状态） ----
  // 「回收」只认当前章之前发生的；当前章及之后的 resolves 不算（写第 1 章时第 3 章还没写）
  const all = collectForeshadows(chapters);
  const foreshadows: AssembledContext["foreshadows"] = [];
  for (const [id, f] of all) {
    if (f.declaredIn.frontmatter.order > fm.order) continue;
    const resolvedBefore = f.resolvedIn && f.resolvedIn.frontmatter.order <= fm.order;
    if (resolvedBefore) continue;
    const declaredHere = f.declaredIn.frontmatter.order === fm.order;
    const due = f.due;
    const status: AssembledContext["foreshadows"][number]["status"] =
      due === undefined ? "open" : fm.order > due ? "overdue" : due - fm.order <= 2 ? "due-soon" : "open";
    if (!declaredHere && status === "open") continue;
    const note = f.declaredIn.frontmatter.foreshadows?.find((x) => x.id === id)?.note;
    foreshadows.push({ id, note, due, declaredIn: f.declaredIn.frontmatter.order, status });
  }

  // ---- 上一章末尾 ----
  const prevIdx = chapters.findIndex((c) => c.frontmatter.order === fm.order);
  const prev = prevIdx > 0 ? chapters[prevIdx - 1] : undefined;
  const prevChapterTail = prev ? takeTail(stripAuthorNotes(prev.content), o.maxPrevChapterTail) : "";

  // ---- 文风样本：当前章之前的 N 章开头 ----
  const styleSamples: string[] = [];
  const start = Math.max(0, prevIdx - o.styleSampleChapters);
  for (let i = start; i < prevIdx; i++) {
    const c = chapters[i];
    if (c) styleSamples.push(takeHead(stripAuthorNotes(c.content), o.styleSampleChars));
  }

  // ---- 约束 ----
  const constraints: string[] = [];
  for (const c of characters) {
    if (c.state?.location && locations.length && !locations.includes(c.state.location) && !c.state.location.includes(locations[0]!)) {
      constraints.push(`${c.name}按角色卡此刻应在「${c.state.location}」，如需移动需交代`);
    }
  }
  const pov = fm.pov;
  if (pov) constraints.push(`视角人物是${pov}，不要写${pov}不可能知道的信息`);

  const ctx: AssembledContext = {
    title: project.config.title,
    chapter: { title: fm.title, order: fm.order, volume: fm.volume, pov: fm.pov },
    characters,
    locations,
    foreshadows,
    prevChapterTail,
    recentText,
    styleSamples,
    constraints,
    estimatedTokens: 0,
  };
  ctx.estimatedTokens = estimateTokens(ctx);
  return ctx;
}

function stripAuthorNotes(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function takeTail(s: string, n: number): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}

function takeHead(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 粗略估算：中文字符各 1 token，其余按 1/4 */
function estimateTokens(ctx: AssembledContext): number {
  const blob = JSON.stringify(ctx);
  let cjk = 0;
  let other = 0;
  for (const ch of blob) {
    if (/[\u3400-\u9fff]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.round(other / 4);
}
