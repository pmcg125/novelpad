/**
 * 快照索引与写作会话状态。
 *
 * `snapshots.json` 是给界面读的**友好视图**——git 只管存字节，作者要的是
 * 「今天改了什么、改了多少字」。索引坏了可以重建（从 ref 列表反推），
 * 所以它只是缓存，不是真相。
 */
import fs from "node:fs";
import path from "node:path";
import type { ExecFn } from "./repo.js";
import { AUTO_REF_PREFIX, autoRefs, autoRefName, createSnapshot, listRefs, milestoneRefName, MILESTONE_REF_PREFIX, PUBLISH_REF_PREFIX, readFileAt, refExists } from "./repo.js";

/* ============================================================
 * 类型
 * ============================================================ */

export type SnapshotKind = "auto" | "milestone" | "publish";

/** 改动来源：人写的，还是 AI 续写进来的 */
export type Origin = { kind: "human" } | { kind: "ai"; prompt?: string; model?: string };

export interface SnapshotRecord {
  id: string;
  ref: string;
  commit: string;
  kind: SnapshotKind;
  /** ISO 时间 */
  time: string;
  /** 里程碑 / 发布版才有的人类标签 */
  label?: string;
  /** 可选备注 */
  note?: string;
  /** 本次涉及的文件（相对作品根） */
  files: string[];
  /** 所属章节 key（自动存档按章节分桶） */
  chapter?: string;
  /** 字数快照 */
  words?: { total: number; delta: number };
  origin: Origin;
}

export interface SnapshotIndex {
  /** 索引格式版本，便于以后迁移 */
  version: 1;
  snapshots: SnapshotRecord[];
}

/** 写作会话：用于算「本次写作净增多少字」 */
export interface SessionState {
  /** 会话开始时间 ISO */
  started: string;
  /** 开始时的字数 */
  startWords: number;
  /** 最近一次快照时间 */
  lastSnapshot?: string;
  /** 最近一次落盘的字数 */
  lastWords?: number;
}

/* ============================================================
 * 路径
 * ============================================================ */

export const META_DIR = path.join(".novelpad", "version");
export const INDEX_FILE = "snapshots.json";
export const SESSION_FILE = "session.json";

export function indexPath(root: string): string {
  return path.join(root, META_DIR, INDEX_FILE);
}

export function sessionPath(root: string): string {
  return path.join(root, META_DIR, SESSION_FILE);
}

/* ============================================================
 * 原子读写
 * ============================================================ */

/** 先写临时文件再 rename：断电也不会留下半截 JSON */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function loadIndex(root: string): SnapshotIndex {
  const idx = readJson<SnapshotIndex>(indexPath(root), { version: 1, snapshots: [] });
  if (!Array.isArray(idx.snapshots)) return { version: 1, snapshots: [] };
  return idx;
}

export function saveIndex(root: string, idx: SnapshotIndex): void {
  // 新到旧，界面直接按序渲染
  const snapshots = [...idx.snapshots].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  writeJsonAtomic(indexPath(root), { version: 1, snapshots });
}

export function loadSession(root: string): SessionState | undefined {
  return readJson<SessionState | undefined>(sessionPath(root), undefined);
}

export function saveSession(root: string, s: SessionState): void {
  writeJsonAtomic(sessionPath(root), s);
}

/* ============================================================
 * ID
 * ============================================================ */

/** 稳定、按时间可排序、无碰撞（同毫秒加随机尾） */
export function makeId(kind: SnapshotKind, at: Date, rand = Math.random): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const ts = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}_${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  const tail = p(Math.floor(rand() * 0xffff), 4);
  return `${kind === "auto" ? "s" : kind === "milestone" ? "m" : "p"}_${ts}_${tail}`;
}

/* ============================================================
 * 记录写入
 * ============================================================ */

export interface RecordInput {
  kind: SnapshotKind;
  commit: string;
  ref: string;
  at: Date;
  files: string[];
  chapter?: string;
  label?: string;
  note?: string;
  words?: { total: number; delta: number };
  origin?: Origin;
  id?: string;
}

export function makeRecord(input: RecordInput): SnapshotRecord {
  return {
    id: input.id ?? makeId(input.kind, input.at),
    ref: input.ref,
    commit: input.commit,
    kind: input.kind,
    time: input.at.toISOString(),
    label: input.label,
    note: input.note,
    files: input.files,
    chapter: input.chapter,
    words: input.words,
    origin: input.origin ?? { kind: "human" },
  };
}

