#!/usr/bin/env node
// 从 custom-apps/focus-companion/（应用源码真身）生成 lib/builtin-apps/focus-companion-{source,meta}.ts。
//
// 链路：custom-apps/focus-companion/index.html + manifest.json
//        └─ node scripts/build-focus-companion-dist.mjs
//            └─ lib/builtin-apps/focus-companion-source.ts （入口 HTML，字符串分块 join）
//            └─ lib/builtin-apps/focus-companion-meta.ts   （manifest + buildFocusCompanionApp）
//
// 用法：node scripts/build-focus-companion-dist.mjs
// 改了应用源码（index.html / manifest.json）之后跑一次即可；生成物提交进仓库。
// 同时校验 manifest permissions 全部落在 lib/custom-app-types.ts 的 CustomAppPermission 联合类型里。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "custom-apps", "focus-companion");
const libDir = path.join(root, "lib", "builtin-apps");

const html = fs.readFileSync(path.join(appDir, "index.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(appDir, "manifest.json"), "utf8"));

// ---- 权限校验 ----
const typesSrc = fs.readFileSync(path.join(root, "lib", "custom-app-types.ts"), "utf8");
const unionMatch = typesSrc.match(/export type CustomAppPermission =([\s\S]*?);/);
if (!unionMatch) { console.error("❌ 无法定位 CustomAppPermission 类型"); process.exit(2); }
const allowed = new Set([...unionMatch[1].matchAll(/"([a-zA-Z0-9._]+)"/g)].map(m => m[1]));
const declared = manifest.permissions ?? [];
const unknown = declared.filter(p => !allowed.has(p));
console.log(`permissions: declared=${declared.length} union=${allowed.size}`);
if (unknown.length > 0) {
  console.error("❌ manifest 里存在宿主不认识的权限（运行时会被 requirePermission 拒绝）：", unknown);
  process.exit(1);
}
console.log("✅ permission check OK");

// ---- focus-companion-source.ts ----
const CHUNK = 120_000;
const chunks = [];
for (let i = 0; i < html.length; i += CHUNK) chunks.push(html.slice(i, i + CHUNK));
const q = s => JSON.stringify(s);
const sourceTs = [
  "/**",
  " * 内置「角色陪伴专注」的入口 HTML（1:1 保留 doris.focus.companion 的原始实现）。",
  " *",
  " * 为什么内嵌而不是重写：原版是按小手机自定义 App SDK（window.AiPhone）写的完整应用，",
  " * 番茄专注、角色陪伴、AI 出题与错题本、惩罚锁定、睡眠计时、背书、激励经济全链路已就绪。",
  " * 由 CustomAppRunner 挂载后复用宿主的 AiPhone 桥（db / ai / chat / media / tools / voice / events），",
  " * 功能与装到应用市场的版本完全一致，但不需要用户手动安装。",
  " *",
  " * 源文件：custom-apps/focus-companion/index.html（改完跑 scripts/build-focus-companion-dist.mjs 重新生成）。",
  " * 本版相对市场 zip v1.9.4 的改动（内置化修复，见 docs/focus-companion-builtin-migration-plan.md §5/§8）：",
  " *   1. 统一生图闸门 canGenWall：自定义壁纸启用后默认暂停 AI 生图，奖励壁纸也受总开关控制；",
  " *   2. 设置页壁纸改为四选一模式（全部不生成 / 只用AI / 只用我的 / 两者都要）；",
  " *   3. 导出与保存图片走宿主原生通道（media.download / media.save），APK 里不再依赖 <a download>。",
  " */",
  `export const FOCUS_COMPANION_APP_ID = ${q(manifest.id)};`,
  "export const FOCUS_COMPANION_ENTRY_HTML = [",
  ...chunks.map(c => "  " + q(c) + ","),
  '].join("");',
].join("\n") + "\n";
fs.writeFileSync(path.join(libDir, "focus-companion-source.ts"), sourceTs);
console.log(`✅ focus-companion-source.ts: ${chunks.length} chunks / ${html.length} chars`);

// ---- focus-companion-meta.ts ----
const metaTs = `/** 内置「角色陪伴专注」的元信息（不含 HTML 本体）。
 *
 * 拆成两份是为了别把 ~1MB 的 HTML 拖进工具箱/指令这类只需要 manifest 的模块：
 * · 本文件：id / 名称 / 权限 / manifest（5 个角色工具、2 条富媒体指令、2 个 plusActions、1 个后台事件）
 * · focus-companion-source.ts：入口 HTML（只有桌面壳挂载时才会 import）
 *
 * manifest 与权限 1:1 来自市场 zip v1.9.4（custom-apps/focus-companion/manifest.json），
 * app id 保持不变——老用户装过市场版的话，数据（ai_phone_custom_app_data_v1:<id>/*）无缝延续。
 * 本文件由 scripts/build-focus-companion-dist.mjs 生成，不要手改 manifest 部分。
 */
import type { InstalledCustomApp } from "../custom-app-types";

export const FOCUS_COMPANION_APP_ID = ${q(manifest.id)};
export const FOCUS_COMPANION_APP_NAME = ${q(manifest.name)};
export const FOCUS_COMPANION_APP_VERSION = ${q(manifest.version)};
export const FOCUS_COMPANION_APP_DESCRIPTION = ${q(manifest.description)};

export const FOCUS_COMPANION_MANIFEST: InstalledCustomApp["manifest"] =
  ${JSON.stringify(manifest, null, 2)} as InstalledCustomApp["manifest"];

/** zip 包里声明了 icon.png 但没随包提供，桌面图标走 desktop-config 的内置图标。 */
export function buildFocusCompanionApp(entryHtml: string): InstalledCustomApp {
  return {
    id: FOCUS_COMPANION_APP_ID,
    name: FOCUS_COMPANION_APP_NAME,
    version: FOCUS_COMPANION_APP_VERSION,
    author: ${q(manifest.author ?? "")},
    description: FOCUS_COMPANION_APP_DESCRIPTION,
    entryHtml,
    permissions: (FOCUS_COMPANION_MANIFEST.permissions ?? []) as InstalledCustomApp["permissions"],
    manifest: FOCUS_COMPANION_MANIFEST,
    assets: {},
    installedAt: "2026-11-21T00:00:00.000Z",
    updatedAt: "2026-11-21T00:00:00.000Z",
  };
}
`;
fs.writeFileSync(path.join(libDir, "focus-companion-meta.ts"), metaTs);
console.log(`✅ focus-companion-meta.ts written`);
