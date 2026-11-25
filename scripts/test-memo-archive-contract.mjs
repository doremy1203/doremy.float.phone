import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [storage, tools, ui, assembler, chat] = await Promise.all([
  readFile("lib/memo-archive-storage.ts", "utf8"),
  readFile("lib/tool-executor.ts", "utf8"),
  readFile("components/memo-archive-app.tsx", "utf8"),
  readFile("lib/short-term-assembler.ts", "utf8"),
  readFile("lib/chat-engine.ts", "utf8"),
]);

// Local-only persistence and owner isolation.
assert.match(storage, /super\("floatphone-memo-archive-v1"\)/);
assert.match(storage, /if\(old&&!same\(old\.owner,owner\)\)throw Error/);
assert.match(storage, /if\(!f\|\|!same\(f\.owner,owner\)\)throw Error/);
assert.match(storage, /只有用户自己的备忘录可以分享/);
assert.match(storage, /owner\.type==="user"\?raw\.sharedWith as string\[\]:\[\]/);

// Import must validate structure and references before committing.
assert.match(storage, /不支持的备份格式/);
assert.match(storage, /备份中存在不存在的档案盒引用/);
assert.match(storage, /备忘录标签或待办数据无效/);
assert.match(storage, /d\.transaction\("rw",d\.folders,d\.notes/);

// Batch todo writes are atomic and append to the latest persisted version.
assert.match(storage, /export async function appendMemoTodos/);
assert.match(storage, /d\.transaction\("rw",d\.notes/);
assert.match(storage, /todos:\[\.\.\.current\.todos,\.\.\.additions\]/);
assert.match(tools, /appendMemoTodos\(owner/);
assert.match(tools, /完成备忘录维护/);
assert.match(tools, /items 至少需要包含一条有效 text/);

// Review scheduling is bounded and only consumed after successful generation.
assert.match(storage, /slice\(0, 5\)/);
assert.match(storage, /maxChars = 850/);
assert.match(storage, /pendingMemoReviewIds/);
assert.match(storage, /recordMemoMaintenanceResult/);
assert.match(storage, /changedNoteIds/);
assert.match(storage, /loadMemoMaintenanceHistory/);
assert.match(storage, /getMemoReviewStatus/);
assert.match(storage, /forceMemoReviewOnNextChat/);
assert.ok(storage.includes("memoBodyTextForPrompt(note.body)"));
assert.ok(storage.includes("replace(/" + String.fromCharCode(92) + "s+/g"), "digest must collapse whitespace");

// Capability stays private-chat-only and shared user notes are read-only.
assert.match(tools, /备忘录工具仅允许在一对一私聊中使用/);
assert.match(tools, /用户分享（只读）/);
assert.match(tools, /readSharedMemoNotes/);

// UI exposes archive lifecycle, backup, review and per-space typography preferences.
for (const token of ["我的备忘录", "角色备忘录", "全部手记", "待办清单", "分类", "已收起的手记", "回收站", "偏好与备份", "导出当前空间", "永久删除", "memo-archive-appearance:"]) {
  assert.ok(ui.includes(token), `missing memo UI contract: ${token}`);
}
assert.match(ui, /setSelectedId\(null\); setTab\("settings"\)/);
assert.match(ui, /setMobileMoreOpen/);
assert.match(ui, /formatToolbar/);
assert.ok(ui.includes("contentEditable"));
assert.ok(ui.includes('data-type="checklist"'));
assert.ok(ui.includes('data-checked="true"') || ui.includes('item.dataset.checked'));
assert.ok(ui.includes("memoBodyPlainText"));
assert.ok(ui.includes("memo-rich-v1"));
assert.ok(ui.includes("DOMPurify.sanitize"));
assert.ok(ui.includes("dangerouslySetInnerHTML={{ __html: memoBodyHtml"));
assert.match(ui, /批量移动/);
assert.match(ui, /noteQuickActions/);
assert.match(ui, /renameNote/);
assert.ok(storage.includes("Math.round(hours * 60) / 60"));
assert.match(ui, /detailBody/);
assert.match(ui, /data-theme=\{theme\}/);
assert.match(ui, /reviewHistory/);
assert.match(ui, /角色定期维护/);
assert.match(ui, /每分钟（测试）/);
assert.match(ui, /下一次一对一私聊请求中触发/);
assert.match(assembler, /loadMemoTimelineProjectionEntries/);
assert.match(assembler, /sourceApp: "memo"/);
assert.match(chat, /只有该工具成功返回/);
assert.doesNotMatch(chat, /markMemoReviewCompleted/);

console.log("Memo archive contract checks passed.");
