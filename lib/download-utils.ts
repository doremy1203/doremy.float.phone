function emitDownloadNotice(kind: "success" | "error" | "info", message: string): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("app-global-notice", { detail: { kind, message, at: Date.now() } }));
}

export type DownloadFileOptions = {
    disableNativeShare?: boolean;
    nativeShareOnly?: boolean;
};

/** android-shell 壳的 WebView UA 后缀标识（见 MainActivity.kt 的 userAgentString 拼接）。 */
const FLOAT_SHELL_UA_MARK = "FloatShell/";

/** 壳暴露的原生桥（能力按需特性检测，非壳环境为 undefined）。 */
type FloatShellBridge = {
    saveBase64File?: (fileName: string, base64: string) => boolean;
    openUrl?: (url: string) => boolean;
    launchExternalApp?: (packageName: string, dataUrl: string) => boolean;
    /** 直链交给系统下载管理器（真后台）；返回是否成功入队 */
    downloadUrl?: (url: string, fileName: string) => boolean;
    /** 大文件分块写入，避免整个备份变成单个 base64 字符串 */
    beginChunkedFile?: (fileName: string) => string;
    appendChunkedFile?: (token: string, base64Chunk: string) => boolean;
    finishChunkedFile?: (token: string) => boolean;
    abortChunkedFile?: (token: string) => void;
    /** 原生剪贴板兜底 */
    copyText?: (text: string) => boolean;
};

function readFloatShellBridge(): FloatShellBridge | null {
    if (typeof window === "undefined" || typeof navigator === "undefined") return null;
    if (!navigator.userAgent.includes(FLOAT_SHELL_UA_MARK)) return null;
    return (window as unknown as { AndroidShell?: FloatShellBridge }).AndroidShell ?? null;
}

/** 是否运行在 android-shell 壳内（普通浏览器/iOS 均为 false）。 */
export function isFloatShell(): boolean {
    return readFloatShellBridge() !== null;
}

/**
 * 用壳的桥能力打开外部 App / URL（桌宠联动）。
 * 优先按自定义 scheme 走 ACTION_VIEW（对方声明了 intent-filter 即可，不要求正在运行），
 * 失败时退回按包名唤起。非壳环境返回 false，调用方自行兜底。
 */
export function openInFloatShell(url: string, packageName?: string): boolean {
    const bridge = readFloatShellBridge();
    if (!bridge) return false;
    const direct = bridge.openUrl;
    if (direct) {
        try {
            if (direct(url)) return true;
        } catch {
            // 落到包名唤起
        }
    }
    if (packageName && bridge.launchExternalApp) {
        try {
            return bridge.launchExternalApp(packageName, url);
        } catch {
            return false;
        }
    }
    return false;
}

