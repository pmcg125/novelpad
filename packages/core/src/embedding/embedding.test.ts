import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProject } from "../project.js";
import { MockEmbedding, OpenAICompatibleEmbedding } from "./provider.js";
import { VectorIndex, chunkByHeadings, chunkChapter, cosine, hashText, type ChunkMeta } from "./store.js";
import { collectChunks } from "./collect.js";

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples/demo-novel");
const CANNIAN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples/cannian");

describe("分块", () => {
  it("chunkChapter 按场景分隔，去掉备注与标题", () => {
    const chunks = chunkChapter("# 第一章\n\n第一段。<!-- 备注 -->\n\n第二段。\n\n***\n\n第三段。", {
      kind: "chapter", file: "chapters/001.md", order: 1, title: "第一章",
    });
    expect(chunks.map((c) => c.text)).toEqual(["第一段。\n\n第二段。", "第三段。"]);
    expect(chunks[0]?.meta).toMatchObject({ kind: "chapter", order: 1, index: 0 });
    expect(chunks[1]?.meta).toMatchObject({ index: 1 });
  });

  it("过长段落按句切分", () => {
    const long = Array.from({ length: 60 }, (_, i) => `这是第${i}句话。`).join("");
    const chunks = chunkChapter(long, { kind: "chapter", file: "f", order: 1, title: "t" }, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(210);
  });

  it("chunkByHeadings 保留标题为 section", () => {
    const chunks = chunkByHeadings("# 残念\n\n简介。\n\n## 2.1 数据生命\n\n她不是神明。\n\n## 3 能力\n\n很强。", {
      kind: "entity", file: "OC/残念.md", entity: "残念", entityKind: "character",
    });
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.text).toContain("# 残念");
    expect(chunks[1]?.meta).toMatchObject({ section: "2.1 数据生命" });
    expect(chunks[1]?.text).toContain("她不是神明");
  });

  it("hash 稳定", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });
});

describe("VectorIndex", () => {
  it("增量：首次全嵌，第二次无变化零嵌入，改一块只嵌一块", async () => {
    const emb = new MockEmbedding(8);
    const idx = new VectorIndex(emb);
    const mk = (n: number, txt: (i: number) => string) =>
      Array.from({ length: n }, (_, i) => ({ id: `chapter:f:${i}`, text: txt(i), hash: hashText(txt(i)), meta: { kind: "chapter", file: "f", order: 1, title: "t", index: i } as ChunkMeta }));
    const r1 = await idx.sync(mk(3, (i) => `段落${i}`));
    expect(r1.added).toBe(3);
    expect(idx.size).toBe(3);
    const r2 = await idx.sync(mk(3, (i) => `段落${i}`));
    expect(r2.added).toBe(0);
    expect(r2.unchanged).toBe(3);
    const r3 = await idx.sync(mk(3, (i) => (i === 1 ? "改了" : `段落${i}`)));
    expect(r3.added).toBe(1);
    expect(r3.unchanged).toBe(2);
    const r4 = await idx.sync(mk(2, (i) => `段落${i}`));
    expect(r4.removed).toBe(1);
    expect(idx.size).toBe(2);
  });

  it("save / load 往返，模型不同则重建", async () => {
    const emb = new MockEmbedding(8);
    const idx = new VectorIndex(emb);
    await idx.sync([{ id: "a:1", text: "你好", hash: "h", meta: { kind: "chapter", file: "a", order: 1, title: "t", index: 0 } }]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "np-idx-")), "vectors.json");
    idx.save(file);
    expect(fs.statSync(file).size).toBeGreaterThan(10);
    const back = VectorIndex.load(file, emb);
    expect(back?.size).toBe(1);
    expect(VectorIndex.load(file, new MockEmbedding(8) /* id 相同 */)?.size).toBe(1);
    const other = new MockEmbedding(8);
    Object.defineProperty(other, "id", { value: "other-model" });
    expect(VectorIndex.load(file, other)).toBeUndefined();
  });

  it("cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
});

describe("collectChunks", () => {
  it("demo-novel：章节 + 实体 + 大纲", () => {
    const p = loadProject({ root: DEMO });
    const chunks = collectChunks(p);
    const kinds = new Map<string, number>();
    for (const c of chunks) kinds.set(c.meta.kind, (kinds.get(c.meta.kind) ?? 0) + 1);
    expect(kinds.get("chapter")).toBeGreaterThan(0);
    expect(kinds.get("entity")).toBeGreaterThanOrEqual(8);
    expect(kinds.get("outline")).toBeGreaterThanOrEqual(1);
    const lw = chunks.find((c) => c.meta.kind === "entity" && c.meta.entity === "林晚");
    expect(lw?.text).toContain("紧张时摸左手腕");
    expect(lw?.text).toContain("敌对");
  });

  it("cannian：按标题切成多块，含冲突清单", () => {
    if (!fs.existsSync(CANNIAN)) return;
    const p = loadProject({ root: CANNIAN });
    const chunks = collectChunks(p);
    expect(chunks.length).toBeGreaterThan(50);
    const sections = chunks.filter((c) => c.meta.kind === "lore" || c.meta.kind === "outline").map((c) => (c.meta as { section?: string }).section);
    expect(sections.some((s) => s?.includes("发长"))).toBe(true);
    // 冲突清单应被收录
    const conflict = chunks.find((c) => c.meta.kind === "lore" && c.meta.file.includes("99-"));
    expect(conflict).toBeDefined();
  });
});

