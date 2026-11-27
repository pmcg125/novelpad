/**
 * 快照索引与写作会话状态。
 *
 * `snapshots.json` 是给界面读的**友好视图**——git 只管存字节，作者要的是
 * 「今天改了什么、改了多少字」。索引坏了可以重建（从 ref 列表反推），
 * 所以它只是缓存，不是真相。
 */
import fs from "node:fs";
import path from "node:path";
import type { ExecFn, TrunkInfo } from "./repo.js";
import { AUTO_KEEP_PER_CHAPTER, AUTO_REF_PREFIX, advanceTrunk, autoRefs, autoRefName, createSnapshot, deleteRef, listRefs, milestoneRefName, MILESTONE_REF_PREFIX, PUBLISH_REF_PREFIX, readProjectFileAt, refExists, resolveTrunk, sanitizeRefComponent, setRef } from "./repo.js";
import { excludeLocalIndex } from "./branch.js";

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

/**
 * 滚动清理：删旧 ref **并同步索引**。
 *
 * 两件事必须一起做。只删 ref 会在索引里留下死记录——时间线照样显示，
 * 点进去取不到内容；只删索引则会留下孤儿 ref，`git gc` 收不走。
 * 这两个模块分成两个文件，所以这里显式把它们配成一对。
 *
 * 返回实际清掉的条数。
 */
export async function pruneAutoSnapshots(
  exec: ExecFn,
  root: string,
  chapterKey: string,
  keep = AUTO_KEEP_PER_CHAPTER,
): Promise<number> {
  if (keep < 1) return 0;
  const prefix = `${AUTO_REF_PREFIX}${sanitizeRefComponent(chapterKey)}/`;
  const refs = await listRefs(exec, root, prefix);
  if (refs.length <= keep) return 0;

  const doomed = refs.slice(keep);
  const gone: string[] = [];
  for (const r of doomed) {
    if (await deleteRef(exec, root, r.name)) gone.push(r.name);
  }
  if (gone.length) removeRecords(root, gone);
  return gone.length;
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
    out.push(synthesize(ref.name, ref.commit, ref.time, "milestone", ref.subject));
  }
  for (const ref of await listRefs(exec, root, PUBLISH_REF_PREFIX)) {
    out.push(synthesize(ref.name, ref.commit, ref.time, "publish", ref.subject));
  }
  for (const ref of await autoRefs(exec, root)) {
    out.push(synthesize(ref.name, ref.commit, ref.time, "auto", ref.subject));
  }
  const idx: SnapshotIndex = { version: 1, snapshots: out };
  saveIndex(root, idx);
  return idx;
}

/**
 * 只把「索引里还没有的 ref」补进索引，**不覆盖已有记录**。
 *
 * 与 rebuildIndex 的区别不是细节：synthesize 只能从 ref 名反推出
 * kind / 时间 / 章节，**推不出作者写的标签、备注、字数和 AI 来源**。
 * 索引丢失时用它兜底是对的（有总比没有强），但换机器取回时如果直接
 * rebuildIndex，本地已有的完整记录会被这份残缺版本盖掉——
 * 「第三章 改完雨夜对峙」变成一条没有时间线的匿名版本。
 *
 * 所以取回走这个函数：已有的一条不动，只补云端新来的。
 */
export async function backfillFromRefs(exec: ExecFn, root: string): Promise<{ added: number; index: SnapshotIndex }> {
  const idx = loadIndex(root);
  const known = new Set(idx.snapshots.map((s) => s.ref));
  const fresh: SnapshotRecord[] = [];

  const collect = async (refs: Awaited<ReturnType<typeof listRefs>>, kind: SnapshotKind) => {
    for (const ref of refs) {
      if (known.has(ref.name)) continue;
      fresh.push(synthesize(ref.name, ref.commit, ref.time, kind, ref.subject));
    }
  };

  await collect(await listRefs(exec, root, MILESTONE_REF_PREFIX), "milestone");
  await collect(await listRefs(exec, root, PUBLISH_REF_PREFIX), "publish");
  await collect(await autoRefs(exec, root), "auto");

  if (fresh.length) {
    idx.snapshots = [...idx.snapshots, ...fresh];
    saveIndex(root, idx);
  }
  return { added: fresh.length, index: idx };
}

