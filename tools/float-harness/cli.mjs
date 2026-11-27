#!/usr/bin/env node
/**
 * Small CLI for the App-internal harness.
 *
 *   node tools/float-harness/cli.mjs status
 *   node tools/float-harness/cli.mjs setup
 *   node tools/float-harness/cli.mjs eval "document.title"
 *   node tools/float-harness/cli.mjs eval-file ./expr.js
 *   node tools/float-harness/cli.mjs fs '{"action":"list","root":"data"}'
 *   node tools/float-harness/cli.mjs prefs '{"action":"list"}'
 *   node tools/float-harness/cli.mjs sqlite '{"action":"list"}'
 *   node tools/float-harness/cli.mjs screenshot ./screen.png
 */
import fs from "node:fs/promises";
import { AppBridge, BASE_DIR, PACKAGE } from "./app-bridge.mjs";

const bridge = new AppBridge();
const [command, ...args] = process.argv.slice(2);

function print(value) {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function jsonArg(value, label) {
  if (!value) throw new Error(`${label} 需要 JSON 参数`);
  try { return JSON.parse(value); } catch { throw new Error(`${label} 不是合法 JSON`); }
}

try {
  if (!command || command === "help" || command === "-h" || command === "--help") {
    console.log(`Float app harness CLI
package: ${PACKAGE}
dir:     ${BASE_DIR}

commands:
  status
  setup
  info
  eval <expression>
  eval-file <file>
  reload
  screenshot [out.png]
  fs <json>
  prefs <json>
  sqlite <json>`);
    process.exit(0);
  }
  if (command === "status") print(await bridge.status());
  else if (command === "setup") print(await bridge.ensureSetup({ enable: true }));
  else if (command === "info") print(await bridge.info());
  else if (command === "eval") {
    const expression = args.join(" ").trim();
    if (!expression) throw new Error("eval 需要表达式");
    print(await bridge.evaluate(expression));
  } else if (command === "eval-file") {
    const file = args[0];
    if (!file) throw new Error("eval-file 需要文件");
    print(await bridge.evaluate(await fs.readFile(file, "utf8")));
  } else if (command === "reload") print(await bridge.reload());
  else if (command === "screenshot") {
    const data = await bridge.screenshot();
    const out = args[0] || "float-screenshot.png";
    await fs.writeFile(out, Buffer.from(data, "base64"));
    print({ ok: true, file: out });
  } else if (command === "fs") print(await bridge.fs(jsonArg(args[0], "fs")));
  else if (command === "prefs") print(await bridge.prefs(jsonArg(args[0], "prefs")));
  else if (command === "sqlite") print(await bridge.sqlite(jsonArg(args[0], "sqlite")));
  else throw new Error(`未知命令：${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
