"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import "./verify.css";

const QUERY_CODE_KEY = "float_verify_query_code";

type StatusResult = {
  status: "pending" | "approved" | "rejected";
  activationCode: string | null;
  note: string | null;
};

export default function VerifyPage() {
  const [tab, setTab] = useState<"apply" | "check">("apply");
  const [contact, setContact] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [queryCode, setQueryCode] = useState("");
  const [checkCode, setCheckCode] = useState("");
  const [statusResult, setStatusResult] = useState<StatusResult | null>(null);
  const [copied, setCopied] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function copyText(text: string, key: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setCopied(key);
      setTimeout(() => setCopied(current => (current === key ? "" : current)), 1800);
    } catch {
      setError("复制失败，请长按手动复制。");
    }
  }

  useEffect(() => {
    document.title = "Float · 内测资格申请";
    try {
      const saved = window.localStorage.getItem(QUERY_CODE_KEY) || "";
      if (saved) {
        setCheckCode(saved);
        setTab("check");
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  function pickFile(picked: File | null) {
    setError("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (!picked) { setFile(null); setPreviewUrl(""); return; }
    if (!["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(picked.type)) {
      setError("只支持 JPG、PNG、WebP 图片。"); return;
    }
    if (picked.size > 4 * 1024 * 1024) {
      setError("图片过大，请压缩到 4MB 以内再上传。"); return;
    }
    setFile(picked);
    setPreviewUrl(URL.createObjectURL(picked));
  }

  async function submit() {
    if (busy) return;
    setError("");
    if (!contact.trim()) { setError("请填写小红书昵称。"); return; }
    if (!file) { setError("请上传一张证明图片。"); return; }
    setBusy(true);
    try {
      const formData = new FormData();
      formData.set("contact", contact.trim());
      formData.set("file", file);
      const response = await fetch("/api/verify/submit", { method: "POST", body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "提交失败，请稍后再试。");
      setQueryCode(data.queryCode);
      setCheckCode(data.queryCode);
      try { window.localStorage.setItem(QUERY_CODE_KEY, data.queryCode); } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败，请稍后再试。");
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    if (busy) return;
    setError("");
    setStatusResult(null);
    const code = checkCode.trim().toUpperCase();
    if (!code) { setError("请输入查询码。"); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/verify/status?code=${encodeURIComponent(code)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "查询失败，请稍后再试。");
      setStatusResult({ status: data.status, activationCode: data.activationCode, note: data.note });
      try { window.localStorage.setItem(QUERY_CODE_KEY, code); } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "查询失败，请稍后再试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="vr-root">
      <div className="vr-brand">Float</div>
      <div className="vr-brand-sub">内测资格申请 · Adult Verification</div>

      <section className="vr-card">
        <div className="vr-tabs">
          <button type="button" className={`vr-tab${tab === "apply" ? " on" : ""}`} onClick={() => { setTab("apply"); setError(""); }}>提交申请</button>
          <button type="button" className={`vr-tab${tab === "check" ? " on" : ""}`} onClick={() => { setTab("check"); setError(""); }}>查询进度</button>
        </div>

        {error ? <div className="vr-error">{error}</div> : null}

        {tab === "apply" ? (
          queryCode ? (
            <div>
              <div className="vr-code-box">
                <div className="vr-code-label">你的查询码 · 请务必保存</div>
                <div className="vr-code-value">{queryCode}</div>
                <button type="button" className="vr-copy-btn" onClick={() => copyText(queryCode, "query")}>
                  {copied === "query" ? "✓ 已复制" : "复制查询码"}
                </button>
              </div>
              <div className="vr-warn">
                ⚠️ 查询码是领取激活码的<b>唯一凭证</b>，请立即<b>复制并发给自己</b>（或截图保存）。
                忘记查询码将无法查到审核结果，只能重新提交申请。
              </div>
              <div className="vr-note">
                审核完成后，回到本页「查询进度」输入查询码即可领取激活码。
                查询码已自动保存在当前浏览器中，但换设备或清缓存后，只能靠你自己保存的找回。
              </div>
              <button type="button" className="vr-btn ghost" onClick={() => { setTab("check"); setStatusResult(null); }}>
                去查询进度
              </button>
            </div>
          ) : (
            <div>
              <div className="vr-note">
                为符合内容分级要求，本应用仅向成年人开放内测。请上传一张能证明你已成年的图片
                （如证件的出生日期部分）。<b>与年龄无关的信息（姓名、证件号、住址等）请遮挡</b>，
                审核完成后图片会立即删除，不做任何留存。
              </div>
              <label className="vr-field">
                <span>小红书昵称（便于审核时对上号）</span>
                <input
                  type="text"
                  value={contact}
                  onChange={event => setContact(event.target.value)}
                  placeholder="填你的小红书昵称"
                  maxLength={120}
                />
              </label>
              <div className="vr-field">
                <span>成年证明图片（JPG / PNG / WebP，≤ 4MB）</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  style={{ display: "none" }}
                  onChange={event => pickFile(event.target.files?.[0] ?? null)}
                />
                {previewUrl ? (
                  <img src={previewUrl} alt="预览" className="vr-preview" onClick={() => fileInputRef.current?.click()} />
                ) : (
                  <div className="vr-pick" onClick={() => fileInputRef.current?.click()}>
                    点击选择图片
                  </div>
                )}
              </div>
              <button type="button" className="vr-btn" disabled={busy} onClick={submit}>
                {busy ? "提交中…" : "提交申请"}
              </button>
            </div>
          )
        ) : (
          <div>
            <label className="vr-field">
              <span>查询码</span>
              <input
                type="text"
                value={checkCode}
                onChange={event => setCheckCode(event.target.value)}
                placeholder="VR-XXXXXXXX"
                maxLength={16}
              />
            </label>
            <button type="button" className="vr-btn" disabled={busy} onClick={check}>
              {busy ? "查询中…" : "查询"}
            </button>
            {statusResult ? (
              statusResult.status === "approved" ? (
                <div className="vr-status approved">
                  审核已通过 🎉
                  <div className="vr-code-box" style={{ margin: "12px 0 0" }}>
                    <div className="vr-code-label">你的激活码</div>
                    <div className="vr-code-value">{statusResult.activationCode}</div>
                    <button type="button" className="vr-copy-btn"
                      onClick={() => copyText(statusResult.activationCode || "", "activation")}>
                      {copied === "activation" ? "✓ 已复制" : "复制激活码"}
                    </button>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 12.5 }}>回到登录页，注册时填入即可。</div>
                </div>
              ) : statusResult.status === "rejected" ? (
                <div className="vr-status rejected">
                  申请未通过。
                  {statusResult.note ? <div style={{ marginTop: 6 }}>原因：{statusResult.note}</div> : null}
                  <div style={{ marginTop: 6, fontSize: 12.5 }}>如有疑问可在群里联系作者，或重新提交申请。</div>
                </div>
              ) : (
                <div className="vr-status pending">正在飞速审核中...</div>
              )
            ) : null}
          </div>
        )}
      </section>

      <Link className="vr-back" href="/">← 返回登录页</Link>
      <div className="vr-footer">FLOAT · LIMITED BETA</div>
    </main>
  );
}
