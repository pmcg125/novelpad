/**
 * 书房首页的纯逻辑（无 vscode 依赖）。
 *
 * 为什么单独拆：这一层有两个会被作者立刻看出来的错误，而且都不会报错：
 *   1. 今日字数算错 → 他明明写了三千字，进度环是空的
 *   2. 曲线跳过没写的日子 → 看起来像连着写了两天
 * 两者都只能靠断言守住。
 */
import type { Chapter, Project } from "@novelpad/core";

/* ============================================================
 * 日期
 * ============================================================ */

/** 本地时区的 YYYY-MM-DD */
export function localDayKey(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** 最近 n 天（含今天），从旧到新 */
export function lastNDays(n: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(localDayKey(new Date(now.getTime() - i * 86_400_000)));
  }
  return out;
}

/* ============================================================
 * 曲线
 * ============================================================ */

export interface DayDelta {
  day: string;
  delta: number;
}

export interface CurvePoint {
  day: string;
  delta: number;
}

/**
 * 近七天曲线。
 *
 * 必须补空白天：`groupByDay` 只返回「有存档的那几天」，
 * 直接拿去画线会把「周一写了、周三写了」连成一条经过周二的线，
 * 视觉上等于骗作者他周二也在写。
 */
export function weekCurve(groups: readonly DayDelta[], now: Date = new Date(), days = 7): CurvePoint[] {
  const byDay = new Map(groups.map((g) => [g.day, g.delta]));
  return lastNDays(days, now).map((day) => ({ day, delta: byDay.get(day) ?? 0 }));
}

/** 今日字数：只看今天这一天的净增，与「软件开了多久」无关 */
export function todayDelta(groups: readonly DayDelta[], now: Date = new Date()): number {
  const key = localDayKey(now);
  return groups.find((g) => g.day === key)?.delta ?? 0;
}

/* ============================================================
 * 进度
 * ============================================================ */

export interface Progress {
  /** 0~1，超出目标按 1 算 */
  ratio: number;
  done: boolean;
  /** 离目标还差多少字；已达标为 0 */
  remaining: number;
}

export function progress(done: number, target: number): Progress {
  // 目标可能是作者手滑填的 0 或负数——不能让进度环除以零得出 NaN
  const t = target > 0 ? target : 1;
  const d = Math.max(0, done);
  return {
    ratio: Math.min(1, d / t),
    done: d >= t,
    remaining: Math.max(0, t - d),
  };
}

/* ============================================================
 * 伏笔
 * ============================================================ */

export interface OverdueForeshadow {
  id: string;
  note?: string;
  due: number;
  /** 在哪一章埋下的（标题，用于「第X章埋下」的提示） */
  plantedIn: string;
}

/**
 * 到期未收的伏笔。
 *
 * 三个容易做错的地方：
 *   - `resolvedAt` 是「在第几章回收」的**记录**，不是布尔值；
 *     为 0 也算已回收（第 0 章不存在，但 0 是合法数字，不能用 !resolvedAt 判断）
 *   - 已回收的伏笔 ID 会出现在后续章节的 `resolves` 里——要全局看，
 *     不能只看埋它的那一章
 *   - 没有 `due` 的伏笔不算欠债：作者可能就是没计划什么时候收
 */
export function overdueForeshadows(project: Pick<Project, "chapters">): OverdueForeshadow[] {
  const resolved = new Set<string>();
  for (const c of project.chapters) {
    for (const id of c.frontmatter.resolves ?? []) resolved.add(id);
  }

  const maxOrder = Math.max(0, ...project.chapters.map((c) => c.frontmatter.order));
  const out: OverdueForeshadow[] = [];

  for (const c of project.chapters) {
    for (const f of c.frontmatter.foreshadows ?? []) {
      if (f.resolvedAt !== undefined) continue; // 埋它的那一章自己标了已回收
      if (resolved.has(f.id)) continue; // 后面的章节回收了
      if (f.due === undefined) continue; // 没定什么时候收
      if (f.due > maxOrder) continue; // 还没到期（作者已经写到那里了才算欠）
      out.push({ id: f.id, note: f.note, due: f.due, plantedIn: c.frontmatter.title });
    }
  }

  // 拖得最久的排前面：那是最该先处理的
  out.sort((a, b) => a.due - b.due);
  return out;
}

/* ============================================================
 * 未完成章节
 * ============================================================ */

export interface DraftChapter {
  order: number;
  title: string;
  words: number;
  volume?: string;
  status: string;
}

/** 还没定稿的章节，按顺序 */
export function draftChapters(chapters: readonly Chapter[]): DraftChapter[] {
  return chapters
    .filter((c) => (c.frontmatter.status ?? "draft") !== "final")
    .sort((a, b) => a.frontmatter.order - b.frontmatter.order)
    .map((c) => ({
      order: c.frontmatter.order,
      title: c.frontmatter.title,
      words: c.wordCount,
      volume: c.frontmatter.volume,
      status: c.frontmatter.status ?? "draft",
    }));
}

/* ============================================================
 * 问候
 * ============================================================ */

/** 凌晨还在写的人不该被说「早上好」 */
export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}