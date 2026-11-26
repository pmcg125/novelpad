import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProject } from "../project.js";
import { assembleContext } from "../copilot/context.js";
import { DecisionProvider, MockDecisionProvider, q, type Questions, type Answers, type ChoiceAnswer, type NoulAnswer, type ScoreAnswer } from "./provider.js";
import { classifyIngest, preContinuation, resolveAttrConflict, reviewText, reviewToDiagnostics } from "./scenes.js";

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples/demo-novel");
const project = loadProject({ root: EXAMPLE });
const ch1 = project.chapters[0]!;

/* ---------- mock 辅助 ---------- */
const choice = (c: string, conf = 0.9): ChoiceAnswer => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf } });
const noul = (p: number): NoulAnswer => ({ type: "noul", noul: p });
const score = (s: number): ScoreAnswer => ({ type: "score", score: s, confidence: 0.8, legend: {}, probabilities: {} });

describe("DecisionProvider（mock）", () => {
  it("超过 16 个问题报错", async () => {
    const d = new DecisionProvider({ workspaceId: "x", apiKey: "k", fetch: (() => { throw new Error("should not fetch"); }) as unknown as typeof fetch });
    const questions = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`q${i}`, q.noul("x")]));
    await expect(d.decide({ state: "s", questions })).rejects.toThrow(/16/);
  });

  it("端点拼接正确", () => {
    const d = new DecisionProvider({ workspaceId: "llm-abc", apiKey: "k" });
    expect(d.endpoint).toBe("https://llm-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone");
  });
});

describe("reviewText", () => {
  it("构造 state 与 6 个问题，结果映射正确", async () => {
    const mock = new MockDecisionProvider(() => ({
      inCharacter: noul(0.97),
      povViolation: noul(0.05),
      loreConflict: noul(0.03),
      aiStyle: score(0.3),
      tension: score(2.1),
      mood: choice("suspense"),
    }) as Answers<Questions>);
    const v = await reviewText(mock, {
      text: "林晚没有回头。",
      characters: [{ name: "林晚", state: { emotion: "戒备" } }],
      pov: "林晚",
    });
    expect(v.inCharacter.noul).toBe(0.97);
    expect(v.mood.choice).toBe("suspense");
    const state = mock.calls[0]!.state as { 视角人物: string; 待审查正文: string };
    expect(state.视角人物).toBe("林晚");
    expect(state.待审查正文).toContain("林晚");
    expect(Object.keys(mock.calls[0]!.questions)).toHaveLength(6);
  });

  it("reviewToDiagnostics 按概率分级", () => {
    const base = { inCharacter: noul(0.95), povViolation: noul(0.02), loreConflict: noul(0.01), aiStyle: score(0.5), tension: score(1), mood: choice("calm") };
    expect(reviewToDiagnostics({ ...base, raw: null as never })).toHaveLength(0);
    const d1 = reviewToDiagnostics({ ...base, povViolation: noul(0.8), raw: null as never });
    expect(d1[0]).toMatchObject({ severity: "warning", rule: "novelpad/decision-pov" });
    const d2 = reviewToDiagnostics({ ...base, loreConflict: noul(0.95), inCharacter: noul(0.2), aiStyle: score(2.3), raw: null as never });
    expect(d2.map((x) => x.severity)).toEqual(["error", "error", "info"]);
  });
});

describe("preContinuation", () => {
  it("根据情绪 / 地点 / 节奏生成约束", async () => {
    const chars = project.entities.filter((e) => e.kind === "character").slice(0, 2);
    const names = chars.map((c) => c.name);
    const mock = new MockDecisionProvider(() => ({
      locationConsistent: noul(0.3),
      shouldResolveForeshadow: noul(0.8),
      pacing: choice("slow_down"),
      [`emotion:${names[0]}`]: choice("tense", 0.9),
      [`emotion:${names[1]}`]: choice("calm", 0.9),
    }) as Answers<Questions>);
    const r = await preContinuation(mock, { chapter: ch1, characters: chars, recentText: "雨是从傍晚开始下的。" });
    expect(r.constraints.some((c) => c.includes("戒备") && c.includes(names[0]!))).toBe(true);
    expect(r.constraints.some((c) => !c.includes(names[1]!))).toBe(true);
    expect(r.constraints.some((c) => c.includes("位置"))).toBe(true);
    expect(r.constraints.some((c) => c.includes("放慢"))).toBe(true);
    expect(r.verdict.emotions[names[0]!]?.choice).toBe("tense");
  });
});

describe("resolveAttrConflict", () => {
  it("候选版本进 criteria，含 other 兜底", async () => {
    const mock = new MockDecisionProvider(() => ({ adopt: choice("v3"), autoResolve: noul(0.85), reliability: score(3) }) as Answers<Questions>);
    const v = await resolveAttrConflict(mock, {
      entity: "残念",
      attr: "发长",
      versions: [
        { value: "及臀", source: "方舟 23", rank: "user" },
        { value: "及腰", source: "方舟 1117", rank: "assistant", note: "早期版本" },
        { value: "及膝", source: "方舟 2232", rank: "user" },
      ],
    });
    expect(v.adopt.choice).toBe("v3");
    const qq = mock.calls[0]!.questions.adopt as { criteria: Record<string, string> };
    expect(Object.keys(qq.criteria)).toEqual(["v1", "v2", "v3", "other"]);
    expect(qq.criteria.v2).toContain("助手资料");
  });
});

