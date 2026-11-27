/**
 * 由设计令牌生成 VS Code 主题 JSON。
 * 令牌与 docs/design/mockups/mockup.css 保持一致；后续迁入 Style Dictionary 后改为读取 tokens/*.json。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 可选参数：输出目录。校验脚本会传一个临时目录，用「重新生成一遍再比对」
// 来确认仓库里的主题 JSON 没有被手改过（手改会在下次构建被静默覆盖）。
const out = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../themes");
fs.mkdirSync(out, { recursive: true });

/* ---------- 令牌（与 mockup.css 一致） ---------- */
const PAPER = {
  bgEditor: "#F7F3E8", bgSidebar: "#F0EBDD", bgActivity: "#2F2D2A", bgStatus: "#E8E2D4",
  bgHover: "#EAE4D6", bgActive: "#E3E9DC", bgInput: "#FBF8F0", border: "#E1DACA",
  fgText: "#2B2825", fgUi: "#3A3630", fgMuted: "#6B645C", fgFaint: "#948C80",
  fgDisabled: "#8E877F",
  accent: "#2F7D6B", accentFg: "#FFFFFF", accentSoft: "#E3E9DC",
  warning: "#B7791F", error: "#C5283D", success: "#3C8C5A", info: "#3A6EA5",
};
const INK = {
  bgEditor: "#201F1C", bgSidebar: "#1B1A17", bgActivity: "#141311", bgStatus: "#171614",
  bgHover: "#24231F", bgActive: "#242923", bgInput: "#26241F", border: "#2C2A26",
  fgText: "#DAD3C6", fgUi: "#CFC8BA", fgMuted: "#9A938A", fgFaint: "#6E685E",
  fgDisabled: "#7E7770",
  accent: "#5CB8A6", accentFg: "#10201B", accentSoft: "#1F2D28",
  warning: "#D9A04A", error: "#E5586B", success: "#5DBA82", info: "#7AA9DA",
};

