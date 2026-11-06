"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clipboard, Download, RefreshCw, ShieldCheck, Smartphone, Wifi, XCircle } from "lucide-react";
import { getQaErrorEntries, type QaErrorEntry } from "@/lib/qa-error-log";
import { loadVirtualLifeState } from "@/lib/life/life-storage";
import { hasNotificationReplyBridge } from "@/lib/notification-reply";
import { isPersonalPushCloudActive } from "@/lib/personal-push-cloud";
import { consumeServerOutbox } from "@/lib/push-outbox-client";
import { copyTextToClipboard } from "@/lib/clipboard-utils";
import { LifeDiagnosticsPanel } from "@/components/life/life-diagnostics-panel";
import { ScreenshotDiagnosticsPanel } from "@/components/screenshot/diagnostics-panel";
import { ModuleDiagnostics } from "@/components/settings/module-diagnostics";

type CheckStatus = "ok" | "warn" | "fail" | "info";
type CheckItem = { id: string; title: string; status: CheckStatus; detail: string; fix?: string };
type AndroidShellDiagnostics = {
  getVersion?: () => string;
  getDiagnosticsSnapshot?: () => string;
  getLastNativeCrashLog?: () => string;
  clearLastNativeCrashLog?: () => boolean;
  getWebConsoleLogs?: () => string;
  clearWebConsoleLogs?: () => boolean;
  getGlobalWatchDiagnostics?: () => string;
  getDeviceActionCapabilities?: () => string;
  getPerceptionCapabilities?: () => string;
  getLocationCapabilities?: () => string;
  getHealthCapabilities?: () => string;
  getCalendarCapabilities?: () => string;
  getScreenshotCapabilities?: () => string;
  getScreenshotDiagnostics?: () => string;
};
declare global { interface Window { AndroidShell?: AndroidShellDiagnostics; } }

function iconFor(status: CheckStatus) {
  if (status === "ok") return <CheckCircle2 size={18} />;
  if (status === "fail") return <XCircle size={18} />;
  if (status === "warn") return <AlertTriangle size={18} />;
  return <ShieldCheck size={18} />;
}
function labelFor(status: CheckStatus) {
  return status === "ok" ? "正常" : status === "fail" ? "异常" : status === "warn" ? "需检查" : "信息";
}
function safeRead<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}
function recentErrors(): QaErrorEntry[] {
  return safeRead(() => getQaErrorEntries().slice(-30).reverse(), []);
}

