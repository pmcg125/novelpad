/**
 * 批注存储单测。
 *
 * 这些是**会丢数据**的地方，所以测得比别人密：
 *   - 原子写（中途崩溃不能留下半截文件）
 *   - 一行坏了只丢一条（不能整个文件读不出来）
 *   - 建议的 before 必须从原文截（不能信任调用方传的值）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANNOTATIONS_FILE,
  addAnnotation,
  annotationsPath,
  createAnnotation,
  dedupeById,
  forFile,
  groupByFile,
  loadAnnotations,
  makeAnnotationId,
  openCount,
  removeAnnotation,
  replyToAnnotation,
  saveAnnotations,
  setAnnotationStatus,
  withUniqueId,
} from "./annotations-store.js";
import type { Annotation, AnnotationAuthor } from "./annotate.js";

const AUTHOR: AnnotationAuthor = { id: "editor@example.com", name: "编辑" };
const T0 = new Date("2026-11-27T10:00:00Z");

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "np-ann-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function make(over: Partial<Parameters<typeof createAnnotation>[0]> = {}): Annotation {
  return createAnnotation({
    file: "chapters/003.md",
    text: "雨幕里，伞压得很低，露出一截下巴。",
    start: 4,
    end: 10,
    body: "这里可以再压一句。",
    kind: "comment",
    author: AUTHOR,
    now: T0,
    rand: () => 0.5,
    ...over,
  });
}

describe("id 生成", () => {
  it("带时间前缀，天然按时间排序", () => {
    const a = makeAnnotationId(new Date("2026-11-27T10:00:00Z"), () => 0.1);
    const b = makeAnnotationId(new Date("2026-11-27T11:00:00Z"), () => 0.1);
    expect(a.startsWith("a_20261127100000")).toBe(true);
    expect(a < b).toBe(true);
  });

  it("同毫秒不同随机数产生不同 id", () => {
    const a = makeAnnotationId(T0, () => 0.1);
    const b = makeAnnotationId(T0, () => 0.9);
    expect(a).not.toBe(b);
  });

  it("随机数为 0 时也补满 4 位", () => {
    const id = makeAnnotationId(T0, () => 0);
    expect(id.split("_")[2]).toHaveLength(4);
  });
});

describe("createAnnotation", () => {
  it("从原文截出 quote 与前后文", () => {
    const a = make();
    expect(a.anchor.quote).toBe("伞压得很低，");
    expect(a.anchor.prefix).toBe("雨幕里，");
    expect(a.anchor.suffix).toBe("露出一截下巴。");
    expect(a.anchor.offset).toBe(4);
  });

  it("新批注状态为 open", () => {
    expect(make().status).toBe("open");
  });

  it("越界的选区被夹到文本范围内，不抛异常", () => {
    const a = make({ start: -10, end: 99999 });
    expect(a.anchor.offset).toBe(0);
    expect(a.anchor.quote.length).toBeGreaterThan(0);
  });

  // 关键：before 必须与原文完全一致，否则「接受建议」校验会失败
  it("建议模式的 before 从原文截取，而不是信任调用方", () => {
    const a = make({ kind: "suggestion", suggestion: { after: "伞压得极低，几乎贴着眉骨" } });
    expect(a.suggestion?.before).toBe("伞压得很低，");
    expect(a.suggestion?.after).toBe("伞压得极低，几乎贴着眉骨");
  });

  it("普通批注不带 suggestion 字段", () => {
    const a = make({ kind: "comment", suggestion: { after: "x" } });
    expect(a.suggestion).toBeUndefined();
  });

  it("建议模式但没给 after 时不生成 suggestion", () => {
    const a = make({ kind: "suggestion", suggestion: undefined });
    expect(a.suggestion).toBeUndefined();
  });
});

describe("落盘与读取", () => {
  it("文件不存在时返回空数组（首次使用不该报错）", () => {
    expect(loadAnnotations(root)).toEqual([]);
  });

  it("写入后能读回", () => {
    const a = make();
    addAnnotation(root, a);
    const back = loadAnnotations(root);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(a.id);
    expect(back[0].anchor.quote).toBe(a.anchor.quote);
  });

  it("落在 .novelpad/annotations.jsonl", () => {
    addAnnotation(root, make());
    expect(fs.existsSync(path.join(root, ANNOTATIONS_FILE))).toBe(true);
    expect(annotationsPath(root)).toContain(".novelpad");
  });

  it("一行一条（jsonl，git diff 友好）", () => {
    addAnnotation(root, make());
    addAnnotation(root, make({ start: 0, end: 3 }));
    const lines = fs.readFileSync(annotationsPath(root), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("追加不清掉已有批注", () => {
    addAnnotation(root, make());
    addAnnotation(root, make({ start: 0, end: 2 }));
    expect(loadAnnotations(root)).toHaveLength(2);
  });

  // 同一毫秒 + 同一随机数 → id 相撞。不处理的话删除一条会连坐另一条。
  it("id 相撞时自动顺延，两条都留下", () => {
    const a = make();
    const b = make({ start: 0, end: 2 }); // 固定 rand，id 与 a 完全相同
    expect(b.id).toBe(a.id); // 前提：确实相撞了

    addAnnotation(root, a);
    addAnnotation(root, b);

    const back = loadAnnotations(root);
    expect(back).toHaveLength(2);
    expect(new Set(back.map((x) => x.id)).size).toBe(2);
  });

  it("顺延后删除只影响目标那条", () => {
    const a = make();
    const b = make({ start: 0, end: 2 });
    addAnnotation(root, a);
    addAnnotation(root, b);

    const ids = loadAnnotations(root).map((x) => x.id);
    removeAnnotation(root, ids[0]);
    const back = loadAnnotations(root);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(ids[1]);
  });

  it("withUniqueId 不改变未碰撞的 id", () => {
    const a = make();
    expect(withUniqueId(a, []).id).toBe(a.id);
    expect(withUniqueId(a, [make({ start: 0, end: 1 })]).id).not.toBe(a.id);
  });

  it("id 后缀不是合法 36 进制时也能顺延", () => {
    const weird = { ...make(), id: "a_20260101000000_zzzz" };
    const out = withUniqueId(weird, [weird]);
    expect(out.id).not.toBe(weird.id);
    expect(out.id.startsWith("a_20260101000000_")).toBe(true);
  });

  // 原子写：临时文件必须清理掉，不能留在 .novelpad 里被提交
  it("写完不留 .tmp 残留", () => {
    addAnnotation(root, make());
    const files = fs.readdirSync(path.join(root, ".novelpad"));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("目录不存在时自动创建", () => {
    expect(fs.existsSync(path.join(root, ".novelpad"))).toBe(false);
    saveAnnotations(root, [make()]);
    expect(fs.existsSync(annotationsPath(root))).toBe(true);
  });
});

describe("坏数据的容错", () => {
  it("单个坏行只丢那一条", () => {
    const a = make();
    addAnnotation(root, a);
    const good = fs.readFileSync(annotationsPath(root), "utf8");
    // 中间插一行坏的，再补一条好的
    fs.writeFileSync(annotationsPath(root), `${good}{ 这不是 json\n${JSON.stringify(make({ start: 0, end: 2 }))}\n`);
    const back = loadAnnotations(root);
    expect(back).toHaveLength(2); // 两条好的都在
    expect(back.every((x) => typeof x.id === "string")).toBe(true);
  });

  it("缺关键字段的记录被跳过", () => {
    fs.mkdirSync(path.join(root, ".novelpad"), { recursive: true });
    fs.writeFileSync(
      annotationsPath(root),
      [
        JSON.stringify({ id: "a1" }), // 缺 file/anchor
        JSON.stringify({ file: "x.md", anchor: { quote: "", prefix: "", suffix: "", offset: 0 } }), // 缺 id
        JSON.stringify(make()),
      ].join("\n"),
    );
    const back = loadAnnotations(root);
    expect(back).toHaveLength(1);
  });

  it("空文件返回空数组", () => {
    fs.mkdirSync(path.join(root, ".novelpad"), { recursive: true });
    fs.writeFileSync(annotationsPath(root), "");
    expect(loadAnnotations(root)).toEqual([]);
  });
});

describe("状态迁移", () => {
  it("改状态并持久化", () => {
    const a = make();
    addAnnotation(root, a);
    setAnnotationStatus(root, a.id, "accepted");
    expect(loadAnnotations(root)[0].status).toBe("accepted");
  });

  it("改不存在的 id 不抛异常（另一个窗口可能已删除）", () => {
    addAnnotation(root, make());
    expect(() => setAnnotationStatus(root, "不存在", "resolved")).not.toThrow();
    expect(loadAnnotations(root)).toHaveLength(1);
  });

  it("状态设为 orphaned 后仍保留记录（绝不静默丢弃）", () => {
    const a = make();
    addAnnotation(root, a);
    setAnnotationStatus(root, a.id, "orphaned");
    const back = loadAnnotations(root);
    expect(back).toHaveLength(1);
    expect(back[0].status).toBe("orphaned");
  });
});

describe("线程与删除", () => {
  it("追加回复", () => {
    const a = make();
    addAnnotation(root, a);
    replyToAnnotation(root, a.id, { author: { id: "me" }, time: "2026-11-27T12:00:00Z", body: "同意" });
    replyToAnnotation(root, a.id, { author: { id: "you" }, time: "2026-11-27T13:00:00Z", body: "改好了" });
    const back = loadAnnotations(root)[0];
    expect(back.thread).toHaveLength(2);
    expect(back.thread?.[1].body).toBe("改好了");
  });

  it("回复不存在的批注不抛异常", () => {
    expect(() => replyToAnnotation(root, "nope", { author: { id: "x" }, time: "", body: "" })).not.toThrow();
  });

  it("删除只删指定那条", () => {
    const a = make();
    const b = make({ start: 0, end: 2 });
    addAnnotation(root, a);
    addAnnotation(root, b);
    // 两条 id 相撞，第二条被顺延，所以要按**实际存下的** id 比较
    const ids = loadAnnotations(root).map((x) => x.id);
    removeAnnotation(root, ids[0]);
    const back = loadAnnotations(root);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(ids[1]);
  });
});

describe("查询与分组", () => {
  it("按文件分组", () => {
    const all = [
      make({ file: "chapters/001.md" }),
      make({ file: "chapters/002.md" }),
      make({ file: "chapters/001.md" }),
    ];
    const g = groupByFile(all);
    expect(g.size).toBe(2);
    expect(g.get("chapters/001.md")).toHaveLength(2);
  });

  it("组内按创建时间升序（像旁批的落笔顺序）", () => {
    const early = createAnnotation({
      file: "a.md",
      text: "abcdef",
      start: 0,
      end: 1,
      body: "早",
      kind: "comment",
      author: AUTHOR,
      now: new Date("2026-11-27T09:00:00Z"),
      rand: () => 0.1,
    });
    const late = createAnnotation({
      file: "a.md",
      text: "abcdef",
      start: 0,
      end: 1,
      body: "晚",
      kind: "comment",
      author: AUTHOR,
      now: new Date("2026-11-27T10:00:00Z"),
      rand: () => 0.1,
    });
    const g = groupByFile([late, early]);
    expect(g.get("a.md")?.map((x) => x.body)).toEqual(["早", "晚"]);
  });

  it("forFile 只返回该文件", () => {
    const all = [make({ file: "a.md" }), make({ file: "b.md" })];
    expect(forFile(all, "a.md")).toHaveLength(1);
  });

  it("openCount 只数 open", () => {
    const all = [make(), { ...make(), status: "accepted" as const }, { ...make(), status: "orphaned" as const }];
    expect(openCount(all)).toBe(1);
  });

  // 合并分支时同一 id 会出现两次
  it("dedupeById 保留先出现的那条", () => {
    const a = make();
    const dup = { ...a, body: "后面的版本" };
    const out = dedupeById([a, dup]);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe(a.body);
  });
});