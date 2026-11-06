"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type NoticeKind = "success" | "error" | "info";
type NoticePayload = { kind?: NoticeKind; message?: string; at?: number };
type NoticeItem = { id: number; kind: NoticeKind; message: string };

const palette: Record<NoticeKind, { icon: string; title: string; border: string }> = {
  success: { icon: "✓", title: "已完成", border: "#4d9b70" },
  error: { icon: "!", title: "操作失败", border: "#d65a5a" },
  info: { icon: "i", title: "提示", border: "#7b91b7" },
};

/** 全局操作反馈宿主：接收 download-utils 等模块发出的 app-global-notice 事件。 */
export function GlobalNoticeHost() {
  const [notice, setNotice] = useState<NoticeItem | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextIdRef = useRef(0);

  useEffect(() => {
    const handleNotice = (event: Event) => {
      const payload = (event as CustomEvent<NoticePayload>).detail;
      if (!payload || typeof payload.message !== "string" || !payload.message.trim()) return;
      const kind: NoticeKind = payload.kind === "success" || payload.kind === "error" ? payload.kind : "info";
      const item = { id: ++nextIdRef.current, kind, message: payload.message.trim() };
      setNotice(item);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setNotice(current => current?.id === item.id ? null : current), kind === "error" ? 7000 : 4200);
    };
    window.addEventListener("app-global-notice", handleNotice);
    return () => {
      window.removeEventListener("app-global-notice", handleNotice);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!notice || typeof document === "undefined") return null;
  const style = palette[notice.kind];
  return createPortal(
    <div
      key={notice.id}
      role={notice.kind === "error" ? "alert" : "status"}
      aria-live={notice.kind === "error" ? "assertive" : "polite"}
      className="fixed z-[10000] flex items-start gap-3 rounded-2xl border bg-[var(--c-card,#fff)] px-4 py-3 text-[var(--c-text,#292722)] shadow-[0_12px_36px_rgba(0,0,0,.2)]"
      style={{ position: "fixed", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "min(420px, calc(100vw - 32px))", maxWidth: "calc(100vw - 32px)", boxSizing: "border-box", borderColor: style.border, animation: "globalNoticeIn 180ms cubic-bezier(.2,.8,.2,1) both" }}
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-sm font-bold text-white" style={{ background: style.border }}>{style.icon}</span>
      <div className="min-w-0 flex-1 text-sm leading-5 break-words">
        <div className="mb-0.5 font-semibold">{style.title}</div>
        {notice.message}
      </div>
      <button type="button" className="ml-1 grid h-6 w-6 shrink-0 place-items-center rounded-full text-lg leading-none opacity-60 hover:opacity-100" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>
      <style>{`@keyframes globalNoticeIn { from { opacity: 0; } to { opacity: 1; } }`}</style>
    </div>,
    document.body
  );
}