/** 由一组令牌生成 workbench 配色 */
function workbenchColors(t) {
  return {
    foreground: t.fgUi,
    descriptionForeground: t.fgMuted,
    errorForeground: t.error,
    "activityBar.background": t.bgActivity,
    "activityBar.foreground": t.fgMuted,
    "activityBar.inactiveForeground": t.fgFaint,
    "activityBar.activeBorder": t.accent,
    "activityBar.border": t.bgActivity,
    "sideBar.background": t.bgSidebar,
    "sideBar.foreground": t.fgUi,
    "sideBar.border": t.border,
    "sideBarSectionHeader.background": t.bgSidebar,
    "sideBarSectionHeader.border": t.border,
    "sideBarSectionHeader.foreground": t.fgMuted,
    "sideBarTitle.foreground": t.fgUi,
    "editor.background": t.bgEditor,
    "editor.foreground": t.fgText,
    "editorLineNumber.foreground": t.fgFaint,
    "editorLineNumber.activeForeground": t.accent,
    "editorCursor.foreground": t.accent,
    "editor.selectionBackground": t.accentSoft,
    "editor.inactiveSelectionBackground": t.bgActive,
    "editor.lineHighlightBackground": t.bgActive,
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionHighlightBackground": t.accentSoft + "80",
    "editor.wordHighlightBackground": t.accentSoft + "80",
    "editorIndentGuide.background1": t.border + "80",
    "editorIndentGuide.activeBackground1": t.fgFaint,
    "editorRuler.foreground": t.border,
    "editorBracketMatch.background": t.accentSoft,
    "editorBracketMatch.border": t.accent,
    "editorGutter.background": t.bgEditor,
    "editorWhitespace.foreground": t.border,
    "editorHoverWidget.background": t.bgInput,
    "editorHoverWidget.border": t.border,
    "editorSuggestWidget.background": t.bgInput,
    "editorSuggestWidget.border": t.border,
    "editorSuggestWidget.selectedBackground": t.bgActive,
    "editorSuggestWidget.highlightForeground": t.accent,
    "editorWidget.background": t.bgInput,
    "editorWidget.border": t.border,
    "editorError.foreground": t.error,
    "editorWarning.foreground": t.warning,
    "editorInfo.foreground": t.info,
    "editorInlayHint.foreground": t.fgMuted,
    "editorInlayHint.background": t.bgSidebar,
    "editorGroup.border": t.border,
    "editorGroup.emptyBackground": t.bgEditor,
    "editorGroupHeader.tabsBackground": t.bgSidebar,
    "editorGroupHeader.noTabsBackground": t.bgSidebar,
    "editorGroupHeader.border": t.border,
    "tab.activeBackground": t.bgEditor,
    "tab.activeForeground": t.fgText,
    "tab.activeBorderTop": t.accent,
    "tab.inactiveBackground": t.bgSidebar,
    "tab.inactiveForeground": t.fgMuted,
    "tab.border": t.border,
    "tab.hoverBackground": t.bgHover,
    "statusBar.background": t.bgStatus,
    "statusBar.foreground": t.fgMuted,
    "statusBar.border": t.border,
    "statusBar.noFolderBackground": t.bgStatus,
    "titleBar.activeBackground": t.bgSidebar,
    "titleBar.activeForeground": t.fgUi,
    "titleBar.inactiveBackground": t.bgSidebar,
    "titleBar.inactiveForeground": t.fgFaint,
    "titleBar.border": t.border,
    "menu.background": t.bgInput,
    "menu.foreground": t.fgUi,
    "menu.border": t.border,
    "menu.selectionBackground": t.bgActive,
    "menu.selectionForeground": t.fgText,
    "menu.separatorBackground": t.border,
    "menubar.selectionBackground": t.bgHover,
    "menubar.selectionForeground": t.fgText,
    "commandCenter.background": t.bgSidebar,
    "commandCenter.foreground": t.fgMuted,
    "commandCenter.border": t.border,
    "commandCenter.activeBackground": t.bgHover,
    "input.background": t.bgInput,
    "input.foreground": t.fgText,
    "input.border": t.border,
    "input.placeholderForeground": t.fgFaint,
    "inputOption.activeBorder": t.accent,
    "dropdown.background": t.bgInput,
    "dropdown.foreground": t.fgText,
    "dropdown.border": t.border,
    "button.background": t.accent,
    "button.foreground": t.accentFg,
    "button.hoverBackground": t.accent + "DD",
    "button.secondaryBackground": t.bgActive,
    "button.secondaryForeground": t.fgUi,
    "button.secondaryHoverBackground": t.bgHover,
    "badge.background": t.accent,
    "badge.foreground": t.accentFg,
    "scrollbarSlider.background": t.fgFaint + "50",
    "scrollbarSlider.hoverBackground": t.fgFaint + "70",
    "scrollbarSlider.activeBackground": t.fgFaint + "90",
    "list.activeSelectionBackground": t.bgActive,
    "list.activeSelectionForeground": t.fgText,
    "list.activeSelectionIconForeground": t.accent,
    "list.focusOutline": t.accent,
    "list.hoverBackground": t.bgHover,
    "list.hoverForeground": t.fgText,
    "list.inactiveSelectionBackground": t.bgActive,
    "list.highlightForeground": t.accent,
    "list.errorForeground": t.error,
    "list.warningForeground": t.warning,
    "list.deemphasizedForeground": t.fgFaint,
    "tree.indentGuidesStroke": t.border,
    "tree.inactiveIndentGuidesStroke": t.border + "80",
    "panel.background": t.bgSidebar,
    "panel.border": t.border,
    "panelTitle.activeBorder": t.accent,
    "panelTitle.activeForeground": t.fgText,
    "panelTitle.inactiveForeground": t.fgMuted,
    "panelSection.border": t.border,
    "peekView.border": t.border,
    "peekViewTitle.background": t.bgSidebar,
    "peekViewTitleLabel.foreground": t.fgUi,
    "peekViewEditor.background": t.bgEditor,
    "peekViewEditorGutter.background": t.bgEditor,
    "peekViewResult.background": t.bgSidebar,
    "peekViewResult.selectionBackground": t.bgActive,
    "peekViewResult.matchHighlightBackground": t.accentSoft,
    "notifications.background": t.bgInput,
    "notifications.foreground": t.fgUi,
    "notifications.border": t.border,
    "notificationLink.foreground": t.info,
    "notificationsErrorIcon.foreground": t.error,
    "notificationsWarningIcon.foreground": t.warning,
    "notificationsInfoIcon.foreground": t.info,
    "welcomePage.background": t.bgEditor,
    "welcomePage.tileBackground": t.bgInput,
    "welcomePage.tileHoverBackground": t.bgHover,
    "welcomePage.tileBorder": t.border,
    "welcomePage.buttonBackground": t.accent,
    "welcomePage.buttonForeground": t.accentFg,
    "welcomePage.buttonHoverBackground": t.accent + "DD",
    "welcomePage.link.foreground": t.info,
    "settings.headerForeground": t.fgText,
    "settings.modifiedItemIndicator": t.accent,
    "settings.textInputBackground": t.bgInput,
    "settings.textInputForeground": t.fgText,
    "settings.numberInputBackground": t.bgInput,
    "settings.numberInputForeground": t.fgText,
    "checkbox.background": t.bgInput,
    "checkbox.foreground": t.fgUi,
    "checkbox.border": t.border,
    "checkbox.selectBackground": t.bgActive,
    "checkbox.selectBorder": t.accent,
    "settings.focusedRowBackground": t.bgActive,
    "quickInput.background": t.bgInput,
    "quickInput.foreground": t.fgUi,
    "quickInputList.focusBackground": t.bgActive,

    /* ---- 界面各处直接引用的颜色 ----
     *
     * 这些是 webview CSS（var(--vscode-…)）和装饰（new ThemeColor(…)）
     * 会读到的键。**每一个都必须显式定义**，缺色有两种失效方式，
     * 都不报错：
     *   - ThemeColor 读不到 → 上游 resolveValue 返回 'transparent'
     *     → 那段文字直接消失（作者以为稿子丢了）
     *   - CSS var 读不到 → 回落到 VS Code 默认值 → 宣纸页面上
     *     出现微软蓝链接（webview 拿不到主题兜底，就是裸的默认值）
     *
     * 注意上游的 registry 默认值是按 VS Code 自己的视觉体系定的，
     * 跟 NovelPad 的暖宣纸/青绿完全不搭，不能指望它兜底。
     */
    disabledForeground: t.fgDisabled,
    "textLink.foreground": t.accent,
    // 悬停/点按时的链接色：比静置亮一档。上游 light 默认是 #0066BF，
    // 不定义的话 markdown 预览里的链接一碰就变微软蓝。
    "textLink.activeForeground": t.accent + "CC",
    "gitDecoration.addedResourceForeground": t.success,
    "gitDecoration.modifiedResourceForeground": t.warning,
    "gitDecoration.deletedResourceForeground": t.error,
    "gitDecoration.ignoredResourceForeground": t.fgFaint,
    // 代码块底色：比 input 深一档，在宣纸上是一块淡淡的墨痕
    "textCodeBlock.background": t.bgHover,
    // 引用块：底色与左竖线，预览里 `> 引文` 用的就是这两个
    "textBlockQuote.background": t.bgSidebar,
    "textBlockQuote.border": t.accent + "66",
    // 焦点描边。上游 light 默认同样是蓝色系；写作界面里到处是
    // 输入框和列表项，焦点色不统一会一眼看出不是同一个主题。
    focusBorder: t.accent + "99",
    // 高对比分隔线。我们的主题不靠它活着（多数用法带 fallback），
    // 但 workbench.css 有一处裸用，缺色会退化成 currentColor 的重线。
    contrastBorder: t.border,
  };
}
/** TextMate 语法着色：面向 Markdown / YAML 写作场景 */
function tokenColors(t) {
  return [
    // Markdown
    { scope: "markup.heading", settings: { foreground: t.accent, fontStyle: "bold" } },
    { scope: "markup.heading.marker", settings: { foreground: t.fgFaint } },
    { scope: "markup.bold", settings: { fontStyle: "bold" } },
    { scope: "markup.italic", settings: { fontStyle: "italic" } },
    { scope: "markup.list", settings: { foreground: t.fgFaint } },
    { scope: "markup.quote", settings: { foreground: t.fgMuted, fontStyle: "italic" } },
    { scope: "markup.inline.raw", settings: { foreground: t.warning } },
    { scope: "markup.underline.link", settings: { foreground: t.info } },
    { scope: "punctuation.definition.link", settings: { foreground: t.fgFaint } },
    { scope: "comment", settings: { foreground: t.fgFaint, fontStyle: "italic" } },
    { scope: "punctuation.definition.comment", settings: { foreground: t.fgFaint } },
    { scope: "constant.character.escape", settings: { foreground: t.fgFaint } },
    // frontmatter / YAML
    { scope: "entity.name.tag.yaml", settings: { foreground: t.info } },
    { scope: "punctuation.definition.key-value.yaml", settings: { foreground: t.fgFaint } },
    { scope: "string.unquoted.plain.out.yaml", settings: { foreground: t.fgText } },
    { scope: "string.quoted", settings: { foreground: t.success } },
    { scope: "constant.numeric", settings: { foreground: t.warning } },
    { scope: "constant.language", settings: { foreground: t.warning } },
    { scope: "punctuation.definition.directive", settings: { foreground: t.fgFaint } },
    { scope: "keyword", settings: { foreground: t.info } },
    { scope: "entity.name", settings: { foreground: t.fgText } },
    { scope: "variable", settings: { foreground: t.fgText } },
  ];
}

function build(t, name, type) {
  return { name, type, colors: workbenchColors(t), tokenColors: tokenColors(t) };
}

const paper = build(PAPER, "宣纸 · NovelPad Paper", "light");
const ink = build(INK, "夜墨 · NovelPad Ink", "dark");

fs.writeFileSync(path.join(out, "novelpad-paper-color-theme.json"), JSON.stringify(paper, null, 2) + "\n");
fs.writeFileSync(path.join(out, "novelpad-ink-color-theme.json"), JSON.stringify(ink, null, 2) + "\n");
console.log(`generated 2 themes → ${out}`);