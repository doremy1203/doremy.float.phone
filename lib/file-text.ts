"use client";

const MAX_EXTRACT_CHARS = 24_000;
const MAX_PDF_PAGES = 60;

export const SUPPORTED_FILE_ACCEPT = [
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".log", ".html", ".htm", ".docx", ".pdf",
    "text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json",
    "application/xml", "text/xml", "application/x-yaml", "text/yaml", "text/html",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/pdf",
].join(",");

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "html", "htm"]);
const TEXT_MIMES = new Set([
    "text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json",
    "application/xml", "text/xml", "application/x-yaml", "text/yaml", "text/html",
]);

export function fileExtension(name: string): string {
    const value = String(name || "").trim().toLowerCase();
    const dot = value.lastIndexOf(".");
    return dot >= 0 ? value.slice(dot + 1) : "";
}

export function isSupportedReadableFile(name: string, mime: string): boolean {
    const ext = fileExtension(name);
    const type = String(mime || "").toLowerCase().split(";")[0].trim();
    if (ext === "docx" || ext === "pdf") return true;
    if (TEXT_EXTENSIONS.has(ext)) return true;
    if (type === "application/pdf") return true;
    return TEXT_MIMES.has(type);
}

function decodeBase64(dataUrl: string): Uint8Array {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("文件数据无效");
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function decodeEntities(value: string): string {
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripHtml(value: string): string {
    return decodeEntities(value
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " "))
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

async function extractDocx(dataUrl: string): Promise<string> {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(decodeBase64(dataUrl));
    const entry = zip.file("word/document.xml");
    if (!entry) throw new Error("docx 里没有正文");
    const xml = await entry.async("string");
    const paragraphs = xml.match(/<w:p[\s\S]*?<\/w:p>/g) || [xml];
    const text = paragraphs.map(paragraph => {
        const withBreaks = paragraph
            .replace(/<w:tab\/>/g, "\t")
            .replace(/<w:br\/>/g, "\n")
            .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, "$1");
        return decodeEntities(withBreaks.replace(/<[^>]+>/g, "")).trim();
    }).filter(Boolean).join("\n");
    return text.trim();
}

/**
 * 提取 PDF 文本层。
 * 只读文字，不做版面还原，也不做 OCR：扫描件/纯图片页会得到空内容。
 * 页数和字数都设上限，避免在 WebView 里解析几百页的文件把内存打满。
 */
async function extractPdf(dataUrl: string): Promise<string> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // 浏览器里用 public 下的 worker；Node 测试环境不设 workerSrc，走 pdfjs 的 fake worker。
    if (typeof window !== "undefined") {
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    }
    const task = pdfjs.getDocument({
        data: decodeBase64(dataUrl),
        useWorkerFetch: false,
        isEvalSupported: false,
        disableFontFace: true,
    });
    try {
        const doc = await task.promise;
        const totalPages = doc.numPages;
        const pageLimit = Math.min(totalPages, MAX_PDF_PAGES);
        const pages: string[] = [];
        let collected = 0;
        for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
            const page = await doc.getPage(pageNumber);
            try {
                const content = await page.getTextContent();
                let line = "";
                const lines: string[] = [];
                for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
                    if (typeof item.str !== "string") continue;
                    line += item.str;
                    if (item.hasEOL) { lines.push(line); line = ""; }
                }
                if (line) lines.push(line);
                const pageText = lines.join("\n").trim();
                if (pageText) {
                    pages.push(pageText);
                    collected += pageText.length + 2;
                }
            } finally {
                page.cleanup();
            }
            if (collected > MAX_EXTRACT_CHARS * 2) break;
        }
        const text = pages.join("\n\n").trim();
        const skippedPages = totalPages > pageLimit;
        if (skippedPages) {
            return `${text}\n\n…（PDF 共 ${totalPages} 页，只读取了前 ${pageLimit} 页）`.trim();
        }
        return text;
    } finally {
        await task.destroy().catch(() => undefined);
    }
}

export async function extractReadableFileText(fileName: string, mime: string, dataUrl: string): Promise<{ text: string; truncated: boolean } | null> {
    if (!isSupportedReadableFile(fileName, mime)) return null;
    const ext = fileExtension(fileName);
    let text = "";
    if (ext === "pdf" || String(mime).toLowerCase().includes("application/pdf")) {
        text = await extractPdf(dataUrl);
    } else if (ext === "docx") {
        text = await extractDocx(dataUrl);
    } else {
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(decodeBase64(dataUrl));
        text = String(decoded || "").replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
        if (ext === "json" || String(mime).includes("json")) {
            try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
        } else if (ext === "html" || ext === "htm" || String(mime).includes("html")) {
            text = stripHtml(text);
        }
    }
    const truncated = text.length > MAX_EXTRACT_CHARS;
    return { text: truncated ? `${text.slice(0, MAX_EXTRACT_CHARS)}\n\n…（文件较长，只读取了前 ${MAX_EXTRACT_CHARS} 字）` : text, truncated };
}