/** 追加一条记录并落盘；同一 commit 已存在时更新而不是重复添加 */
export function appendRecord(root: string, rec: SnapshotRecord): SnapshotIndex {
  const idx = loadIndex(root);
  const at = idx.snapshots.findIndex((s) => s.commit === rec.commit && s.kind === rec.kind);
  if (at >= 0) idx.snapshots[at] = { ...idx.snapshots[at], ...rec };
  else idx.snapshots.push(rec);
  saveIndex(root, idx);
  return idx;
}

export function removeRecords(root: string, refs: readonly string[]): SnapshotIndex {
  const idx = loadIndex(root);
  const drop = new Set(refs);
  idx.snapshots = idx.snapshots.filter((s) => !drop.has(s.ref));
  saveIndex(root, idx);
  return idx;
}

/* ============================================================
 * 切片与统计
 * ============================================================ */

/** 按天分组（本地时区），用于时间线渲染 */
export interface DayGroup {
  /** YYYY-MM-DD */
  day: string;
  records: SnapshotRecord[];
  /** 当天净增字数 */
  delta: number;
}

export function groupByDay(records: readonly SnapshotRecord[], tzOffsetMinutes = -new Date().getTimezoneOffset()): DayGroup[] {
  const groups = new Map<string, SnapshotRecord[]>();
  for (const r of records) {
    const t = new Date(r.time);
    // 用本地日期，而不是 UTC——作者眼里的「今天」是本地的今天
    const local = new Date(t.getTime() + tzOffsetMinutes * 60_000);
    const day = local.toISOString().slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(r);
  }
  return [...groups.entries()]
    .map(([day, recs]) => ({
      day,
      records: recs.sort((a, b) => (a.time < b.time ? 1 : -1)),
      delta: recs.reduce((s, r) => s + (r.words?.delta ?? 0), 0),
    }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** 字数曲线：按天累计 / 当日值 */
export interface WordPoint {
  day: string;
  total: number;
  delta: number;
}

export function wordSeries(groups: readonly DayGroup[]): WordPoint[] {
  // 从旧到新，方便直接画折线
  const asc = [...groups].sort((a, b) => (a.day < b.day ? -1 : 1));
  return asc.map((g) => ({
    day: g.day,
    // 当天最后一个快照的累计字数；没有字数信息时退回 0
    total: g.records.find((r) => r.words)?.words?.total ?? 0,
    delta: g.delta,
  }));
}

export interface Overview {
  total: number;
  auto: number;
  milestone: number;
  publish: number;
  /** 最近 7 天净增字数 */
  weekDelta: number;
  /** 最近一次快照 */
  latest?: SnapshotRecord;
}

export function overview(records: readonly SnapshotRecord[], now = new Date()): Overview {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const recent = records.filter((r) => r.time >= weekAgo);
  return {
    total: records.length,
    auto: records.filter((r) => r.kind === "auto").length,
    milestone: records.filter((r) => r.kind === "milestone").length,
    publish: records.filter((r) => r.kind === "publish").length,
    weekDelta: recent.reduce((s, r) => s + (r.words?.delta ?? 0), 0),
    latest: [...records].sort((a, b) => (a.time < b.time ? 1 : -1))[0],
  };
}

/** 只看 AI 引入的改动（供「撤销这次续写」筛选） */
export function aiRecords(records: readonly SnapshotRecord[]): SnapshotRecord[] {
  return records.filter((r) => r.origin.kind === "ai");
}

/* ============================================================
 * 从 ref 重建索引（索引丢失时的兜底）
 * ============================================================ */

export async function rebuildIndex(exec: ExecFn, root: string): Promise<SnapshotIndex> {
  const out: SnapshotRecord[] = [];
  for (const ref of await listRefs(exec, root, MILESTONE_REF_PREFIX)) {
    out.push(synthesize(ref.name, ref.commit, ref.time, "milestone"));
  }
  for (const ref of await listRefs(exec, root, PUBLISH_REF_PREFIX)) {
    out.push(synthesize(ref.name, ref.commit, ref.time, "publish"));
  }
  for (const ref of await autoRefs(exec, root)) {
    out.push(synthesize(ref.name, ref.commit, ref.time, "auto"));
  }
  const idx: SnapshotIndex = { version: 1, snapshots: out };
  saveIndex(root, idx);
  return idx;
}

function synthesize(ref: string, commit: string, time: string, kind: SnapshotKind): SnapshotRecord {
  const tail = ref.split("/").pop() ?? "";
  const fromRef = ref.startsWith(AUTO_REF_PREFIX) ? ref.slice(AUTO_REF_PREFIX.length).split("/")[0] : undefined;
  return {
    id: `${kind === "auto" ? "s" : kind === "milestone" ? "m" : "p"}_${tail}`,
    ref,
    commit,
    kind,
    time: time || new Date(0).toISOString(),
    files: [],
    chapter: fromRef,
    origin: { kind: "human" },
  };
}

/* ============================================================
 * 编排：一次自动存档
 * ============================================================ */

export interface AutoSnapshotInput {
  root: string;
  chapterKey: string;
  files: readonly string[];
  /** 当前全书字数 */
  totalWords: number;
  /** 与上一次快照相比的净增 */
  deltaWords: number;
  origin?: Origin;
  at?: Date;
}

export interface AutoSnapshotOutput {
  ok: boolean;
  record?: SnapshotRecord;
  empty?: boolean;
  error?: string;
}

/**
 * 打一次自动存档并更新索引与会话。
 * 内容没变时返回 `empty: true` 且不写索引——避免时间线被空记录刷屏。
 */
export async function autoSnapshot(exec: ExecFn, input: AutoSnapshotInput): Promise<AutoSnapshotOutput> {
  const at = input.at ?? new Date();
  const idx = loadIndex(input.root);

  // 同一章节上一版的内容：自动存档是独立根提交，没有父可比，显式拿它做去重。
  //
  // 不能按「ref 与本条不同」来筛掉刚写的记录：stamp 只到毫秒，同一毫秒内连打两次
  // ref 必然相同，而那条正是要被覆盖的上一版。筛掉它就等于放弃去重，
  // 「内容没变」会退化成「又存了一版」。Linux 上文件操作够快，两次调用稳定落在
  // 同一毫秒，CI 会踩中；Windows 恰好跨了毫秒，本地就看不出来。
  const prev = idx.snapshots
    .filter((s) => s.kind === "auto" && s.chapter === input.chapterKey)
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : a.ref < b.ref ? 1 : -1))[0];

  // 一个快照一个 ref。撞名（同一毫秒、内容又不同）就加序号：
  // 否则 update-ref 会覆盖上一条，索引里留下两条指向同一 ref 的记录，
  // 清理时删一个 ref 会连带丢掉两次存档。
  //
  // 序号从索引里的已知 ref 推，不循环探测 git：探测循环一旦遇上「什么都返回成功」
  // 的执行器就永不退出（测试里的桩就是这样，vitest 直接被拖死）。
  const base = autoRefName(input.chapterKey, at);
  let ref = base;
  const taken = new Set(idx.snapshots.map((s) => s.ref));
  if (taken.has(ref) || (await refExists(exec, input.root, ref))) {
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    ref = `${base}-${n}`;
  }
  const res = await createSnapshot(exec, input.root, {
    message: `auto: ${input.chapterKey} ${at.toISOString()}`,
    paths: input.files.length ? input.files : undefined,
    ref,
    // 自动存档造独立根提交：每个快照互不依赖，滚动清理只需删 ref
    parent: "none",
    dedupeAgainst: prev?.commit,
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.empty) return { ok: true, empty: true };

  const rec = makeRecord({
    kind: "auto",
    commit: res.commit!,
    ref,
    at,
    files: [...input.files],
    chapter: input.chapterKey,
    words: { total: input.totalWords, delta: input.deltaWords },
    origin: input.origin,
  });
  appendRecord(input.root, rec);
  const session = loadSession(input.root);
  if (session) {
    session.lastSnapshot = at.toISOString();
    session.lastWords = input.totalWords;
    saveSession(input.root, session);
  }
  return { ok: true, record: rec };
}

/** 打一个里程碑（作者手动「存一版」） */
export async function milestoneSnapshot(
  exec: ExecFn,
  input: { root: string; label: string; note?: string; files?: readonly string[]; totalWords: number; deltaWords?: number; at?: Date },
): Promise<AutoSnapshotOutput> {
  const at = input.at ?? new Date();
  const id = makeId("milestone", at);
  const ref = milestoneRefName(id);
  const res = await createSnapshot(exec, input.root, {
    message: `milestone: ${input.label}`,
    paths: input.files && input.files.length ? input.files : undefined,
    ref,
    // 里程碑接在 HEAD 上，形成可读的连续历史（作者推 GitHub 时看得懂）
  });
  if (!res.ok) return { ok: false, error: res.error };

  const rec = makeRecord({
    kind: "milestone",
    commit: res.commit!,
    ref,
    at,
    files: input.files ? [...input.files] : [],
    label: input.label,
    note: input.note,
    words: { total: input.totalWords, delta: input.deltaWords ?? 0 },
    origin: { kind: "human" },
    id,
  });
  appendRecord(input.root, rec);
  return { ok: true, record: rec, empty: res.empty };
}

/** 读回某快照中的正文（用于 diff 与预览） */
export async function readSnapshotFile(exec: ExecFn, root: string, rec: SnapshotRecord, relPath: string): Promise<string | undefined> {
  return readFileAt(exec, root, rec.commit, relPath);
}