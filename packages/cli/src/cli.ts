#!/usr/bin/env node
import { parse, cmdExport, cmdCheck, cmdStats, cmdInit, fail, HELP } from "./lib.js";

const args = parse(process.argv.slice(2));
const cmd = args._.shift();

if (args.help || !cmd) {
  console.log(HELP);
  process.exit(args.help ? 0 : 1);
}

switch (cmd) {
  case "export": cmdExport(args); break;
  case "check": cmdCheck(args); break;
  case "stats": cmdStats(args); break;
  case "init": cmdInit(args); break;
  default: fail(`未知命令「${cmd}」，运行 novelpad --help 查看用法`);
}