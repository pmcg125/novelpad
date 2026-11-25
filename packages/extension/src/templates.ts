/**
 * 新建章节 / 角色文件的模板（纯函数，便于测试）
 */

export function toId(name: string): string {
  const ascii = name
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return ascii || name;
}

export function chapterTemplate(opts: { order: number; title: string; volume?: string; pov?: string }): string {
  return [
    "---",
    `title: ${opts.title}`,
    `order: ${opts.order}`,
    ...(opts.volume ? [`volume: ${opts.volume}`] : []),
    ...(opts.pov ? [`pov: ${opts.pov}`] : []),
    "status: draft",
    "characters: []",
    "locations: []",
    "---",
    "",
    `# ${opts.title}`,
    "",
    "",
  ].join("\n");
}

export function characterTemplate(opts: { name: string; role?: string; aliases?: string[] }): string {
  return [
    `name: ${opts.name}`,
    ...(opts.role ? [`role: ${opts.role}`] : []),
    `aliases: [${(opts.aliases ?? []).join(", ")}]`,
    "tags: []",
    "summary: ",
    "attrs: {}",
    "relations: []",
    "",
  ].join("\n");
}
