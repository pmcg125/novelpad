import { describe, expect, it } from "vitest";
import {
  AUTO_REF_PREFIX,
  MILESTONE_REF_PREFIX,
  PUBLISH_REF_PREFIX,
  autoRefName,
  autoRefs,
  chapterOf,
  createSnapshot,
  deleteRef,
  detectGit,
  ensureRepo,
  isRepo,
  listRefs,
  logRef,
  parseLog,
  publishRefName,
  readFileAt,
  changedFiles,
  restoreTo,
  sanitizeRefComponent,
  trimAutoRefs,
  type ExecFn,
  type ExecResult,
} from "./repo.js";

/* ============================================================
 * 假 git：记录命令，按规则回答
 * ============================================================ */

interface FakeState {
  calls: string[][];
  refs: Map<string, string>;
  objects: Map<string, string>;
  parents: Map<string, string>;
  trees: Map<string, string>;
  times: Map<string, string>;
  currentTree: string;
  repoExists: boolean;
  dirty: boolean;
  seq: number;
}

function makeFakeGit(over: Partial<FakeState> = {}) {
  const st: FakeState = {
    calls: [],
    refs: new Map(),
    objects: new Map(),
    parents: new Map(),
    trees: new Map(),
    times: new Map(),
    currentTree: "tree-0",
    repoExists: true,
    dirty: true,
    seq: 0,
    ...over,
  };

  const exec: ExecFn = async (args) => {
    st.calls.push([...args]);
    const cmd = args[0];
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    const bad = (stderr = "boom"): ExecResult => ({ code: 1, stdout: "", stderr });
    const resolve = (s: string): string | undefined => {
      const name = s.replace(/\^\{commit\}$/, "").replace(/\^\{tree\}$/, "");
      if (name === "HEAD") return st.refs.get("HEAD");
      if (st.refs.has(name)) return st.refs.get(name);
      if (st.objects.has(name)) return name;
      return undefined;
    };

    if (cmd === "--version") return ok("git version 2.43.0\n");

    if (cmd === "init") {
      st.repoExists = true;
      return ok();
    }
    if (cmd === "symbolic-ref") return ok();

    if (cmd === "rev-parse" && args[1] === "--show-toplevel") {
      return st.repoExists ? ok("/repo\n") : bad("not a git repository");
    }

    if (cmd === "rev-parse") {
      const spec = args[args.length - 1] ?? "";
      if (spec.endsWith("^{tree}")) {
        const c = resolve(spec);
        return c ? ok((st.trees.get(c) ?? "tree-1") + "\n") : bad("");
      }
      const c = resolve(spec);
      return c ? ok(c + "\n") : bad("");
    }

    if (cmd === "add") return ok();

    if (cmd === "write-tree") {
      if (!st.dirty) return ok(st.currentTree);
      st.seq++;
      st.currentTree = "tree-" + st.seq;
      return ok(st.currentTree);
    }

    if (cmd === "commit-tree") {
      const tree = args[1];
      st.seq++;
      const id = "c" + st.seq;
      st.objects.set(id, "content-of-" + id);
      st.trees.set(id, tree);
      // 时间递增，保证排序稳定
      st.times.set(id, new Date(Date.UTC(2026, 10, 27, 10, 0, st.seq)).toISOString());
      const pi = args.indexOf("-p");
      if (pi > 0) st.parents.set(id, args[pi + 1]);
      return ok(id + "\n");
    }

    if (cmd === "update-ref") {
      if (args[1] === "-d") {
        st.refs.delete(args[2]);
        return ok();
      }
      st.refs.set(args[1], args[2]);
      return ok();
    }

    if (cmd === "for-each-ref") {
      const prefix = args[args.length - 1];
      const names = [...st.refs.keys()].filter((r) => r.startsWith(prefix)).sort();
      return ok(names.map((n) => `${n}\u001f${st.refs.get(n)}\u001f${st.times.get(st.refs.get(n)!) ?? ""}`).join("\n") + (names.length ? "\n" : ""));
    }

    if (cmd === "log") {
      const limit = Number(args[args.indexOf("-n") + 1] ?? 50);
      const ref = args[args.indexOf("-n") + 2] ?? "HEAD";
      let cur = resolve(ref);
      const out: string[] = [];
      while (cur && out.length < limit) {
        out.push(`${cur}\u001f${st.times.get(cur) ?? ""}\u001fmessage ${cur}\u0000`);
        cur = st.parents.get(cur);
      }
      return ok(out.join(""));
    }

    if (cmd === "show") {
      if (args[1].startsWith("--")) return ok("chapters/001.md\nchapters/002.md\n");
      const [commit, path] = args[1].split(":");
      if (st.objects.has(commit) && path) return ok("正文 " + commit + " " + path);
      return bad("path not found");
    }

    if (cmd === "checkout") return ok();

    return bad("unhandled: " + args.join(" "));
  };

  return { exec, st };
}

