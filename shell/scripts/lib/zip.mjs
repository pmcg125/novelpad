/**
 * 最小 zip 读取器（纯 JS，无外部依赖）。
 *
 * 为什么不用 `tar -xf`：vsix 是 zip，而 Windows 自带的 `tar` 是 bsdtar，能读 zip；
 * Linux 上的 GNU tar 不行，直接报 "This does not look like a tar archive"。
 * 构建脚本要跑在 win/linux/mac 三处，靠系统工具就等于靠平台差异。
 *
 * 只做这件事需要的最小集合：读中央目录 → 按需解压条目。
 * 支持存储（0）与 deflate（8），vsix 只会用这两种。
 */
import fs from "node:fs";
import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * 从文件尾部倒着找 EOCD。
 * 注释区最长 65535 字节，所以最多回退这么多。
 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("不是有效的 zip：找不到中央目录结尾记录（EOCD）");
}

/** @typedef {{ name: string, method: number, compressedSize: number, size: number, localOffset: number }} ZipEntry */

/** @returns {ZipEntry[]} */
export function listEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  /** @type {ZipEntry[]} */
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error(`中央目录第 ${i} 项签名不对（偏移 ${p}）`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    // 文件名一律 UTF-8：vsix 由 vsce 生成，内部路径都是 ASCII
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.push({ name, method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * 取出单个条目的内容。
 * 本地头的文件名/扩展区长度可能与中央目录不同，必须按本地头重新算数据起点。
 */
export function readEntry(buf, entry) {
  const lh = entry.localOffset;
  if (buf.readUInt32LE(lh) !== LOCAL_SIG) throw new Error(`本地头签名不对：${entry.name}`);
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的压缩方法 ${entry.method}（${entry.name}）`);
}

/**
 * 读 zip 文件并解到目标目录。
 * 会写入完整相对路径 —— 这里不防目录穿越（zip 里出现 ../ 说明打包环节已被污染，
 * 那种情况下失败比悄悄写到外面更好）。
 */
export function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  const entries = listEntries(buf);
  let files = 0;
  for (const entry of entries) {
    if (entry.name.endsWith("/")) {
      fs.mkdirSync(`${destDir}/${entry.name}`, { recursive: true });
      continue;
    }
    const target = `${destDir}/${entry.name}`;
    fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(target, readEntry(buf, entry));
    files++;
  }
  return { entries: entries.length, files };
}