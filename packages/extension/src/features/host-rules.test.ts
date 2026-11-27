/**
 * 托管层单测。
 *
 * 三个重点：
 *   1. 中文作品名不能变成空仓库名（作者会看到一片空白输入框）
 *   2. 作品埋在别人的仓库里时必须拦住（否则推上去会泄露无关文件）
 *   3. 报错必须能指导下一步动作，不能只说「失败了」
 */
import { describe, expect, it } from "vitest";
import { backupHint, describeStatus, explainCreateError, hostingProblem, suggestRepoName, validRepoName } from "./host-rules.js";

const D = new Date("2026-11-27T10:00:00Z");

describe("suggestRepoName", () => {
  it("中文作品名退回「带日期的稳定名」，不能是空串", () => {
    // 《长夜将明》全被 ASCII 过滤器吃掉——若直接返回空，作者的输入框是空的
    const n = suggestRepoName("长夜将明", D);
    expect(n).toBe("novelpad-20261127");
  });

  it("纯 ASCII 名直接转 kebab-case", () => {
    expect(suggestRepoName("Night Falls", D)).toBe("night-falls");
    expect(suggestRepoName("Novel_Pad 2", D)).toBe("novel-pad-2");
  });

  it("中英混排时取能用的英文部分", () => {
    expect(suggestRepoName("长夜 Night", D)).toBe("night");
  });

  it("单个字母太容易撞名，退回稳定名", () => {
    expect(suggestRepoName("a", D)).toBe("novelpad-20261127");
  });

  it("首尾分隔符被清掉（不能是 -foo- 这种）", () => {
    expect(suggestRepoName("  --长夜--  ", D)).toBe("novelpad-20261127");
    expect(suggestRepoName("--abc--", D)).toBe("abc");
  });

  it("结果总是合法仓库名", () => {
    for (const t of ["长夜将明", "Night Falls", "a", "", "????", "第三部：归途"]) {
      expect(validRepoName(suggestRepoName(t, D))).toBe(true);
    }
  });

  it("超长名字被截断且仍合法", () => {
    const n = suggestRepoName("a".repeat(200), D);
    expect(n.length).toBeLessThanOrEqual(60);
    expect(validRepoName(n)).toBe(true);
  });
});

describe("validRepoName", () => {
  it("接受常见写法", () => {
    for (const n of ["novel", "my.novel", "my_novel", "my-novel", "A1"]) expect(validRepoName(n)).toBe(true);
  });

  it("拒绝空格、中文、斜杠", () => {
    for (const n of ["my novel", "小说", "a/b", ""]) expect(validRepoName(n)).toBe(false);
  });
});

describe("hostingProblem", () => {
  it("仓库根就是作品根：没问题", () => {
    expect(hostingProblem("E:/novel", "E:/novel")).toBeUndefined();
  });

  it("结尾斜杠与反斜杠不影响判断", () => {
    expect(hostingProblem("E:\\novel\\", "E:/novel")).toBeUndefined();
  });

  it("作品埋在别人的仓库里：拦住，并说清风险", () => {
    const msg = hostingProblem("E:/Documents", "E:/Documents/novel");
    expect(msg).toBeDefined();
    expect(msg).toContain("整个仓库");
    // 必须说清后果：作者要知道「无关文件也会被推上去」
    expect(msg).toContain("无关");
  });

  it("还没建仓库时放行（后面会 ensureRepo）", () => {
    expect(hostingProblem(undefined, "E:/novel")).toBeUndefined();
  });

  it("只是名字前缀相同不算嵌套（/novel 与 /novel2 是两回事）", () => {
    expect(hostingProblem("E:/novel", "E:/novel2")).toBeDefined();
    expect(hostingProblem("E:/novel2", "E:/novel")).toBeDefined();
  });
});

describe("explainCreateError", () => {
  it("重名时说清是重名，并给两条出路", () => {
    const m = explainCreateError('{"message":"Repository creation failed.","errors":[{"message":"name already exists on this account"}]}', "novel");
    expect(m).toContain("已经有一个");
    expect(m).toContain("换个名字");
  });

  it("凭据失效时说要重连", () => {
    expect(explainCreateError("Bad credentials", "x")).toContain("重新连接");
  });

  it("权限不足时说清需要什么权限", () => {
    expect(explainCreateError("Resource not accessible by personal access token", "x")).toContain("repo");
  });

  it("网络问题单独一类", () => {
    expect(explainCreateError("getaddrinfo ENOTFOUND api.github.com", "x")).toContain("网络");
  });

  it("非法名字时回显名字并给出字符集", () => {
    const m = explainCreateError("Repository name is invalid", "我的 小说");
    expect(m).toContain("我的 小说");
    expect(m).toContain("字母");
  });

  it("认不出的错误原样返回（不吞原因）", () => {
    expect(explainCreateError("something odd", "x")).toBe("something odd");
  });

  it("空输入不崩", () => {
    expect(explainCreateError("", "x")).toBe("建仓库失败，原因不明");
  });
});

describe("describeStatus", () => {
  const p = (o: Partial<{ ahead: number; behind: number; dirty: boolean; hasUpstream: boolean }>) => ({
    ahead: 0,
    behind: 0,
    dirty: false,
    hasUpstream: true,
    ...o,
  });

  it("未连接时直说", () => {
    expect(describeStatus({ connected: false })).toBe("未连接云端");
  });

  it("已连接但没推过第一版", () => {
    expect(describeStatus({ connected: true, preview: p({ hasUpstream: false }) })).toBe("还没推过第一版");
  });

  it("N 版待备份", () => {
    expect(describeStatus({ connected: true, preview: p({ ahead: 3 }) })).toBe("3 版待备份");
  });

  it("两边都有新东西时说清是哪边", () => {
    const s = describeStatus({ connected: true, preview: p({ ahead: 2, behind: 1 }) });
    expect(s).toContain("2 版待备份");
    expect(s).toContain("云端也有新的");
  });

  it("同步完成", () => {
    expect(describeStatus({ connected: true, preview: p({}) })).toBe("已同步");
  });

  it("不用 ahead / behind / upstream 这些词（作者不认）", () => {
    const cases = [
      describeStatus({ connected: false }),
      describeStatus({ connected: true, preview: p({ ahead: 1, behind: 1 }) }),
      describeStatus({ connected: true, preview: p({ hasUpstream: false }) }),
    ];
    for (const s of cases) {
      expect(s).not.toMatch(/ahead|behind|upstream|commit|push/i);
    }
  });
});

describe("backupHint", () => {
  it("有未提交改动时提醒会先自动存档", () => {
    const h = backupHint({ connected: true, preview: { ahead: 0, behind: 0, dirty: true, hasUpstream: true } });
    expect(h).toContain("自动存一版");
  });

  it("没改动时退回普通状态文案", () => {
    const h = backupHint({ connected: true, preview: { ahead: 1, behind: 0, dirty: false, hasUpstream: true } });
    expect(h).toBe("1 版待备份");
  });
});