/* ============================================================
 * 测试
 * ============================================================ */

describe("detectGit", () => {
  it("解析版本号", async () => {
    const { exec } = makeFakeGit();
    expect(await detectGit(exec, "/repo")).toEqual({ available: true, version: "2.43.0" });
  });

  it("未安装时返回 false，不抛异常", async () => {
    const exec: ExecFn = async () => ({ code: 127, stdout: "", stderr: "not found" });
    expect(await detectGit(exec, "/x")).toEqual({ available: false });
  });
});

describe("ensureRepo / isRepo", () => {
  it("已有仓库时不动", async () => {
    const { exec, st } = makeFakeGit();
    const r = await ensureRepo(exec, "/repo");
    expect(r.created).toBe(false);
    expect(st.calls.some((c) => c[0] === "init")).toBe(false);
  });

  it("无仓库时 init 并统一分支名为 main", async () => {
    const { exec, st } = makeFakeGit({ repoExists: false });
    const r = await ensureRepo(exec, "/novel");
    expect(r.created).toBe(true);
    expect(st.calls.some((c) => c[0] === "init")).toBe(true);
    expect(st.calls.find((c) => c[0] === "symbolic-ref")?.slice(1)).toEqual(["HEAD", "refs/heads/main"]);
  });

  it("识别仓库与普通目录", async () => {
    const a = makeFakeGit();
    expect(await isRepo(a.exec, "/repo")).toBe(true);
    const b = makeFakeGit({ repoExists: false });
    expect(await isRepo(b.exec, "/plain")).toBe(false);
  });
});

describe("ref 命名", () => {
  it("自动存档 ref 带章节与时间戳，排序即时间序", () => {
    const a = autoRefName("003", new Date(2026, 10, 27, 9, 5, 3, 7));
    const b = autoRefName("003", new Date(2026, 10, 27, 9, 5, 4, 0));
    expect(a.startsWith(AUTO_REF_PREFIX + "003/")).toBe(true);
    expect(a < b).toBe(true);
    expect(a).toContain("20261127090503007");
  });

  it("自动存档不进 refs/heads，作者看不到分支污染", () => {
    expect(autoRefName("003").startsWith("refs/heads/")).toBe(false);
  });

  it("非法字符被清掉", () => {
    expect(sanitizeRefComponent(" 第 3 章 ")).toBe("第-3-章");
    expect(sanitizeRefComponent("a~b^c:d?e*f[g\\h")).toBe("a-b-c-d-e-f-g-h");
    expect(sanitizeRefComponent("...")).toBe("default");
    expect(sanitizeRefComponent("")).toBe("default");
    expect(sanitizeRefComponent("x.lock")).toBe("x");
  });

  it("里程碑与发布用独立前缀", () => {
    expect(MILESTONE_REF_PREFIX).toBe("refs/novelpad/milestone/");
    expect(publishRefName("v1")).toBe(PUBLISH_REF_PREFIX + "v1");
  });

  it("能从 ref 名反解章节 key", () => {
    expect(chapterOf(autoRefName("003"))).toBe("003");
    expect(chapterOf("refs/heads/main")).toBe("");
  });
});

