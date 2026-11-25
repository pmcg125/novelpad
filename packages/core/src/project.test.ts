import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEntityIndex, findEntity, isNovelPadProject, loadProject } from "./project.js";
import { kindFromPath } from "./parser/entity.js";

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/demo-novel");

describe("kindFromPath", () => {
  it("characters/ → character", () => expect(kindFromPath("characters/lin-wan.yaml")).toBe("character"));
  it("world/locations/ → location", () => expect(kindFromPath("world/locations/jiucheng.md")).toBe("location"));
  it("world/factions/ → faction", () => expect(kindFromPath("world/factions/x.md")).toBe("faction"));
  it("world/items/ → item", () => expect(kindFromPath("world/items/x.md")).toBe("item"));
  it("world/ 顶层 → lore", () => expect(kindFromPath("world/背景.md")).toBe("lore"));
  it("其他 → undefined", () => expect(kindFromPath("chapters/001.md")).toBeUndefined());
});

describe("loadProject", () => {
  it("示例作品可被识别", () => {
    expect(isNovelPadProject(EXAMPLE)).toBe(true);
  });

  it("读取配置", () => {
    const p = loadProject({ root: EXAMPLE });
    expect(p.config.title).toBe("雨夜");
  });

  it("章节按 order 升序", () => {
    const p = loadProject({ root: EXAMPLE });
    expect(p.chapters.map((c) => c.frontmatter.order)).toEqual([1, 2, 3]);
    expect(p.chapters[0]?.frontmatter.title).toBe("第一章 雨夜");
  });

  it("解析所有实体并区分类型", () => {
    const p = loadProject({ root: EXAMPLE });
    const kinds = p.entities.map((e) => e.kind);
    expect(kinds.filter((k) => k === "character")).toHaveLength(4);
    expect(kinds.filter((k) => k === "location")).toHaveLength(2);
    expect(kinds.filter((k) => k === "faction")).toHaveLength(1);
    expect(kinds.filter((k) => k === "item")).toHaveLength(1);
  });

  it("角色卡解析：别称、属性、关系、状态", () => {
    const p = loadProject({ root: EXAMPLE });
    const lw = findEntity(p, "林晚");
    expect(lw).toBeDefined();
    expect(lw?.kind).toBe("character");
    if (lw?.kind === "character") {
      expect(lw.role).toBe("protagonist");
      expect(lw.aliases).toEqual(["阿晚", "晚晚"]);
      expect(lw.attrs?.["情绪克制"]).toBe("高");
      expect(lw.relations?.[0]?.target).toBe("沈默");
      expect(lw.relations?.[0]?.category).toBe("enemy");
      expect(lw.state?.knows).toEqual(["父亲的事"]);
    }
  });

  it("通过别称查找实体", () => {
    const p = loadProject({ root: EXAMPLE });
    expect(findEntity(p, "阿晚")?.id).toBe("lin-wan");
  });

  it("Markdown 实体把正文并入 description", () => {
    const p = loadProject({ root: EXAMPLE });
    const loc = p.entities.find((e) => e.name === "清风茶馆");
    expect(loc?.description).toContain("布帘");
  });

  it("物品解析 holder", () => {
    const p = loadProject({ root: EXAMPLE });
    const item = p.entities.find((e) => e.kind === "item");
    expect(item?.kind === "item" && item.holder).toBe("林晚");
  });

  it("readContent=false 时 content 为空但 wordCount 保留", () => {
    const p = loadProject({ root: EXAMPLE, readContent: false });
    expect(p.chapters[0]?.content).toBe("");
    expect(p.chapters[0]?.wordCount).toBeGreaterThan(0);
  });

  it("buildEntityIndex 含别称", () => {
    const p = loadProject({ root: EXAMPLE });
    const idx = buildEntityIndex(p);
    expect(idx.get("林晚")?.id).toBe("lin-wan");
    expect(idx.get("晚晚")?.id).toBe("lin-wan");
    expect(idx.get("港口商会")?.kind).toBe("faction");
  });
});