describe.skipIf(process.env.NOVLEPAD_EMBED_TEST !== "1")("真实 qwen3.7-text-embedding-flash（需 NOVLEPAD_EMBED_TEST=1）", () => {
  const embedder = new OpenAICompatibleEmbedding({
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.DASHSCOPE_API_KEY ?? "DASHSCOPE_KEY_REDACTED",
    model: "qwen3.7-text-embedding-flash",
  });

  it("embedding 1024 维，批量顺序正确", async () => {
    const r = await embedder.embed(["林晚推门进去", "沈默靠在门板上", "雨是从傍晚开始下的"]);
    expect(r.vectors).toHaveLength(3);
    expect(r.vectors[0]).toHaveLength(1024);
    expect(r.promptTokens).toBeGreaterThan(0);
  }, 30_000);

  it("对 cannian 建索引并检索「残念对过去的态度」", async () => {
    if (!fs.existsSync(CANNIAN)) return;
    const p = loadProject({ root: CANNIAN });
    const chunks = collectChunks(p);
    const idx = new VectorIndex(embedder);
    const r = await idx.sync(chunks, (d, t) => { if (d % 40 === 0) console.log(`  embedding ${d}/${t}`); });
    console.log(`indexed ${r.chunks} chunks, ${r.tokens} tokens`);
    expect(r.chunks).toBeGreaterThan(50);
    const hits = await idx.search("残念对过去的态度是怎样的", { topK: 5 });
    console.log("\n--- 残念对过去的态度 ---");
    for (const h of hits) console.log(`  ${h.score.toFixed(3)}  ${h.chunk.meta.kind} ${(h.chunk.meta as { section?: string; entity?: string; title?: string }).section ?? (h.chunk.meta as { entity?: string }).entity ?? (h.chunk.meta as { title?: string }).title}\n      ${h.chunk.text.slice(0, 80).replace(/\n/g, " ")}…`);
    expect(hits[0]?.score).toBeGreaterThan(0.4);
    expect(hits.some((h) => h.chunk.text.includes("过去") || h.chunk.text.includes("缓存"))).toBe(true);

    const hits2 = await idx.search("冬至说话为什么慢半拍", { topK: 3 });
    console.log("\n--- 冬至口吃（仅向量）---");
    for (const h of hits2) console.log(`  ${h.score.toFixed(3)}  ${(h.chunk.meta as { entity?: string }).entity ?? ""} ${(h.chunk.meta as { section?: string }).section ?? ""}\n      ${h.chunk.text.slice(0, 80).replace(/\n/g, " ")}…`);

    // rerank 精排
    const { DashScopeReranker } = await import("./rerank.js");
    const reranker = new DashScopeReranker({ workspaceId: process.env.DASHSCOPE_WORKSPACE ?? "WORKSPACE_REDACTED", apiKey: process.env.DASHSCOPE_API_KEY ?? "DASHSCOPE_KEY_REDACTED" });
    const hits2r = await idx.search("冬至说话为什么慢半拍", { topK: 3, reranker, recallK: 15 });
    console.log("\n--- 冬至口吃（向量召回 15 → rerank 取 3）---");
    for (const h of hits2r) console.log(`  ${h.score.toFixed(3)} (vec ${(h.vectorScore ?? 0).toFixed(3)})  ${(h.chunk.meta as { entity?: string }).entity ?? ""} ${(h.chunk.meta as { section?: string }).section ?? ""}\n      ${h.chunk.text.slice(0, 80).replace(/\n/g, " ")}…`);
    expect(hits2r[0]?.chunk.text).toMatch(/口吃|慢半拍|感冒|垫半拍|半拍/);

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "np-idx-")), "vectors.json");
    idx.save(file);
    console.log(`index file: ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
    const back = VectorIndex.load(file, embedder);
    expect(back?.size).toBe(idx.size);
    // 「发长冲突」纯向量会被总述块干扰；rerank 后应命中 B1. 发长
    const q0 = await back!.search("发长冲突", { topK: 3 });
    console.log("\n--- 发长冲突（仅向量）---");
    for (const h of q0) console.log(`  ${h.score.toFixed(3)}  ${(h.chunk.meta as { section?: string }).section ?? ""}`);
    const q = await back!.search("发长冲突", { topK: 3, reranker });
    console.log("\n--- 发长冲突（rerank）---");
    for (const h of q) console.log(`  ${h.score.toFixed(3)} (vec ${(h.vectorScore ?? 0).toFixed(3)})  ${(h.chunk.meta as { section?: string }).section ?? ""}`);
    expect(q[0]?.chunk.text).toMatch(/发长|及腰|及膝/);
    expect((q[0]?.chunk.meta as { section?: string }).section).toBe("B1. 发长");
  }, 180_000);
});
