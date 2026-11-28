/**
 * 壳产物校验的纯逻辑层（不碰文件系统），方便自检。
 *
 * CLI 壳在 ../verify-artifact.mjs。
 * 这套判据的每一条都对应一次真实事故或一个会静默失效的环节，
 * 改判据前先读该文件头部的说明。
 */
import crypto from "node:crypto";

/**
 * 和上游 `build/gulpfile.vscode.js` 的 `computeChecksum` 必须逐字一致：
 * **md5** → base64 → 去掉尾部 `=`，共 27 字符。
 * （不是 sha1：长度一样，内容完全不同，看起来像「格式对」。）
 */
export function md5b64(buf) {
  return crypto.createHash("md5").update(buf).digest("base64").replace(/=+$/, "");
}

/**
 * @param {{
 *   entries: Array<{name: string, size: number}>,
 *   read: (name: string) => Buffer,
 *   expectFlat?: boolean,
 * }} input
 * @returns {Array<{name: string, ok: boolean, detail?: string}>}
 */
export function inspectArtifact({ entries, read, expectFlat = false }) {
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok, detail });
  const byName = new Map(entries.map((e) => [e.name, e]));

  /* ---- 1. 空壳检测 ---- */
  check("不是空包（条目数 > 500）", entries.length > 500, `只有 ${entries.length} 条`);

  const productEntry = entries.find((e) => /(^|\/)resources\/app\/product\.json$/.test(e.name));
  if (!productEntry) {
    check("找到 resources/app/product.json", false, "这不是壳产物");
    return results;
  }

  const appRoot = productEntry.name.replace(/resources\/app\/product\.json$/, "");

  /* ---- 2. 品牌与目录层级 ---- */
  if (expectFlat) {
    check("解压根就是应用根（不再套一层目录）", appRoot === "", `实际前缀 ${JSON.stringify(appRoot)}`);
  }
  check("目录名不含 VSCode 品牌", !/VSCode/i.test(appRoot), appRoot);

  /* ---- 3. 关键文件在场 ---- */
  const need = [
    [/(^|\/)NovelPad\.exe$/, "NovelPad.exe"],
    [/resources\/app\/out\/vs\/workbench\/workbench\.desktop\.main\.js$/, "workbench 主 bundle"],
    [/resources\/app\/out\/vs\/code\/electron-sandbox\/workbench\/workbench\.html$/, "workbench.html"],
    [/resources\/app\/out\/vs\/code\/node\/cli\.js$/, "cli.js"],
    [/resources\/app\/package\.json$/, "app package.json"],
  ];
  for (const [re, label] of need) {
    const hit = entries.find((e) => re.test(e.name) && e.size > 0);
    check(`${label} 在场`, !!hit, hit ? "" : "缺失");
  }

  const exe = entries.find((e) => /(^|\/)NovelPad\.exe$/.test(e.name));
  check(
    "NovelPad.exe > 100MB（不是空壳）",
    !!exe && exe.size > 100 * 1048576,
    exe ? `${(exe.size / 1048576).toFixed(1)} MB` : "缺失",
  );

  // 占位包不可能有这个 20MB+ 的单文件
  const bundle = byName.get(`${appRoot}resources/app/out/vs/workbench/workbench.desktop.main.js`);
  check(
    "workbench.desktop.main.js > 10MB（真编译）",
    !!bundle && bundle.size > 10 * 1048576,
    bundle ? `${(bundle.size / 1048576).toFixed(1)} MB` : "缺失",
  );

  /* ---- 4. product.json 内容 ---- */
  let product = null;
  try {
    product = JSON.parse(read(productEntry.name).toString("utf8"));
  } catch (e) {
    check("product.json 可解析", false, String(e.message));
  }
  if (product) {
    check('nameShort 是 "NovelPad"', product.nameShort === "NovelPad", String(product.nameShort));
    check(
      "nameLong / applicationName 不含 Microsoft",
      !/microsoft/i.test(`${product.nameLong} ${product.applicationName}`),
      `${product.nameLong} / ${product.applicationName}`,
    );
    check("version 有值", typeof product.version === "string" && product.version.length > 0, String(product.version));
    check(
      "commit 是 40 位（真实构建）",
      typeof product.commit === "string" && product.commit.length === 40,
      String(product.commit),
    );
    check(
      "builtInExtensions 已清空（不夹带微软专有扩展）",
      Array.isArray(product.builtInExtensions) && product.builtInExtensions.length === 0,
    );
    check(
      "扩展市场指向 Open VSX",
      String(product.extensionsGallery?.serviceUrl ?? "").includes("open-vsx.org"),
      String(product.extensionsGallery?.serviceUrl),
    );
  }

  /* ---- 5. L2 挂载点真的进包了 ---- */
  const htmlEntry = byName.get(`${appRoot}resources/app/out/vs/code/electron-sandbox/workbench/workbench.html`);
  if (htmlEntry) {
    const html = read(htmlEntry.name).toString("utf8");
    check('workbench.html 挂了 body class="novelpad"', /<body[^>]*class="novelpad"/.test(html));
    check(
      "workbench.html 引了扩展里的 workbench.css",
      html.includes("extensions/novelpad/media/workbench.css"),
    );
  } else {
    check("workbench.html 可读", false);
  }

  /* ---- 6. 内置扩展完整 ---- */
  const EXT = `${appRoot}resources/app/extensions/novelpad/`;
  const extEntry = byName.get(`${EXT}package.json`);
  check("内置扩展 novelpad 在场", !!extEntry);
  if (extEntry) {
    try {
      const pkg = JSON.parse(read(extEntry.name).toString("utf8"));
      check("扩展名是 novelpad", pkg.name === "novelpad", String(pkg.name));
      check("扩展有 main 入口", typeof pkg.main === "string", String(pkg.main));
      check(
        "扩展声明了命令（不是空壳 manifest）",
        (pkg.contributes?.commands ?? []).length >= 40,
        `${(pkg.contributes?.commands ?? []).length} 条`,
      );
    } catch (e) {
      check("扩展 package.json 可解析", false, String(e.message));
    }
  }
  const distEntry = byName.get(`${EXT}dist/extension.js`);
  check(
    "扩展 dist/extension.js 已编译（> 100KB）",
    !!distEntry && distEntry.size > 100 * 1024,
    distEntry ? `${(distEntry.size / 1024).toFixed(0)} KB` : "缺失",
  );
  const cssEntry = byName.get(`${EXT}media/workbench.css`);
  check(
    "皮肤 media/workbench.css 在场（> 5KB）",
    !!cssEntry && cssEntry.size > 5 * 1024,
    cssEntry ? `${cssEntry.size} B` : "缺失",
  );
  const fonts = entries.filter((e) => e.name.startsWith(`${EXT}media/fonts/`) && e.name.endsWith(".woff2"));
  check("字体分片齐全（>= 90 片）", fonts.length >= 90, `${fonts.length} 片`);

  /* ---- 6b. 中文语言包与首启动模板 ---- */
  //
  // 这两样缺了都只是「界面变英文」，不会报任何错。语言包目录名必须等于
  // manifest.name——写成 <publisher>.<name> 时扫描器认不出来，同样静默失效。
  const LP = `${appRoot}resources/app/extensions/vscode-language-pack-zh-hans/`;
  const lpEntry = byName.get(`${LP}package.json`);
  check("中文语言包已内置", !!lpEntry);
  if (lpEntry) {
    try {
      const pkg = JSON.parse(read(lpEntry.name).toString("utf8"));
      const zh = (pkg.contributes?.localizations ?? []).find((l) => l.languageId === "zh-cn");
      check("语言包声明 zh-cn", !!zh, (pkg.contributes?.localizations ?? []).map((l) => l.languageId).join(","));
      check("语言包目录名与 manifest.name 一致", pkg.name === "vscode-language-pack-zh-hans", String(pkg.name));
    } catch (e) {
      check("语言包 package.json 可解析", false, String(e.message));
    }
  }
  const lpMain = byName.get(`${LP}translations/main.i18n.json`);
  check(
    "语言包主翻译文件在场（> 500KB）",
    !!lpMain && lpMain.size > 500 * 1024,
    lpMain ? `${(lpMain.size / 1024).toFixed(0)} KB` : "缺失",
  );

  const tplEntry = byName.get(`${appRoot}resources/app/novelpad-languagepack.json`);
  if (tplEntry) {
    try {
      const tpl = JSON.parse(read(tplEntry.name).toString("utf8"));
      const pack = tpl["zh-cn"];
      const count = Object.keys(pack?.translations ?? {}).length;
      check("首启动语言包模板含 zh-cn", !!pack);
      check("模板翻译条目齐全（>= 80）", count >= 80, `${count} 条`);
      // 模板里必须是相对路径：绝对路径在用户换盘安装后全失效
      const abs = Object.values(pack?.translations ?? {}).filter((p) => /^[a-zA-Z]:|^\//.test(String(p)));
      check("模板用相对路径（换盘安装也不失效）", abs.length === 0, `${abs.length} 条绝对路径`);
    } catch (e) {
      check("语言包模板可解析", false, String(e.message));
    }
  } else {
    check("首启动语言包模板在场", false);
  }

  /* ---- 7. checksums 必须与实际文件一致 ---- */
  //
  // 不写「至少 4 项」这种门槛：上游 `build/gulpfile.vscode.js` 里是固定的
  // 6 个文件，少一项就等于启动时会去校验一个不存在的声明。按清单精确比。
  const REQUIRED_SUMS = [
    "vs/base/parts/sandbox/electron-sandbox/preload.js",
    "vs/workbench/workbench.desktop.main.js",
    "vs/workbench/workbench.desktop.main.css",
    "vs/workbench/api/node/extensionHostProcess.js",
    "vs/code/electron-sandbox/workbench/workbench.html",
    "vs/code/electron-sandbox/workbench/workbench.js",
  ];
  const sums = product?.checksums ?? {};
  for (const rel of REQUIRED_SUMS) {
    check(`声明了 checksum ${rel}`, typeof sums[rel] === "string", sums[rel] ?? "缺失");
  }
  for (const rel of Object.keys(sums)) {
    // 路径基准是 out/ 而不是 resources/app/
    const e = byName.get(`${appRoot}resources/app/out/${rel}`);
    if (!e) {
      check(`checksum ${rel}`, false, "文件不在包里");
      continue;
    }
    const actual = md5b64(read(e.name));
    check(`checksum ${rel}`, actual === sums[rel], `期望 ${sums[rel]} 实际 ${actual}`);
  }

  return results;
}