describe("createSnapshot", () => {
  it("首次快照：无父提交也能成功", async () => {
    const { exec } = makeFakeGit();
    const r = await createSnapshot(exec, "/repo", { message: "auto", parent: "none" });
    expect(r.ok).toBe(true);
    expect(r.commit).toBeTruthy();
  });

  it("内容没变时不产生新提交", async () => {
    const { exec, st } = makeFakeGit();
    const first = await createSnapshot(exec, "/repo", { message: "a", parent: "none" });
    st.dirty = false;
    const second = await createSnapshot(exec, "/repo", { message: "b", parent: first.commit });
    expect(second.ok).toBe(true);
    expect(second.empty).toBe(true);
    expect(second.commit).toBe(first.commit);
  });

  it("里程碑接在 HEAD 上，历史连续", async () => {
    const { exec, st } = makeFakeGit();
    const a = await createSnapshot(exec, "/repo", { message: "a", parent: "none" });
    st.refs.set("HEAD", a.commit!);
    const b = await createSnapshot(exec, "/repo", { message: "b" });
    expect(st.parents.get(b.commit!)).toBe(a.commit);
  });

  it("parent:none 造独立提交，便于精确滚动", async () => {
    const { exec, st } = makeFakeGit();
    const a = await createSnapshot(exec, "/repo", { message: "a", parent: "none" });
    const b = await createSnapshot(exec, "/repo", { message: "b", parent: "none" });
    expect(st.parents.get(a.commit!)).toBeUndefined();
    expect(st.parents.get(b.commit!)).toBeUndefined();
  });

  it("指定路径时只暂存这些路径", async () => {
    const { exec, st } = makeFakeGit();
    await createSnapshot(exec, "/repo", { message: "m", paths: ["chapters/003.md"] });
    const add = st.calls.find((c) => c[0] === "add")!;
    expect(add).toContain("chapters/003.md");
    expect(add).toContain("-A");
  });

  it("add 失败时返回错误而不是抛异常", async () => {
    const exec: ExecFn = async (args) => (args[0] === "add" ? { code: 1, stdout: "", stderr: "index locked" } : { code: 0, stdout: "", stderr: "" });
    const r = await createSnapshot(exec, "/repo", { message: "m" });
    expect(r).toEqual({ ok: false, error: "index locked" });
  });
});

describe("parseLog", () => {
  it("解析 %x1f / %x00 分隔的记录", () => {
    const raw = "abc\u001f2026-11-27T10:00:00+08:00\u001f改完雨夜\n\u0000def\u001f2026-11-26T09:00:00+08:00\u001f初稿\u0000";
    expect(parseLog(raw)).toEqual([
      { commit: "abc", time: "2026-11-27T10:00:00+08:00", message: "改完雨夜" },
      { commit: "def", time: "2026-11-26T09:00:00+08:00", message: "初稿" },
    ]);
  });

  it("空输出得到空数组", () => {
    expect(parseLog("")).toEqual([]);
    expect(parseLog("\u0000\u0000")).toEqual([]);
  });
});

describe("listRefs", () => {
  it("按时间新到旧排序", async () => {
    const { exec } = makeFakeGit();
    const r1 = await createSnapshot(exec, "/repo", { message: "1", parent: "none", ref: autoRefName("001", new Date(2026, 10, 27, 9, 0)) });
    const r2 = await createSnapshot(exec, "/repo", { message: "2", parent: "none", ref: autoRefName("001", new Date(2026, 10, 27, 10, 0)) });
    const refs = await listRefs(exec, "/repo", AUTO_REF_PREFIX);
    expect(refs).toHaveLength(2);
    expect(refs[0].commit).toBe(r2.commit);
    expect(refs[1].commit).toBe(r1.commit);
  });

  it("无匹配时返回空数组", async () => {
    const { exec } = makeFakeGit();
    expect(await listRefs(exec, "/repo", AUTO_REF_PREFIX)).toEqual([]);
  });

  it("ref 不存在时 log 返回空而不是报错", async () => {
    const { exec } = makeFakeGit();
    expect(await logRef(exec, "/repo", autoRefName("999"))).toEqual([]);
  });
});

describe("readFileAt / changedFiles", () => {
  it("读出指定提交的文件内容", async () => {
    const { exec } = makeFakeGit();
    const r = await createSnapshot(exec, "/repo", { message: "m", parent: "none" });
    expect(await readFileAt(exec, "/repo", r.commit!, "chapters/001.md")).toContain(r.commit);
  });

  it("文件不存在返回 undefined", async () => {
    const { exec } = makeFakeGit();
    expect(await readFileAt(exec, "/repo", "nope", "x.md")).toBeUndefined();
  });

  it("列出提交改动的文件", async () => {
    const { exec } = makeFakeGit();
    expect(await changedFiles(exec, "/repo", "c1")).toEqual(["chapters/001.md", "chapters/002.md"]);
  });
});