export function isAndroidBrowser(): boolean {
    return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

export function isIOSBrowser(): boolean {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    return /iPad|iPhone|iPod/i.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** 2MB 一块：足够小，避免 WebView JS Bridge 单次字符串和 Java Base64 峰值。 */
const NATIVE_CHUNK_BYTES = 2 * 1024 * 1024;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const step = 0x8000;
    for (let index = 0; index < bytes.length; index += step) {
        binary += String.fromCharCode(...bytes.subarray(index, Math.min(bytes.length, index + step)));
    }
    return btoa(binary);
}

/** 分块把 Blob 交给壳写盘；返回 false 表示当前 APK 不支持分块。 */
async function saveBlobInChunks(blob: Blob, filename: string, bridge: FloatShellBridge): Promise<boolean> {
    if (blob.size <= 0) throw new Error("导出内容为空，未写入文件");
    if (!bridge.beginChunkedFile || !bridge.appendChunkedFile || !bridge.finishChunkedFile) return false;
    const token = bridge.beginChunkedFile(filename);
    if (!token) return false;
    try {
        let offset = 0;
        let lastProgress = 0;
        while (offset < blob.size) {
            const end = Math.min(blob.size, offset + NATIVE_CHUNK_BYTES);
            const chunk = await blob.slice(offset, end).arrayBuffer();
            if (!bridge.appendChunkedFile(token, arrayBufferToBase64(chunk))) {
                throw new Error("原生写入分块失败");
            }
            offset = end;
            const progress = blob.size > 8 * 1024 * 1024 ? Math.floor((offset / blob.size) * 100) : 0;
            if (progress >= lastProgress + 25) {
                lastProgress = progress;
                emitDownloadNotice("info", `正在保存 ${filename}：${progress}%`);
            }
        }
        return bridge.finishChunkedFile(token);
    } catch (error) {
        bridge.abortChunkedFile?.(token);
        throw error;
    }
}

async function downloadFileInternal(blob: Blob, filename: string, options: DownloadFileOptions = {}): Promise<void> {
    const url = URL.createObjectURL(blob);
    const anchorDownload = () => {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        try {
            a.click();
        } finally {
            a.remove();
        }
    };

    const shouldUseNativeShare = options.nativeShareOnly || (!options.disableNativeShare && isIOSBrowser());
    if (shouldUseNativeShare) {
        const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
        const canNativeShare = typeof navigator !== "undefined"
            && typeof navigator.share === "function"
            && typeof navigator.canShare === "function"
            && navigator.canShare({ files: [file] });
        if (canNativeShare) {
            try {
                await navigator.share({ files: [file] });
                emitDownloadNotice("success", `已打开系统分享：${filename}`);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return;
            } catch (err) {
                // User explicitly dismissed the share sheet → respect it, don't force a download.
                if (err instanceof DOMException && err.name === "AbortError") {
                    emitDownloadNotice("info", `已取消保存：${filename}`);
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    return;
                }
                // Any other failure (webview without real file-share support, lost user
                // activation, etc.) is surfaced to the caller on iOS instead of opening
                // the blob URL, which can navigate away from the app.
            }
        }
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        emitDownloadNotice("error", `${filename}：当前浏览器没有成功打开系统分享，请在 Safari 中重试，或导出轻量备份后再试。`);
        return;
    }

    // 壳环境中 blob: + a[download] 通常无法落盘，必须使用原生桥；失败时不再假装浏览器兜底成功。
    const shell = readFloatShellBridge();
    if (shell) {
        if (!shell.saveBase64File) {
            emitDownloadNotice("error", `${filename} 保存失败：当前 APK 没有文件保存能力，请更新到包含下载桥的版本。`);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return;
        }
        try {
            // 优先分块：备份动辄几百 MB，整块 base64 会直接把 WebView 堆撑爆。
            if (await saveBlobInChunks(blob, filename, shell)) {
                emitDownloadNotice("success", `已保存到系统下载目录：${filename}`);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return;
            }
            if (blob.size > 8 * 1024 * 1024) {
                emitDownloadNotice("error", `${filename} 保存失败：当前 APK 不支持大文件分块写入，请更新 APK 后重试。`);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return;
            }
            const base64 = await blobToBase64(blob);
            if (shell.saveBase64File(filename, base64)) {
                emitDownloadNotice("success", `已保存到系统下载目录：${filename}`);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return;
            }
            emitDownloadNotice("error", `${filename} 保存失败：Android 原生保存接口返回失败，请检查存储空间和文件权限。`);
        } catch (error) {
            emitDownloadNotice("error", `${filename} 保存失败：${error instanceof Error ? error.message : "读取或写入文件时发生错误"}`);
        }
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
    }

    try {
        anchorDownload();
        // 浏览器无法确认最终落盘，因此提示为已触发，不虚报成功。
        emitDownloadNotice("info", `已触发浏览器下载：${filename}。如果下载列表没有记录，请检查浏览器下载权限后重试。`);
    } catch (error) {
        emitDownloadNotice("error", `${filename} 下载启动失败：${error instanceof Error ? error.message : "浏览器拒绝了下载请求"}`);
        throw error;
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

/**
 * 下载统一入口：即使调用方吞掉 Promise rejection，也先向全局 UI 发出可见错误。
 * 浏览器无法确认用户是否真的保存成功，因此成功提示使用“已发起/已交给系统”，不虚报落盘。
 */
export async function downloadFile(blob: Blob, filename: string, options: DownloadFileOptions = {}): Promise<void> {
    try {
        await downloadFileInternal(blob, filename, options);
    } catch (error) {
        const reason = error instanceof Error ? error.message : "未知错误";
        emitDownloadNotice("error", `${filename} 下载失败：${reason}`);
        throw error;
    }
}

/** Blob → 纯 base64（去掉 data URL 前缀），供壳的 saveBase64File 使用。 */
function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || "");
            const comma = result.indexOf(",");
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error("读取文件内容失败"));
        reader.readAsDataURL(blob);
    });
}

/**
 * 把 http(s) 直链交给壳的系统下载管理器（DownloadManager）：系统托管，
 * 切后台、锁屏、退出 App 都会继续下载，完成后通知栏提示。
 * 非壳环境、非直链、或入队失败时返回 false，由调用方走原有兜底路径。
 */
export function downloadUrlInFloatShell(url: string, filename: string): boolean {
    const bridge = readFloatShellBridge();
    if (!bridge?.downloadUrl) return false;
    if (!/^https?:\/\//i.test(url)) return false;
    try {
        return bridge.downloadUrl(url, filename);
    } catch {
        return false;
    }
}

/** 把站内相对地址补成绝对地址（壳的原生下载器拿不到页面 base，必须给完整 URL）。 */
function toAbsoluteUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    try {
        return new URL(url, window.location.href).href;
    } catch {
        return url;
    }
}

export async function downloadUrl(url: string, filename: string): Promise<void> {
    // 直链优先走壳的原生下载：页面里的 fetch→blob 一旦进后台就被暂停，
    // 交给系统下载器才能真正「离开界面继续下」。
    if (downloadUrlInFloatShell(toAbsoluteUrl(url), filename)) {
        emitDownloadNotice("success", `已交给系统下载管理器：${filename}`);
        return;
    }

    let blob: Blob | null = null;

    try {
        const res = await fetch(url);
        if (res.ok) blob = await res.blob();
    } catch { /* CORS or network error — try proxy */ }

    if (!blob && /^https?:\/\//.test(url)) {
        try {
            const res = await fetch("/api/tool-proxy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url, method: "GET" }),
            });
            if (res.ok) blob = await res.blob();
        } catch { /* proxy also failed */ }
    }

    if (blob) {
        await downloadFile(blob, filename);
    } else if (readFloatShellBridge()) {
        emitDownloadNotice("error", `${filename} 下载失败：资源请求和站内代理均未取得文件，Android 壳无法保存。请检查网络、资源链接或跨域限制后重试。`);
    } else {
        // 普通浏览器仍尝试打开原始链接，但明确告知这只是兜底尝试，不代表下载成功。
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        emitDownloadNotice("info", `${filename}无法直接保存，已尝试打开原始链接；若没有下载，请检查浏览器下载权限或资源链接。`);
    }
}
