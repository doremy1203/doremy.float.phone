#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(ROOT, "lib/sticker-pack-png.ts"), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const module = { exports: {} };
const require = id => {
  if (id === "./custom-sticker-storage") return {};
  if (id === "./theme-storage") return {};
  if (id === "./download-utils") return {};
  throw new Error("unexpected require " + id);
};
new Function("require", "module", "exports", js)(require, module, module.exports);
const { embedMetadata, extractMetadata } = module.exports.__stickerPackPngInternals;
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const meta = { v: 1, name: "测试图集", note: "备注", stickers: [{ name: "笑", dataUrl: "data:image/png;base64,AAAA" }] };
const embedded = embedMetadata(png, meta);
const extracted = extractMetadata(embedded);
const ok = extracted && extracted.name === "测试图集" && extracted.stickers.length === 1 && embedded.length > png.length;
console.log(ok ? "✅ 表情包 PNG 元数据写入/读取正常" : "❌ 元数据不一致: " + JSON.stringify(extracted));
process.exit(ok ? 0 : 1);