/**
 * 从 ref 反推一条索引记录（索引是缓存，ref 才是真相）。
 *
 * `subject` 是提交信息的主题行，也是**唯一还能找回作者标签的途径**：
 * 里程碑的提交信息固定是 `milestone: <作者写的那句>`，所以换一台机器
 * clone + 取回之后，时间线上显示的是「第二章 渡口」而不是一个匿名版本。
 * 不传或格式不符时留空——猜出来的假标签比没有标签更糟。
 *
 * 自动存档的主题（`auto: 003 <时间>`）是内部编号，不是作者写的字，
 * 所以只有里程碑取标签。
 */
function synthesize(
  ref: string,
  commit: string,
  time: string,
  kind: SnapshotKind,
  subject?: string,
): SnapshotRecord {
  const tail = ref.split("/").pop() ?? "";
  const fromRef = ref.startsWith(AUTO_REF_PREFIX) ? ref.slice(AUTO_REF_PREFIX.length).split("/")[0] : undefined;
  const label = kind === "milestone" && subject?.startsWith("milestone: ")
    ? subject.slice("milestone: ".length).trim() || undefined
    : undefined;
  return {
    id: `${kind === "auto" ? "s" : kind === "milestone" ? "m" : "p"}_${tail}`,
    ref,
    commit,
    kind,
    time: time || new Date(0).toISOString(),
    files: [],
    chapter: fromRef,
    ...(label ? { label } : {}),
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
 * 里程碑的返回。比自动存档多两个字段，因为「存一版」除了造版本，
 * 还要把主干推进——而推进可能失败或根本不该做。
 *
 * `ok: true` 只代表**版本存下来了**。`trunkSkipped` 有值时它没进主干，
 * 也就是「备份到云端」不会把它推上去。调用方必须把这个区别告诉作者，
 * 否则他以为点了存就安全了。
 */
export interface MilestoneOutput extends AutoSnapshotOutput {
  /** 推进了哪条分支 */
  trunk?: string;
  /** 没推进主干的原因（人话） */
  trunkSkipped?: string;
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
): Promise<MilestoneOutput> {
  const at = input.at ?? new Date();
  const id = makeId("milestone", at);
  const ref = milestoneRefName(id);

  // 主干是「备份到云端」真正推出去的那条分支。设计里里程碑就该落在它上面
  // （docs/PLAN-VERSIONING.md §2.2：`refs/heads/main` 作者手动里程碑，可见、可推送）。
  const trunk = await resolveTrunk(exec, input.root);

  const place = await milestonePlacement(exec, input.root, trunk);

  // 主干未出生时，这一版就是这部作品的**全部**。
  // 哪怕调用方只给了几个文件，也必须收整个作品目录——否则第一条主稿
  // 里只有那几章，其余章节和设定永远不在主干上（备份出去就是残缺的）。
  // applyMerge 里同样的判断（`baseExists ? writablePaths : ["."]`）。
  const firstOnTrunk = Boolean(trunk && !trunk.tip);
  const paths = firstOnTrunk ? ["."] : input.files && input.files.length ? input.files : undefined;

  const snap = await createSnapshot(exec, input.root, {
    message: `milestone: ${input.label}`,
    paths,
    ref,
    ...place,
  });
  if (!snap.ok) return { ok: false, error: snap.error };

  // 内容与主干一字不差：没有新提交，但作者确实点了一次「存一版」，
  // 标签得留下。把里程碑 ref 补挂到主干顶端那个提交上——不补的话
  // rebuildIndex 扫不到这个 ref，索引一重建这条标签就凭空消失。
  let commit = snap.commit!;
  if (snap.empty && trunk?.tip) {
    commit = trunk.tip;
    await setRef(exec, input.root, ref, trunk.tip);
  }

  const rec = makeRecord({
    kind: "milestone",
    commit,
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

  const out: MilestoneOutput = { ok: true, record: rec, empty: snap.empty };
  if (!trunk) {
    // 分离 HEAD（作者自己 checkout 过 commit）：没有能推进的分支。
    // 硬造一个分支名会把稿子推到他看不见的地方，所以这里只做本地版本。
    out.trunkSkipped = "这部作品当前不在任何分支上（可能手动检出过某个版本），这一版只存在本地。";
    return out;
  }
  out.trunk = trunk.name;

  // 空版没造新提交，主干自然也不用动（内容本来就等于主干顶端）。
  if (snap.empty) return out;

  const adv = await advanceTrunk(exec, input.root, trunk.ref, commit, trunk.tip);
  if (!adv.ok) {
    // 版本已经存下（ref 与索引都在），但主干没前进 → 备份会漏掉这一版。
    // 不能当成成功返回，否则作者以为稿子已经上云了。
    out.trunkSkipped = adv.raced
      ? "另一个窗口同时存了版本，这一版没能接上主干。再点一次「存一版」即可。"
      : `这一版存下来了，但没能接上主干：${adv.error}`;
  }
  return out;
}

/**
 * 里程碑提交该接在谁后面、以什么为基底。
 *
 * 三种情形，区别在于**树的内容从哪来**：
 *
 *   - 主干已存在 → base = 主干整棵树，paths 的改动叠加上去。
 *     没有 base 的话 `git add -A -- <paths>` 得到的树只含本次文件，
 *     主干上其余章节与设定会凭空从历史里消失（这条踩过，见 repo.ts）。
 *   - 分支未出生（新建作品的常态）→ 独立根提交，此刻工作区就是第一版。
 *   - 分离 HEAD → 退回接在 HEAD 上，不碰任何分支。
 */
async function milestonePlacement(
  exec: ExecFn,
  root: string,
  trunk: TrunkInfo | undefined,
): Promise<{ base?: string; parent?: string | "none" }> {
  if (!trunk) return {}; // 默认：接 HEAD
  if (trunk.unborn) {
    // 第一次存版之前必须把本地缓存排除掉，否则 snapshots.json 会进主干，
    // 之后排除它时 `git status` 又显示成「已删除」。
    await excludeLocalIndex(exec, root);
    return { parent: "none" };
  }
  return { base: trunk.tip, parent: trunk.tip };
}

/* ============================================================
 * 主干同步（托管的前置动作）
 * ============================================================ */

export interface TrunkSyncResult {
  ok: boolean;
  /** 主干现在指向的提交 */
  commit?: string;
  /** 内容与主干一致，没有产生新版本 */
  unchanged?: boolean;
  /** 无法同步的原因（人话）。有它时 `ok` 仍可能为 true——本地版本没丢，只是备份带不上 */
  skipped?: string;
  error?: string;
}

/**
 * 把此刻工作区的全部内容同步到主干。
 *
 * 为什么需要它：**自动存档不碰主干**（它们挂 `refs/novelpad/auto/…`，
 * 按章滚动清理）。于是「写完三小时没点存一版，直接点备份」会只推上去
 * 上次里程碑的内容——作者看到"已备份"，云端却是几小时前的稿子。
 *
 * 所以备份前先做一次全量同步。它**不写索引**：主干是托管用的管道，
 * 作者的时间线只关心他主动存的那几版，凭空多出「备份」条目只会刷屏。
 */
export async function syncTrunk(
  exec: ExecFn,
  root: string,
  opts: { message?: string } = {},
): Promise<TrunkSyncResult> {
  const trunk = await resolveTrunk(exec, root);
  if (!trunk) {
    return {
      ok: false,
      skipped: "这部作品当前不在任何分支上（可能手动检出过某个版本），没法把它接到主干备份。请先在源代码管理里切回分支。",
    };
  }

  if (trunk.unborn) {
    await excludeLocalIndex(exec, root);
    const res = await createSnapshot(exec, root, {
      message: opts.message ?? `NovelPad：${new Date().toISOString().slice(0, 10)} 的稿子`,
      paths: ["."],
      parent: "none",
    });
    if (!res.ok) return { ok: false, error: res.error };
    const adv = await advanceTrunk(exec, root, trunk.ref, res.commit!);
    if (!adv.ok) return { ok: false, error: adv.error };
    return { ok: true, commit: res.commit };
  }

  const res = await createSnapshot(exec, root, {
    message: opts.message ?? `NovelPad：${new Date().toISOString().slice(0, 10)} 的稿子`,
    // 全量：主干的意义就是「此刻完整的稿子」
    paths: ["."],
    ref: undefined,
    base: trunk.tip,
    parent: trunk.tip,
    // 与主干顶端一字不差时不造新提交，否则每次备份都多一条空提交
    dedupeAgainst: trunk.tip,
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.empty) return { ok: true, commit: res.commit, unchanged: true };

  const adv = await advanceTrunk(exec, root, trunk.ref, res.commit!, trunk.tip);
  if (!adv.ok) {
    return {
      ok: false,
      error: adv.raced
        ? "另一个窗口同时改了版本，没能接上主干。再点一次备份即可。"
        : adv.error,
    };
  }
  return { ok: true, commit: res.commit };
}

/** 读回某快照中的正文（用于 diff 与预览）；路径相对作品根 */
export async function readSnapshotFile(exec: ExecFn, root: string, rec: SnapshotRecord, relPath: string): Promise<string | undefined> {
  return readProjectFileAt(exec, root, rec.commit, relPath);
}