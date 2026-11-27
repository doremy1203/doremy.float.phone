"use client";

import {
    addStickerByUrlToPack,
    addStickerToPack,
    createStickerPack,
    loadStickerPacks,
    type StickerPack,
} from "./custom-sticker-storage";
import { getThemeAssetMap } from "./theme-storage";
import { downloadUrl } from "./download-utils";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const TEXT_KEYWORD = "AiPhoneStickerPack";
const CELL = 220;
const PAD = 8;
const MAX_COLS = 6;

type ExportedSticker = {
    name: string;
    dataUrl?: string;
    externalUrl?: string;
};

type PackMetadata = {
    v: 1;
    name: string;
    note?: string;
    createdAt?: string;
    stickers: ExportedSticker[];
};

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
        crc ^= bytes[index];
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
}

function readUint32(source: Uint8Array, offset: number): number {
    return ((source[offset] << 24) | (source[offset + 1] << 16) | (source[offset + 2] << 8) | source[offset + 3]) >>> 0;
}

function asciiBytes(value: string): Uint8Array {
    return Uint8Array.from(value, character => character.charCodeAt(0) & 0xff);
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
}

function bytesToLatin1(bytes: Uint8Array): string {
    let value = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
        value += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return value;
}

function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function textChunk(keyword: string, value: string): Uint8Array {
    const type = asciiBytes("tEXt");
    const data = new Uint8Array(keyword.length + 1 + value.length);
    data.set(asciiBytes(keyword), 0);
    data[keyword.length] = 0;
    data.set(asciiBytes(value), keyword.length + 1);
    const chunk = new Uint8Array(12 + data.length);
    writeUint32(chunk, 0, data.length);
    chunk.set(type, 4);
    chunk.set(data, 8);
    const crcSource = chunk.subarray(4, 8 + data.length);
    writeUint32(chunk, 8 + data.length, crc32(crcSource));
    return chunk;
}

/** 把元数据塞进 PNG 的 tEXt 块；普通看图工具仍能正常打开，导入时再读回来。 */
function embedMetadata(pngBytes: Uint8Array, metadata: PackMetadata): Uint8Array {
    const json = JSON.stringify(metadata);
    const encoded = bytesToBase64(new TextEncoder().encode(json));
    const extra = textChunk(TEXT_KEYWORD, encoded);
    let offset = 8;
    let iendStart = -1;
    while (offset + 12 <= pngBytes.length) {
        const length = readUint32(pngBytes, offset);
        const type = String.fromCharCode(...pngBytes.subarray(offset + 4, offset + 8));
        if (type === "IEND") { iendStart = offset; break; }
        offset += 12 + length;
    }
    if (iendStart < 0) throw new Error("PNG 结构异常");
    const out = new Uint8Array(pngBytes.length + extra.length);
    out.set(pngBytes.subarray(0, iendStart), 0);
    out.set(extra, iendStart);
    out.set(pngBytes.subarray(iendStart), iendStart + extra.length);
    return out;
}

function extractMetadata(pngBytes: Uint8Array): PackMetadata | null {
    let offset = 8;
    let last: PackMetadata | null = null;
    while (offset + 12 <= pngBytes.length) {
        const length = readUint32(pngBytes, offset);
        const type = String.fromCharCode(...pngBytes.subarray(offset + 4, offset + 8));
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > pngBytes.length) break;
        if (type === "tEXt") {
            const data = pngBytes.subarray(dataStart, dataEnd);
            const zero = data.indexOf(0);
            if (zero > 0) {
                const keyword = String.fromCharCode(...data.subarray(0, zero));
                if (keyword === TEXT_KEYWORD) {
                    try {
                        const json = new TextDecoder().decode(base64ToBytes(bytesToLatin1(data.subarray(zero + 1))));
                        const parsed = JSON.parse(json) as PackMetadata;
                        if (parsed && parsed.v === 1 && Array.isArray(parsed.stickers)) last = parsed;
                    } catch { /* ignore damaged metadata */ }
                }
            }
        }
        if (type === "IEND") break;
        offset = dataEnd + 4;
    }
    return last;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片加载失败"));
        image.src = dataUrl;
    });
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function dataUrlToBlob(dataUrl: string): Blob {
    const comma = dataUrl.indexOf(",");
    const header = dataUrl.slice(0, comma);
    const mime = header.slice(5, header.indexOf(";")) || "image/png";
    const bytes = base64ToBytes(dataUrl.slice(comma + 1));
    return new Blob([bytesToArrayBuffer(bytes)], { type: mime });
}

