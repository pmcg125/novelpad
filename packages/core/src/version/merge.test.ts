/**
 * 章节级合并单测。
 *
 * 两类测试：
 *   1. 纯逻辑（decideVerdict / charCount / chapterTitle / planMerge）
 *      —— 三方判定的分支组合有 3^3 种，穷举得到钉死。
 *   2. 真实 git（listBranches / compareBranches / applyMerge）
 *      —— 只有真跑一遍才敢说「两分支比较是对的」。mock 的 git
 *         永远会同意你的假设。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMerge,
  chapterComparison,
  chapterTitle,
  charCount,
  compareBranches,
  currentBranch,
  decideVerdict,
  detectDefaultBranch,
  listBranches,
  planMerge,
} from "./merge.js";
import type { ExecFn } from "./repo.js";

const pexec = promisify(execFile);

/* ============================================================
 * 测试用的 git 执行器
 *
 * 不用 repo.ts 的 nodeExec：那个带 20s 超时和 stderr 归一化，
 * 排查测试失败时反而看不清原始输出。这里给一份最直白的。
 * ============================================================ */

const exec: ExecFn = async (args, opts) => {
  try {
    const { stdout, stderr } = await pexec("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
    };
  }
};

let root: string;

async function git(...args: string[]): Promise<string> {
  const r = await exec(args, { cwd: root });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
  return r.stdout;
}

async function write(rel: string, content: string): Promise<void> {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

async function commitAll(message: string): Promise<void> {
  await git("add", "-A");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message, "--allow-empty");
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "np-merge-"));
  await git("init", "-q", "-b", "main");
  // 关掉换行转换：Windows 上 autocrlf 会把 \n 变 \r\n，
  // 于是「内容相同」的判断在 CI（Linux）与本地（Windows）表现不一致
  await git("config", "core.autocrlf", "false");
  await write("chapters/001.md", "# 第一章 起点\n\n雨落在瓦上。\n");
  await commitAll("初始");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/* ============================================================
 * 纯逻辑
 * ============================================================ */

describe("decideVerdict", () => {
  it("只有来源改了 → take-source", () => {
    expect(decideVerdict("a", "a", "b")).toBe("take-source");
  });

  it("只有目标改了 → keep-target", () => {
    expect(decideVerdict("a", "b", "a")).toBe("keep-target");
  });

  it("两边都没改 → identical", () => {
    expect(decideVerdict("a", "a", "a")).toBe("identical");
  });

  it("两边改成一样 → identical（不需要作者做决定）", () => {
    expect(decideVerdict("a", "b", "b")).toBe("identical");
  });

  it("两边都改且不同 → conflict", () => {
    expect(decideVerdict("a", "b", "c")).toBe("conflict");
  });

  it("两边各自新增了同名章节且内容不同 → conflict", () => {
    expect(decideVerdict(undefined, "x", "y")).toBe("conflict");
  });

  it("两边新增同名章节且内容相同 → identical", () => {
    expect(decideVerdict(undefined, "x", "x")).toBe("identical");
  });

  it("来源删了、目标没动 → deleted-in-source", () => {
    expect(decideVerdict("a", "a", undefined)).toBe("deleted-in-source");
  });

  it("来源删了、目标也改了 → 仍然 deleted-in-source（保留还是删要人定）", () => {
    expect(decideVerdict("a", "b", undefined)).toBe("deleted-in-source");
  });

  it("两边都删了 → identical", () => {
    expect(decideVerdict("a", undefined, undefined)).toBe("identical");
  });

  it("目标删了、来源改了 → recreated（问要不要复活）", () => {
    expect(decideVerdict("a", undefined, "b")).toBe("recreated");
  });

  it("目标没有、来源新增 → take-source（协作里最常见，不该烦人）", () => {
    expect(decideVerdict(undefined, undefined, "b")).toBe("take-source");
  });

  it("来源没有、目标新增 → keep-target（与本分支无关）", () => {
    expect(decideVerdict(undefined, "a", undefined)).toBe("keep-target");
  });
});

