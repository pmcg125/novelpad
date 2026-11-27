import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aiRecords,
  appendRecord,
  autoSnapshot,
  backfillFromRefs,
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
  pruneAutoSnapshots,
  saveIndex,
  saveSession,
  sessionPath,
  syncTrunk,
  wordSeries,
  writeJsonAtomic,
  type SnapshotRecord,
} from "./snapshot.js";
import {
  AUTO_REF_PREFIX,
  autoRefName,
  MILESTONE_REF_PREFIX,
  PUBLISH_REF_PREFIX,
  type ExecFn,
  type ExecResult,
} from "./repo.js";

/* ============================================================
 * 最小假 git（只覆盖 snapshot.ts 用到的命令）
 * ============================================================ */

function makeGit(over: { dirty?: boolean; branch?: string | null; refs?: Record<string, string> } = {}) {
  const refs = new Map<string, string>(Object.entries(over.refs ?? {}));
  const parents = new Map<string, string>();
  const times = new Map<string, string>();
  const trees = new Map<string, string>();
  const objects = new Set<string>();
  // 预置的 ref 顶端要能被 rev-parse 认出来（真实 git 里它们是存在的提交对象）
  for (const commit of refs.values()) objects.add(commit);
  // commit-tree 的 -m：真实 git 会把首行作为 %(subject) 回吐，桩照做
  const messages = new Map<string, string>();
  // HEAD 指向的分支名。null = 分离 HEAD（作者自己 checkout 过某个版本）。
  const branch = over.branch === undefined ? "main" : over.branch;
  // 每次调用的参数，用于断言「有没有带 base / 父提交是谁」
  const calls: string[][] = [];
  const current = {
    tree: "tree-0", dirty: over.dirty ?? true, seq: 0, refs, parents, times, trees, messages, branch, calls,
    // 置 true 模拟分支被别的窗口抢先推进（update-ref 的旧值不匹配）
    failUpdateRef: false,
  };

  const exec: ExecFn = async (args) => {
    calls.push([...args]);
    const cmd = args[0];
    const ok = (s = ""): ExecResult => ({ code: 0, stdout: s, stderr: "" });
    const bad = (s = "boom"): ExecResult => ({ code: 1, stdout: "", stderr: s });

    if (cmd === "add") return ok();
    // 临时索引从空树开始：桩里只需确认命令被调用过
    if (cmd === "read-tree") return ok();
    // advanceTrunk / ensureBaseline 同步索引用；桩里只需确认被调用
    if (cmd === "reset") return ok();
    if (cmd === "symbolic-ref") {
      if (!branch) return bad("not a symbolic ref");
      return ok(branch + "\n");
    }
    if (cmd === "write-tree") {
      if (!current.dirty) return ok(current.tree);
      current.seq++;
      current.tree = "tree-" + current.seq;
      return ok(current.tree);
    }
    if (cmd === "rev-parse") {
      const spec = args[args.length - 1];
      // 作品根 = 仓库根：--show-toplevel 给仓库根，--show-prefix 给空
      if (spec === "--show-toplevel") return ok("/repo\n");
      if (spec === "--show-prefix") return ok("\n");
      if (spec.startsWith("HEAD")) return bad();
      if (spec.endsWith("^{tree}")) {
        const id = spec.replace(/\^\{tree\}$/, "");
        // 直接给 commit id 也认（去重比较会这么用）
        const t = trees.get(id) ?? (objects.has(id) ? "tree-" + id.slice(1) : undefined);
        return t ? ok(t + "\n") : bad();
      }
      // 提交对象本身也能 rev-parse（主干顶端存的直接就是 commit id）
      const key = spec.replace(/\^\{commit\}$/, "");
      const id = refs.get(key) ?? (objects.has(key) || trees.has(key) ? key : undefined);
      return id ? ok(id + "\n") : bad();
    }
    if (cmd === "commit-tree") {
      current.seq++;
      const tree = args[1];
      const id = "c" + current.seq;
      objects.add(id);
      trees.set(id, tree);
      times.set(id, new Date(Date.UTC(2026, 10, 27, 10, 0, current.seq)).toISOString());
      const mi = args.indexOf("-m");
      if (mi > 0) messages.set(id, String(args[mi + 1] ?? "").split(/\r?\n/)[0]);
      const pi = args.indexOf("-p");
      if (pi > 0) parents.set(id, args[pi + 1]);
      return ok(id + "\n");
    }
    if (cmd === "update-ref") {
      // 只让「带旧值的 CAS 形式」失败（update-ref <ref> <new> <old>）：
      // 那才是分支被别的窗口抢推。createSnapshot 挂里程碑 ref 用的
      // 两参数形式必须照样成功，否则整个测试场景与真实 git 不符。
      if (current.failUpdateRef && args.length >= 4) return bad("cannot lock ref");
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
      // 真实 git 现在输出 4 个字段（第 4 个是提交主题），桩必须跟上，
      // 否则测的是「git 永远不会给出」的形状，标签恢复那条路径等于没测。
      return ok(
        names
          .map((n) => `${n}\u001f${refs.get(n)}\u001f${times.get(refs.get(n)!) ?? ""}\u001f${messages.get(refs.get(n)!) ?? ""}`)
          .join("\n"),
      );
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

describe("pruneAutoSnapshots", () => {
  /** 造一个只回答 for-each-ref / update-ref -d 的执行器 */
  function makeRefsExec(initial: string[]) {
    const live = new Set(initial);
    const exec: ExecFn = async (args) => {
      if (args[0] === "for-each-ref") {
        const prefix = args[args.length - 1] ?? "";
        const list = [...live]
          .filter((r) => r.startsWith(prefix))
          // 让顺序确定：名称倒序 = 新的在前
          .sort((a, b) => (a < b ? 1 : -1));
        return {
          code: 0,
          // 4 个字段：与 listRefs 现在要求的格式一致（第 4 个是提交主题）
          stdout: list.map((r) => `${r}\u001f${"c-" + r}\u001f2026-11-27T10:00:00+08:00\u001f`).join("\n"),
          stderr: "",
        };
      }
      if (args[0] === "update-ref" && args[1] === "-d") {
        live.delete(args[2]);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return { exec, live };
  }

  it("删旧 ref 的同时同步索引，不留死记录", async () => {
    const r = "refs/novelpad/auto/001/";
    const refs = [`${r}2026112710000000`, `${r}2026112710010000`, `${r}2026112710020000`];
    for (const ref of refs) {
      appendRecord(root, makeRecord({ kind: "auto", commit: "c-" + ref, ref, at: new Date(), files: [], chapter: "001" }));
    }

    const { exec, live } = makeRefsExec(refs);
    const removed = await pruneAutoSnapshots(exec, root, "001", 1);

    expect(removed).toBe(2);
    expect(live.size).toBe(1);
    // 索引只剩存活的那条 —— 否则时间线会显示点不进去的记录
    const idx = loadIndex(root);
    expect(idx.snapshots.map((s) => s.ref)).toEqual([...live]);
  });

  it("未超上限时不动", async () => {
    const r = "refs/novelpad/auto/002/";
    const refs = [`${r}2026112710000000`, `${r}2026112710010000`];
    for (const ref of refs) {
      appendRecord(root, makeRecord({ kind: "auto", commit: "c-" + ref, ref, at: new Date(), files: [], chapter: "002" }));
    }
    const { exec, live } = makeRefsExec(refs);
    expect(await pruneAutoSnapshots(exec, root, "002", 5)).toBe(0);
    expect(live.size).toBe(2);
    expect(loadIndex(root).snapshots).toHaveLength(2);
  });

  it("只清理指定章节，别的章节与里程碑不受影响", async () => {
    const a = "refs/novelpad/auto/003/";
    const b = "refs/novelpad/auto/004/";
    const refs = [`${a}2026112710000000`, `${a}2026112710010000`, `${b}2026112710000000`];
    for (const ref of refs) {
      appendRecord(root, makeRecord({ kind: "auto", commit: "c-" + ref, ref, at: new Date(), files: [], chapter: ref.includes("/003/") ? "003" : "004" }));
    }
    appendRecord(root, makeRecord({ kind: "milestone", commit: "m1", ref: "refs/novelpad/milestone/m1", at: new Date(), files: [] }));

    const { exec, live } = makeRefsExec(refs);
    expect(await pruneAutoSnapshots(exec, root, "003", 1)).toBe(1);

    expect(live.has(`${b}2026112710000000`)).toBe(true);
    expect(loadIndex(root).snapshots.some((s) => s.kind === "milestone")).toBe(true);
  });

  it("keep < 1 时不动作（防止误删全部）", async () => {
    const { exec, live } = makeRefsExec(["refs/novelpad/auto/005/x"]);
    expect(await pruneAutoSnapshots(exec, root, "005", 0)).toBe(0);
    expect(live.size).toBe(1);
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

  /* ---- 主干：托管真正推出去的那条分支 ---- */

  it("主干未出生时，存一版把分支建起来（否则备份推不出任何东西）", async () => {
    const { exec, current } = makeGit();
    expect(current.refs.has("refs/heads/main")).toBe(false);

    const r = await milestoneSnapshot(exec, { root, label: "开篇", totalWords: 100, deltaWords: 100 });
    expect(r.ok).toBe(true);
    expect(r.trunk).toBe("main");
    expect(r.trunkSkipped).toBeUndefined();
    // 分支与里程碑 ref 指向同一个提交
    expect(current.refs.get("refs/heads/main")).toBe(r.record?.commit);
  });

  it("主干已存在时，存一版推进它并带上整棵树作基底", async () => {
    const { exec, current } = makeGit({ refs: { "refs/heads/main": "cOld" } });
    current.tree = "tree-new";

    const r = await milestoneSnapshot(exec, { root, label: "第二章", files: ["chapters/002.md"], totalWords: 200, deltaWords: 50 });
    expect(r.ok).toBe(true);
    expect(current.refs.get("refs/heads/main")).toBe(r.record?.commit);
    expect(current.refs.get("refs/heads/main")).not.toBe("cOld");

    // **必须带 base**：否则 write-tree 出来的树只含 chapters/002.md，
    // 主干上其余章节会凭空从历史里消失。
    const add = current.calls.find((a) => a[0] === "read-tree");
    expect(add).toEqual(["read-tree", "cOld"]);
    // 父提交是旧的主干顶端，历史是连续的
    expect(current.parents.get(r.record!.commit)).toBe("cOld");
  });

  it("主干未出生时收全部内容，不受 files 限制", async () => {
    const { exec, current } = makeGit();
    const r = await milestoneSnapshot(exec, { root, label: "第一版", files: ["chapters/003.md"], totalWords: 10, deltaWords: 10 });
    expect(r.ok).toBe(true);
    // 空基底 + paths=["."]；若只收 003，第一条主稿就缺了其余章节
    const read = current.calls.find((a) => a[0] === "read-tree");
    expect(read).toEqual(["read-tree", "--empty"]);
    const add = current.calls.find((a) => a[0] === "add");
    expect(add).toContain(".");
    expect(add).not.toContain("chapters/003.md");
  });

  it("内容与主干一字不差时不推进分支，但标签仍挂在主干顶端", async () => {
    const { exec, current } = makeGit({ refs: { "refs/heads/main": "cSame" } });
    // 主干顶端的树 == 本次要写的树 → createSnapshot 判定 empty
    current.trees.set("cSame", "tree-1");
    current.dirty = false;
    current.tree = "tree-1";

    const r = await milestoneSnapshot(exec, { root, label: "什么都没改", totalWords: 5, deltaWords: 0 });
    expect(r.ok).toBe(true);
    expect(r.empty).toBe(true);
    // 分支没动
    expect(current.refs.get("refs/heads/main")).toBe("cSame");
    // 里程碑 ref 补挂到同一提交：不补的话 rebuildIndex 扫不到，标签会凭空消失
    expect(current.refs.get(r.record!.ref)).toBe("cSame");
    expect(loadIndex(root).snapshots[0].label).toBe("什么都没改");
  });

  it("分支被别的窗口抢推时如实说明，不覆盖那边的提交", async () => {
    const { exec, current } = makeGit({ refs: { "refs/heads/main": "cOld" } });
    current.tree = "tree-new";
    current.failUpdateRef = true;

    const r = await milestoneSnapshot(exec, { root, label: "冲突的一版", totalWords: 9, deltaWords: 1 });
    // 版本本身存下来了（ref 与索引都在），所以 ok 是真的
    expect(r.ok).toBe(true);
    expect(r.record).toBeDefined();
    // 但主干没前进：备份会漏掉它，必须让调用方知道
    expect(r.trunkSkipped).toContain("另一个窗口");
    expect(current.refs.get("refs/heads/main")).toBe("cOld");
  });

  it("分离 HEAD 时只做本地版本，不猜分支名", async () => {
    const { exec, current } = makeGit({ branch: null });
    const r = await milestoneSnapshot(exec, { root, label: "分离状态", totalWords: 1, deltaWords: 1 });
    expect(r.ok).toBe(true);
    expect(r.trunk).toBeUndefined();
    expect(r.trunkSkipped).toContain("不在任何分支");
    // 没有造出任何 refs/heads/*
    expect([...current.refs.keys()].some((k) => k.startsWith("refs/heads/"))).toBe(false);
  });
});

describe("syncTrunk", () => {
  it("主干未出生时建出分支（新建作品从没点过存一版，直接备份）", async () => {
    const { exec, current } = makeGit();
    const r = await syncTrunk(exec, root);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(current.refs.get("refs/heads/main")).toBe(r.commit);
  });

  it("同步不写索引：备份不该在时间线里刷出一堆条目", async () => {
    const { exec } = makeGit();
    const r = await syncTrunk(exec, root);
    expect(r.ok).toBe(true);
    expect(loadIndex(root).snapshots).toEqual([]);
  });

  it("推进主干时以旧顶端为基底（全量内容，不只是改动文件）", async () => {
    const { exec, current } = makeGit({ refs: { "refs/heads/main": "cOld" } });
    current.tree = "tree-new";
    const r = await syncTrunk(exec, root);
    expect(r.ok).toBe(true);
    expect(current.refs.get("refs/heads/main")).toBe(r.commit);
    const read = current.calls.find((a) => a[0] === "read-tree");
    expect(read).toEqual(["read-tree", "cOld"]);
    const add = current.calls.find((a) => a[0] === "add");
    expect(add).toContain(".");
  });

  it("内容没变时 unchanged 且不动分支（避免每次备份一条空提交）", async () => {
    const { exec, current } = makeGit({ refs: { "refs/heads/main": "cSame" } });
    current.trees.set("cSame", "tree-1");
    current.dirty = false;
    current.tree = "tree-1";

    const r = await syncTrunk(exec, root);
    expect(r.ok).toBe(true);
    expect(r.unchanged).toBe(true);
    expect(current.refs.get("refs/heads/main")).toBe("cSame");
  });

  it("分离 HEAD 时明确拒绝，并说清该怎么走出来", async () => {
    const { exec, current } = makeGit({ branch: null });
    const r = await syncTrunk(exec, root);
    expect(r.ok).toBe(false);
    expect(r.skipped).toContain("不在任何分支");
    expect([...current.refs.keys()].some((k) => k.startsWith("refs/heads/"))).toBe(false);
  });
});

describe("backfillFromRefs", () => {
  it("只补索引里没有的 ref，不覆盖已有记录", async () => {
    const { exec, current } = makeGit();
    // 索引里已有一条带标签的里程碑
    const known = MILESTONE_REF_PREFIX + "m_keep";
    appendRecord(root, makeRecord({ kind: "milestone", commit: "c1", ref: known, at: new Date(), files: [], label: "我写的标签", note: "备注", words: { total: 500, delta: 20 } }));
    current.refs.set(known, "c1");
    current.refs.set(MILESTONE_REF_PREFIX + "m_new", "c2");
    current.times.set("c2", "2026-11-26T09:00:00Z");

    const r = await backfillFromRefs(exec, root);
    expect(r.added).toBe(1);
    const idx = loadIndex(root);
    expect(idx.snapshots).toHaveLength(2);
    // 关键：已有记录的标签/备注/字数原样保留（rebuildIndex 会把它们冲掉）
    const kept = idx.snapshots.find((s) => s.ref === known)!;
    expect(kept.label).toBe("我写的标签");
    expect(kept.note).toBe("备注");
    expect(kept.words).toEqual({ total: 500, delta: 20 });
    // 新补进来的用 ref 名反推
    expect(idx.snapshots.find((s) => s.ref === MILESTONE_REF_PREFIX + "m_new")?.time).toBe("2026-11-26T09:00:00Z");
  });

  it("全部已知时不写盘（added 0）", async () => {
    const { exec, current } = makeGit();
    const ref = MILESTONE_REF_PREFIX + "m_x";
    appendRecord(root, makeRecord({ kind: "milestone", commit: "c1", ref, at: new Date(), files: [] }));
    current.refs.set(ref, "c1");
    expect((await backfillFromRefs(exec, root)).added).toBe(0);
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

  it("从提交信息恢复作者写的标签（换机器后时间线不再是匿名版本）", async () => {
    const { exec, current } = makeGit();
    // 模拟另一台机器：ref 与提交对象在，snapshots.json 不在
    current.refs.set(MILESTONE_REF_PREFIX + "m_a", "c1");
    current.times.set("c1", "2026-11-26T09:00:00Z");
    current.messages.set("c1", "milestone: 第二章 渡口");
    current.refs.set(MILESTONE_REF_PREFIX + "m_b", "c2");
    current.times.set("c2", "2026-11-25T09:00:00Z");
    current.messages.set("c2", "milestone: 改完雨夜对峙\n\n章节：3");

    const idx = await rebuildIndex(exec, root);
    expect(idx.snapshots.find((s) => s.ref === MILESTONE_REF_PREFIX + "m_a")?.label).toBe("第二章 渡口");
    // 多行信息只取主题行
    expect(idx.snapshots.find((s) => s.ref === MILESTONE_REF_PREFIX + "m_b")?.label).toBe("改完雨夜对峙");
  });

  it("标签恢复不猜：主题不是 milestone: 开头时留空", async () => {
    const { exec, current } = makeGit();
    current.refs.set(MILESTONE_REF_PREFIX + "m_c", "c1");
    current.times.set("c1", "2026-11-26T09:00:00Z");
    current.messages.set("c1", "随便一次提交");
    current.refs.set(AUTO_REF_PREFIX + "001/20261127", "c2");
    current.times.set("c2", "2026-11-27T09:00:00Z");
    current.messages.set("c2", "auto: 001 2026-11-27T09:00:00Z");

    const idx = await rebuildIndex(exec, root);
    // 猜出来的假标签比没有标签更糟
    expect(idx.snapshots.find((s) => s.ref === MILESTONE_REF_PREFIX + "m_c")?.label).toBeUndefined();
    // 自动存档的主题是内部编号，不当标签用
    const auto = idx.snapshots.find((s) => s.kind === "auto");
    expect(auto?.label).toBeUndefined();
    expect(auto?.chapter).toBe("001");
  });

  it("存一版后删掉索引再重建，标签原样回来", async () => {
    const { exec } = makeGit();
    const r = await milestoneSnapshot(exec, { root, label: "第三章 雪停了", totalWords: 900, deltaWords: 120 });
    expect(r.ok).toBe(true);

    // 抹掉索引缓存（等价于换机器 clone 后 .novelpad/version 不存在）
    fs.rmSync(indexPath(root), { force: true });
    expect(loadIndex(root).snapshots).toEqual([]);

    const idx = await rebuildIndex(exec, root);
    expect(idx.snapshots).toHaveLength(1);
    expect(idx.snapshots[0].label).toBe("第三章 雪停了");
    expect(idx.snapshots[0].kind).toBe("milestone");
  });
});