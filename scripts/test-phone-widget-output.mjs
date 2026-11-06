import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function loadTs(relativePath, filename) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleBox = { exports: {} };
  vm.runInNewContext(compiled, {
    module: moduleBox, exports: moduleBox.exports,
    JSON, Array, String, RegExp,
  }, { filename });
  return moduleBox.exports;
}

const { parseWidgetLineOutput } = loadTs("../lib/widget/output.ts", "widget-output.cjs");
const { stripMalformedTextToolDirectives, stripTextToolDirectives } =
  loadTs("../lib/text-tool-protocol.ts", "text-tool-protocol.cjs");

assert.deepEqual(JSON.parse(JSON.stringify(parseWidgetLineOutput('{"text":"灯没关，桌上那杯茶给你留着","status":"耐心等着"}'))), {
  text: "灯没关，桌上那杯茶给你留着",
  status: "耐心等着",
});
const fence = String.fromCharCode(96).repeat(3);
assert.deepEqual(JSON.parse(JSON.stringify(parseWidgetLineOutput(fence + 'json\n{"text":"今天有点想你","status":"在想你"}\n' + fence))), {
  text: "今天有点想你",
  status: "在想你",
});

// The one-shot widget generator must never surface raw prompt/tool protocol.
for (const invalid of [
  "[执行动作:在桌面留句话({\"text\":\"泄漏\"})]",
  "[获取指令:在桌面留句话]",
  "以下是你获取指令的返回结果：动作：在桌面留句话",
  "<tool_call>phone_widget</tool_call>",
  "这是一句自然语言，但不是 JSON",
  '{"text":"正常内容","status":12}',
  '{"status":"缺少正文"}',
  '{"text":"[执行动作:在桌面留句话(...)]"}',
  '["text":"不合法的参数"]',
  "",
]) assert.equal(parseWidgetLineOutput(invalid), null, invalid);

const longText = "灯".repeat(80);
const parsed = parseWidgetLineOutput(JSON.stringify({ text: longText, status: "等".repeat(20) }));
assert.equal(Array.from(parsed.text).length, 60);
assert.equal(Array.from(parsed.status).length, 12);

// Malformed tool directives are removed from visible text, not shown as prose.
assert.equal(
  stripMalformedTextToolDirectives('正常留言\n[执行动作:在桌面留句话(["text":"泄漏"]\n下一句'),
  "正常留言\n下一句",
);
assert.equal(
  stripMalformedTextToolDirectives('前半句 [执行动作:参数不完整\n后续正文'),
  "前半句\n后续正文",
);
assert.equal(
  stripTextToolDirectives('正常留言 [执行动作:在桌面留句话({"text":"正常"})]'),
  "正常留言",
);
assert.equal(
  stripMalformedTextToolDirectives('普通文字\n没有动作指令'),
  '普通文字\n没有动作指令',
);

console.log("Phone widget output safety tests passed.");
