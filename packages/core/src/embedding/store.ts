/**
 * 向量索引 + 检索器（纯 JS，零原生依赖）
 *
 * 存储：.novelpad/index/vectors.json —— { model, dims, chunks: [{ id, text, meta, vector }] }
 * 检索：暴力余弦相似度。小说规模（数千块）下 < 10ms，可 Git diff。
 * 规模到 10 万块再换 sqlite-vec。
 *
 * 增量：按内容 hash 判断，只重嵌改动的块。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { EmbeddingProvider } from "./provider.js";
import type { Reranker } from "./rerank.js";

/* ============================================================
 * 分块
 * ============================================================ */

export interface Chunk {
  /** 稳定 ID：由 kind + 相对路径 + 序号构成 */
  id: string;
  text: string;
  hash: string;
  meta: ChunkMeta;
}

export type ChunkMeta =
  | { kind: "chapter"; file: string; order: number; title: string; index: number; characters?: string[]; locations?: string[] }
  | { kind: "entity"; file: string; entity: string; entityKind: string; section?: string }
  | { kind: "lore"; file: string; title: string }
  | { kind: "outline"; file: string; title: string };

/** 按 Markdown 标题切块（设定 / 大纲） */
export function chunkByHeadings<B extends { kind: "entity" | "lore" | "outline"; file: string }>(
  text: string,
  base: B,
  maxChars = 1200,
): Chunk[] {
  const lines = text.split(/\r?\n/);
  const sections: { title: string; body: string[] }[] = [{ title: "", body: [] }];
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) sections.push({ title: m[2]!.trim(), body: [] });
    else sections[sections.length - 1]!.body.push(line);
  }
  const out: Chunk[] = [];
  let i = 0;
  for (const s of sections) {
    const body = s.body.join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
    // 只有标题没有正文的块不索引（否则会以空内容召回）
    if (!body) continue;
    const heading = s.title ? `## ${s.title}\n` : "";
    for (const p of splitParagraphs(body, maxChars)) {
      if (!p.trim()) continue;
      const meta = { ...base, ...(s.title ? { section: s.title } : {}) } as unknown as ChunkMeta;      out.push(makeChunk(meta, i++, heading + p));
    }
  }
  return out;
}

/** 按场景切块（章节正文）：以 *** 或空行分组，超过 maxChars 再切 */
export function chunkChapter(
  content: string,
  base: Omit<Extract<ChunkMeta, { kind: "chapter" }>, "index">,
  maxChars = 1000,
): Chunk[] {
  const clean = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#{1,6}\s+.*$/m, "")
    .replace(/^\s*([-*_]\s*){3,}$/gm, "\u0000")
    .trim();
  const scenes = clean.split("\u0000");
  const out: Chunk[] = [];
  let i = 0;
  for (const scene of scenes) {
    for (const p of splitParagraphs(scene.trim(), maxChars)) {
      if (!p.trim()) continue;
      out.push(makeChunk({ ...base, index: i }, i, p));
      i++;
    }
  }
  return out;
}

function splitParagraphs(text: string, maxChars: number): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    if ((buf + "\n\n" + p).length > maxChars && buf) {
      out.push(buf);
      buf = "";
    }
    if (p.length > maxChars) {
      const sentences = p.split(/(?<=[。！？」』])/);
      let sb = "";
      for (const s of sentences) {
        if ((sb + s).length > maxChars && sb) {
          out.push(sb);
          sb = "";
        }
        sb += s;
      }
      if (sb) out.push(sb);
      continue;
    }
    buf = buf ? buf + "\n\n" + p : p;
  }
  if (buf) out.push(buf);
  return out;
}

export function makeChunk(meta: ChunkMeta, index: number, text: string): Chunk {
  return { id: `${meta.kind}:${meta.file}:${index}`, text, hash: hashText(text), meta };
}

export function hashText(s: string): string {
  return crypto.createHash("sha1").update(s, "utf8").digest("hex").slice(0, 16);
}

/* ============================================================
 * 索引
 * ============================================================ */

export interface VectorStore {
  model: string;
  dims: number;
  chunks: (Chunk & { vector: number[] })[];
}

export interface IndexResult {
  added: number;
  unchanged: number;
  removed: number;
  tokens: number;
  chunks: number;
}