describe("restoreTo", () => {
  it("恢复前先打保护快照，且顺序早于 checkout", async () => {
    const { exec, st } = makeFakeGit();
    const r = await restoreTo(exec, "/repo", "c9", { guardRef: autoRefName("guard") });
    expect(r.ok).toBe(true);
    expect(r.guard).toBeTruthy();
    const commitTreeIdx = st.calls.findIndex((c) => c[0] === "commit-tree");
    const checkoutIdx = st.calls.findIndex((c) => c[0] === "checkout");
    expect(commitTreeIdx).toBeGreaterThan(-1);
    expect(commitTreeIdx).toBeLessThan(checkoutIdx);
  });

  it("checkout 失败时把保护快照的 id 也返回", async () => {
    const { exec } = makeFakeGit();
    const wrap: ExecFn = async (args, o) => (args[0] === "checkout" ? { code: 1, stdout: "", stderr: "conflict" } : exec(args, o));
    const r = await restoreTo(wrap, "/repo", "c9");
    expect(r.ok).toBe(false);
    expect(r.guard).toBeTruthy();
  });

  it("可只恢复指定路径", async () => {
    const { exec, st } = makeFakeGit();
    await restoreTo(exec, "/repo", "c9", { paths: ["chapters/003.md"] });
    expect(st.calls.find((c) => c[0] === "checkout")).toEqual(["checkout", "c9", "--", "chapters/003.md"]);
  });
});

describe("trimAutoRefs", () => {
  it("少于上限时不删", async () => {
    const { exec, st } = makeFakeGit();
    for (let i = 0; i < 3; i++) {
      await createSnapshot(exec, "/repo", { message: "m" + i, parent: "none", ref: autoRefName("001", new Date(2026, 10, 27, 9, i)) });
    }
    expect(await trimAutoRefs(exec, "/repo", "001", 20)).toBe(0);
    expect([...st.refs.keys()].filter((r) => r.startsWith(AUTO_REF_PREFIX))).toHaveLength(3);
  });

  it("超过上限时删掉最旧的，保留 keep 个", async () => {
    const { exec } = makeFakeGit();
    for (let i = 0; i < 8; i++) {
      await createSnapshot(exec, "/repo", { message: "m" + i, parent: "none", ref: autoRefName("001", new Date(2026, 10, 27, 9, i)) });
    }
    expect(await trimAutoRefs(exec, "/repo", "001", 4)).toBe(4);
    const left = await autoRefs(exec, "/repo");
    expect(left).toHaveLength(4);
    // 留下的是最新的四个
    expect(left[0].name).toContain("0907");
    expect(left[3].name).toContain("0904");
  });

  it("只影响指定章节", async () => {
    const { exec } = makeFakeGit();
    for (let i = 0; i < 6; i++) {
      await createSnapshot(exec, "/repo", { message: "a" + i, parent: "none", ref: autoRefName("001", new Date(2026, 10, 27, 9, i)) });
      await createSnapshot(exec, "/repo", { message: "b" + i, parent: "none", ref: autoRefName("002", new Date(2026, 10, 27, 9, i)) });
    }
    expect(await trimAutoRefs(exec, "/repo", "001", 2)).toBe(4);
    const all = await autoRefs(exec, "/repo");
    expect(all.filter((r) => chapterOf(r.name) === "001")).toHaveLength(2);
    expect(all.filter((r) => chapterOf(r.name) === "002")).toHaveLength(6);
  });

  it("keep < 1 时不动作（防止误删全部）", async () => {
    const { exec, st } = makeFakeGit();
    await createSnapshot(exec, "/repo", { message: "m", parent: "none", ref: autoRefName("001") });
    expect(await trimAutoRefs(exec, "/repo", "001", 0)).toBe(0);
    expect(st.refs.size).toBe(1);
  });
});

describe("deleteRef", () => {
  it("只允许删自动存档，保护里程碑与发布版", async () => {
    const { exec, st } = makeFakeGit();
    st.refs.set(autoRefName("001"), "c1");
    st.refs.set(PUBLISH_REF_PREFIX + "v1", "c2");
    st.refs.set(MILESTONE_REF_PREFIX + "m1", "c3");
    expect(await deleteRef(exec, "/repo", autoRefName("001"))).toBe(true);
    expect(await deleteRef(exec, "/repo", PUBLISH_REF_PREFIX + "v1")).toBe(false);
    expect(await deleteRef(exec, "/repo", MILESTONE_REF_PREFIX + "m1")).toBe(false);
    expect(st.refs.size).toBe(2);
  });
});