async function buildSheet(stickers: ExportedSticker[]): Promise<Blob> {
    const cols = Math.max(1, Math.min(MAX_COLS, Math.ceil(Math.sqrt(Math.max(1, stickers.length)))));
    const rows = Math.max(1, Math.ceil(stickers.length / cols));
    const width = cols * CELL;
    const height = rows * CELL;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建图片画布");
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(0,0,0,0.04)";
    for (let index = 0; index < stickers.length; index += 1) {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const left = col * CELL;
        const top = row * CELL;
        const source = stickers[index].dataUrl || stickers[index].externalUrl;
        if (!source) continue;
        try {
            const image = await loadImage(source);
            const maxSize = CELL - PAD * 2;
            const scale = Math.min(maxSize / Math.max(1, image.naturalWidth), maxSize / Math.max(1, image.naturalHeight), 1);
            const drawWidth = Math.max(1, Math.round(image.naturalWidth * scale));
            const drawHeight = Math.max(1, Math.round(image.naturalHeight * scale));
            context.drawImage(image, left + (CELL - drawWidth) / 2, top + (CELL - drawHeight) / 2, drawWidth, drawHeight);
        } catch {
            // 外链图片可能因 CORS 画不进画布；导入仍使用元数据里的原图。
        }
    }
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("导出 PNG 失败");
    return blob;
}

export async function exportStickerPackAsPng(packId: string): Promise<void> {
    const pack = loadStickerPacks().find(item => item.id === packId);
    if (!pack) throw new Error("找不到这个图集");
    const assetMap = await getThemeAssetMap(pack.stickers.map(sticker => sticker.assetId).filter(Boolean));
    const stickers: ExportedSticker[] = pack.stickers.map(sticker => ({
        name: sticker.name,
        ...(sticker.externalUrl ? { externalUrl: sticker.externalUrl } : {}),
        ...(!sticker.externalUrl && sticker.assetId ? { dataUrl: assetMap[sticker.assetId] || "" } : {}),
    })).filter(sticker => sticker.dataUrl || sticker.externalUrl);
    const sheet = await buildSheet(stickers);
    const pngBytes = new Uint8Array(await sheet.arrayBuffer());
    const metadata: PackMetadata = {
        v: 1,
        name: pack.name,
        ...(pack.note ? { note: pack.note } : {}),
        createdAt: pack.createdAt,
        stickers,
    };
    const withMetadata = embedMetadata(pngBytes, metadata);
    const blob = new Blob([bytesToArrayBuffer(withMetadata)], { type: "image/png" });
    const url = URL.createObjectURL(blob);
    try {
        await downloadUrl(url, `${pack.name || "表情包图集"}.png`);
    } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
}

export async function importStickerPackFromPng(file: File): Promise<StickerPack> {
    if (!/\.png$/i.test(file.name) && file.type !== "image/png") throw new Error("请选择本应用导出的图集 PNG");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) throw new Error("不是有效的 PNG 文件");
    const metadata = extractMetadata(bytes);
    if (!metadata) throw new Error("这个 PNG 没有表情包图集信息；请用「导出图集 PNG」生成的文件");
    const pack = createStickerPack(metadata.name || file.name.replace(/\.png$/i, ""), metadata.note || "");
    for (const item of metadata.stickers) {
        const name = String(item.name || "").trim();
        if (!name) continue;
        if (item.externalUrl) {
            addStickerByUrlToPack(pack.id, name, item.externalUrl);
        } else if (item.dataUrl) {
            await addStickerToPack(pack.id, name, dataUrlToBlob(item.dataUrl));
        }
    }
    return loadStickerPacks().find(item => item.id === pack.id) || pack;
}

/** 测试/诊断用：验证 PNG tEXt 元数据读写。 */
export const __stickerPackPngInternals = { embedMetadata, extractMetadata };
