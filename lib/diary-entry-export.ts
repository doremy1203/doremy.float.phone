import JSZip from "jszip";
import type { DiaryEntry } from "./diary-entry-types";
import { downloadFile } from "./download-utils";

export type DiaryExportFormat = "txt" | "md";

function safeFileName(value: string): string {
  return String(value || "日记")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64) || "日记";
}

function entryBody(entry: DiaryEntry): string {
  return entry.blocks.map(block => {
    if (block.type === "paragraph") return block.text;
    if (block.type === "quote") return "> " + block.text.replace(/\n/g, "\n> ");
    if (block.type === "correction") return block.replacement ? "~~" + block.text + "~~ → **" + block.replacement + "**" : "~~" + block.text + "~~";
    if (block.type === "image") return "**图片记录：" + (block.caption || "未命名图片") + "**\n\n> " + block.description;
    if (block.type === "todo") return [block.title ? "### " + block.title : "", ...block.items.map(item => (item.done ? "- [x] " : "- [ ] ") + item.text)].filter(Boolean).join("\n");
    return "";
  }).filter(Boolean).join("\n\n");
}

export function diaryEntryToMarkdown(entry: DiaryEntry): string {
  const meta = [entry.dateLabel, entry.weather].filter(Boolean).join(" · ");
  return [
    "# " + (entry.title || "未命名日记"),
    "",
    meta,
    "",
    entryBody(entry),
    "",
    "---",
    entry.characterName,
  ].filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== "")).join("\n");
}

export function diaryEntryToText(entry: DiaryEntry): string {
  return [
    entry.title || "未命名日记",
    [entry.dateLabel, entry.weather].filter(Boolean).join(" · "),
    "",
    entryBody(entry),
    "",
    entry.characterName,
  ].join("\n");
}


export async function downloadDiaryEntry(entry: DiaryEntry, format: DiaryExportFormat): Promise<void> {
  const filename = safeFileName(entry.dateLabel || entry.createdAt.slice(0, 10)) + "_" + safeFileName(entry.title);
  const markdown = diaryEntryToMarkdown(entry);
  const blob = new Blob(
    [format === "md" ? markdown : diaryEntryToText(entry)],
    { type: format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8" },
  );
  await downloadFile(blob, filename + "." + format);
}

export async function downloadDiaryEntriesZip(entries: DiaryEntry[]): Promise<void> {
  if (!entries.length) throw new Error("当前没有可导出的日记。");
  const zip = new JSZip();
  for (const entry of entries) {
    const folder = safeFileName(entry.characterName);
    const date = safeFileName(entry.dateLabel || entry.createdAt.slice(0, 10));
    const title = safeFileName(entry.title);
    zip.file(folder + "/" + date + "_" + title + "_" + safeFileName(entry.id.slice(-8)) + ".md", diaryEntryToMarkdown(entry));
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  await downloadFile(blob, "日记导出_" + new Date().toISOString().slice(0, 10) + ".zip");
}

