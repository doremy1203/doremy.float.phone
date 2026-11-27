#!/usr/bin/env node
/* DSML 工具调用标记解析：不同 DeepSeek 输出变体都要能剥掉，参数要能还原。 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import vm from "node:vm";

const source = await readFile(new URL("../lib/dsml-tool-calls.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const box = { exports: {} };
vm.runInNewContext(compiled, { module: box, exports: box.exports, Date, JSON, String, RegExp, Map, console }, { filename: "dsml-tool-calls.cjs" });
const { extractDsmlToolCalls, stripDsmlToolCalls } = box.exports;

const v4 = [
  "<｜DSML｜tool_calls>",
  '<｜DSML｜invoke name="action_ab12cd">',
  '<｜DSML｜parameter name="targetId" string="true">456</｜DSML｜parameter>',
  '<｜DSML｜parameter name="count" string="false">3</｜DSML｜parameter>',
  '<｜DSML｜parameter name="options" string="false">{"a":1}</｜DSML｜parameter>',
  "</｜DSML｜invoke>",
  "</｜DSML｜tool_calls>",
].join("\n");
const parsed = extractDsmlToolCalls(v4);
assert.equal(parsed.toolCalls.length, 1, "V4 tool_calls block should parse one call");
assert.equal(parsed.toolCalls[0].name, "action_ab12cd");
assert.equal(JSON.stringify(parsed.toolCalls[0].args), JSON.stringify({ targetId: "456", count: 3, options: { a: 1 } }));
assert.equal(parsed.text, "", "markup must not remain in visible text");

const v32 = [
  "<｜DSML｜function_calls>",
  '<｜DSML｜invoke name="查看手机状态">',
  '<｜DSML｜parameter name="detail" string="true">完整</｜DSML｜parameter>',
  "</｜DSML｜invoke>",
  "</｜DSML｜function_calls>",
].join("\n");
assert.equal(extractDsmlToolCalls(v32).toolCalls[0].name, "查看手机状态");

// 网页端/双竖线/竖线两侧带空格的变体 + 前后正文保留
const spaced = [
  "我先查一下。",
  "< | | DSML | | calls>",
  '< | | DSML | | invoke name="action_ausle4">',
  '< | | DSML | | parameter name="audience" string="true">true< / | | DSML | | parameter>',
  "</ | | DSML | | invoke>",
  "</ | | DSML | | calls>",
  "查到了。",
].join("\n");
const spacedParsed = extractDsmlToolCalls(spaced);
assert.equal(spacedParsed.toolCalls.length, 1, "doubled-pipe spaced variant should parse");
assert.equal(spacedParsed.toolCalls[0].name, "action_ausle4");
assert.equal(spacedParsed.text.includes("我先查一下。"), true);
assert.equal(spacedParsed.text.includes("查到了。"), true);
assert.equal(/DSML/i.test(spacedParsed.text), false, "no DSML marker may leak into visible text");

// 旧版无 DSML 前缀的裸标签
const legacy = '<function_calls><invoke name="记忆写入"><parameter name="text" string="true">记得吃饭</parameter></invoke></function_calls>';
const legacyParsed = extractDsmlToolCalls(legacy);
assert.equal(legacyParsed.toolCalls.length, 1);
assert.equal(legacyParsed.toolCalls[0].name, "记忆写入");
assert.equal(legacyParsed.toolCalls[0].args.text, "记得吃饭");

// 漏闭合的截断输出也要剥掉，不能变成对白（不完整调用按规范丢弃，不执行）
const truncated = "<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"action_maf9x\">\n<｜DSML｜parameter name=\"audience\" string=\"true\">true";
const truncatedParsed = extractDsmlToolCalls(truncated);
assert.equal(truncatedParsed.toolCalls.length, 0, "an unclosed invoke must not be executed");
assert.equal(/DSML|action_maf9x/i.test(truncatedParsed.text), false);

// 普通文本不受影响
assert.equal(stripDsmlToolCalls("今天图书馆很安静。"), "今天图书馆很安静。");

console.log("DSML tool call regression tests passed.");
