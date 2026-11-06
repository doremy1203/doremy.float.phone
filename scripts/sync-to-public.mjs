#!/usr/bin/env node
/**
 * 实验仓库 → 公开仓库 同步脚本。
 *
 * 用法（在实验仓库根目录）：
 *   node scripts/sync-to-public.mjs <公开仓库本地路径> [--dry-run]
 *
 * 行为：
 * 1. 以实验仓库工作区为准，把全部受版本控制的文件镜像到公开仓库（新增/覆盖/删除）；
 * 2. 白名单保留公开仓库独有的文档（DEVICE_SETUP_GUIDE.md、docs/本次功能同步说明.md），
 *    这些文件不在实验仓库里，同步时原样保留；
 * 3. 永远不碰 .git、node_modules、.next、.env.local、.watch-cache、server.log；
 * 4. --dry-run 只打印将发生的变更，不写盘。
 *
 * 同步后请手动完成：
 *   cd <公开仓库> && npx tsc --noEmit && npm run test:life && npm run build
 *   README/文档如需更新，参考实验仓库的同名文件。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const target = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!target || !fs.existsSync(path.join(target, ".git"))) {
  console.error("用法: node scripts/sync-to-public.mjs <公开仓库本地路径> [--dry-run]");
  process.exit(1);
}

const sourceRoot = process.cwd();
const targetRoot = path.resolve(target);
const PRESERVE = new Set([
  "DEVICE_SETUP_GUIDE.md",
  "docs/本次功能同步说明.md",
]);
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".watch-cache", ".vercel", ".netlify"]);

function listTrackedFiles(root) {
  const out = execSync("git ls-files -z", { cwd: root, maxBuffer: 1024 * 1024 * 32 }).toString().split("\0").filter(Boolean);
  return new Set(out);
}

function walkDir(dir, base = dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkDir(full, base, acc);
    else acc.push(rel);
  }
  return acc;
}

const tracked = listTrackedFiles(sourceRoot);
const sourceFiles = walkDir(sourceRoot).filter(rel => tracked.has(rel) || rel.startsWith("public/"));
let copied = 0, removed = 0, preserved = 0, skippedUntracked = 0;

for (const rel of sourceFiles) {
  const src = path.join(sourceRoot, rel);
  const dest = path.join(targetRoot, rel);
  const destDir = path.dirname(dest);
  if (!dryRun) fs.mkdirSync(destDir, { recursive: true });
  const srcBuf = fs.readFileSync(src);
  let destBuf = null;
  try { destBuf = fs.readFileSync(dest); } catch { /* 新文件 */ }
  if (!destBuf || !srcBuf.equals(destBuf)) {
    if (!dryRun) fs.writeFileSync(dest, srcBuf);
    copied += 1;
  }
}

const targetFiles = walkDir(targetRoot);
for (const rel of targetFiles) {
  if (PRESERVE.has(rel)) { preserved += 1; continue; }
  if (!tracked.has(rel)) continue; // 公开仓库自己的未跟踪文件不动
  const inSource = fs.existsSync(path.join(sourceRoot, rel));
  if (!inSource) {
    if (!dryRun) fs.rmSync(path.join(targetRoot, rel), { force: true });
    removed += 1;
  }
}

for (const rel of walkDir(targetRoot)) {
  if (!tracked.has(rel) && !PRESERVE.has(rel)) skippedUntracked += 1;
}

console.log(`[sync] ${dryRun ? "(dry-run) 将" : "已"}覆盖/新增 ${copied} 个文件，删除 ${removed} 个已在实验仓库移除的文件。`);
console.log(`[sync] 保留公开仓库独有文档 ${preserved} 个：${[...PRESERVE].join("、")}`);
if (skippedUntracked) console.log(`[sync] 跳过公开仓库自己的未跟踪文件 ${skippedUntracked} 个（构建产物/日志等）。`);
console.log("[sync] 下一步：在公开仓库运行 npx tsc --noEmit && npm run test:life && npm run build，确认后提交推送。");
