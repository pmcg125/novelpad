import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll } from "vitest";
import { parse, resolveRoot, loadProfile, cmdInit } from "./lib.js";

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/demo-novel");
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

describe("parse", () => {
  it("解析 --k v 与 --k=v 两种形式", () => {
    const a = parse(["export", "--format", "txt", "--profile=print", "examples/x"]);
    expect(a._).toEqual(["export", "examples/x"]);
    expect(a.format).toBe("txt");
    expect(a.profile).toBe("print");
  });
  it("默认 format=all", () => {
    expect(parse([]).format).toBe("all");
  });
});

describe("resolveRoot", () => {
  it("显式目录原样返回", () => {
    expect(resolveRoot(EXAMPLE)).toBe(EXAMPLE);
  });
  it("无参数时从 cwd 向上查找 .novelpad", () => {
    const cwd = process.cwd();
    process.chdir(path.join(EXAMPLE, "chapters"));
    try {
      expect(resolveRoot(undefined)).toBe(EXAMPLE);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("loadProfile", () => {
  it("内置 profile", () => {
    expect(loadProfile(EXAMPLE, "submission").txt.blankLineBetweenParagraphs).toBe(true);
  });
  it("读取 config.exportProfile", () => {
    expect(loadProfile(EXAMPLE).name).toBe("default");
  });
});

describe("cmdInit", () => {
  it("创建标准目录结构", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novelpad-"));
    cmdInit({ _: [dir], format: "all", profile: undefined, out: undefined, status: undefined, help: false });
    for (const p of [".novelpad/config.json", "chapters/001.md", "characters", "world/locations"]) {
      expect(fs.existsSync(path.join(dir, p))).toBe(true);
    }
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".novelpad/config.json"), "utf8")).title).toBe(path.basename(dir));
  });
});

describe("CLI 端到端（dist/cli.js）", () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error("请先构建 @novelpad/cli");
  });

  function run(args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  }

  it("stats 输出章节与合计", () => {
    const r = run(["stats", EXAMPLE]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("《雨夜》");
    expect(r.stdout).toContain("合计：3 章");
  });

  it("check 返回 0 并列出问题", () => {
    const r = run(["check", EXAMPLE]);
    expect([0, 1]).toContain(r.status);
    expect(r.stdout).toMatch(/\d+ 个问题/);
  });

  it("export --format txt 生成带 BOM 的 UTF-8 文本", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "novelpad-out-"));
    const r = run(["export", EXAMPLE, "--format", "txt", "--out", out]);
    expect(r.status, r.stderr).toBe(0);
    const files = fs.readdirSync(out);
    expect(files).toEqual(["雨夜.txt"]);
    const buf = fs.readFileSync(path.join(out, "雨夜.txt"));
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(buf.toString("utf8")).toContain("第一章 雨夜");
  });

  it("export --format docx 生成 docx", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "novelpad-out-"));
    const r = run(["export", EXAMPLE, "--format", "docx", "--out", out, "--profile", "submission"]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(out)).toEqual(["雨夜.docx"]);
    expect(fs.statSync(path.join(out, "雨夜.docx")).size).toBeGreaterThan(1000);
  });

  it("--help", () => {
    expect(run(["--help"]).status).toBe(0);
  });
});
