/**
 * 书房首页逻辑单测。
 *
 * 这一层的错误都不会抛异常——它们只是让首页上的数字不对。
 * 作者会先怀疑自己，然后怀疑软件。所以每条都要断言住。
 */
import { describe, expect, it } from "vitest";
import type { Chapter, ChapterFrontmatter } from "@novelpad/core";
import {
  draftChapters,
  greeting,
  lastNDays,
  localDayKey,
  overdueForeshadows,
  progress,
  todayDelta,
  weekCurve,
} from "./studio-rules.js";

function ch(order: number, fm: Partial<ChapterFrontmatter> = {}): Chapter {
  return {
    path: `/n/${order}.md`,
    relativePath: `chapters/${order}.md`,
    frontmatter: { title: `第${order}章`, order, ...fm },
    content: "",
    wordCount: 100,
  };
}

describe("localDayKey", () => {
  it("用本地日期，不是 UTC 日期", () => {
    // 本地时间 23:30 一定属于今天，哪怕 UTC 已经是明天
    const d = new Date(2026, 10, 27, 23, 30, 0);
    expect(localDayKey(d)).toBe("2026-11-27");
  });

  it("凌晨 00:30 属于新的一天", () => {
    const d = new Date(2026, 10, 28, 0, 30, 0);
    expect(localDayKey(d)).toBe("2026-11-28");
  });
});

describe("lastNDays", () => {
  it("含今天，从旧到新", () => {
    const now = new Date(2026, 10, 27, 12, 0, 0);
    expect(lastNDays(3, now)).toEqual(["2026-11-25", "2026-11-26", "2026-11-27"]);
  });

  it("跨月正确", () => {
    const now = new Date(2026, 11, 2, 12, 0, 0);
    expect(lastNDays(3, now)).toEqual(["2026-11-30", "2026-12-01", "2026-12-02"]);
  });
});

describe("weekCurve", () => {
  const now = new Date(2026, 10, 27, 12, 0, 0);

  it("没写的日子补 0，不能直接从周一连到周三", () => {
    const w = weekCurve([{ day: "2026-11-24", delta: 500 }, { day: "2026-11-26", delta: 300 }], now, 5);
    // 11-23 到 11-27
    expect(w.map((p) => p.day)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]);
    expect(w.map((p) => p.delta)).toEqual([0, 500, 0, 300, 0]);
  });

  it("恰好七天，按时间升序", () => {
    const w = weekCurve([], now);
    expect(w).toHaveLength(7);
    expect(w[6]!.day).toBe("2026-11-27");
    expect(w[0]!.day).toBe("2026-11-21");
  });

  it("范围外的旧数据不出现（曲线只讲近七天）", () => {
    const w = weekCurve([{ day: "2026-01-01", delta: 9999 }], now, 7);
    expect(w.some((p) => p.delta === 9999)).toBe(false);
  });

  it("今天有存档时落在最后一个点", () => {
    const w = weekCurve([{ day: "2026-11-27", delta: 1200 }], now, 7);
    expect(w[6]!.delta).toBe(1200);
  });
});

describe("todayDelta", () => {
  const now = new Date(2026, 10, 27, 20, 0, 0);

  it("只算今天这一天", () => {
    const g = [
      { day: "2026-11-26", delta: 3000 },
      { day: "2026-11-27", delta: 800 },
    ];
    expect(todayDelta(g, now)).toBe(800);
  });

  it("今天没写过就是 0（不是昨天的数字）", () => {
    expect(todayDelta([{ day: "2026-11-26", delta: 3000 }], now)).toBe(0);
  });

  it("没有存档时是 0", () => {
    expect(todayDelta([], now)).toBe(0);
  });

  it("删掉的字会让当日净增为负（如实显示，不取绝对值）", () => {
    expect(todayDelta([{ day: "2026-11-27", delta: -200 }], now)).toBe(-200);
  });
});