describe("charCount", () => {
  it("数中文字符", () => {
    expect(charCount("雨落在瓦上")).toBe(5);
  });

  it("不计空白与换行（作者心里的「字数」不算排版空格）", () => {
    expect(charCount("雨 落\n在\t瓦上")).toBe(5);
  });

  it("去掉 frontmatter", () => {
    expect(charCount("---\ntitle: 第一章\n---\n正文")).toBe(2);
  });

  it("去掉 Markdown 标题标记", () => {
    expect(charCount("# 第一章\n\n正文")).toBe(5);
  });

  it("去掉强调标记但保留文字", () => {
    expect(charCount("**加粗** 和 *斜体*")).toBe(5);
  });

  it("链接只留文字，丢掉 URL", () => {
    expect(charCount("见[这里](https://example.com/very/long)")).toBe(3);
  });

  it("图片整个丢掉（alt 也不计入正文）", () => {
    expect(charCount("前![](a.png)后")).toBe(2);
  });

  it("emoji 算一个字，不是两个码元", () => {
    // 用 [...s] 而不是 s.length；否则这里会是 2
    expect(charCount("🎉")).toBe(1);
  });

  it("生僻字（扩展 B 区）算一个字", () => {
    expect(charCount("𠮷")).toBe(1);
  });

  it("空文本为 0", () => {
    expect(charCount("")).toBe(0);
    expect(charCount(undefined)).toBe(0);
  });

  it("纯空白为 0", () => {
    expect(charCount("\n\n   \t")).toBe(0);
  });
});

describe("chapterTitle", () => {
  it("取第一个一级标题", () => {
    expect(chapterTitle("# 第三章 雨夜\n\n正文", "chapters/003.md")).toBe("第三章 雨夜");
  });

  it("没有标题时用文件名", () => {
    expect(chapterTitle("正文而已", "chapters/003.md")).toBe("003");
  });

  it("文件不存在（新增冲突一侧缺失）时也能给名字", () => {
    expect(chapterTitle(undefined, "chapters/007.md")).toBe("007");
  });

  it("标题前后的空白被去掉", () => {
    expect(chapterTitle("#   标题   \n", "a.md")).toBe("标题");
  });

  it("二级标题不算章名", () => {
    expect(chapterTitle("## 小节\n\n正文", "chapters/005.md")).toBe("005");
  });
});

describe("planMerge", () => {
  const mk = (verdict: Parameters<typeof decideVerdict> extends never ? never : any) => ({
    file: "chapters/001.md",
    verdict,
    targetChars: 10,
    sourceChars: 20,
    baseChars: 10,
    delta: 10,
    title: "第一章",
  });

  it("只有来源改了 → 建议采用，不需要决定", () => {
    const [item] = planMerge({
      target: "main",
      source: "line/x",
      chapters: [mk("take-source")],
      conflicts: 0,
      takeable: 1,
      totalDelta: 10,
    });
    expect(item.suggested).toBe("take-source");
    expect(item.needsDecision).toBe(false);
  });

  it("冲突 → 需要决定，默认保留目标（不静默采用对方的版本）", () => {
    const [item] = planMerge({
      target: "main",
      source: "line/x",
      chapters: [mk("conflict")],
      conflicts: 1,
      takeable: 0,
      totalDelta: 0,
    });
    expect(item.suggested).toBe("keep-target");
    expect(item.needsDecision).toBe(true);
  });

  it("来源删了章 → 需要决定，默认保留（删除比保留更难撤销）", () => {
    const [item] = planMerge({
      target: "main",
      source: "line/x",
      chapters: [mk("deleted-in-source")],
      conflicts: 0,
      takeable: 0,
      totalDelta: -10,
    });
    expect(item.suggested).toBe("keep-target");
    expect(item.needsDecision).toBe(true);
  });

  it("目标删了章、来源改过 → 需要决定", () => {
    const [item] = planMerge({
      target: "main",
      source: "line/x",
      chapters: [mk("recreated")],
      conflicts: 0,
      takeable: 0,
      totalDelta: 10,
    });
    expect(item.needsDecision).toBe(true);
  });

  it("空计划返回空数组", () => {
    expect(
      planMerge({ target: "main", source: "x", chapters: [], conflicts: 0, takeable: 0, totalDelta: 0 }),
    ).toEqual([]);
  });
});

