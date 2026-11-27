import { describe, expect, it } from "vitest";
import {
  allIndices,
  fromJsonl,
  makeAnchor,
  resolveAll,
  resolveAnchor,
  stats,
  toJsonl,
  type Annotation,
} from "./annotate.js";

describe("makeAnchor", () => {
  it("采集引文与前后文", () => {
    const text = "雨幕里，伞压得很低，露出一截下巴。";
    const a = makeAnchor(text, 4, 7);
    expect(a.quote).toBe("伞压得");
    expect(a.prefix).toBe("雨幕里，");
    expect(a.suffix).toBe("很低，露出一截下巴。");
    expect(a.offset).toBe(4);
  });

  it("文首文末不越界", () => {
    const a = makeAnchor("abc", 0, 3);
    expect(a.prefix).toBe("");
    expect(a.suffix).toBe("");
    expect(a.quote).toBe("abc");
  });

  it("上下文长度可配", () => {
    const a = makeAnchor("0123456789", 4, 6, 2);
    expect(a.prefix).toBe("23");
    expect(a.suffix).toBe("67");
  });
});

describe("resolveAnchor", () => {
  const text = "第一段。雨幕里，伞压得很低，露出一截下巴。第三段。";
  const anchor = makeAnchor(text, text.indexOf("伞压得"), text.indexOf("伞压得") + 3);

  it("文本未变：精确命中", () => {
    const r = resolveAnchor(text, anchor);
    expect(r.via).toBe("exact");
    expect(text.slice(r.start, r.end)).toBe("伞压得");
  });

  it("前面插入内容后仍能定位（offset 漂移）", () => {
    const edited = "新加的一大段开头，很长很长。\n\n" + text;
    const r = resolveAnchor(edited, anchor);
    expect(r.via).toBe("exact");
    expect(edited.slice(r.start, r.end)).toBe("伞压得");
    expect(r.start).not.toBe(anchor.offset);
  });

  it("后文被改写：退到 prefix + quote", () => {
    const edited = text.replace("露出一截下巴", "露出半张脸");
    const r = resolveAnchor(edited, anchor);
    expect(r.via).toBe("prefix");
    expect(edited.slice(r.start, r.end)).toBe("伞压得");
  });

  it("前后文都被改写：退到纯引文", () => {
    const edited = "完全不同的开头。伞压得很低。完全不同的结尾。";
    const r = resolveAnchor(edited, anchor);
    expect(r.via).toBe("quote");
    expect(edited.slice(r.start, r.end)).toBe("伞压得");
  });

  it("同一句出现多次：取离原位置最近的", () => {
    const a = makeAnchor("他说他冷。" + "填充。".repeat(20) + "他说他冷。", 2, 5); // "他冷。"
    const edited = "他说他冷。" + "填充。".repeat(20) + "他说他冷。";
    const r = resolveAnchor(edited, a);
    expect(r.via).toBe("exact");
    expect(r.start).toBe(2);
  });

  it("句尾被删掉一半：还能靠前半段找到", () => {
    const a = makeAnchor("他慢慢地转过身来。", 0, 9); // "他慢慢地转过身来。"
    const edited = "他慢慢地转过身。";
    const r = resolveAnchor(edited, a);
    expect(r.via).toBe("quote");
    // 命中引文的前半段（floor(9/2)=4 字），足以告诉作者「大概是这里」
    expect(edited.slice(r.start, r.end)).toBe("他慢慢地");
  });

  it("原文彻底不存在：标记为 orphaned", () => {
    const edited = "这句话完全换了个写法。";
    const r = resolveAnchor(edited, anchor);
    expect(r.via).toBe("orphaned");
    expect(r.start).toBe(-1);
  });

  it("空引文退化为 offset", () => {
    const r = resolveAnchor("正文", { quote: "", prefix: "", suffix: "", offset: 99 });
    expect(r.via).toBe("offset");
    expect(r.start).toBe(2);
  });
});

describe("allIndices", () => {
  it("列出所有出现位置", () => {
    expect(allIndices("aaaa", "aa")).toEqual([0, 1, 2]);
  });

  it("无命中返回空", () => {
    expect(allIndices("abc", "z")).toEqual([]);
  });

  it("空 needle 返回空", () => {
    expect(allIndices("abc", "")).toEqual([]);
  });
});

describe("resolveAll / stats", () => {
  const text = "甲乙丙丁";
  const mk = (id: string, start: number, end: number, status: Annotation["status"] = "open"): Annotation => ({
    id,
    author: { id: "local" },
    created: "2026-11-27T00:00:00Z",
    file: "chapters/001.md",
    anchor: makeAnchor(text, start, end),
    kind: "comment",
    body: "备注 " + id,
    status,
  });

  it("批量定位，失效的自动改 status 但不改入参", () => {
    const a = mk("a", 0, 2);
    const gone = mk("b", 0, 2);
    gone.anchor = { ...gone.anchor, quote: "不存在的内容", prefix: "", suffix: "" };
    const res = resolveAll(text, [a, gone]);
    expect(res[0].range.via).toBe("exact");
    expect(res[1].range.via).toBe("orphaned");
    expect(res[1].annotation.status).toBe("orphaned");
    expect(gone.status).toBe("open"); // 入参未被修改
  });

  it("统计只算 open 与 orphaned", () => {
    const s = stats([mk("1", 0, 1), mk("2", 1, 2, "accepted"), mk("3", 2, 3, "orphaned")]);
    expect(s).toEqual({ open: 1, orphaned: 1, total: 3 });
  });
});

describe("jsonl 序列化", () => {
  const a: Annotation = {
    id: "a_01",
    author: { id: "editor@example.com", name: "编辑" },
    created: "2026-11-27T10:00:00Z",
    file: "chapters/003.md",
    anchor: { quote: "伞压得很低", prefix: "雨幕里，", suffix: "，露出", offset: 4 },
    kind: "suggestion",
    body: "这里可以再压一句",
    suggestion: { before: "伞压得很低", after: "伞压得极低" },
    status: "open",
  };

  it("往返不丢字段", () => {
    expect(fromJsonl(toJsonl([a]))).toEqual([a]);
  });

  it("坏行跳过，好行保留", () => {
    const bad = toJsonl([a]) + "{ 这不是 json\n\n" + JSON.stringify({ ...a, id: "a_02" }) + "\n";
    const parsed = fromJsonl(bad);
    expect(parsed.map((x) => x.id)).toEqual(["a_01", "a_02"]);
  });

  it("空输入得到空数组", () => {
    expect(fromJsonl("")).toEqual([]);
    expect(toJsonl([])).toBe("");
  });

  it("缺少必要字段的记录被忽略", () => {
    expect(fromJsonl('{"id":"x"}\n{"file":"y"}\n{"id":"z","file":"f"}')).toEqual([]);
  });
});