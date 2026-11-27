#!/usr/bin/env node
/**
 * 版本管理端到端自检：**真实 git**，不用假实现。
 *
 *   node shell/scripts/e2e-version.mjs [core dist 目录]
 *
 * 为什么必须有一条真实 git 的测试：
 * 假 git 只能验证「命令拼得对不对」，验证不了 git 对 pathspec 的真实解释。
 * 而这里踩过的三个坑全是**静默**的：
 *
 *   1. `git show <rev>:<path>` 里的 path 永远相对提交树根，与 cwd 无关。
 *      作品在仓库子目录时不补前缀 → git 返回非零 → 界面显示「两版没有差异」。
 *   2. `git add` 的 pathspec 相对 cwd。补了前缀就变成 novel/novel/，直接失败。
 *   3. `write-tree` 写出的是**整个索引**。用作者的真实索引会把仓库里
 *      无关文件一起带进快照，还会污染他的暂存区。
 *
 * 它检查的不是 git 能不能用，是我们有没有用对。CI 三平台都跑（秒级）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const repoRoot = path.resolve(here, "../..");
const distDir = process.argv[2] ?? path.join(repoRoot, "packages/core/dist");
const core = await import(pathToFileURL(path.join(distDir, "index.js")).href);

const {
  nodeExec,
  ensureRepo,
  repoLayout,
  toRepoPath,
  createSnapshot,
  autoSnapshot,
  milestoneSnapshot,
  loadIndex,
  pruneAutoSnapshots,
  readSnapshotFile,
  diffParagraphs,
  overview,
  groupByDay,
  AUTO_KEEP_PER_CHAPTER,
} = core;

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let fail = 0;
let pass = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass++;
    console.log(`OK   ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name} ${extra}`);
  }
};

/** 建一个「仓库根包含子目录作品」的临时布局 */
function makeLayout() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "np-e2e-"));
  const root = path.join(tmp, "novel");
  fs.mkdirSync(path.join(root, "chapters"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "unrelated.txt"), "仓库里与作品无关的文件\n");
  fs.writeFileSync(path.join(root, "chapters", "001.md"), "# 第一章 夜航\n\n第一段正文。\n\n第二段正文。\n");
  git(tmp, "init", "-q");
  git(tmp, "config", "user.email", "t@t.t");
  git(tmp, "config", "user.name", "t");
  git(tmp, "config", "commit.gpgsign", "false");
  return { tmp, root };
}

/* ============================================================
 * 1. 路径坐标系
 * ============================================================ */

