import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const [codec, chat, executor] = await Promise.all([
  readFile("lib/native-tool-name.ts", "utf8"),
  readFile("lib/chat-engine.ts", "utf8"),
  readFile("lib/tool-executor.ts", "utf8"),
]);

// Exercise the production codec rather than a copied test implementation.
const compiled = ts.transpileModule(codec, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = { exports: {} };
new Function("module", "exports", compiled)(loaded, loaded.exports);
const { makeNativeToolName } = loaded.exports;

const used = new Set();
assert.equal(makeNativeToolName("操作手机设备", used), "action_13ojn7");
assert.equal(makeNativeToolName("查看手机状态", used), "action_1l1js0");
const collisionSet = new Set();
const first = makeNativeToolName("duplicate", collisionSet);
const second = makeNativeToolName("duplicate", collisionSet);
assert.equal(second, `${first}_2`, "collision suffixes must remain part of the stable identifier");

// Registration and execution must use the same codec and a registry-backed resolver.
assert.match(chat, /import \{ makeNativeToolName \} from "\.\/native-tool-name"/);
assert.doesNotMatch(chat, /function stableToolHash/);
assert.match(executor, /function resolveNativeToolCall/);
assert.match(executor, /getEnabledTools\(context\?\.appId \?\? "chat"\)/);
assert.match(executor, /getInternalCapabilitySubToolDefinitions/);
assert.match(executor, /uniqueMatches\.length === 1/);
assert.match(executor, /call = resolveNativeToolCall\(call, context\)/);
assert.match(executor, /makeNativeToolName\(expandedName\(displayName\), usedNames\)/);

console.log("Native tool name resolution checks passed.");
