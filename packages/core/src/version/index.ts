/**
 * 版本管理内核（M8）：git 后端 + 快照 / diff / 批注。
 *
 *   repo.ts      与 git 对话（execFile，无依赖）
 *   snapshot.ts  三类快照的建/读/清理 + 本地索引
 *   diff.ts      段落级 + 字级 diff
 *   annotate.ts  批注锚定与四级退让
 */
export * from "./repo.js";
export * from "./layout.js";
export * from "./snapshot.js";
export * from "./diff.js";
export * from "./annotate.js";