{
  const { tmp, root } = makeLayout();

  const layout = await repoLayout(nodeExec, root);
  check("识别出作品在仓库子目录", layout?.prefix === "novel/", JSON.stringify(layout));
  check("作品相对路径 → 仓库相对路径", toRepoPath(layout, "chapters/001.md") === "novel/chapters/001.md");

  // 读历史：<rev>:<path> 相对提交树根，必须先建个提交
  const snap = await createSnapshot(nodeExec, root, { message: "init", ref: "refs/novelpad/auto/t1", parent: "none" });
  check("首次快照成功", snap.ok === true && !!snap.commit, JSON.stringify(snap));

  if (snap.commit) {
    // 证明「不补前缀确实读不到」这件事是真的（这正是界面静默出错的根因）
    let raw = "";
    try {
      raw = git(tmp, "show", `${snap.commit}:chapters/001.md`);
    } catch {
      raw = "";
    }
    check("不补前缀读不到（证明这个坑真实存在）", raw === "", JSON.stringify(raw.slice(0, 30)));

    const ok = git(tmp, "show", `${snap.commit}:${toRepoPath(layout, "chapters/001.md")}`);
    check("补上前缀后读到正文", ok.includes("第一段正文"));
  }

  // 快照范围：不能把仓库根无关文件带进去
  if (snap.commit) {
    const files = git(tmp, "show", "--pretty=format:", "--name-only", snap.commit).split("\n").filter(Boolean);
    check("快照只含作品目录下的文件", files.every((f) => f.startsWith("novel/")), JSON.stringify(files));
    check("未把仓库根无关文件写进快照", !files.includes("unrelated.txt"), JSON.stringify(files));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ============================================================
 * 2. 不污染作者的暂存区
 * ============================================================ */

{
  const { tmp, root } = makeLayout();

  // 作者手头有一个已暂存的改动 + 一个未跟踪的半成品
  fs.writeFileSync(path.join(root, "notes.md"), "# 笔记（改过）\n");
  git(tmp, "add", "novel/notes.md");
  fs.writeFileSync(path.join(root, "draft-temp.md"), "半成品\n");

  const statusBefore = git(tmp, "status", "--porcelain");
  const indexBefore = fs.readFileSync(path.join(tmp, ".git", "index"));

  const snap = await createSnapshot(nodeExec, root, { message: "auto", ref: "refs/novelpad/auto/t2", parent: "none" });

  const indexAfter = fs.readFileSync(path.join(tmp, ".git", "index"));
  check("快照成功", snap.ok === true, JSON.stringify(snap));
  check("真实 index 文件逐字节未变", Buffer.compare(indexBefore, indexAfter) === 0);
  check("作者的 git status 未变", git(tmp, "status", "--porcelain") === statusBefore);

  if (snap.commit) {
    const files = git(tmp, "show", "--pretty=format:", "--name-only", snap.commit).split("\n").filter(Boolean);
    check("快照包含未跟踪的稿件", files.includes("novel/draft-temp.md"), JSON.stringify(files));
    check("作者的暂存区没被塞入半成品", !git(tmp, "diff", "--cached", "--name-only").includes("draft-temp.md"));
  }

  const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("novelpad-index-"));
  check("临时索引已清理", leftovers.length === 0, JSON.stringify(leftovers));

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ============================================================
 * 3. 懒初始化：只建不改
 * ============================================================ */

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "np-e2e-fresh-"));
  const root = path.join(tmp, "novel");
  fs.mkdirSync(path.join(root, "chapters"), { recursive: true });
  fs.writeFileSync(path.join(root, "chapters", "001.md"), "# 新作\n\n正文。\n");

  const r = await ensureRepo(nodeExec, root);
  check("无仓库 → created:true", r.created === true, JSON.stringify(r));
  // 统一 main，否则作者换机器会看到 master/main 不一致
  check("新建仓库分支为 main（不受全局 init.defaultBranch 影响）", git(root, "symbolic-ref", "--short", "HEAD") === "main");
  check("toplevel 指向自己", path.resolve(r.toplevel) === path.resolve(root), `${r.toplevel} vs ${root}`);

  const again = await ensureRepo(nodeExec, root);
  check("已有仓库 → created:false（不重复 init）", again.created === false);

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ============================================================
 * 4. 完整写作链路：存 → 读 → 比 → 清理
 * ============================================================ */