describe("progress", () => {
  it("一半是 0.5", () => {
    expect(progress(1000, 2000).ratio).toBe(0.5);
  });

  it("超额按 1 算，remaining 为 0", () => {
    const p = progress(3000, 2000);
    expect(p.ratio).toBe(1);
    expect(p.done).toBe(true);
    expect(p.remaining).toBe(0);
  });

  it("目标为 0 时不除出 NaN（作者可能把设置清空）", () => {
    const p = progress(500, 0);
    expect(Number.isNaN(p.ratio)).toBe(false);
    expect(p.ratio).toBe(1);
  });

  it("目标是负数时也不崩", () => {
    const p = progress(0, -100);
    expect(Number.isFinite(p.ratio)).toBe(true);
  });

  it("刚好达标算达成", () => {
    const p = progress(2000, 2000);
    expect(p.done).toBe(true);
    expect(p.ratio).toBe(1);
  });

  it("写了负数字数（删稿）不会变成负进度", () => {
    expect(progress(-50, 2000).ratio).toBe(0);
  });
});

describe("overdueForeshadows", () => {
  it("到期且没回收的才算", () => {
    const p = {
      chapters: [
        ch(1, { title: "第一章", foreshadows: [{ id: "fs-umbrella", due: 3, note: "红伞" }] }),
        ch(2),
        ch(3),
      ],
    };
    const out = overdueForeshadows(p);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("fs-umbrella");
    expect(out[0]!.plantedIn).toBe("第一章");
  });

  it("后面的章节 resolves 了就不算欠", () => {
    const p = {
      chapters: [
        ch(1, { foreshadows: [{ id: "fs-umbrella", due: 2 }] }),
        ch(2, { resolves: ["fs-umbrella"] }),
        ch(3),
      ],
    };
    expect(overdueForeshadows(p)).toEqual([]);
  });

  it("埋下时就标了 resolvedAt 的不算欠（0 也算已回收）", () => {
    const p = {
      chapters: [ch(1, { foreshadows: [{ id: "fs-a", due: 1, resolvedAt: 0 }] }), ch(2)],
    };
    expect(overdueForeshadows(p)).toEqual([]);
  });

  it("还没到期的（due 超过最新章）不算欠", () => {
    const p = { chapters: [ch(1, { foreshadows: [{ id: "fs-a", due: 99 }] }), ch(2)] };
    expect(overdueForeshadows(p)).toEqual([]);
  });

  it("没写 due 的不算欠（作者可能本来就没打算定时收）", () => {
    const p = { chapters: [ch(1, { foreshadows: [{ id: "fs-a" }] }), ch(2)] };
    expect(overdueForeshadows(p)).toEqual([]);
  });

  it("拖得最久的排最前", () => {
    const p = {
      chapters: [
        ch(1, { foreshadows: [{ id: "late", due: 5 }, { id: "early", due: 2 }] }),
        ch(5),
      ],
    };
    const out = overdueForeshadows(p);
    expect(out.map((f) => f.id)).toEqual(["early", "late"]);
  });

  it("同一章里解析失败（坏 frontmatter）时不崩", () => {
    const p = { chapters: [ch(1, { foreshadows: undefined })] };
    expect(overdueForeshadows(p)).toEqual([]);
  });
});

describe("draftChapters", () => {
  it("final 的不列出", () => {
    const out = draftChapters([ch(1, { status: "final" }), ch(2, { status: "draft" })]);
    expect(out.map((c) => c.order)).toEqual([2]);
  });

  it("没有 status 时按 draft 算", () => {
    expect(draftChapters([ch(1)])[0]!.status).toBe("draft");
  });

  it("按 order 升序，不管输入顺序", () => {
    const out = draftChapters([ch(3), ch(1), ch(2)]);
    expect(out.map((c) => c.order)).toEqual([1, 2, 3]);
  });

  it("空作品返回空数组", () => {
    expect(draftChapters([])).toEqual([]);
  });
});

describe("greeting", () => {
  it("凌晨说的是夜深了，不是早上好", () => {
    expect(greeting(new Date(2026, 10, 27, 2, 0))).toBe("夜深了");
  });

  it("四个时段各自正确", () => {
    expect(greeting(new Date(2026, 10, 27, 9, 0))).toBe("早上好");
    expect(greeting(new Date(2026, 10, 27, 12, 0))).toBe("中午好");
    expect(greeting(new Date(2026, 10, 27, 16, 0))).toBe("下午好");
    expect(greeting(new Date(2026, 10, 27, 21, 0))).toBe("晚上好");
  });
});