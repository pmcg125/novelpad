import type { Project } from "../types.js";
import { lint, type LintOptions, type Rule } from "./engine.js";
import { foreshadowOverdue, unknownForeshadow, foreshadowResolvedBeforeDeclared } from "./foreshadow.js";
import { unknownCharacter, unknownPov, unknownLocation, duplicateOrder } from "./consistency.js";
import { repeatedWord, longParagraph, unclosedComment } from "./text.js";

export { lint, resolveSeverity } from "./engine.js";
export type { Rule, RuleMeta, RuleContext, LintOptions, SeverityConfig } from "./engine.js";
export { foreshadowOverdue, unknownForeshadow, foreshadowResolvedBeforeDeclared, collectForeshadows } from "./foreshadow.js";
export { unknownCharacter, unknownPov, unknownLocation, duplicateOrder } from "./consistency.js";
export { repeatedWord, longParagraph, unclosedComment } from "./text.js";

/** 内置规则全集 */
export const builtinRules: Rule[] = [
  foreshadowOverdue,
  unknownForeshadow,
  foreshadowResolvedBeforeDeclared,
  unknownCharacter,
  unknownPov,
  unknownLocation,
  duplicateOrder,
  repeatedWord,
  longParagraph,
  unclosedComment,
];

/** 对作品运行全部内置规则 */
export function lintProject(project: Project, opts: LintOptions = {}, rules: Rule[] = builtinRules) {
  return lint(project, rules, opts);
}
