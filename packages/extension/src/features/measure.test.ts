/**
 * 正文栏宽判据的单测。
 *
 * 为什么值得测：这一块全是「只能跑出来」的错误。
 *   - 忘了按工作区记账 → 每次启动都翻转一次居中版式，作者手动关掉无效。
 *   - 把 `defaultValue` 当成用户选择 → 永远不写 fixedWidth，栏宽退回
 *     1150px（一行 59 字），看起来「限宽没生效」。
 *   - 记账数组原地改 → 多个工作区共享同一份状态，切来切去会丢记录。
 */
import { describe, expect, it } from "vitest";
import {
  CENTER_COMMAND,
  FIXED_WIDTH_KEY,
  explicitValue,
  shouldCenter,
  shouldSetFixedWidth,
  withCentered,
} from "./measure-rules.js";

describe("每个工作区只切一次", () => {
  it("没记过账 → 要切", () => {
    expect(shouldCenter([], "file:///e/novels/a")).toBe(true);
    expect(shouldCenter(["file:///e/novels/b"], "file:///e/novels/a")).toBe(true);
  });

  it("记过账 → 不切（尊重作者自己关掉居中版式）", () => {
    expect(shouldCenter(["file:///e/novels/a"], "file:///e/novels/a")).toBe(false);
  });

  // 不同作品分开记账：A 作品切过，换到 B 作品还要切一次
  it("多个工作区互不干扰", () => {
    let done: string[] = [];
    done = withCentered(done, "a");
    expect(shouldCenter(done, "a")).toBe(false);
    expect(shouldCenter(done, "b")).toBe(true);
    done = withCentered(done, "b");
    expect(done).toEqual(["a", "b"]);
  });
});

describe("记账数组", () => {
  it("追加后返回新数组，不动入参（避免共享引用被改）", () => {
    const before = ["a"];
    const after = withCentered(before, "b");
    expect(before).toEqual(["a"]);
    expect(after).toEqual(["a", "b"]);
  });

  it("重复记同一个工作区不产生重复项", () => {
    expect(withCentered(["a", "b"], "a")).toEqual(["a", "b"]);
  });

  it("入参是只读数组也能用（globalState 取出来的可能是冻结的）", () => {
    const frozen = Object.freeze(["a"]) as readonly string[];
    expect(withCentered(frozen, "b")).toEqual(["a", "b"]);
  });
});

describe("固定宽度", () => {
  it("作者没设过 → 我们写（默认按比例 61.8% 太宽）", () => {
    expect(shouldSetFixedWidth(undefined)).toBe(true);
  });

  it("作者设过 → 不动，包括设成 false", () => {
    expect(shouldSetFixedWidth(true)).toBe(false);
    expect(shouldSetFixedWidth(false)).toBe(false);
  });
});

describe("取作者显式值", () => {
  // defaultValue 是上游默认值，不能当作用户意图：fixedWidth 的上游默认
  // 是 false，若把它算成「用户设过了」，我们永远不写这个键，栏宽就退回
  // 1150px（一行 59 字），现象是「限宽没生效」，而没有任何报错。
  it("defaultValue 不算用户选择", () => {
    const inspected = { key: FIXED_WIDTH_KEY, defaultValue: false, globalValue: undefined };
    expect(explicitValue(inspected as { globalValue?: boolean })).toBeUndefined();
  });

  it("工作区 / 文件夹级优先于全局", () => {
    expect(explicitValue({ globalValue: true, workspaceValue: false })).toBe(false);
    expect(explicitValue({ globalValue: true, workspaceValue: false, workspaceFolderValue: true })).toBe(true);
  });

  it("inspect 返回 undefined（键不存在）也不炸", () => {
    expect(explicitValue(undefined)).toBeUndefined();
  });
});

describe("命令与键名", () => {
  // 拼错的字符串不会报错，只是点了没反应
  it("用的是上游真实命令", () => {
    expect(CENTER_COMMAND).toBe("workbench.action.toggleCenteredLayout");
  });

  it("用的是上游真实设置键", () => {
    expect(FIXED_WIDTH_KEY).toBe("workbench.editor.centeredLayoutFixedWidth");
  });
});