/* ============================================================
 * 真实 git
 * ============================================================ */

describe("分支列表（真实 git）", () => {
  it("能列出分支并标出当前分支", async () => {
    await git("checkout", "-q", "-b", "line/林晚照");
    const list = await listBranches(exec, root);
    const names = list.map((b) => b.name);
    expect(names).toContain("main");
    expect(names).toContain("line/林晚照");
    expect(list[0].current).toBe(true); // 当前分支排最前
    expect(list[0].name).toBe("line/林晚照");
  });

  it("带空格的分支名被 git 拒绝（记录这个约束）", async () => {
    // git 本身不允许分支名含空格（check-ref-format），
    // 所以 listBranches 用 %00 分隔不是为空格，而是为**中文和斜杠**
    await expect(git("checkout", "-q", "-b", "line/第二 结局")).rejects.toThrow();
    await git("checkout", "-q", "-b", "line/第二结局");
    const list = await listBranches(exec, root);
    expect(list.map((b) => b.name)).toContain("line/第二结局");
  });

  it("中文与斜杠的分支名解析正确", async () => {
    await git("checkout", "-q", "-b", "line/林晚照");
    const list = await listBranches(exec, root);
    const hit = list.find((b) => b.name === "line/林晚照");
    expect(hit).toBeDefined();
    expect(hit?.ref).toBe("refs/heads/line/林晚照");
    // 时间戳必须解析出来，否则说明按空格劈开了
    expect(hit?.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("ahead/behind 数字对得上", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await write("chapters/002.md", "# 第二章\n\n新的一章。\n");
    await commitAll("支线加一章");
    await write("chapters/002.md", "# 第二章\n\n又改了一次。\n");
    await commitAll("支线再改");

    const list = await listBranches(exec, root, "main");
    const x = list.find((b) => b.name === "line/x");
    expect(x?.ahead).toBe(2);
    expect(x?.behind).toBe(0);
  });

  it("main 落后支线时 behind 正确", async () => {
    await git("checkout", "-q", "-b", "line/y");
    await write("chapters/003.md", "内容\n");
    await commitAll("加一章");
    await git("checkout", "-q", "main");
    await write("chapters/004.md", "主线的新章\n");
    await commitAll("主线加一章");

    const list = await listBranches(exec, root, "line/y");
    const main = list.find((b) => b.name === "main");
    expect(main?.ahead).toBe(1);
    expect(main?.behind).toBe(1);
  });

  it("currentBranch 返回当前分支", async () => {
    expect(await currentBranch(exec, root)).toBe("main");
  });

  it("detectDefaultBranch 优先 main", async () => {
    expect(await detectDefaultBranch(exec, root)).toBe("main");
  });
});

describe("两分支比较（真实 git）", () => {
  it("只有支线改了 → take-source", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await write("chapters/001.md", "# 第一章 起点\n\n雨落在瓦上，很轻。\n");
    await commitAll("支线改了第一章");

    const cmp = await compareBranches(exec, root, "main", "line/x");
    expect(cmp.chapters).toHaveLength(1);
    expect(cmp.chapters[0].verdict).toBe("take-source");
    expect(cmp.takeable).toBe(1);
    expect(cmp.conflicts).toBe(0);
  });

  it("只有主线改了 → keep-target", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await git("checkout", "-q", "main");
    await write("chapters/001.md", "# 第一章 起点\n\n主线改的。\n");
    await commitAll("主线改");

    const cmp = await compareBranches(exec, root, "main", "line/x");
    expect(cmp.chapters[0].verdict).toBe("keep-target");
  });

  it("两边改同一章 → conflict，且不自动采用", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await write("chapters/001.md", "# 第一章 起点\n\n支线版本。\n");
    await commitAll("支线改");
    await git("checkout", "-q", "main");
    await write("chapters/001.md", "# 第一章 起点\n\n主线版本。\n");
    await commitAll("主线改");

    const cmp = await compareBranches(exec, root, "main", "line/x");
    expect(cmp.chapters[0].verdict).toBe("conflict");
    expect(cmp.conflicts).toBe(1);
    const plan = planMerge(cmp);
    expect(plan[0].suggested).toBe("keep-target");
    expect(plan[0].needsDecision).toBe(true);
  });

  it("两边各写一章 → 两个都 take-source，零冲突", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await write("chapters/002.md", "# 第二章\n\n支线写的。\n");
    await commitAll("支线加章");
    await git("checkout", "-q", "main");
    await write("chapters/003.md", "# 第三章\n\n主线写的。\n");
    await commitAll("主线加章");

    const cmp = await compareBranches(exec, root, "main", "line/x");
    // 从 main 的视角：003 已经在 main 上了，不该出现在「来源改动」里；
    // 002 是支线新写的，应当可以直接采用
    const files = cmp.chapters.map((c) => c.file);
    expect(files).toContain("chapters/002.md");
    expect(cmp.conflicts).toBe(0);
    const take = cmp.chapters.find((c) => c.file === "chapters/002.md");
    expect(take?.verdict).toBe("take-source");
  });

  it("统计字数与标题", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await write("chapters/002.md", "# 第二章 雨夜\n\n这是一段正文。\n");
    await commitAll("加章");

    const cmp = await compareBranches(exec, root, "main", "line/x");
    const ch = cmp.chapters.find((c) => c.file === "chapters/002.md");
    expect(ch?.title).toBe("第二章 雨夜");
    expect(ch?.targetChars).toBe(0);
    // "第二章雨夜" 5 字（去掉 # 和空格）+ "这是一段正文。" 7 字 = 12
    expect(ch?.sourceChars).toBe(12);
    expect(ch?.delta).toBe(12);
  });

  it("只比较作品目录内的 Markdown", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await write(".novelpad/annotations.jsonl", '{"id":"a1"}\n');
    await write("notes.txt", "不是章节");
    await write("chapters/002.md", "# 第二章\n\n正文\n");
    await commitAll("乱七八糟的改动");

    const cmp = await compareBranches(exec, root, "main", "line/x");
    const files = cmp.chapters.map((c) => c.file);
    expect(files).toEqual(["chapters/002.md"]);
  });

  it("支持作品在仓库子目录（前缀）", async () => {
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), "np-merge-sub-"));
    try {
      await exec(["init", "-q", "-b", "main"], { cwd: sub });
      await exec(["config", "core.autocrlf", "false"], { cwd: sub });
      const sw = async (rel: string, c: string) => {
        const p = path.join(sub, "novel", rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, c, "utf8");
      };
      await sw("chapters/001.md", "# 第一章\n\n原文\n");
      await exec(["add", "-A"], { cwd: sub });
      await exec(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: sub });
      await exec(["checkout", "-q", "-b", "line/x"], { cwd: sub });
      await sw("chapters/001.md", "# 第一章\n\n支线改的\n");
      await exec(["add", "-A"], { cwd: sub });
      await exec(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "改"], { cwd: sub });

      const cmp = await compareBranches(exec, sub, "main", "line/x", "novel/");
      expect(cmp.chapters).toHaveLength(1);
      // 返回的是作品相对路径，不带 novel/ 前缀
      expect(cmp.chapters[0].file).toBe("chapters/001.md");
      expect(cmp.chapters[0].verdict).toBe("take-source");
    } finally {
      fs.rmSync(sub, { recursive: true, force: true });
    }
  });

  it("没有共同祖先时不崩，两边都算改动", async () => {
    // 造一棵完全独立的历史
    await git("checkout", "-q", "--orphan", "island");
    await git("rm", "-rf", "--cached", ".");
    await write("chapters/001.md", "# 独立\n\n另一棵树。\n");
    await commitAll("独立根");

    const cmp = await compareBranches(exec, root, "main", "island");
    expect(cmp.mergeBase).toBeUndefined();
    expect(cmp.chapters.length).toBeGreaterThan(0);
  });

  // 真实场景：作者从没配过 git，仓库是我们静默初始化的
  it("作者没配 git 身份时，合并提交仍然成功", async () => {
    // 模拟「从没用过 git」的机器：把 global/system 配置指向空文件，
    // 让 git 完全找不到 user.name / user.email。
    // 注意不能设成空字符串的环境变量——那会让 git 报 "empty ident"，
    // 是另一种失败，不是我们要测的「没配置」。
    const empty = path.join(root, ".empty-gitconfig");
    fs.writeFileSync(empty, "");
    const noIdentity: ExecFn = (args, opts) =>
      exec(args, {
        ...opts,
        env: { ...opts.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty },
      });

    // 先在这个「无身份」环境下确认普通 commit 确实会失败，证明测试前提成立
    const probe = await noIdentity(["-c", "user.useConfigOnly=true", "commit-tree", "HEAD^{tree}", "-m", "probe"], {
      cwd: root,
    });
    expect(probe.code).not.toBe(0);
    expect(probe.stderr).toMatch(/identity|user\.email|user\.name/i);

    // 关掉仓库级身份，确保 createSnapshot 里只剩我们自己的兜底
    await exec(["config", "--unset", "user.name"], { cwd: root });
    await exec(["config", "--unset", "user.email"], { cwd: root });

    await noIdentity(["checkout", "-q", "-b", "line/x"], { cwd: root });
    await write("chapters/002.md", "# 第二章\n\n新章。\n");
    await noIdentity(["add", "-A"], { cwd: root });
    // 这一步必须显式给身份：否则这个测试准备用的 commit 本身就做不出来
    await noIdentity(
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "支线"],
      { cwd: root },
    );

    const result = await applyMerge(
      noIdentity,
      root,
      {
        source: "line/x",
        targetRef: "refs/novelpad/merge/noidentity",
        decisions: [{ file: "chapters/002.md", action: "take-source" }],
        summary: "合并",
      },
      async (file) => {
        const r = await exec(["show", `line/x:${file}`], { cwd: root });
        const p = path.join(root, file);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, r.stdout, "utf8");
      },
    );

    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
  });
});

