"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Lock, Trash2 } from "lucide-react";

import { Input, Toggle } from "@/components/ui/form";
import {
  LOCK_SCREEN_PASSWORD_MAX_LENGTH,
  loadLockScreenConfig,
  requestLockScreenNow,
  saveLockScreenConfig,
  type LockScreenConfig,
} from "@/lib/lock-screen-storage";

type LockScreenSettingsPageProps = {
  onNotice: (text: string) => void;
};

export function LockScreenSettingsPage({ onNotice }: LockScreenSettingsPageProps) {
  const [config, setConfig] = useState<LockScreenConfig>(() => loadLockScreenConfig());
  const [editingPassword, setEditingPassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setConfig(loadLockScreenConfig());
  }, []);

  const update = (patch: Partial<LockScreenConfig>) => {
    const next = saveLockScreenConfig(patch);
    setConfig(next);
    return next;
  };

  const handleToggle = (enabled: boolean) => {
    update({ enabled });
    onNotice(enabled ? "锁屏已开启" : "锁屏已关闭");
  };

  const startEditPassword = () => {
    setPasswordDraft("");
    setEditingPassword(true);
  };

  const savePassword = () => {
    if (passwordDraft.length < 4) {
      onNotice("密码至少 4 位数字");
      return;
    }
    update({ password: passwordDraft });
    setEditingPassword(false);
    setPasswordDraft("");
    onNotice("锁屏密码已保存");
  };

  const clearPassword = () => {
    update({ password: "" });
    setEditingPassword(false);
    setPasswordDraft("");
    onNotice("已清除锁屏密码，上滑即可解锁");
  };

  const handleWallpaperFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onNotice("请选择图片文件");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      onNotice("图片过大，请选择 12MB 以内的图片");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      update({ wallpaper: reader.result });
      onNotice("锁屏壁纸已更新");
    };
    reader.onerror = () => onNotice("读取图片失败，请重试");
    reader.readAsDataURL(file);
  };

  return (
    <div className="theme-section-page" data-bottom-reserve style={{ gap: 14 }}>
      <div className="g-card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 12 }}>
        <span className="card-icon card-icon-glass"><Lock size={20} strokeWidth={1.8} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ts-15 font-semibold text-[var(--c-text)]">启用锁屏</div>
          <div className="ts-12 text-[var(--c-icon)]" style={{ marginTop: 2 }}>
            进入应用或回到前台时显示锁屏
          </div>
        </div>
        <Toggle checked={config.enabled} onChange={handleToggle} />
      </div>

      {config.enabled && (
        <button
          type="button"
          className="ui-btn ui-btn-outline"
          style={{ alignSelf: "stretch" }}
          onClick={() => {
            onNotice("正在锁屏预览…");
            requestLockScreenNow();
          }}
        >
          立即锁屏预览
        </button>
      )}

      <div className="g-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div className="ts-15 font-semibold text-[var(--c-text)]">锁屏密码</div>
            <div className="ts-12 text-[var(--c-icon)]" style={{ marginTop: 2 }}>
              {config.password ? "已设置密码，解锁需输入数字密码" : "未设置密码，上滑即可解锁"}
            </div>
          </div>
          {!editingPassword && (
            <button
              type="button"
              className="ui-btn ui-btn-ghost"
              onClick={startEditPassword}
            >
              {config.password ? "修改" : "设置"}
            </button>
          )}
        </div>

        {editingPassword && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={passwordDraft}
              onChange={event =>
                setPasswordDraft(event.target.value.replace(/\D/g, "").slice(0, LOCK_SCREEN_PASSWORD_MAX_LENGTH))
              }
              placeholder={`输入 4-${LOCK_SCREEN_PASSWORD_MAX_LENGTH} 位数字`}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="ui-btn ui-btn-primary" onClick={savePassword}>保存密码</button>
              <button
                type="button"
                className="ui-btn ui-btn-outline"
                onClick={() => {
                  setEditingPassword(false);
                  setPasswordDraft("");
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}

        {config.password && !editingPassword && (
          <button type="button" className="ui-btn ui-btn-ghost" style={{ alignSelf: "flex-start" }} onClick={clearPassword}>
            清除密码
          </button>
        )}
      </div>

      <div className="g-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div className="ts-15 font-semibold text-[var(--c-text)]">锁屏壁纸</div>
          <div className="ts-12 text-[var(--c-icon)]" style={{ marginTop: 2 }}>
            {config.wallpaper ? "已设置自定义锁屏壁纸" : "未设置，将使用默认渐变背景"}
          </div>
        </div>

        {config.wallpaper && (
          <div
            role="img"
            aria-label="锁屏壁纸预览"
            style={{
              width: "100%",
              aspectRatio: "9 / 16",
              maxHeight: 260,
              borderRadius: 14,
              backgroundImage: `url("${config.wallpaper}")`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              backgroundColor: "var(--c-page-body-bg)",
            }}
          />
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => fileRef.current?.click()}>
            <ImagePlus size={15} strokeWidth={1.8} /> 选择壁纸
          </button>
          {config.wallpaper && (
            <button
              type="button"
              className="ui-btn ui-btn-outline"
              onClick={() => {
                update({ wallpaper: "" });
                onNotice("已移除锁屏壁纸");
              }}
            >
              <Trash2 size={15} strokeWidth={1.8} /> 移除
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleWallpaperFile} />
      </div>

      <p className="ts-12 text-[var(--c-icon)]" style={{ padding: "0 4px", lineHeight: 1.7 }}>
        提示：锁屏会遮挡整个虚拟手机，包括状态栏和应用内容。忘记密码时可回到这里清除密码。
      </p>
    </div>
  );
}