describe("classifyIngest", () => {
  it("归类到实体并给证据等级", async () => {
    const mock = new MockDecisionProvider(() => ({ target: choice("e1"), conflicts: noul(0.1), evidenceLevel: choice("user_statement") }) as Answers<Questions>);
    const v = await classifyIngest(mock, { text: "冬至永远 16 岁", entities: [{ name: "冬至", kind: "character" }, { name: "残念", kind: "character" }] });
    expect(v.target.choice).toBe("e1");
    const qq = mock.calls[0]!.questions.target as { criteria: Record<string, string> };
    expect(qq.criteria.e1).toContain("冬至");
    expect(qq.criteria.new).toBeTruthy();
  });
});

/* ============================================================
 * 真实决策模型
 * ============================================================ */
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY ?? "DASHSCOPE_KEY_REDACTED";
const WORKSPACE = process.env.DASHSCOPE_WORKSPACE ?? "WORKSPACE_REDACTED";

describe.skipIf(process.env.NOVLEPAD_DECISION_TEST !== "1")("真实 decision-model（需 NOVLEPAD_DECISION_TEST=1）", () => {
  const decider = new DecisionProvider({ workspaceId: WORKSPACE, apiKey: DASHSCOPE_KEY });

  it("审查第 1 章：不 OOC、不越界、低 AI 腔、高紧张", async () => {
    const ctx = assembleContext(project, { chapter: ch1 });
    const text = ch1.content.replace(/<!--[\s\S]*?-->/g, "").slice(0, 900);
    const v = await reviewText(decider, {
      text,
      characters: ctx.characters.map((c) => ({ name: c.name, summary: c.summary, attrs: c.attrs, state: c.state })),
      pov: "林晚",
      lore: project.entities.filter((e) => e.kind !== "character").map((e) => `${e.name}：${e.summary ?? ""}`),
    });
    console.log("\n--- 审查 ---\n", JSON.stringify({ ...v, raw: undefined }, null, 2), "\nlatency:", v.raw.latencyMs, "ms");
    expect(v.inCharacter.noul).toBeGreaterThan(0.7);
    expect(v.povViolation.noul).toBeLessThan(0.3);
    expect(v.loreConflict.noul).toBeLessThan(0.3);
    expect(v.aiStyle.score).toBeLessThan(1.5);
    expect(v.tension.score).toBeGreaterThan(1.5);
  }, 30_000);

  it("故意写一段 OOC + 视角越界，模型应抓出来", async () => {
    const ctx = assembleContext(project, { chapter: ch1 });
    const bad = "林晚开心地笑了起来，蹦蹦跳跳地跑进茶馆，一点也没有戒心。沈默心里想着：她还是那么可爱，我舍不得伤害她，但为了商会我必须这么做。周砚此时正在港口和林父喝酒。";
    const v = await reviewText(decider, {
      text: bad,
      characters: ctx.characters.map((c) => ({ name: c.name, summary: c.summary, attrs: c.attrs, state: c.state })),
      pov: "林晚",
    });
    console.log("\n--- 反例审查 ---\n", JSON.stringify({ ...v, raw: undefined }, null, 2));
    const diags = reviewToDiagnostics(v);
    console.log("diagnostics:", diags);
    // 应至少抓到一项：OOC 或视角越界
    const flagged = diags.filter((d) => /ooc|pov/.test(d.rule));
    expect(flagged.length).toBeGreaterThan(0);
  }, 30_000);

  it("续写前判断：林晚应判为紧张 / 戒备", async () => {
    const ctx = assembleContext(project, { chapter: ch1 });
    const chars = project.entities.filter((e) => e.kind === "character" && ctx.characters.some((c) => c.name === e.name));
    const r = await preContinuation(decider, { chapter: ch1, characters: chars, recentText: ch1.content.slice(-600) });
    console.log("\n--- 续写前 ---\n", JSON.stringify({ ...r.verdict, raw: undefined }, null, 2), "\nconstraints:", r.constraints);
    const lw = r.verdict.emotions["林晚"];
    expect(lw).toBeDefined();
    expect(["tense", "afraid", "confused"]).toContain(lw!.choice);
  }, 30_000);

  it("冲突裁决：用户最新版应胜出", async () => {
    const v = await resolveAttrConflict(decider, {
      entity: "残念",
      attr: "发长",
      versions: [
        { value: "及臀 / 大腿根", source: "方舟 23", rank: "user", when: "早期" },
        { value: "及腰", source: "方舟 1117", rank: "assistant", note: "助手资料" },
        { value: "及膝 / 过膝", source: "方舟 2232", rank: "user", when: "后期用户明确" },
      ],
    });
    console.log("\n--- 冲突裁决 ---\n", JSON.stringify({ ...v, raw: undefined }, null, 2));
    expect(v.adopt.choice).toBe("v3");
  }, 30_000);
});
