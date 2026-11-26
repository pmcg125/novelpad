import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Entity } from "../types.js";
import { assembleContext, detectEntities } from "./context.js";
import {
  ACTION_LABEL,
  buildContinuationMessages,
  buildEditMessages,
  buildQuestionMessages,
  buildSystemPrompt,
  cleanContinuation,
  continueStory,
  draftCharacterCard,
  editText,
  parseEditResult,
} from "./prompts.js";
import { MockProvider } from "../llm/provider.js";
import { loadProject } from "../project.js";

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples/demo-novel");
const project = loadProject({ root: EXAMPLE });
const ch1 = project.chapters[0]!;
const ch3 = project.chapters[2]!;

const index = new Map<string, Entity>();
for (const e of project.entities) {
  index.set(e.name, e);
  for (const a of e.aliases ?? []) index.set(a, e);
}

describe("detectEntities", () => {
  it("识别名称与别称，去重", () => {
    const found = detectEntities("林晚和阿晚都认识沈默，小默也在。", index);
    const names = found.map((e) => e.name);
    expect(names).toContain("林晚");
    expect(names).toContain("沈默");
    expect(names.filter((n) => n === "林晚")).toHaveLength(1);
  });
  it("长名优先：不会把「林晚」拆成别的", () => {
    const found = detectEntities("林晚", index);
    expect(found.map((e) => e.name)).toEqual(["林晚"]);
  });
});

describe("assembleContext", () => {
  it("角色 = frontmatter 声明 ∪ 正文检测，含状态与在场关系", () => {
    const ctx = assembleContext(project, { chapter: ch1 });
    const names = ctx.characters.map((c) => c.name);
    expect(names).toContain("林晚");
    expect(names).toContain("沈默");
    const lw = ctx.characters.find((c) => c.name === "林晚")!;
    expect(lw.state?.emotion).toBe("戒备");
    expect(lw.relationsWithPresent).toEqual([{ target: "沈默", type: "敌对 · 对峙" }]);
    expect(ctx.locations).toEqual(["旧城区", "清风茶馆"]);
  });

  it("伏笔状态：第 1 章时 fs-letter 即将到期", () => {
    const ctx = assembleContext(project, { chapter: ch1 });
    const fs = ctx.foreshadows.find((f) => f.id === "fs-letter");
    expect(fs?.status).toBe("due-soon");
    expect(fs?.note).toBe("那封信的来历");
  });

  it("第 3 章有上一章结尾和文风样本，第 1 章没有", () => {
    const c1 = assembleContext(project, { chapter: ch1 });
    const c3 = assembleContext(project, { chapter: ch3 });
    expect(c1.prevChapterTail).toBe("");
    expect(c1.styleSamples).toEqual([]);
    expect(c3.prevChapterTail.length).toBeGreaterThan(0);
    expect(c3.styleSamples.length).toBe(2);
  });

  it("textBeforeCursor 剥除备注并按需截断", () => {
    const ctx = assembleContext(project, {
      chapter: ch1,
      textBeforeCursor: "第一段很长的文字。<!-- 备注 -->\n\n第二段也不短。",
      maxRecentChars: 10,
    });
    expect(ctx.recentText).not.toContain("备注");
    expect(ctx.recentText.startsWith("…")).toBe(true);
    expect(ctx.recentText.length).toBeLessThanOrEqual(11);
  });

  it("pov 生成约束", () => {
    const ctx = assembleContext(project, { chapter: ch1 });
    expect(ctx.constraints.some((c) => c.includes("林晚"))).toBe(true);
  });

  it("estimatedTokens > 0", () => {
    expect(assembleContext(project, { chapter: ch1 }).estimatedTokens).toBeGreaterThan(50);
  });
});

const ctx1 = assembleContext(project, { chapter: ch1 });

