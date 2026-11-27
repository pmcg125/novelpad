#!/usr/bin/env node
/**
 * 生成 NovelPad 品牌图标（可复现，无外部依赖）。
 *
 *   node shell/scripts/gen-icons.mjs
 *
 * 为什么自己画：品牌图标是 L1 的一部分，必须随源码可复现地生成，
 * 而不是塞一堆来历不明的二进制。上游的打包脚本从这些固定路径取图标：
 *   build/lib/electron.js            winIcon: resources/win32/code.ico
 *                                    darwinIcon: resources/darwin/code.icns
 *   build/gulpfile.vscode.win32.js   rcedit 用 resources/win32/code.ico
 *   build/gulpfile.vscode.js         resources/win32/code_70x70.png / code_150x150.png
 *   build/gulpfile.vscode.linux.js   resources/linux/code.png
 * 所以文件名保持上游的叫法，只用 overlay 换内容。
 *
 * 图形：圆角方底（青绿渐变）+ 摊开的书（宣纸白）。
 * 16px 下仍能分辨，是一个「书」的剪影，不做细碎纹样。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.resolve(here, "../overlay/resources");

/* ---------- 颜色（DESIGN.md §2.1）---------- */
const RADIUS = 0.22; // 圆角半径（相对边长）
const PAD = 0.02; // 满幅图标只留一点边
const PAD_MAC = 0.10; // macOS 图标惯例留白
const BG_TOP = [0x35, 0x89, 0x77]; // accent 提亮
const BG_BOT = [0x24, 0x5e, 0x51]; // accent 压暗
const PAPER = [0xf7, 0xf3, 0xe8]; // bg.editor 宣纸
const SPINE = 0.90; // 书脊处压暗系数

/** 摊开的书：以 0.5 为书脊，左右对称。
 *  上沿下沉、下沿几乎平；书脊处留一条缝，这样一眼是「摊开的书」。
 *
 *  gutter 至少 1 像素——不做这个下限，16px 图标里缝会缩到 0.2px，
 *  左右两页糊成一团白色，认不出是书。 */
function bookPolygons(size) {
  const gutter = Math.max(1 / size, 0.014);
  const cx = 0.5;
  const top = 0.352;
  const bottom = 0.716;
  const topDip = 0.062; // 上沿：书脊比外侧低
  const botDip = 0.012; // 下沿：几乎平
  const left = 0.146;
  const right = 1 - left;
  const l = cx - gutter;
  const r = cx + gutter;
  return [
    [
      [l, top + 0.004],
      [left, top - topDip],
      [left, bottom - botDip],
      [l, bottom + 0.004],
    ],
    [
      [r, top + 0.004],
      [right, top - topDip],
      [right, bottom - botDip],
      [r, bottom + 0.004],
    ],
  ];
}

/** 射线法：点是否在多边形内 */
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 圆角矩形 SDF（返回 <0 表示在内部） */
function roundRectSdf(x, y, pad, radius) {
  const half = 0.5 - pad;
  const qx = Math.abs(x - 0.5) - (half - radius);
  const qy = Math.abs(y - 0.5) - (half - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * 渲染一张 RGBA 图。
 * @param {number} size 边长
 * @param {number} pad  外边距（0~0.5）
 */
function render(size, pad) {
  const ss = size <= 64 ? 4 : size <= 256 ? 3 : 2; // 超采样倍数
  const book = bookPolygons(size);
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;

          // 底：圆角方，青绿竖向渐变
          if (roundRectSdf(u, v, pad, RADIUS * (1 - pad * 1.4)) > 0) continue;

          const t = Math.min(1, Math.max(0, (v - pad) / (1 - pad * 2)));
          let cr = BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t;
          let cg = BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t;
          let cb = BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t;

          // 前景：书页
          if (inPoly(u, v, book[0]) || inPoly(u, v, book[1])) {
            // 书脊附近轻微压暗，让小尺寸也有层次
            const d = Math.abs(u - 0.5);
            const shade = d < 0.045 ? SPINE + (1 - SPINE) * (d / 0.045) : 1;
            cr = PAPER[0] * shade;
            cg = PAPER[1] * shade;
            cb = PAPER[2] * shade;
          }

          r += cr;
          g += cg;
          b += cb;
          a += 1;
        }
      }

      const n = ss * ss;
      const o = (y * size + x) * 4;
      if (a > 0) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
        px[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return px;
}

/* ---------- PNG 编码（RGBA8，逐行 filter 0）---------- */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pad) {
  const px = render(size, pad);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filter
  ihdr[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- ICO ----------
   只有 256px 用 PNG，其余用 BMP(DIB) 载荷——与上游 code.ico 一致：
   16/32/128 用 BMP、256 用 PNG。GDI+（System.Drawing）读不了 PNG 小图，
   Windows 资源管理器与 rcedit 也只在 256px 上稳定支持 PNG，
   所以不要「优化」这一条。 */
function bmpPayload(size, pad) {
  const px = render(size, pad);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight（含 AND 掩码）
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage
  // biXPelsPerMeter / biYPelsPerMeter / biClrUsed / biClrImportant 保持 0

  // XOR：BGRA，自下而上
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = px[s + 2];
      xor[d + 1] = px[s + 1];
      xor[d + 2] = px[s];
      xor[d + 3] = px[s + 3];
    }
  }

  // AND 掩码：32bpp 靠 alpha 通道，掩码置 0；每行按 4 字节对齐
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);

  return Buffer.concat([header, xor, mask]);
}

function ico(sizes) {
  const images = sizes.map((s) => ({
    size: s,
    data: s >= 256 ? png(s, PAD) : bmpPayload(s, PAD),
  }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const dir = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...images.map((i) => i.data)]);
}

/* ---------- ICNS（PNG 载荷）---------- */
function icns() {
  // icns 的 PNG 类型码
  const map = [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ];
  const chunks = map.map(([type, size]) => {
    const data = png(size, PAD_MAC);
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/* ---------- 落盘 ---------- */
const write = (rel, buf) => {
  const file = path.join(outRoot, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`${rel.padEnd(30)} ${(buf.length / 1024).toFixed(1)} KB`);
};

write("win32/code.ico", ico([16, 24, 32, 48, 64, 128, 256]));
write("win32/code_70x70.png", png(70, PAD));
write("win32/code_150x150.png", png(150, PAD));
write("linux/code.png", png(512, PAD));
write("darwin/code.icns", icns());

// 任务栏/开始菜单磁贴：上游内容里写的是 "Code - OSS"，这里换成我们的
write(
  "win32/VisualElementsManifest.xml",
  Buffer.from(
    `<Application xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
\t<VisualElements
\t\tBackgroundColor="#2F7D6B"
\t\tShowNameOnSquare150x150Logo="on"
\t\tSquare150x150Logo="resources\\app\\resources\\win32\\code_150x150.png"
\t\tSquare70x70Logo="resources\\app\\resources\\win32\\code_70x70.png"
\t\tForegroundText="light"
\t\tShortDisplayName="NovelPad" />
</Application>
`,
    "utf8",
  ),
);