export function RuntimeDiagnostics({ onNotice }: { onNotice?: (message: string) => void }) {
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [termuxCommandCopied, setTermuxCommandCopied] = useState(false);
  const termuxInstallCommand = "curl -fsSL https://raw.githubusercontent.com/Zyxxx1203/doremy.float.phone/main/tools/video-resolver/install-android.sh | bash";
  const copyTermuxInstallCommand = async () => {
    try {
      await navigator.clipboard.writeText(termuxInstallCommand);
      setTermuxCommandCopied(true);
      onNotice?.("Termux 部署命令已复制。请切换到 Termux 粘贴并执行。");
    } catch {
      setTermuxCommandCopied(false);
      onNotice?.("自动复制不可用，请长按下方命令复制后到 Termux 执行。");
    }
  };
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<number | null>(null);
  const [errors, setErrors] = useState<QaErrorEntry[]>([]);
  const [nativeInfo, setNativeInfo] = useState<Record<string, unknown> | null>(null);
  const [nativeCrashLog, setNativeCrashLog] = useState("");
  const [webConsoleLogs, setWebConsoleLogs] = useState<string[]>([]);

  const runChecks = useCallback(async () => {
    setBusy(true);
    const result: CheckItem[] = [];
    const shell = typeof window !== "undefined" ? window.AndroidShell : undefined;
    const isShell = Boolean(shell && typeof shell.getVersion === "function");
    result.push({ id: "runtime", title: "运行容器", status: isShell ? "ok" : "info", detail: isShell ? "检测到 Android 原生壳。" : "没有检测到 AndroidShell；可能是浏览器、PWA 或旧版 APK。", fix: !isShell ? "如果正在 APK 内使用，请确认安装的是包含原生桥接的版本。" : undefined });

    if (isShell) {
      const version = safeRead(() => String(shell!.getVersion!()), "读取失败");
      result.push({ id: "version", title: "原生壳版本", status: version === "读取失败" ? "warn" : "ok", detail: "原生版本：" + version });
      // 真实调用一遍桥方法：接口存在不代表能调用。Java exception 必须显示在这里，
      // 而不是被“版本正常/接口存在”掩盖。
      const probes: Array<[string, (() => unknown) | undefined]> = [
        ["getDiagnosticsSnapshot", shell!.getDiagnosticsSnapshot ? () => shell!.getDiagnosticsSnapshot!() : undefined],
        ["getWebConsoleLogs", shell!.getWebConsoleLogs ? () => shell!.getWebConsoleLogs!() : undefined],
        ["getLastNativeCrashLog", shell!.getLastNativeCrashLog ? () => shell!.getLastNativeCrashLog!() : undefined],
        ["getGlobalWatchDiagnostics", shell!.getGlobalWatchDiagnostics ? () => shell!.getGlobalWatchDiagnostics!() : undefined],
        ["getDeviceActionCapabilities", shell!.getDeviceActionCapabilities ? () => shell!.getDeviceActionCapabilities!() : undefined],
        ["getPerceptionCapabilities", shell!.getPerceptionCapabilities ? () => shell!.getPerceptionCapabilities!() : undefined],
        ["getLocationCapabilities", shell!.getLocationCapabilities ? () => shell!.getLocationCapabilities!() : undefined],
        ["getHealthCapabilities", shell!.getHealthCapabilities ? () => shell!.getHealthCapabilities!() : undefined],
        ["getCalendarCapabilities", shell!.getCalendarCapabilities ? () => shell!.getCalendarCapabilities!() : undefined],
        ["getScreenshotDiagnostics", shell!.getScreenshotDiagnostics ? () => shell!.getScreenshotDiagnostics!() : undefined],
      ];
      const failures: string[] = [];
      for (const [name, probe] of probes) {
        if (!probe) continue;
        try {
          probe();
        } catch (error) {
          failures.push(name + "：" + (error instanceof Error ? error.message : String(error)));
        }
      }
      result.push({
        id: "native-bridge-calls",
        title: "原生桥方法调用",
        status: failures.length > 0 ? "fail" : "ok",
        detail: failures.length > 0
          ? "以下方法实际调用失败：" + failures.join("；")
          : "已实际调用诊断/能力方法，未抛 Java exception。",
        fix: failures.length > 0 ? "更新到包含“UI 线程缓存页面 URL”修复的 APK；若仍失败，复制完整报告检查具体方法。" : undefined,
      });
    }

    result.push({ id: "online", title: "网络状态", status: navigator.onLine ? "ok" : "fail", detail: navigator.onLine ? "浏览器报告网络在线；不代表云端 API 一定可访问。" : "浏览器报告当前离线。", fix: !navigator.onLine ? "检查 Wi-Fi / 移动数据后重试。" : undefined });

    try {
      const response = await fetch("/icon-192.png?diag=" + Date.now(), { method: "HEAD", cache: "no-store" });
      result.push({ id: "site", title: "站点连通性", status: response.ok ? "ok" : "warn", detail: response.ok ? "同源静态资源可访问。" : "同源请求返回 HTTP " + response.status, fix: !response.ok ? "检查站点部署、网络代理或静态资源路径。" : undefined });
    } catch (error) {
      result.push({ id: "site", title: "站点连通性", status: "fail", detail: "同源请求失败：" + (error instanceof Error ? error.message : String(error)), fix: "检查网络、域名和站点部署状态。" });
    }

    // Life-scene notification/reply chain: reuse the production outbox consumer so
    // diagnostics exercise the same return path instead of maintaining a parallel parser.
    try {
      const before = loadVirtualLifeState();
      const activeScene = before.scenes.find(scene => scene.status === "active");
      const sceneCharacters = activeScene?.participants.filter(participant =>
        participant.ownerType === "character" && participant.activity !== "离开"
      ) ?? [];
      const sceneReady = Boolean(
        before.settings.enabled
        && before.settings.enableCharacterAutonomy
        && before.settings.enableProactiveSceneMessages !== false
        && activeScene?.participants.some(participant => participant.ownerType === "player" && participant.ownerId === "player")
        && sceneCharacters.length > 0
      );
      result.push({
        id: "life-scene-autonomy",
        title: "生活现场主动消息条件",
        status: sceneReady ? "ok" : "warn",
        detail: sceneReady
          ? `主动消息开关已启用；当前现场「${activeScene?.locationName || "未命名地点"}」有 ${sceneCharacters.length} 位在场角色。`
          : "当前没有满足条件的活动现场，或生活系统/角色自主发言开关未启用。",
        fix: sceneReady ? undefined : "进入生活现场，确认玩家与至少一位角色在场，并检查生活系统、角色自主行为和主动消息开关。"
      });

      const shellReplyBridge = hasNotificationReplyBridge();
      result.push({
        id: "life-notification-reply-bridge",
        title: "通知栏回复接收桥",
        status: shellReplyBridge ? "ok" : isShell ? "warn" : "info",
        detail: shellReplyBridge
          ? "AndroidShell 提供 consumePendingReplies；可以从原生队列接收通知栏回复。"
          : isShell
            ? "检测到原生壳，但没有通知回复桥接方法；回复可能留在原生队列而无法回写。"
            : "当前不是带原生回复桥的 Android 壳，跳过通知栏直回检测。",
        fix: isShell && !shellReplyBridge ? "安装包含 NotificationReplyReceiver / consumePendingReplies 桥接的最新 APK。" : undefined
      });

      const cloudReady = isShell || isPersonalPushCloudActive();
      if (cloudReady) {
        await consumeServerOutbox({ force: true, silent: true });
      }
      const after = loadVirtualLifeState();
      const latestSceneMessage = [...after.sceneMessages].reverse().find(message => message.id.startsWith("life-outbox-"));
      const latestReply = [...after.sceneMessages].reverse().find(message => message.id.startsWith("notification-reply-"));
      result.push({
        id: "life-scene-outbox",
        title: "后台主动消息回写",
        status: !cloudReady ? "warn" : latestSceneMessage ? "ok" : "info",
        detail: !cloudReady
          ? "当前环境没有可用的后台回传箱路径，无法验证云端主动消息回写。"
          : latestSceneMessage
            ? `已找到云端回写记录（${new Date(latestSceneMessage.createdAt).toLocaleString()}）；本次已通过正式回传箱消费链路检查待处理记录。`
            : "回传箱消费已尝试，但本地没有云端生活现场记录。仅凭空回传箱不能证明后台调度持续运行。",
        fix: !cloudReady ? "安卓壳应走站点任务/回传箱；浏览器需启用个人云推送并部署对应 Edge Functions。" : !latestSceneMessage ? "保持一个角色在活动生活现场，等待下一次后台主动触发后重跑检测；同时检查 push_jobs 与 push_outbox 服务端记录。" : undefined
      });
      result.push({
        id: "life-notification-reply-writeback",
        title: "通知回复生活现场回写",
        status: latestReply ? "ok" : "info",
        detail: latestReply
          ? `已找到通知回复写回记录（${new Date(latestReply.createdAt).toLocaleString()}），对应现场 ${latestReply.sceneId}。`
          : "尚未发现通知回复写回记录；需从在场角色的通知栏直接回复一条消息后再次检测。",
        fix: latestReply ? undefined : "从当前在场角色的通知栏直接回复测试文本，然后重新运行诊断。"
      });
    } catch (error) {
      result.push({
        id: "life-chain-diagnostics",
        title: "生活现场通知链路",
        status: "fail",
        detail: "检测或回传箱消费异常：" + (error instanceof Error ? error.message : String(error)),
        fix: "复制完整诊断报告，检查浏览器控制台与 push_outbox 服务端日志。"
      });
    }

    // Optional Termux video resolver: absence is informational because platform iframe fallback may still work.
    const resolverEndpoint = safeRead(() => { let endpoint = (localStorage.getItem("watch_local_resolver_endpoint_v1") || "http://127.0.0.1:8765").trim(); while (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1); return endpoint; }, "http://127.0.0.1:8765");
    const resolverToken = safeRead(() => localStorage.getItem("watch_local_resolver_token_v1") || "", "");
    try {
      const headers: Record<string, string> = {};
      if (resolverToken) headers["X-Resolver-Token"] = resolverToken;
      const response = await fetch(resolverEndpoint + "/health", { headers, cache: "no-store", signal: AbortSignal.timeout(3500) });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const health = await response.json() as { ok?: boolean; version?: string; engines?: Record<string, boolean>; ffmpeg?: boolean };
      const engines = health.engines ? Object.entries(health.engines).map(([name, ready]) => name + (ready ? "✓" : "×")).join(" / ") : "引擎状态未知";
      const ready = health.ok !== false && Boolean(health.engines?.["yt-dlp"] || health.engines?.["parse-video-py"]);
      result.push({ id: "video-resolver", title: "一起看本地解析链路", status: ready ? "ok" : "warn", detail: "服务已响应 · v" + (health.version || "未知") + " · " + engines + " · FFmpeg " + (health.ffmpeg ? "可用" : "未检测到"), fix: !ready ? "检查 Termux 服务和解析引擎；安装/启动命令可在一起看 → 设置 → 本地视频下载引擎中复制。" : undefined });
    } catch (error) {
      result.push({ id: "video-resolver", title: "一起看本地解析链路", status: "info", detail: "未连接到本机解析服务（" + (error instanceof Error ? error.message : String(error)) + "）。这不代表播放器整体不可用：支持的 B 站/YouTube 等链接仍会尝试内嵌播放器；部分平台会限制 iframe。", fix: "如需启用本地解析，在一起看设置中复制 Termux 一键部署命令，执行后返回此处重新检测。" });
    }

    const storage = safeRead(() => { const key = "__float_diag_test__"; localStorage.setItem(key, "1"); localStorage.removeItem(key); return true; }, false);
    result.push({ id: "storage", title: "本地存储", status: storage ? "ok" : "fail", detail: storage ? "localStorage 可读写。" : "localStorage 写入失败，可能是存储受限或空间异常。", fix: !storage ? "检查浏览器/应用存储；不要直接清除应用数据，以免丢失本地数据。" : undefined });
    const indexedDb = typeof indexedDB !== "undefined";
    result.push({ id: "idb", title: "IndexedDB", status: indexedDb ? "ok" : "fail", detail: indexedDb ? "IndexedDB 接口存在；不代表每个数据库都能正常打开。" : "当前环境没有 IndexedDB 接口。", fix: !indexedDb ? "更新 Android System WebView / 浏览器，并检查是否处于受限环境。" : undefined });
    const sw = "serviceWorker" in navigator;
    result.push({ id: "sw", title: "Service Worker 能力", status: sw ? "ok" : "info", detail: sw ? "提供 Service Worker API；后台执行仍受系统限制。" : "当前容器不支持 Service Worker API。", fix: undefined });

    let parsed: Record<string, unknown> | null = null;
    const hasDiag = Boolean(shell && typeof shell.getDiagnosticsSnapshot === "function");
    result.push({ id: "native-diag", title: "原生诊断接口", status: !isShell ? "info" : hasDiag ? "ok" : "warn", detail: !isShell ? "非原生环境，跳过 Android 专项检查。" : hasDiag ? "当前 APK 提供原生诊断接口。" : "当前 APK 没有诊断接口，可能是旧版。", fix: isShell && !hasDiag ? "重新构建并安装包含诊断接口的 APK。" : undefined });
    if (isShell) {
      result.push({ id: "screenshot-auth", title: "截屏授权", status: "info", detail: "Android 屏幕捕获通常使用临时 MediaProjection 授权，系统不提供可靠的永久授权标志，因此这里不会误报“已授权”。请在设置 → 截屏中实际执行一次测试。", fix: "如果授权弹窗出现后仍失败，请记录失败发生在授权、捕获还是图片返回阶段。" });
    }

    if (hasDiag) {
      try {
        parsed = JSON.parse(shell!.getDiagnosticsSnapshot!()) as Record<string, unknown>;
        if (typeof parsed.diagnosticsError === "string" && parsed.diagnosticsError) {
          result.push({ id: "native-diag-error", title: "原生诊断返回错误", status: "fail", detail: parsed.diagnosticsError, fix: "更新 APK；若仍出现，记录具体机型/版本。" });
        }
        const perms = parsed.permissions && typeof parsed.permissions === "object" ? parsed.permissions as Record<string, unknown> : {};
        const items = [["notifications", "通知权限", "到系统应用设置中允许通知。"], ["overlay", "悬浮窗权限", "在系统特殊权限中允许显示在其他应用上层。"], ["usageAccess", "应用使用情况访问", "在系统设置中为小手机开启“使用情况访问权限”。"], ["accessibility", "无障碍服务", "在系统无障碍设置中启用小手机对应服务。"]] as const;
        for (const item of items) {
          const value = perms[item[0]];
          result.push({ id: "perm-" + item[0], title: item[1], status: value === true ? "ok" : value === false ? "warn" : "info", detail: value === true ? "系统检测为已启用。" : value === false ? "系统检测为未启用。" : "当前 APK 未提供此项状态。", fix: value === false ? item[2] : undefined });
        }
      } catch (error) {
        result.push({ id: "native-read", title: "读取原生状态", status: "warn", detail: "原生诊断数据读取失败：" + (error instanceof Error ? error.message : String(error)) });
      }
    }
    setNativeInfo(parsed);
    setNativeCrashLog(shell && typeof shell.getLastNativeCrashLog === "function" ? safeRead(() => shell.getLastNativeCrashLog!(), "") : "");
    const rawConsoleLogs = shell && typeof shell.getWebConsoleLogs === "function" ? safeRead(() => shell.getWebConsoleLogs!(), "[]") : "[]";
    setWebConsoleLogs(safeRead(() => { const parsedLogs: unknown = JSON.parse(rawConsoleLogs); return Array.isArray(parsedLogs) ? parsedLogs.filter((item): item is string => typeof item === "string").slice(-200).reverse() : []; }, []));
    setErrors(recentErrors());
    setChecks(result);
    setLastRun(Date.now());
    setBusy(false);
  }, []);

  useEffect(() => { void runChecks(); }, [runChecks]);

  const report = useMemo(() => {
    const lines = [
      "小手机运行诊断报告",
      "生成时间：" + (lastRun ? new Date(lastRun).toLocaleString() : "尚未运行"),
      "页面地址：" + safeRead(() => location.origin + location.pathname, "未知"),
      "用户代理：" + safeRead(() => navigator.userAgent, "未知"),
      "屏幕：" + safeRead(() => screen.width + "×" + screen.height + "，DPR " + devicePixelRatio, "未知"),
      "网络在线标志：" + safeRead(() => String(navigator.onLine), "未知"),
      "一起看本地解析地址：" + safeRead(() => localStorage.getItem("watch_local_resolver_endpoint_v1") || "http://127.0.0.1:8765（默认）", "读取失败"),
      "", "检查结果：",
      ...checks.map(item => "[" + labelFor(item.status) + "] " + item.title + "：" + item.detail + (item.fix ? "；建议：" + item.fix : "")),
      "", "原生信息：", nativeInfo ? JSON.stringify(nativeInfo, null, 2) : "无（浏览器/PWA 或当前 APK 不支持）",
      "", "上一次原生崩溃日志：", nativeCrashLog || "没有已保存的原生崩溃日志",
      "", "最近 WebView Console 警告/错误（最多 200 条）：",
      ...(webConsoleLogs.length ? webConsoleLogs.slice().reverse() : ["无已捕获日志；可能不是原生壳或 APK 版本较旧"]),
      "", "最近前端异常（最多 30 条；不包含聊天记录）：",
      ...(errors.length ? errors.map(item => "[" + new Date(item.ts).toISOString() + "] " + item.kind + (item.source ? " (" + item.source + ")" : "") + " " + item.message) : ["无已捕获异常"]),
      "", "隐私说明：报告由本机生成，不会自动上传。分享前请检查是否包含个人信息。"
    ];
    return lines.join("\n");
  }, [checks, errors, lastRun, nativeInfo, nativeCrashLog, webConsoleLogs]);

  const copyReport = async () => {
    const copied = await copyTextToClipboard(report);
    onNotice?.(copied ? "诊断报告已复制；发送前请先检查内容。" : "自动复制失败，请在下方文本框中手动复制。");
  };
  const downloadReport = () => {
    const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "float-diagnostics-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const failed = checks.filter(item => item.status === "fail").length;
  const warned = checks.filter(item => item.status === "warn").length;

  return <div style={{ display: "grid", gap: 14, padding: "4px 0 24px" }}>
    <section style={{ border: "1px solid var(--border, rgba(128,128,128,.18))", borderRadius: 16, padding: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>WebView Console 警告与错误</div>
      <p style={{ fontSize: 12, opacity: .7, lineHeight: 1.6, margin: "7px 0 10px" }}>新版 Android 壳会在本机保留最近 200 条 warning/error，不自动上传。日志可能包含 URL 或错误上下文，分享前请检查。</p>
      {webConsoleLogs.length ? <><div style={{ display: "grid", gap: 7 }}>{webConsoleLogs.slice(0, 12).map((item, index) => <div key={index} style={{ fontSize: 11, lineHeight: 1.5, padding: 9, borderRadius: 10, background: "var(--surface-secondary, rgba(128,128,128,.07))", overflowWrap: "anywhere" }}>{item}</div>)}</div><button type="button" onClick={() => { const ok = safeRead(() => Boolean(window.AndroidShell?.clearWebConsoleLogs?.()), false); if (ok) { setWebConsoleLogs([]); onNotice?.("本机 WebView Console 日志已清除。"); } else onNotice?.("清除失败或当前 APK 不支持。"); }} style={{ marginTop: 8, border: "1px solid var(--border, #ddd)", borderRadius: 9, padding: "7px 10px", background: "transparent", fontSize: 12 }}>清除 Console 日志</button></> : <div style={{ fontSize: 12, opacity: .65 }}>目前没有捕获到 WebView Console 警告/错误，或当前 APK 尚未提供该接口。</div>}
    </section>
    <section style={{ borderRadius: 18, padding: 16, background: "var(--surface-secondary, rgba(128,128,128,.08))", border: "1px solid var(--border, rgba(128,128,128,.18))" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Smartphone size={22} />
        <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 16 }}>运行诊断与故障排查</div><div style={{ fontSize: 12, opacity: .72, marginTop: 3 }}>只在本机检查，不会自动上传诊断信息。</div></div>
        <button type="button" onClick={() => void runChecks()} disabled={busy} aria-label="重新检查" title="重新检查" style={{ border: "1px solid var(--border, #ddd)", borderRadius: 10, padding: 9, background: "transparent" }}><RefreshCw size={17} className={busy ? "animate-spin" : ""} /></button>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, borderRadius: 99, padding: "5px 9px", background: "rgba(22,163,74,.12)" }}>正常 {checks.filter(x => x.status === "ok").length}</span>
        <span style={{ fontSize: 12, borderRadius: 99, padding: "5px 9px", background: "rgba(217,119,6,.12)" }}>需检查 {warned}</span>
        <span style={{ fontSize: 12, borderRadius: 99, padding: "5px 9px", background: "rgba(220,38,38,.12)" }}>异常 {failed}</span>
      </div>
      {lastRun && <div style={{ fontSize: 11, opacity: .6, marginTop: 8 }}>最近检查：{new Date(lastRun).toLocaleString()}</div>}
    </section>
    <section style={{ display: "grid", gap: 8 }}>
      {checks.map(item => <article key={item.id} style={{ display: "grid", gridTemplateColumns: "22px minmax(0,1fr)", gap: 10, padding: 13, borderRadius: 14, border: "1px solid var(--border, rgba(128,128,128,.16))" }}>
        <div style={{ paddingTop: 2, color: item.status === "ok" ? "#16a34a" : item.status === "fail" ? "#dc2626" : item.status === "warn" ? "#d97706" : "var(--muted-foreground, #888)" }}>{iconFor(item.status)}</div>
        <div style={{ minWidth: 0 }}><div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><strong style={{ fontSize: 13 }}>{item.title}</strong><span style={{ fontSize: 10, opacity: .65 }}>{labelFor(item.status)}</span></div><p style={{ fontSize: 12, lineHeight: 1.6, margin: "5px 0 0", overflowWrap: "anywhere" }}>{item.detail}</p>{item.fix && <p style={{ fontSize: 12, lineHeight: 1.6, margin: "5px 0 0", opacity: .75 }}>建议：{item.fix}</p>}</div>
      </article>)}
    </section>
    <section style={{ border: "1px solid var(--border, rgba(128,128,128,.18))", borderRadius: 16, padding: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>一起看 · Termux 一键部署</div>
      <p style={{ fontSize: 12, lineHeight: 1.7, opacity: .75, margin: "7px 0 10px" }}>点击复制命令后，切换到 Termux 粘贴并执行。它会安装 Python、FFmpeg 和解析依赖，并启动本机服务。执行完成后返回本页点击“重新检查”。</p>
      <button type="button" onClick={() => void copyTermuxInstallCommand()} style={{ display: "inline-flex", alignItems: "center", gap: 7, borderRadius: 10, padding: "10px 12px", border: "1px solid var(--border, #c99a6a)", background: "var(--surface-secondary, rgba(201,154,106,.12))", color: "inherit", fontSize: 12, fontWeight: 600 }}><Clipboard size={15} />{termuxCommandCopied ? "已复制 · 再次复制命令" : "复制 Termux 部署命令"}</button>
      <code onClick={() => void copyTermuxInstallCommand()} style={{ display: "block", userSelect: "all", overflowWrap: "anywhere", fontSize: 10, lineHeight: 1.6, marginTop: 9, padding: 10, borderRadius: 9, background: "var(--surface-secondary, rgba(128,128,128,.08))", cursor: "pointer" }}>{termuxInstallCommand}</code>
      <p style={{ fontSize: 11, lineHeight: 1.6, opacity: .7, marginTop: 8 }}>注意：这里的“本地解析链路”检查只验证服务健康状态与引擎存在，不等于已验证某个视频解析成功或 APK 内播放成功。未连接解析服务时，播放器仍会尝试支持的官方内嵌播放器。</p>
    </section>
    <section style={{ border: "1px solid var(--border, rgba(128,128,128,.18))", borderRadius: 16, padding: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>上一次原生崩溃</div>
      <p style={{ fontSize: 12, opacity: .7, lineHeight: 1.6, margin: "7px 0 10px" }}>新版 APK 会在进程发生未捕获原生异常时，将最近一次堆栈保存在应用私有目录；只在本机读取，不会自动上传。旧 APK 无此能力。</p>
      {nativeCrashLog ? <><pre style={{ maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 10, lineHeight: 1.5, padding: 10, borderRadius: 10, background: "var(--surface-secondary, rgba(128,128,128,.07))" }}>{nativeCrashLog}</pre><button type="button" onClick={() => { const ok = safeRead(() => Boolean(window.AndroidShell?.clearLastNativeCrashLog?.()), false); if (ok) { setNativeCrashLog(""); onNotice?.("本机保存的原生崩溃日志已清除。"); } else onNotice?.("清除失败或当前 APK 不支持。"); }} style={{ marginTop: 8, border: "1px solid var(--border, #ddd)", borderRadius: 9, padding: "7px 10px", background: "transparent", fontSize: 12 }}>清除本机崩溃日志</button></> : <div style={{ fontSize: 12, opacity: .65 }}>没有已保存的原生崩溃日志，或当前 APK 版本不支持。</div>}
    </section>
    <section style={{ border: "1px solid var(--border, rgba(128,128,128,.18))", borderRadius: 16, padding: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 700, fontSize: 14 }}><Wifi size={17} /> 最近前端异常</div>
      <p style={{ fontSize: 12, opacity: .7, lineHeight: 1.6, margin: "7px 0 10px" }}>最多显示最近 30 条 JavaScript 异常和未处理 Promise 错误。原生闪退仍需 Android 崩溃日志。</p>
      {errors.length ? <div style={{ display: "grid", gap: 7 }}>{errors.slice(0, 8).map((item, index) => <div key={item.ts + "-" + index} style={{ fontSize: 11, lineHeight: 1.5, padding: 9, borderRadius: 10, background: "var(--surface-secondary, rgba(128,128,128,.07))", overflowWrap: "anywhere" }}><div style={{ opacity: .65 }}>{new Date(item.ts).toLocaleString()} · {item.kind}{item.source ? " · " + item.source : ""}</div><div>{item.message}</div></div>)}</div> : <div style={{ fontSize: 12, opacity: .65 }}>目前没有捕获到前端异常。</div>}
    </section>
    <section style={{ border: "1px solid var(--border, rgba(128,128,128,.18))", borderRadius: 16, padding: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>如果 APK 闪退</div>
      <ol style={{ fontSize: 12, lineHeight: 1.8, paddingLeft: 20, margin: "8px 0 0" }}>
        <li>先区分是整个 APK 退出，还是只有网页白屏/返回桌面后重新加载。</li>
        <li>确认 APK 版本与网页部署版本；修改 Kotlin、Manifest 或原生桥后必须重新构建安装 APK。</li>
        <li>如果整个进程退出，本页只能提供前端异常，不能代替 Android 原生崩溃日志。请通过 Android Studio 的 Logcat 或系统错误报告取得崩溃时间附近的 FATAL EXCEPTION / AndroidRuntime 堆栈。</li>
        <li>分享日志前请删除账号、令牌、个人内容；不要为了排错清除应用数据。</li>
      </ol>
    </section>
    <section style={{ border: "1px solid var(--border, rgba(128,128,128,.18))", borderRadius: 16, padding: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>导出诊断报告</div>
      <p style={{ fontSize: 12, opacity: .7, lineHeight: 1.6, margin: "6px 0 10px" }}>报告包含运行环境、能力检查和最近异常，不包含聊天记录、角色记忆或截图。仍建议发送前人工检查。</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => void copyReport()} style={{ display: "inline-flex", alignItems: "center", gap: 7, borderRadius: 10, padding: "9px 12px", border: "1px solid var(--border, #ddd)", background: "transparent", fontSize: 12 }}><Clipboard size={15} />复制报告</button>
        <button type="button" onClick={downloadReport} style={{ display: "inline-flex", alignItems: "center", gap: 7, borderRadius: 10, padding: "9px 12px", border: "1px solid var(--border, #ddd)", background: "transparent", fontSize: 12 }}><Download size={15} />下载 TXT</button>
      </div>
      <textarea aria-label="诊断报告内容" readOnly value={report} style={{ width: "100%", minHeight: 160, marginTop: 10, padding: 10, borderRadius: 10, resize: "vertical", fontSize: 11, lineHeight: 1.5, background: "var(--surface-secondary, rgba(128,128,128,.05))", border: "1px solid var(--border, rgba(128,128,128,.18))", color: "inherit" }} />
    </section>
    <section style={{ border: "1px solid var(--border, rgba(128,128,128,.18))", borderRadius: 16, padding: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>生活系统 · 专项诊断</div>
      <LifeDiagnosticsPanel />
    </section>
    <section style={{ border: "1px solid var(--border, rgba(128,128,128,.18))", borderRadius: 16, padding: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>截屏与查岗 · 专项诊断</div>
      <ScreenshotDiagnosticsPanel onNotice={onNotice} />
    </section>
    <ModuleDiagnostics />
  </div>;
}
