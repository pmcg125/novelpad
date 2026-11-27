import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aiRecords,
  appendRecord,
  autoSnapshot,
  groupByDay,
  indexPath,
  loadIndex,
  loadSession,
  makeId,
  makeRecord,
  milestoneSnapshot,
  overview,
  rebuildIndex,
  removeRecords,
  saveIndex,
  saveSession,
  sessionPath,
  wordSeries,
  writeJsonAtomic,
  type SnapshotRecord,
} from "./snapshot.js";
import { autoRefName, MILESTONE_REF_PREFIX, PUBLISH_REF_PREFIX, type ExecFn, type ExecResult } from "./repo.js";

/* ============================================================
 * 最小假 git（只覆盖 snapshot.ts 用到的命令）
 * ============================================================ */

function makeGit(over: { dirty?: boolean } = {}) {
  const refs = new Map<string, string>();
  const parents = new Map<string, string>();
  const times = new Map<string, string>();
  const trees = new Map<string, string>();
  const objects = new Set<string>();
  const current = { tree: "tree-0", dirty: over.dirty ?? true, seq: 0, refs, parents, times, trees };

  const exec: ExecFn = async (args) => {
    const cmd = args[0];
    const ok = (s = ""): ExecResult => ({ code: 0, stdout: s, stderr: "" });
    const bad = (s = "boom"): ExecResult => ({ code: 1, stdout: "", stderr: s });

    if (cmd === "add") return ok();
    if (cmd === "write-tree") {
      if (!current.dirty) return ok(current.tree);
      current.seq++;
      current.tree = "tree-" + current.seq;
      return ok(current.tree);
    }
    if (cmd === "rev-parse") {
      const spec = args[args.length - 1];
      if (spec.startsWith("HEAD")) return bad();
      if (spec.endsWith("^{tree}")) {
        const id = spec.replace(/\^\{tree\}$/, "");
        // 直接给 commit id 也认（去重比较会这么用）
        const t = trees.get(id) ?? (objects.has(id) ? "tree-" + id.slice(1) : undefined);
        return t ? ok(t + "\n") : bad();
      }
      const id = refs.get(spec.replace(/\^\{commit\}$/, ""));
      return id ? ok(id + "\n") : bad();
    }
    if (cmd === "commit-tree") {
      current.seq++;
      const tree = args[1];
      const id = "c" + current.seq;
      objects.add(id);
      trees.set(id, tree);
      times.set(id, new Date(Date.UTC(2026, 10, 27, 10, 0, current.seq)).toISOString());
      const pi = args.indexOf("-p");
      if (pi > 0) parents.set(id, args[pi + 1]);
      return ok(id + "\n");
    }
    if (cmd === "update-ref") {
      if (args[1] === "-d") refs.delete(args[2]);
      else refs.set(args[1], args[2]);
      return ok();
    }
    if (cmd === "show-ref") {
      const ref = args[args.length - 1];
      return refs.has(ref) ? ok() : bad("not found");
    }
    if (cmd === "for-each-ref") {
      const prefix = args[args.length - 1];
      const names = [...refs.keys()].filter((r) => r.startsWith(prefix)).sort();
      return ok(names.map((n) => `${n}\u001f${refs.get(n)}\u001f${times.get(refs.get(n)!) ?? ""}`).join("\n"));
    }
    if (cmd === "show") {
      const [commit, p] = args[1].split(":");
      return objects.has(commit) && p ? ok("正文 " + commit + " " + p) : bad();
    }
    return bad("unhandled " + args.join(" "));
  };
  return { exec, current };
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novelpad-snap-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/* ============================================================
 * 索引读写
 * ============================================================ */

describe("索引读写", () => {
  it("原子写：文件内容合法且目录自动创建", () => {
    const file = path.join(root, "deep", "a.json");
    writeJsonAtomic(file, { x: 1 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ x: 1 });
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("文件缺失或损坏时返回空索引，不抛异常", () => {
    expect(loadIndex(root).snapshots).toEqual([]);
    fs.mkdirSync(path.dirname(indexPath(root)), { recursive: true });
    fs.writeFileSync(indexPath(root), "{ 坏掉的 json");
    expect(loadIndex(root)).toEqual({ version: 1, snapshots: [] });
  });

  it("存盘按时间新到旧排序", () => {
    const recs = [
      makeRecord({ kind: "auto", commit: "a", ref: "r1", at: new Date("2026-11-25T00:00:00Z"), files: [] }),
      makeRecord({ kind: "auto", commit: "b", ref: "r2", at: new Date("2026-11-27T00:00:00Z"), files: [] }),
    ];
    saveIndex(root, { version: 1, snapshots: recs });
    expect(loadIndex(root).snapshots.map((s) => s.commit)).toEqual(["b", "a"]);
  });

  it("会话状态可往返", () => {
    expect(loadSession(root)).toBeUndefined();
    saveSession(root, { started: "2026-11-27T09:00:00Z", startWords: 1000 });
    expect(loadSession(root)).toMatchObject({ startWords: 1000 });
    expect(fs.existsSync(sessionPath(root))).toBe(true);
  });
});

describe("makeId", () => {
  it("带类型前缀与时间，同类型可按字符串排序", () => {
    const a = makeId("auto", new Date(2026, 10, 27, 9, 5, 3), () => 0.1);
    const b = makeId("auto", new Date(2026, 10, 27, 9, 5, 4), () => 0.1);
    const c = makeId("milestone", new Date(2026, 10, 27, 9, 5, 4), () => 0.1);
    expect(a).toMatch(/^s_20261127_090503_\d{4}$/);
    expect(c.startsWith("m_20261127_090504_")).toBe(true);
    expect(a < b).toBe(true);
  });

  it("同毫秒加随机尾避免碰撞", () => {
    const at = new Date(2026, 10, 27, 9, 0, 0);
    const ids = new Set<string>();
    const seq = [0, 0.25, 0.5, 0.75];
    seq.forEach((r) => ids.add(makeId("auto", at, () => r)));
    expect(ids.size).toBe(4);
  });
});

/* ============================================================
 * 记录
 * ============================================================ */

describe("makeRecord / appendRecord / removeRecords", () => {
  it("缺省 origin 为 human", () => {
    const r = makeRecord({ kind: "auto", commit: "c", ref: "r", at: new Date("2026-11-27T00:00:00Z"), files: ["a.md"] });
    expect(r.origin).toEqual({ kind: "human" });
    expect(r.time).toBe("2026-11-27T00:00:00.000Z");
  });

  it("同 commit 同类型重复追加时更新而非重复", () => {
    appendRecord(root, makeRecord({ kind: "milestone", commit: "c1", ref: "r", at: new Date(), files: [], label: "初稿" }));
    appendRecord(root, makeRecord({ kind: "milestone", commit: "c1", ref: "r", at: new Date(), files: [], label: "改过的标签" }));
    const idx = loadIndex(root);
    expect(idx.snapshots).toHaveLength(1);
    expect(idx.snapshots[0].label).toBe("改过的标签");
  });

  it("按 ref 删除", () => {
    appendRecord(root, makeRecord({ kind: "auto", commit: "c1", ref: "r1", at: new Date(), files: [] }));
    appendRecord(root, makeRecord({ kind: "auto", commit: "c2", ref: "r2", at: new Date(), files: [] }));
    removeRecords(root, ["r1"]);
    expect(loadIndex(root).snapshots.map((s) => s.ref)).toEqual(["r2"]);
  });
});

/* ============================================================
 * 分组与统计
 * ============================================================ */

function rec(over: Partial<SnapshotRecord> & { time: string }): SnapshotRecord {
  return {
    id: "x",
    ref: "r",
    commit: "c",
    kind: "auto",
    files: [],
    origin: { kind: "human" },
    ...over,
  };
}

describe("groupByDay", () => {
  it("按本地日期分组，组内新到旧，组间新到旧", () => {
    const records = [
      rec({ time: "2026-11-27T02:00:00.000Z", commit: "a" }),
      rec({ time: "2026-11-27T10:00:00.000Z", commit: "b" }),
      rec({ time: "2026-11-26T10:00:00.000Z", commit: "c" }),
    ];
    const g = groupByDay(records, 480); // UTC+8
    expect(g.map((x) => x.day)).toEqual(["2026-11-27", "2026-11-26"]);
    // 组内新到旧：本地 18:00（b）在 10:00（a）之前
    expect(g[0].records.map((r) => r.commit)).toEqual(["b", "a"]);
    expect(g[0].records.length + g[1].records.length).toBe(3);
  });

  it("统计当天净增字数", () => {
    const g = groupByDay(
      [
        rec({ time: "2026-11-27T02:00:00.000Z", words: { total: 100, delta: 100 } }),
        rec({ time: "2026-11-27T03:00:00.000Z", words: { total: 150, delta: 50 } }),
      ],
      0,
    );
    expect(g[0].delta).toBe(150);
  });

  it("空输入返回空数组", () => {
    expect(groupByDay([], 0)).toEqual([]);
  });
});

describe("wordSeries", () => {
  it("从旧到新，取当天最后一个有字数信息的快照", () => {
    const groups = groupByDay(
      [
        rec({ time: "2026-11-27T02:00:00.000Z", words: { total: 100, delta: 100 } }),
        rec({ time: "2026-11-27T05:00:00.000Z", words: { total: 180, delta: 80 } }),
        rec({ time: "2026-11-26T02:00:00.000Z", words: { total: 60, delta: 60 } }),
      ],
      0,
    );
    const s = wordSeries(groups);
    expect(s.map((p) => p.day)).toEqual(["2026-11-26", "2026-11-27"]);
    expect(s[1]).toEqual({ day: "2026-11-27", total: 180, delta: 180 });
  });

  it("没有字数信息时 total 为 0，不崩", () => {
    const s = wordSeries(groupByDay([rec({ time: "2026-11-27T02:00:00.000Z" })], 0));
    expect(s[0].total).toBe(0);
  });
});

describe("overview / aiRecords", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const records = [
    rec({ time: "2026-11-27T02:00:00Z", kind: "auto", words: { total: 10, delta: 10 } }),
    rec({ time: "2026-11-26T02:00:00Z", kind: "milestone", label: "存一版", words: { total: 20, delta: 5 } }),
    rec({ time: "2026-11-01T02:00:00Z", kind: "publish", words: { total: 5, delta: 5 } }),
    rec({ time: "2026-11-27T03:00:00Z", kind: "auto", origin: { kind: "ai", model: "m" }, words: { total: 30, delta: 10 } }),
  ];

  it("分类计数与最近 7 天净增", () => {
    const o = overview(records, now);
    expect(o).toMatchObject({ total: 4, auto: 2, milestone: 1, publish: 1 });
    expect(o.weekDelta).toBe(25); // 只算 11-20 之后
    expect(o.latest?.time).toBe("2026-11-27T03:00:00Z");
  });

  it("空列表不崩", () => {
    expect(overview([], now)).toMatchObject({ total: 0, weekDelta: 0, latest: undefined });
  });

  it("筛选 AI 来源的记录", () => {
    expect(aiRecords(records).map((r) => r.origin.kind)).toEqual(["ai"]);
  });
});

/* ============================================================
 * 编排
 * ============================================================ */

describe("autoSnapshot", () => {
  it("成功时写索引并更新会话", async () => {
    const { exec } = makeGit();
    saveSession(root, { started: "2026-11-27T09:00:00Z", startWords: 1000 });
    const r = await autoSnapshot(exec, {
      root,
      chapterKey: "001",
      files: ["chapters/001.md"],
      totalWords: 1312,
      deltaWords: 312,
      at: new Date("2026-11-27T14:32:00Z"),
    });
    expect(r.ok).toBe(true);
    expect(r.empty).toBeUndefined();
    expect(r.record?.kind).toBe("auto");
    expect(r.record?.chapter).toBe("001");
    expect(loadIndex(root).snapshots).toHaveLength(1);
    expect(loadSession(root)).toMatchObject({ lastWords: 1312 });
  });

  it("内容没变时返回 empty 且不写索引", async () => {
    const { exec, current } = makeGit();
    await autoSnapshot(exec, { root, chapterKey: "001", files: [], totalWords: 10, deltaWords: 10 });
    current.dirty = false;
    const r = await autoSnapshot(exec, { root, chapterKey: "001", files: [], totalWords: 10, deltaWords: 0 });
    expect(r.empty).toBe(true);
    expect(loadIndex(root).snapshots).toHaveLength(1);
  });

  // 回归：同一毫秒内连打两次（Linux 上文件操作够快，稳定触发）。
  // 之前按 `ref !== 当前 ref` 筛上一版，撞名时会把唯一的参照提交筛掉，
  // 去重失效 → 内容没变也存一版，CI 在 ubuntu 上红。
  it("同一毫秒内第二次存档仍能正确去重", async () => {
    const { exec, current } = makeGit();
    const at = new Date(2026, 10, 27, 9, 0, 0, 123);
    const a = await autoSnapshot(exec, { root, chapterKey: "002", files: [], totalWords: 10, deltaWords: 10, at });
    expect(a.ok).toBe(true);
    expect(a.empty).toBeUndefined();

    // 内容未变：第二次必须判空
    current.dirty = false;
    const b = await autoSnapshot(exec, { root, chapterKey: "002", files: [], totalWords: 10, deltaWords: 0, at });
    expect(b.empty).toBe(true);
    expect(loadIndex(root).snapshots).toHaveLength(1);
  });

  // 同一毫秒但内容真的变了：ref 撞名要加序号，不能覆盖上一条。
  // 覆盖会让索引里两条记录指向同一 ref，清理时删一个 ref 丢两次存档。
  it("同一毫秒内容不同时不覆盖上一条 ref", async () => {
    const { exec, current } = makeGit();
    const at = new Date(2026, 10, 27, 9, 0, 0, 123);
    await autoSnapshot(exec, { root, chapterKey: "004", files: [], totalWords: 10, deltaWords: 10, at });
    current.dirty = true; // 内容变了，write-tree 会给新树
    await autoSnapshot(exec, { root, chapterKey: "004", files: [], totalWords: 20, deltaWords: 10, at });

    const snaps = loadIndex(root).snapshots;
    expect(snaps).toHaveLength(2);
    // 一个快照一个 ref：两条记录的 ref 必须不同
    expect(new Set(snaps.map((s) => s.ref)).size).toBe(2);
    expect([...current.refs.keys()]).toHaveLength(2);
  });

  it("AI 来源被记录，可用于后续筛选", async () => {
    const { exec } = makeGit();
    await autoSnapshot(exec, {
      root,
      chapterKey: "003",
      files: ["chapters/003.md"],
      totalWords: 5000,
      deltaWords: 820,
      origin: { kind: "ai", prompt: "续写雨夜", model: "deepseek-v4.1-flash" },
    });
    const recs = aiRecords(loadIndex(root).snapshots);
    expect(recs).toHaveLength(1);
    expect(recs[0].origin).toMatchObject({ kind: "ai", model: "deepseek-v4.1-flash" });
  });

  it("git 失败时返回 error，不写索引", async () => {
    const exec: ExecFn = async (a) => (a[0] === "add" ? { code: 1, stdout: "", stderr: "locked" } : { code: 0, stdout: "", stderr: "" });
    const r = await autoSnapshot(exec, { root, chapterKey: "001", files: [], totalWords: 1, deltaWords: 1 });
    expect(r).toMatchObject({ ok: false, error: "locked" });
    expect(loadIndex(root).snapshots).toHaveLength(0);
  });

  it("自动存档用独立 ref，不进 refs/heads", async () => {
    const { exec, current } = makeGit();
    await autoSnapshot(exec, { root, chapterKey: "001", files: [], totalWords: 1, deltaWords: 1, at: new Date(2026, 10, 27, 9, 0) });
    const refs = [...current.refs.keys()];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe(autoRefName("001", new Date(2026, 10, 27, 9, 0)));
    expect(refs[0].startsWith("refs/heads/")).toBe(false);
  });
});

describe("milestoneSnapshot", () => {
  it("写入带标签的里程碑，接在 HEAD 上", async () => {
    const { exec, current } = makeGit();
    const r = await milestoneSnapshot(exec, { root, label: "第三章 改完雨夜对峙", note: "把动机藏深", totalWords: 48210, deltaWords: 312 });
    expect(r.ok).toBe(true);
    expect(r.record?.kind).toBe("milestone");
    expect(r.record?.label).toBe("第三章 改完雨夜对峙");
    expect(r.record?.note).toBe("把动机藏深");
    expect([...current.refs.keys()][0].startsWith(MILESTONE_REF_PREFIX)).toBe(true);
    expect(loadIndex(root).snapshots[0].label).toBe("第三章 改完雨夜对峙");
  });
});

describe("rebuildIndex", () => {
  it("从 ref 反推出索引（索引丢失时的兜底）", async () => {
    const { exec, current } = makeGit();
    current.refs.set(autoRefName("001", new Date(2026, 10, 27, 9, 0)), "c1");
    current.refs.set(MILESTONE_REF_PREFIX + "m_x", "c2");
    current.refs.set(PUBLISH_REF_PREFIX + "v1", "c3");
    current.times.set("c1", "2026-11-27T09:00:00Z");
    current.times.set("c2", "2026-11-26T09:00:00Z");
    current.times.set("c3", "2026-11-25T09:00:00Z");
    const idx = await rebuildIndex(exec, root);
    expect(idx.snapshots.map((s) => s.kind).sort()).toEqual(["auto", "milestone", "publish"]);
    expect(idx.snapshots.find((s) => s.kind === "auto")?.chapter).toBe("001");
    expect(loadIndex(root).snapshots).toHaveLength(3);
  });

  it("无 ref 时得到空索引", async () => {
    const { exec } = makeGit();
    expect((await rebuildIndex(exec, root)).snapshots).toEqual([]);
  });
});