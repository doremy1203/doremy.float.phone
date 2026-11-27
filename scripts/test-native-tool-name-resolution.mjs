import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const [codec, chat, groupChat, executor, toolStorage] = await Promise.all([
  readFile("lib/native-tool-name.ts", "utf8"),
  readFile("lib/chat-engine.ts", "utf8"),
  readFile("lib/group-chat-engine.ts", "utf8"),
  readFile("lib/tool-executor.ts", "utf8"),
  readFile("lib/tool-storage.ts", "utf8"),
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
assert.match(chat, /nameMap\.set\(nativeName, displayName\)/, "provider-only aliases must retain their Chinese display label");
assert.match(executor, /return \{ \.\.\.call, name: exact \}/, "provider action aliases must resolve back to canonical display names before execution");
assert.match(executor, /makeNativeToolName\(expandedName\(displayName\), usedNames\)/);
assert.match(executor, /export function resolveToolCallDisplayName/, "a shared display-name resolver must be exported");
assert.match(chat, /resolveToolCallDisplayName\(t\.name, displayNameContext\)/, "text-protocol tool notices must show Chinese display names for leaked action_xxx aliases");
assert.match(chat, /resolveToolCallDisplayName\(call\.name,/, "native tool notices must fall back to the shared display-name resolver");
assert.match(groupChat, /resolveToolCallDisplayName\(t\.name,/, "group chat text-protocol notices must show Chinese display names too");
assert.doesNotMatch(executor, /call\.name\.startsWith\("life_"\)/, "life tools must dispatch by Chinese display name, not the internal life_ prefix");
assert.match(executor, /const lifeResult = await tryLife\(\);/, "every tool call must reach the life dispatcher before reporting not-found");
assert.match(toolStorage, /LIFE_TOOL_DEFINITIONS\.find\(tool => tool\.id === name\)\?\.name/, "schema lookup must still accept legacy life_* ids");

console.log("Native tool name resolution checks passed.");