describe("prompts", () => {
  it("system 以小说家批注开头，含书名、角色卡、伏笔、约束", () => {
    const sys = buildSystemPrompt(ctx1);
    expect(sys.startsWith("你的推理过程")).toBe(true);
    expect(sys).toContain("正在写这本书的小说家");
    expect(sys).toContain("第 1 章的草稿");
    expect(sys).toContain("《雨夜》");
    expect(sys).toContain("林晚");
    expect(sys).toContain("情绪克制=高");
    expect(sys).toContain("fs-letter");
    expect(sys).toContain("视角人物是林晚");
    expect(sys).toContain("AI 腔");
  });

  it("续写消息用作者口吻，不含任务腔", () => {
    const msgs = buildContinuationMessages({ ctx: assembleContext(project, { chapter: ch3 }), hint: "让沈默进门" });
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]?.content).toContain("保持这个手感");
    expect(msgs[1]?.content).toContain("另一位作者的批注：让沈默进门");
    expect(msgs[1]?.content).not.toMatch(/用户|任务要求/);
  });

  it("五种编辑动作都有规则", () => {
    for (const a of Object.keys(ACTION_LABEL) as (keyof typeof ACTION_LABEL)[]) {
      const msgs = buildEditMessages(a, "原文", ctx1);
      expect(msgs[1]?.content).toContain("原文");
      expect(msgs[1]?.content).toContain("rewritten");
    }
    expect(buildEditMessages("switch-pov", "x", ctx1, "沈默")[1]?.content).toContain("沈默");
  });

  it("问答只依据事实", () => {
    const msgs = buildQuestionMessages("林晚知道父亲的事吗？", { title: "雨夜", chapterOrder: 3, facts: ["林父与港口商会有关", "林晚在第3章收到信"] });
    expect(msgs[0]?.content).toContain("不要编造");
    expect(msgs[0]?.content).toContain("港口商会");
  });

  it("parseEditResult 解析 JSON / 带 fence 的 JSON / 纯文本", () => {
    expect(parseEditResult('{"rewritten":"好","changes":["a"]}')).toEqual({ rewritten: "好", changes: ["a"] });
    expect(parseEditResult('```json\n{"rewritten":"好","changes":[]}\n```')).toEqual({ rewritten: "好", changes: [] });
    expect(parseEditResult("只是文字")).toEqual({ rewritten: "只是文字", changes: [] });
  });

  it("cleanContinuation 去重复前缀与标题", () => {
    expect(cleanContinuation("# 第二章\n\n正文", "")).toBe("正文");
    expect(cleanContinuation("她知道这个声音。声音很近。", "……林晚没有回头。她知道这个声音。")).toBe("声音很近。");
    expect(cleanContinuation("续写：他进来了。", "")).toBe("他进来了。");
  });
});

describe("copilot 端到端（MockProvider）", () => {
  it("continueStory 走 system+user 并清理输出，返回 CopilotOutput", async () => {
    const p = new MockProvider(() => "```\n他推门进来。\n```");
    const out = await continueStory(p, { ctx: ctx1 });
    expect(out.result).toBe("他推门进来。");
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(p.calls[0]?.messages[0]?.role).toBe("system");
    expect(p.calls[0]?.messages[1]?.content).toContain("当前章草稿");
  });

  it("editText 返回结构化结果", async () => {
    const p = new MockProvider(() => JSON.stringify({ rewritten: "改后", changes: ["删形容词"] }));
    const r = await editText(p, "polish", "改前", ctx1);
    expect(r.result).toEqual({ rewritten: "改后", changes: ["删形容词"] });
  });

  it("draftCharacterCard 去掉 yaml fence", async () => {
    const p = new MockProvider(() => "```yaml\nname: 周砚\n```");
    expect((await draftCharacterCard(p, "周砚", ["片段"], "雨夜")).result).toBe("name: 周砚");
  });

  it("stream 逐字产出", async () => {
    const p = new MockProvider(() => "你好");
    let got = "";
    for await (const ch of p.stream({ messages: [] })) got += ch;
    expect(got).toBe("你好");
  });
});

describe.skipIf(process.env.NOVLEPAD_LLM_TEST !== "1")("真实反代（127.0.0.1:8788）— 需 NOVLEPAD_LLM_TEST=1", () => {
  const cfg = { baseUrl: process.env.NOVLEPAD_LLM_URL ?? "", apiKey: process.env.NOVLEPAD_LLM_KEY ?? "", model: process.env.NOVLEPAD_LLM_MODEL ?? "" };

  it("complete 返回非空文本（简单问题模型可能跳过思考）", async () => {
    const { OpenAICompatibleProvider } = await import("../llm/provider.js");
    const p = new OpenAICompatibleProvider(cfg);
    const r = await p.complete({ messages: [{ role: "user", content: "只回复两个字：收到" }], maxTokens: 800 });
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.usage).toBeDefined();
  }, 30_000);

  it("stream 能产出内容（推理模型需要足够 token 走完思考）", async () => {
    const { OpenAICompatibleProvider } = await import("../llm/provider.js");
    const p = new OpenAICompatibleProvider(cfg);
    let got = "";
    let reasoning = 0;
    for await (const ev of p.streamEvents({ messages: [{ role: "user", content: "数到三" }], maxTokens: 400 })) {
      if (ev.type === "content") got += ev.text;
      if (ev.type === "reasoning") reasoning++;
    }
    expect(got.length).toBeGreaterThan(0);
  }, 60_000);

  it("续写真实章节得到合理输出，且捕获到中文推理过程", async () => {
    const { OpenAICompatibleProvider } = await import("../llm/provider.js");
    const p = new OpenAICompatibleProvider(cfg);
    const out = await continueStory(p, { ctx: ctx1, maxTokens: 1200 });
    expect(out.result.length).toBeGreaterThan(20);
    expect(out.result).not.toContain("```");
    // 推理模型：应有思考过程，且为中文（含 CJK）
    expect(out.reasoning).toBeTruthy();
    expect(/[\u4e00-\u9fff]/.test(out.reasoning ?? "")).toBe(true);
    // 不应出现任务腔
    expect(out.reasoning).not.toMatch(/用户需要|任务要求|输出一段/);
    console.log("\n--- 推理过程（前 300 字）---\n" + (out.reasoning ?? "").slice(0, 300) + "\n--- 续写 ---\n" + out.result + "\n");
  }, 90_000);
});
