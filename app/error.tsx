"use client";

import { useEffect, useState } from "react";

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function AppErrorBoundary({ error, reset }: Props) {
  const [debug, setDebug] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDebug(new URLSearchParams(window.location.search).get("debug") === "1");
    console.error("[float runtime error]", {
      message: error.message,
      name: error.name,
      stack: error.stack,
      digest: error.digest,
      href: window.location.href,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    });
  }, [error]);

  const report = [
    "float client runtime error",
    `message: ${error.message || "(empty message; inspect browser console)"}`,
    `name: ${error.name}`,
    `digest: ${error.digest || "(none)"}`,
    `url: ${typeof window === "undefined" ? "(unknown)" : window.location.href}`,
    `time: ${new Date().toISOString()}`,
    `userAgent: ${typeof navigator === "undefined" ? "(unknown)" : navigator.userAgent}`,
    `stack:\n${error.stack || "(no stack provided)"}`,
  ].join("\n");

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
    } catch {
      setDebug(true);
    }
  }

  return (
    <main style={{ minHeight: "100dvh", background: "#faf7f1", color: "#493c34", padding: "max(24px, env(safe-area-inset-top)) 20px 28px", fontFamily: "system-ui, sans-serif" }}>
      <section style={{ maxWidth: 640, margin: "8vh auto 0", border: "1px solid #e5d8c9", background: "#fffdf9", padding: 24 }}>
        <p style={{ margin: "0 0 8px", fontSize: 12, letterSpacing: "0.16em", color: "#9b7468" }}>FLOAT · RUNTIME DIAGNOSTICS</p>
        <h1 style={{ margin: "0 0 12px", fontSize: 22, fontWeight: 600 }}>页面启动遇到异常</h1>
        <p style={{ margin: "0 0 18px", lineHeight: 1.7, color: "#75675d" }}>这不是普通的网络加载提示。应用捕获到了客户端运行错误，已记录详细信息。可以先重试；如果仍然出现，请复制诊断信息用于定位根因。</p>
        <div style={{ padding: 12, background: "#f4eee6", border: "1px solid #e5d8c9", overflowWrap: "anywhere", fontSize: 13 }}>
          <strong>错误信息：</strong> {error.message || "浏览器未提供错误消息"}
          {error.digest && <div style={{ marginTop: 6 }}>错误标识：{error.digest}</div>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 18 }}>
          <button onClick={reset} style={{ border: 0, background: "#76534d", color: "white", padding: "10px 16px", cursor: "pointer" }}>重试加载</button>
          <button onClick={() => void copyReport()} style={{ border: "1px solid #d7c5b4", background: "#fffdf9", color: "#604a40", padding: "10px 16px", cursor: "pointer" }}>{copied ? "已复制诊断信息" : "复制诊断信息"}</button>
          <button onClick={() => window.location.reload()} style={{ border: "1px solid #d7c5b4", background: "#fffdf9", color: "#604a40", padding: "10px 16px", cursor: "pointer" }}>刷新页面</button>
        </div>
        {debug && <details open style={{ marginTop: 18 }}>
          <summary style={{ cursor: "pointer" }}>调试详情（debug=1）</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.5 }}>{report}</pre>
        </details>}
      </section>
    </main>
  );
}
