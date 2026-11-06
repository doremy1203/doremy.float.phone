import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-output.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
const sandbox = {
  module: moduleBox,
  exports: moduleBox.exports,
  require: (id) => {
    if (id === "jsonrepair") return { jsonrepair: (value) => value };
    throw new Error("unexpected require: " + id);
  },
  console, JSON, Set, Map, Array, String, Number, Boolean, RegExp, Date,
};
vm.runInNewContext(compiled, sandbox, { filename: "life-output.cjs" });
const { parseLifeOutput, validateLifeOutput } = moduleBox.exports;

const json = (value) => JSON.stringify(value);
const same = (actual, expected) => assert.equal(JSON.stringify([...actual]), JSON.stringify(expected));
const base = { plan_change: null, invitation: null, follow_request: null };

// 1. JSON action + dialogue
let parsed = parseLifeOutput(json({ action: "她把杯子推过来，抬眼看你。", dialogue: ["“先喝点热的吧。”"], ...base }));
assert.equal(parsed.mode, "json");
assert.equal(parsed.action, "她把杯子推过来，抬眼看你。");
same(parsed.dialogues, ["先喝点热的吧。"]);
same(validateLifeOutput(parsed, { maxConsecutiveActionOnly: 1, allowEmpty: true }), []);

// Explicit JSON array items are the bubble boundaries. Punctuation inside one
// dialogue must never be used to invent extra bubbles downstream.
parsed = parseLifeOutput(json({ action: "", dialogue: ["第一句。第二句，逗号后仍属于同一条。", "第二条气泡！"], ...base }));
same(parsed.dialogues, ["第一句。第二句，逗号后仍属于同一条。", "第二条气泡！"]);

// 2. Natural action-only is allowed once, but not twice.
parsed = parseLifeOutput(json({ action: "她把毯子轻轻盖在你腿上，没有出声。", dialogue: [], ...base }));
same(validateLifeOutput(parsed, { previousActionOnly: false, maxConsecutiveActionOnly: 1, allowEmpty: true }), []);
same(validateLifeOutput(parsed, { previousActionOnly: true, maxConsecutiveActionOnly: 1, allowEmpty: true }), ["consecutive_action_only"]);

// 3. Strict mode blocks action-only.
same(validateLifeOutput(parsed, { previousActionOnly: false, maxConsecutiveActionOnly: 0, allowEmpty: true }), ["action_only"]);

// 4. Structured JSON preserves field boundaries exactly; malformed placement is
// reported for the format-repair pass rather than silently rewritten.
parsed = parseLifeOutput(json({ action: "她笑了笑，说“别熬夜了”。", dialogue: [], ...base }));
assert.equal(parsed.action, "她笑了笑，说“别熬夜了”。");
same(parsed.dialogues, []);
assert.equal(validateLifeOutput(parsed, { allowEmpty: true }).includes("speech_in_action"), true);

// 5. Dialogue arrays are already bubble boundaries. Legacy action-like prose is
// reported, not silently moved into a different field.
parsed = parseLifeOutput(json({ action: "", dialogue: ["她笑了笑，说：“你回来啦。”"], ...base }));
assert.equal(parsed.action, undefined);
same(parsed.dialogues, ["她笑了笑，说：“你回来啦。”"]);
assert.equal(validateLifeOutput(parsed, { allowEmpty: true }).includes("action_in_dialogue"), true);

// 6. First-person action is not treated as dialogue.
parsed = parseLifeOutput("我走到窗边，轻轻叹了口气。\n“今天有点累。”");
assert.equal(parsed.action, "我走到窗边，轻轻叹了口气。");
same(parsed.dialogues, ["今天有点累。"]);

// 7. XML fallback still works.
parsed = parseLifeOutput("<life_action>她笑了笑</life_action><life_dialogue>“你回来啦。”</life_dialogue>");
assert.equal(parsed.mode, "xml");
assert.equal(parsed.action, "她笑了笑");
same(parsed.dialogues, ["你回来啦。"]);

// 8. Malformed JSON is marked and not silently trusted.
parsed = parseLifeOutput('{"action":"她笑了笑","dialogue":["“你回来啦。”"');
assert.equal(parsed.issues.includes("json_parse"), true);

// 9. Multiple tools are rejected before execution.
parsed = parseLifeOutput(json({
  action: "她看了看时间。",
  dialogue: ["“我晚点回来。”"],
  plan_change: { startAt: "2026-10-27T10:00:00+08:00", endAt: "2026-10-27T11:00:00+08:00", title: "加班" },
  invitation: { time: "2026-10-28T19:00:00+08:00", activity: "吃饭" },
  follow_request: null,
}));
assert.equal(parsed.toolCount, 2);
assert.equal(parsed.issues.includes("multiple_tools"), true);
assert.equal(validateLifeOutput(parsed, { maxConsecutiveActionOnly: 1, allowEmpty: true }).includes("multiple_tools"), true);

// 10. Empty turn is rejected for a player reply.
parsed = parseLifeOutput(json({ action: "", dialogue: [], ...base }));
assert.equal(validateLifeOutput(parsed, { allowEmpty: false }).includes("empty_turn"), true);
same(validateLifeOutput(parsed, { allowEmpty: true }), []);

console.log("Life output parser tests passed.");
