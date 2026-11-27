#!/usr/bin/env node
/* 文件文本抽取测试：txt/json/docx/pdf 能被角色读到，不支持的格式被拒绝。 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromHere = createRequire(import.meta.url);
const source = fs.readFileSync(path.join(ROOT, "lib/file-text.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const module = { exports: {} };
// TS 会把动态 import 降级成 require；pdfjs-dist 是 ESM，交给 Node 原生 require(esm) 处理。
new Function("require", "module", "exports", js)(
  id => id === "jszip" ? JSZip : requireFromHere(id),
  module,
  module.exports,
);
const { extractReadableFileText, isSupportedReadableFile } = module.exports;

let pass = 0;
let fail = 0;
function T(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ""}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ""}`); }
}
const dataUrl = (base64, mime) => `data:${mime};base64,${base64}`;

/** 生成一份最小可解析的 PDF（Helvetica + 单页文本层），用于验证 pdf.js 抽取。 */
function makeMinimalPdf(text) {
  const escaped = text.replace(/([()\\])/g, "\\$1");
  const stream = `BT /F1 18 Tf 50 100 Td (${escaped}) Tj ET`;
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += String(offset).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

console.log("== 1. 支持格式判断 ==");
T("txt 支持", isSupportedReadableFile("note.txt", "text/plain"));
T("json 支持", isSupportedReadableFile("data.json", "application/json"));
T("docx 支持", isSupportedReadableFile("合同.docx", ""));
T("pdf 支持", isSupportedReadableFile("合同.pdf", "application/pdf"));
T("zip 拒绝", !isSupportedReadableFile("打包.zip", "application/zip"));

console.log("== 2. txt / json 抽取 ==");
const txt = await extractReadableFileText("note.txt", "text/plain", dataUrl(Buffer.from("第一行\n第二行", "utf8").toString("base64"), "text/plain"));
T("txt 内容正确", txt?.text === "第一行\n第二行", txt?.text);
const json = await extractReadableFileText("data.json", "application/json", dataUrl(Buffer.from('{"a":1,"b":[2,3]}', "utf8").toString("base64"), "application/json"));
T("json 被格式化", json?.text.includes('"a": 1') && json?.text.includes('"b"'), json?.text);

console.log("== 3. docx 抽取段落 ==");
const zip = new JSZip();
zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>你好，</w:t></w:r><w:r><w:t>这是第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>');
const docxBase64 = await zip.generateAsync({ type: "base64" });
const docx = await extractReadableFileText("测试.docx", "", dataUrl(docxBase64, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
T("docx 段落被抽出", docx?.text.includes("你好，这是第一段") && docx?.text.includes("第二段"), docx?.text);

console.log("== 4. pdf 抽取文字层 ==");
const pdfBuffer = makeMinimalPdf("Hello PDF 123");
const pdf = await extractReadableFileText("测试.pdf", "application/pdf", dataUrl(pdfBuffer.toString("base64"), "application/pdf"));
T("pdf 文本被抽出", Boolean(pdf?.text.includes("Hello PDF 123")), pdf?.text);
T("pdf 未被标记截断", pdf?.truncated === false);

console.log("== 5. 不支持格式返回 null ==");
const zipFile = await extractReadableFileText("打包.zip", "application/zip", dataUrl("", "application/zip"));
T("zip 抽取返回 null", zipFile === null);

console.log(`\n${fail === 0 ? "✅" : "❌"} 文件抽取测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