describe("双版对照（真实 git）", () => {
  it("返回两边的全文与字数", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await write("chapters/001.md", "# 第一章 起点\n\n支线版本，长一些。\n");
    await commitAll("支线");

    const cmp = await chapterComparison(exec, root, "main", "line/x", "chapters/001.md");
    expect(cmp.targetText).toContain("雨落在瓦上");
    expect(cmp.sourceText).toContain("支线版本");
    expect(cmp.sourceChars).toBeGreaterThan(cmp.targetChars);
  });

  it("一边不存在时返回空串而不是抛异常", async () => {
    await git("checkout", "-q", "-b", "line/x");
    const cmp = await chapterComparison(exec, root, "main", "line/x", "chapters/999.md");
    expect(cmp.targetText).toBe("");
    expect(cmp.sourceText).toBe("");
    expect(cmp.targetChars).toBe(0);
  });
});

describe("执行合并（真实 git）", () => {
  it("采用来源版本后，目标分支顶端包含该内容", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await write("chapters/002.md", "# 第二章 雨夜\n\n支线写的新章。\n");
    await commitAll("支线加章");

    // 模拟扩展侧：把来源版本落到工作区
    const result = await applyMerge(
      exec,
      root,
      {
        source: "line/x",
        targetRef: "refs/novelpad/merge/test1",
        decisions: [{ file: "chapters/002.md", action: "take-source" }],
        summary: "合并 林晚照 线",
      },
      async (file) => {
        const r = await exec(["show", `line/x:${file}`], { cwd: root });
        const p = path.join(root, file);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, r.stdout, "utf8");
      },
    );

    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    expect(result.commit).toBeTruthy();

    const content = await exec(["show", `${result.commit}:chapters/002.md`], { cwd: root });
    expect(content.stdout).toContain("支线写的新章");
  });

  /**
   * 这条是**数据丢失**的回归测试。
   *
   * createSnapshot 默认从空树起步（自动存档要的部分快照语义），
   * 因此在一条已有分支上追加提交时必须显式传 base=目标 ref。
   * 曾漏传：合并一章后 `ls-tree` 只剩那一章，其余章节与设定
   * 全部从历史里消失——而且是「合并成功」的绿色结果。
   */
  it("合并不会让未被合并的章节消失（必须带 base）", async () => {
    await write("chapters/001.md", "# 第一章 起点\n\n原有内容\n");
    await write("chapters/002.md", "# 第二章\n\n原有内容\n");
    await write("lore/characters/lin.md", "# 林晚照\n\n设定\n");
    await commitAll("补齐原有文件");

    await git("checkout", "-q", "-b", "line/x");
    await write("chapters/003.md", "# 第三章\n\n支线写的\n");
    await commitAll("支线加第三章");

    const mainHead = (await git("rev-parse", "main")).trim();
    await git("update-ref", "refs/novelpad/merge/noloss", mainHead);

    const result = await applyMerge(
      exec,
      root,
      {
        source: "line/x",
        targetRef: "refs/novelpad/merge/noloss",
        decisions: [{ file: "chapters/003.md", action: "take-source" }],
        summary: "合并",
      },
      async (file) => {
        const r = await exec(["show", `line/x:${file}`], { cwd: root });
        const p = path.join(root, file);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, r.stdout, "utf8");
      },
    );

    expect(result.ok).toBe(true);
    const listed = (await git("ls-tree", "-r", "--name-only", result.commit!)).trim().split("\n");
    expect(listed).toContain("chapters/001.md");
    expect(listed).toContain("chapters/002.md");
    expect(listed).toContain("chapters/003.md");
    expect(listed).toContain("lore/characters/lin.md");
  });

  it("delete 动作会把该章从目标分支删掉，且不影响其他章", async () => {
    await write("chapters/002.md", "# 第二章\n\n待删除\n");
    await commitAll("加第二章");
    await git("checkout", "-q", "-b", "line/x");
    await git("rm", "-q", "chapters/002.md");
    await commitAll("支线删掉第二章");
    const mainHead = (await git("rev-parse", "main")).trim();
    await git("update-ref", "refs/novelpad/merge/del", mainHead);

    const result = await applyMerge(
      exec,
      root,
      {
        source: "line/x",
        targetRef: "refs/novelpad/merge/del",
        decisions: [{ file: "chapters/002.md", action: "delete" }],
        summary: "合并删除",
      },
      async (file, action) => {
        if (action === "delete") {
          fs.rmSync(path.join(root, file), { force: true });
          return;
        }
        throw new Error("不该走到这里");
      },
    );

    expect(result.ok).toBe(true);
    const listed = (await git("ls-tree", "-r", "--name-only", result.commit!)).trim().split("\n");
    expect(listed).not.toContain("chapters/002.md");
    expect(listed).toContain("chapters/001.md");
  });

  it("目标 ref 不存在时也能合并（第一次合并到新支线）", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await write("chapters/002.md", "# 第二章\n\n新章\n");
    await commitAll("加章");

    const result = await applyMerge(
      exec,
      root,
      {
        source: "line/x",
        targetRef: "refs/novelpad/merge/brand-new",
        decisions: [{ file: "chapters/002.md", action: "take-source" }],
        summary: "首次合并",
      },
      async (file) => {
        const r = await exec(["show", `line/x:${file}`], { cwd: root });
        const p = path.join(root, file);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, r.stdout, "utf8");
      },
    );

    expect(result.ok).toBe(true);
    expect(result.commit).toBeTruthy();
    const exists = await exec(["rev-parse", "--verify", "--quiet", "refs/novelpad/merge/brand-new"], { cwd: root });
    expect(exists.code).toBe(0);
  });

  it("全部保留目标时不产生提交", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await write("chapters/002.md", "新章\n");
    await commitAll("加章");

    const result = await applyMerge(
      exec,
      root,
      {
        source: "line/x",
        targetRef: "refs/novelpad/merge/test2",
        decisions: [{ file: "chapters/002.md", action: "keep-target" }],
        summary: "什么都不合并",
      },
      async () => {
        throw new Error("不该被调用");
      },
    );

    expect(result.ok).toBe(true);
    expect(result.empty).toBe(true);
    expect(result.written).toBe(0);
  });

  it("materialize 抛错时不留下半成品提交", async () => {
    const result = await applyMerge(
      exec,
      root,
      {
        source: "line/x",
        targetRef: "refs/novelpad/merge/test3",
        decisions: [{ file: "chapters/002.md", action: "take-source" }],
        summary: "会失败",
      },
      async () => {
        throw new Error("磁盘满了");
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("磁盘满了");
    const ref = await exec(["rev-parse", "--verify", "--quiet", "refs/novelpad/merge/test3"], { cwd: root });
    expect(ref.code).not.toBe(0); // ref 不该被创建
  });

  it("合并提交接在目标 ref 后面（时间线看起来是连续的一版）", async () => {
    await git("checkout", "-q", "-b", "line/x");
    await write("chapters/002.md", "新章内容\n");
    await commitAll("加章");

    // 先给目标 ref 一个初始位置
    const head = (await git("rev-parse", "main")).trim();
    await git("update-ref", "refs/novelpad/merge/test4", head);

    const result = await applyMerge(
      exec,
      root,
      {
        source: "line/x",
        targetRef: "refs/novelpad/merge/test4",
        decisions: [{ file: "chapters/002.md", action: "take-source" }],
        summary: "合并",
      },
      async (file) => {
        const r = await exec(["show", `line/x:${file}`], { cwd: root });
        const p = path.join(root, file);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, r.stdout, "utf8");
      },
    );

    expect(result.ok).toBe(true);
    const parent = (await git("rev-parse", `${result.commit}^`)).trim();
    expect(parent).toBe(head);
  });

  it("支持作品子目录前缀", async () => {
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), "np-merge-apply-"));
    try {
      await exec(["init", "-q", "-b", "main"], { cwd: sub });
      await exec(["config", "core.autocrlf", "false"], { cwd: sub });
      const sw = async (rel: string, c: string) => {
        const p = path.join(sub, "novel", rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, c, "utf8");
      };
      await sw("chapters/001.md", "原文\n");
      await exec(["add", "-A"], { cwd: sub });
      await exec(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: sub });
      await exec(["checkout", "-q", "-b", "line/x"], { cwd: sub });
      await sw("chapters/001.md", "支线版本\n");
      await exec(["add", "-A"], { cwd: sub });
      await exec(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "改"], { cwd: sub });

      const result = await applyMerge(
        exec,
        sub,
        {
          source: "line/x",
          targetRef: "refs/novelpad/merge/sub",
          decisions: [{ file: "chapters/001.md", action: "take-source" }],
          summary: "合并",
          prefix: "novel/",
        },
        async () => {
          // 工作区已经在支线分支上，无需搬运
        },
      );

      expect(result.ok).toBe(true);
      const content = await exec(["show", `${result.commit}:novel/chapters/001.md`], { cwd: sub });
      expect(content.stdout).toContain("支线版本");
    } finally {
      fs.rmSync(sub, { recursive: true, force: true });
    }
  });
});