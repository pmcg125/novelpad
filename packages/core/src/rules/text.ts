/**
 * 文本规则：重复用词、长段落
 */
import type { Rule } from "./engine.js";

/** 同一段落内重复出现的词语（可配置词长与间距） */
export const repeatedWord: Rule = {
  meta: {
    id: "novelpad/repeated-word",
    description: "同一段落内相邻重复的词",
    defaultSeverity: "info",
    perChapter: true,
  },
  run({ chapter, report }) {
    if (!chapter) return;
    const lines = chapter.content.split(/\r?\n/);
    // 同一行内、间隔 ≤ 5 个字（可含标点）的 2~4 字词重复
    const re = /([\u4e00-\u9fff]{2,4})[\u4e00-\u9fff，。、！？；：]{0,6}?\1/g;
    // 常见虚词 / 通用搭配，忽略
    const ignore = new Set([
      "一个", "一种", "一样", "不是", "没有", "可以", "什么", "自己", "这个", "那个", "已经", "还是", "就是",
      "一只", "一张", "一把", "一阵", "一道", "一声", "一下", "一些", "一点", "一次",
      "父亲", "母亲", "男人", "女人", "时候", "地方", "东西", "事情", "知道", "起来",
    ]);
    lines.forEach((text, i) => {
      if (!text.trim() || text.trimStart().startsWith("<!--")) return;
      for (const m of text.matchAll(re)) {
        const w = m[1];
        if (!w || ignore.has(w)) continue;
        report({
          rule: repeatedWord.meta.id,
          line: i + 1,
          column: (m.index ?? 0) + 1,
          message: `「${w}」在本行间隔很近地重复出现`,
        });
      }
    });
  },
};

/** 段落过长（超过 N 字） */
export const longParagraph: Rule = {
  meta: {
    id: "novelpad/long-paragraph",
    description: "单段超过 400 字",
    defaultSeverity: "info",
    perChapter: true,
  },
  run({ chapter, report }) {
    if (!chapter) return;
    const lines = chapter.content.split(/\r?\n/);
    let start = 0;
    let buf: string[] = [];
    const flush = () => {
      if (!buf.length) return;
      const text = buf.join("");
      const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
      if (cjk > 400) {
        report({
          rule: longParagraph.meta.id,
          line: start + 1,
          message: `本段 ${cjk} 字，超过 400 字，手机阅读体验差`,
        });
      }
      buf = [];
    };
    lines.forEach((l, i) => {
      if (!l.trim()) {
        flush();
        start = i + 1;
      } else {
        buf.push(l);
      }
    });
    flush();
  },
};

/** 未闭合的作者备注 */
export const unclosedComment: Rule = {
  meta: {
    id: "novelpad/unclosed-comment",
    description: "HTML 注释没有闭合",
    defaultSeverity: "error",
    perChapter: true,
  },
  run({ chapter, report }) {
    if (!chapter) return;
    const text = chapter.content;
    const opens = (text.match(/<!--/g) ?? []).length;
    const closes = (text.match(/-->/g) ?? []).length;
    if (opens > closes) {
      // 找最后一个未闭合的 <!--
      let idx = -1;
      let pos = 0;
      for (let i = 0; i < opens - closes; i++) {
        idx = text.indexOf("<!--", pos);
        pos = idx + 4;
      }
      const ln = text.slice(0, idx).split(/\r?\n/).length;
      report({
        rule: unclosedComment.meta.id,
        line: ln,
        message: "作者备注 <!-- 没有闭合，导出时会吞掉后文",
      });
    }
  },
};
