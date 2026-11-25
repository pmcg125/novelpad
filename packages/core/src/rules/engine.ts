/**
 * Lint 规则引擎（参考 ESLint 架构：规则 = { meta, run }）
 */
import type { Chapter, Diagnostic, Project } from "../types.js";

export interface RuleContext {
  project: Project;
  /** 当前章节（按章节运行的规则） */
  chapter?: Chapter;
  /** 读取章节正文某行的内容 */
  line(n: number): string;
  /** severity / rule / file 均可省略，由引擎补全（perChapter 规则 file 默认为当前章节） */
  report(d: Omit<Diagnostic, "rule" | "severity" | "file"> & { rule?: string; severity?: Diagnostic["severity"]; file?: string }): void;
}

export interface RuleMeta {
  id: string;
  description: string;
  defaultSeverity: "error" | "warning" | "info";
  /** 是否需要逐章运行（否则全局运行一次） */
  perChapter?: boolean;
}

export interface Rule {
  meta: RuleMeta;
  run(ctx: RuleContext): void;
}

export type SeverityConfig = Record<string, boolean | "error" | "warning" | "info">;

export interface LintOptions {
  /** 项目配置中的 rules 覆盖 */
  rules?: SeverityConfig;
}

/** 解析某规则的最终生效严重级别；false 表示禁用 */
export function resolveSeverity(rule: RuleMeta, config?: SeverityConfig): Diagnostic["severity"] | null {
  const v = config?.[rule.id];
  if (v === false) return null;
  if (v === true || v === undefined) return rule.defaultSeverity;
  return v;
}

export function lint(project: Project, rules: Rule[], opts: LintOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (d: Diagnostic) => out.push(d);

  const makeCtx = (ruleId: string, chapter?: Chapter): RuleContext => {
    const lines = chapter ? chapter.content.split(/\r?\n/) : [];
    return {
      project,
      chapter,
      line: (n) => lines[n - 1] ?? "",
      report: (d) =>
        push({
          severity: "warning",
          ...d,
          rule: d.rule ?? ruleId,
          file: d.file ?? chapter?.relativePath ?? ".novelpad/config.json",
        }),
    };
  };

  for (const rule of rules) {
    const severity = resolveSeverity(rule.meta, opts.rules);
    if (!severity) continue;
    if (rule.meta.perChapter) {
      for (const ch of project.chapters) {
        const ctx = makeCtx(rule.meta.id, ch);
        const before = out.length;
        rule.run(ctx);
        for (let i = before; i < out.length; i++) out[i].severity = severity;
      }
    } else {
      const ctx = makeCtx(rule.meta.id);
      const before = out.length;
      rule.run(ctx);
      for (let i = before; i < out.length; i++) out[i].severity = severity;
    }
  }

  // 按文件、行号排序
  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return out;
}
