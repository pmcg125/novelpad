import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProject } from "../project.js";
import { buildGraph, buildStoryChain } from "./model.js";

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples/demo-novel");
const CANNIAN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples/cannian");

describe("buildGraph", () => {
  const p = loadProject({ root: DEMO });
  const g = buildGraph(p);

  it("实体节点按类型，含章节出场", () => {
    const lw = g.nodes.find((n) => n.label === "林晚");
    expect(lw?.kind).toBe("character");
    expect(lw?.chapters).toEqual([1, 2, 3]);
    expect(g.nodes.some((n) => n.kind === "location")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "faction")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "item")).toBe(true);
  });

  it("显式关系边：林晚 → 沈默 enemy", () => {
    const e = g.edges.find((x) => x.kind === "relation" && x.label?.includes("对峙"));
    expect(e).toBeDefined();
    expect(e?.category).toBe("enemy");
    expect(e?.sourceKind).toBe("card");
  });

  it("物品持有边", () => {
    const hold = g.edges.find((x) => x.kind === "holds");
    expect(hold?.source).toBe("lin-wan");
    expect(hold?.target).toBe("you-zhi-san");
  });

  it("正文推断：同场（角色↔角色）与在场（角色↔地点）", () => {
    expect(g.edges.some((x) => x.kind === "located" && x.label === "在场")).toBe(true);
    const co = g.edges.find((x) => x.kind === "present");
    expect(co?.label).toMatch(/同场/);
  });

  it("伏笔事件节点 + 因果边", () => {
    const open = g.nodes.find((n) => n.id === "ev:open:fs-letter");
    const close = g.nodes.find((n) => n.id === "ev:close:fs-letter");
    expect(open?.event?.chapter).toBe(1);
    expect(close?.event?.chapter).toBe(3);
    const causal = g.edges.find((x) => x.kind === "causal" && x.source === "ev:open:fs-letter");
    expect(causal?.target).toBe("ev:close:fs-letter");
  });

  it("章节范围过滤：事件与因果边按范围裁剪", () => {
    const g1 = buildGraph(p, { chapters: [1, 1] });
    expect(g1.maxOrder).toBe(1);
    expect(g1.nodes.find((n) => n.label === "周砚")?.chapters).toEqual([]); // 不在第 1 章出场
    expect(g1.edges.find((x) => x.kind === "causal")).toBeUndefined(); // 第 3 章的回收不在范围
    expect(g1.nodes.find((n) => n.id === "ev:close:fs-letter")).toBeUndefined();
  });

  it("章节范围 + 范围值", () => {
    expect(g.minOrder).toBe(1);
    expect(g.maxOrder).toBe(3);
  });
});

describe("buildStoryChain", () => {
  const p = loadProject({ root: DEMO });
  const c = buildStoryChain(p);

  it("泳道按出场次数", () => {
    expect(c.lanes[0]).toBe("林晚");
    expect(c.lanes.length).toBeLessThanOrEqual(4);
  });

  it("每章一个场景节点，伏笔开合节点", () => {
    expect(c.nodes.filter((n) => n.kind === "scene")).toHaveLength(3);
    expect(c.nodes.some((n) => n.kind === "foreshadow-open" && n.chapter === 1)).toBe(true);
    expect(c.nodes.some((n) => n.kind === "foreshadow-close" && n.chapter === 3)).toBe(true);
  });

  it("顺序边 + 因果边", () => {
    const seq = c.links.filter((l) => l.kind === "sequence");
    expect(seq.some((l) => l.source === "s:1" && l.target === "s:2")).toBe(true);
    const causal = c.links.find((l) => l.kind === "causal");
    expect(causal?.source).toBe("o:fs-letter");
    expect(causal?.target).toBe("c:fs-letter");
  });
});

describe("cannian 图谱", () => {
  it("没有角色卡 YAML，只有 lore，图为空或极小", () => {
    const p = loadProject({ root: CANNIAN });
    const g = buildGraph(p);
    // cannian 没有 characters/*.yaml，也没有 chapters —— 图谱应为空（这验证了空项目不崩）
    expect(g.nodes.length).toBe(0);
    expect(g.edges.length).toBe(0);
  });
});