{
  const { tmp, root } = makeLayout();
  await ensureRepo(nodeExec, root);

  let first;
  {
    const out = await autoSnapshot(nodeExec, {
      root,
      chapterKey: "001",
      files: ["chapters/001.md"],
      totalWords: 30,
      deltaWords: 30,
    });
    check("第一次自动存档成功", out.ok === true && !!out.record, JSON.stringify(out));
    first = out.record;

    const refs = git(tmp, "for-each-ref", "--format=%(refname)", "refs/novelpad/auto/");
    check("ref 建在 refs/novelpad/auto 下", refs.startsWith("refs/novelpad/auto/001/"), JSON.stringify(refs));
    let hasHead = true;
    try {
      git(tmp, "rev-parse", "--verify", "HEAD");
    } catch {
      hasHead = false;
    }
    check("没有移动作者的分支指针（HEAD 仍未指向任何提交）", hasHead === false);
  }

  // 内容没变 → 不产生新版本
  {
    const before = loadIndex(root).snapshots.length;
    const out = await autoSnapshot(nodeExec, {
      root,
      chapterKey: "001",
      files: ["chapters/001.md"],
      totalWords: 30,
      deltaWords: 0,
    });
    check("内容没变时返回 empty", out.ok === true && out.empty === true, JSON.stringify(out));
    check("索引未新增记录（时间线不被空快照刷屏）", loadIndex(root).snapshots.length === before);
  }

  // 读回 + 段落级 diff
  {
    fs.writeFileSync(path.join(root, "chapters", "001.md"), "# 第一章 夜航\n\n第一段正文，改过了。\n\n第二段正文。\n");
    const out = await autoSnapshot(nodeExec, {
      root,
      chapterKey: "001",
      files: ["chapters/001.md"],
      totalWords: 33,
      deltaWords: 3,
    });
    check("第二次自动存档成功", out.ok === true && !out.empty, JSON.stringify(out));

    const after = await readSnapshotFile(nodeExec, root, out.record, "chapters/001.md");
    const before = await readSnapshotFile(nodeExec, root, first, "chapters/001.md");
    check("能从快照读回正文", typeof after === "string" && after.includes("改过了"), JSON.stringify(after?.slice(0, 30)));

    const diff = diffParagraphs(before, after);
    check("diff 只把改过的那段算作修改", diff.stats.changed === 1, JSON.stringify(diff.stats));
    check("未变的两段仍算相同", diff.stats.same === 2, JSON.stringify(diff.stats));

    const missing = await readSnapshotFile(nodeExec, root, first, "chapters/999.md");
    check("读不存在的文件返回 undefined（不抛异常）", missing === undefined);
  }

  // 里程碑
  {
    const out = await milestoneSnapshot(nodeExec, {
      root,
      label: "雨夜对峙改完",
      note: "把动机藏得更深",
      totalWords: 33,
      deltaWords: 0,
    });
    check("里程碑创建成功", out.ok === true && !!out.record, JSON.stringify(out));
    check("里程碑带人类标签", out.record?.label === "雨夜对峙改完");
    check("里程碑在独立命名空间", out.record?.ref.startsWith("refs/novelpad/milestone/"), out.record?.ref);
  }

  // 滚动清理：ref 与索引必须一起删
  {
    const n = AUTO_KEEP_PER_CHAPTER + 3;
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(root, "chapters", "002.md"), `# 第二章\n\n第 ${i} 版，${Math.random()}\n`);
      await autoSnapshot(nodeExec, {
        root,
        chapterKey: "002",
        files: ["chapters/002.md"],
        totalWords: 40 + i,
        deltaWords: 1,
      });
    }

    const liveBefore = git(tmp, "for-each-ref", "--format=%(refname)", "refs/novelpad/auto/002/").split("\n").filter(Boolean);
    check("清理前超过上限", liveBefore.length > AUTO_KEEP_PER_CHAPTER, String(liveBefore.length));

    const removed = await pruneAutoSnapshots(nodeExec, root, "002", AUTO_KEEP_PER_CHAPTER);
    check("清理返回删除条数", removed > 0, String(removed));

    const liveAfter = new Set(git(tmp, "for-each-ref", "--format=%(refname)", "refs/novelpad/auto/002/").split("\n").filter(Boolean));
    check("清理后 ref 数等于上限", liveAfter.size === AUTO_KEEP_PER_CHAPTER, String(liveAfter.size));

    // 关键：索引不能留下指向已删 ref 的死记录
    const idx = loadIndex(root);
    const dead = idx.snapshots.filter((s) => s.kind === "auto" && s.chapter === "002" && !liveAfter.has(s.ref));
    check("索引里没有死记录（否则时间线显示点不进去的条目）", dead.length === 0, JSON.stringify(dead.map((d) => d.ref)));
    check("里程碑未被自动清理波及", idx.snapshots.filter((s) => s.kind === "milestone").length === 1);

    const ov = overview(idx.snapshots);
    check("overview 统计与实际一致", ov.total === idx.snapshots.length, JSON.stringify(ov));
    const groups = groupByDay(idx.snapshots);
    check("groupByDay 覆盖全部记录", groups.reduce((s, g) => s + g.records.length, 0) === idx.snapshots.length);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ============================================================
 * 5. 非 git 目录：不假装成功
 * ============================================================ */

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "np-e2e-plain-"));
  const layout = await repoLayout(nodeExec, tmp);
  check("非 git 目录返回 undefined（不假装前缀为空）", layout === undefined, JSON.stringify(layout));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;