export class VectorIndex {
  private store: VectorStore;
  constructor(private readonly embedder: EmbeddingProvider, store?: VectorStore) {
    this.store = store ?? { model: embedder.id, dims: embedder.dims ?? 0, chunks: [] };
  }

  get size(): number {
    return this.store.chunks.length;
  }

  /** 增量更新：只嵌入 hash 变化的块 */
  async sync(chunks: Chunk[], onProgress?: (done: number, total: number) => void): Promise<IndexResult> {
    const existing = new Map(this.store.chunks.map((c) => [c.id, c]));
    const keep = new Set<string>();
    const toEmbed: Chunk[] = [];
    let unchanged = 0;
    for (const c of chunks) {
      keep.add(c.id);
      const old = existing.get(c.id);
      if (old && old.hash === c.hash) unchanged++;
      else toEmbed.push(c);
    }
    const removed = [...existing.keys()].filter((id) => !keep.has(id)).length;

    let tokens = 0;
    const embedded: (Chunk & { vector: number[] })[] = [];
    const BATCH = 16;
    for (let i = 0; i < toEmbed.length; i += BATCH) {
      const batch = toEmbed.slice(i, i + BATCH);
      const r = await this.embedder.embed(batch.map((c) => c.text));
      tokens += r.promptTokens;
      batch.forEach((c, j) => embedded.push({ ...c, vector: r.vectors[j]! }));
      onProgress?.(Math.min(i + BATCH, toEmbed.length), toEmbed.length);
    }

    const next = new Map<string, Chunk & { vector: number[] }>();
    for (const c of this.store.chunks) if (keep.has(c.id)) next.set(c.id, c);
    for (const c of embedded) next.set(c.id, c);
    const ordered = chunks.map((c) => next.get(c.id)).filter((c): c is Chunk & { vector: number[] } => !!c);
    this.store = { model: this.embedder.id, dims: this.store.dims || embedded[0]?.vector.length || 0, chunks: ordered };
    return { added: toEmbed.length, unchanged, removed, tokens, chunks: ordered.length };
  }

  /* ---------- 持久化 ---------- */
  save(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const slim = this.store.chunks.map((c) => ({ ...c, vector: c.vector.map((v) => +v.toFixed(4)) }));
    fs.writeFileSync(file, JSON.stringify({ ...this.store, chunks: slim }), "utf8");
  }

  static load(file: string, embedder: EmbeddingProvider): VectorIndex | undefined {
    if (!fs.existsSync(file)) return undefined;
    try {
      const store = JSON.parse(fs.readFileSync(file, "utf8")) as VectorStore;
      if (store.model !== embedder.id) return undefined; // 模型变了，重建
      return new VectorIndex(embedder, store);
    } catch {
      return undefined;
    }
  }

  /* ---------- 检索 ---------- */
  async search(
    query: string,
    opts: { topK?: number; filter?: (meta: ChunkMeta) => boolean; minScore?: number; reranker?: Reranker; recallK?: number } = {},
  ): Promise<SearchHit[]> {
    const { topK = 5, filter, minScore = 0.2, reranker, recallK = Math.max(topK * 4, 20) } = opts;
    if (!this.store.chunks.length) return [];
    const q = (await this.embedder.embed([query])).vectors[0]!;
    const scored: SearchHit[] = [];
    for (const c of this.store.chunks) {
      if (filter && !filter(c.meta)) continue;
      const s = cosine(q, c.vector);
      if (s >= minScore) scored.push({ chunk: { id: c.id, text: c.text, hash: c.hash, meta: c.meta }, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const recalled = scored.slice(0, recallK);

    // 精排：向量召回 → rerank → 取 topK
    if (reranker && recalled.length > 1) {
      const rr = await reranker.rerank(query, recalled.map((h) => h.chunk.text), { topN: topK });
      return rr.results
        .filter((r) => r.index < recalled.length)
        .slice(0, topK)
        .map((r) => ({ ...recalled[r.index]!, score: r.relevanceScore, vectorScore: recalled[r.index]!.score }));
    }
    return recalled.slice(0, topK);
  }
}

export interface SearchHit {
  chunk: Chunk;
  /** 最终分数（有 reranker 时为 relevance，否则为余弦） */
  score: number;
  /** 向量召回阶段的余弦分（有 reranker 时保留） */
  vectorScore?: number;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
