/**
 * 支线显示名的纯逻辑单测。
 *
 * 放在 worktree.test.ts 一起跑：这些函数不依赖 vscode，
 * 而 branches.ts 引了 vscode，在 vitest 里加载不了。
 */
import { describe, expect, it } from "vitest";
import { prettyBranch, sanitizeBranchName } from "./worktree.js";

describe("prettyBranch", () => {
  it("人物线只显示名字（作者输入什么就看到什么）", () => {
    expect(prettyBranch("line/林晚照")).toBe("林晚照");
  });

  it("备选走向加前缀「备选：」，因为作者需要区分这两种性质", () => {
    expect(prettyBranch("alt/第七结局")).toBe("备选：第七结局");
  });

  it("二级命名保留后半段（line/第一卷/林晚照）", () => {
    expect(prettyBranch("line/第一卷/林晚照")).toBe("第一卷/林晚照");
  });

  it("没有前缀时原样返回（作者手工建的分支）", () => {
    expect(prettyBranch("experiment")).toBe("experiment");
  });

  it("未知前缀原样返回，不瞎猜", () => {
    expect(prettyBranch("wip/试验")).toBe("wip/试验");
  });

  it("前缀后面为空时不崩", () => {
    expect(prettyBranch("line/")).toBe("");
  });
});

describe("作者输入 → 分支名的完整链路", () => {
  /**
   * 这几条串起「作者在输入框里打字」到「git 里实际存的名字」。
   * 任何一环错，作者都会找不到自己的支线。
   */
  it("「林晚照线」保持原样", () => {
    expect(sanitizeBranchName("林晚照线")).toBe("林晚照线");
    expect(prettyBranch(`line/${sanitizeBranchName("林晚照线")}`)).toBe("林晚照线");
  });

  it("「第七结局（备选）」去掉全角括号，显示时仍可读", () => {
    const clean = sanitizeBranchName("第七结局（备选）");
    expect(clean).toBe("第七结局备选");
    expect(prettyBranch(`alt/${clean}`)).toBe("备选：第七结局备选");
  });

  it("带空格的输入折成连字符（git 不允许空格）", () => {
    expect(sanitizeBranchName("林晚照 线")).toBe("林晚照-线");
  });
});