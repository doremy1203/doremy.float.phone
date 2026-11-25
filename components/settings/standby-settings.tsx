"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, MessageCircle, RefreshCw, Trash2 } from "lucide-react";

import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
  getStandbyCharacterAsset,
  loadStandbyHomeConfig,
  readFileAsDataUrl,
  requestStandbyNow,
  saveStandbyCharacterAsset,
  saveStandbyHomeConfig,
  type StandbyCharacterAsset,
  type StandbyHomeConfig,
} from "@/lib/standby-storage";
import {
  isStandbyBundleFresh,
  loadStandbyLines,
  STANDBY_LINES_PER_DAY,
  type StandbyLine,
} from "@/lib/standby-lines";

type StandbySettingsPageProps = {
  onNotice: (text: string) => void;
};

export function StandbySettingsPage({ onNotice }: StandbySettingsPageProps) {
  const [config, setConfig] = useState<StandbyHomeConfig>(() => loadStandbyHomeConfig());
  const [characters, setCharacters] = useState<Character[]>(() => loadCharacters());
  const [activeCharId, setActiveCharId] = useState<string | null>(null);
  const fileSpriteRef = useRef<HTMLInputElement>(null);
  const fileBgRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const sync = () => {
      setConfig(loadStandbyHomeConfig());
      setCharacters(loadCharacters());
    };
    window.addEventListener("ai-phone-standby-home-updated", sync);
    window.addEventListener("characters-updated", sync);
    return () => {
      window.removeEventListener("ai-phone-standby-home-updated", sync);
      window.removeEventListener("characters-updated", sync);
    };
  }, []);

  const activeChar = characters.find(c => c.id === activeCharId) ?? characters[0] ?? null;
  const activeAsset: StandbyCharacterAsset | null = activeChar
    ? getStandbyCharacterAsset(config, activeChar.id)
    : null;
  const activeBundle = activeChar ? loadStandbyLines(activeChar.id) : null;
  const lines = activeBundle?.lines ?? [];
  const linesFresh = activeChar ? isStandbyBundleFresh(activeBundle) : false;

  const onToggleLaunch = (showOnLaunch: boolean) => {
    const next = saveStandbyHomeConfig({ showOnLaunch });
    setConfig(next);
    onNotice(showOnLaunch ? "启动时进入待机首页" : "启动时直接进入桌面");
  };

  const handleFile = useCallback(async (
    file: File | null,
    kind: "sprite" | "background",
    activeId: string,
  ) => {
    if (!file || !activeId) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const next = saveStandbyCharacterAsset(activeId, { [kind]: dataUrl });
      setConfig(next);
      onNotice(kind === "sprite" ? "立绘已保存" : "背景已保存");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "读取图片失败");
    }
  }, [onNotice]);

  const clearAsset = (activeId: string, kind: "sprite" | "background") => {
    const next = saveStandbyCharacterAsset(activeId, { [kind]: "" });
    setConfig(next);
    onNotice(kind === "sprite" ? "已清除立绘" : "已清除背景");
  };

  const openFile = (kind: "sprite" | "background") => {
    if (kind === "sprite") fileSpriteRef.current?.click();
    else fileBgRef.current?.click();
  };

  const regenLines = async (char: Character) => {
    try {
      onNotice("生成中…");
      // 复用 standby-home 的兜底逻辑；有 LLM 的话可以通过 window 事件触发
      const evt = new CustomEvent("ai-phone-standby-regenerate-lines", {
        detail: { characterId: char.id },
      });
      window.dispatchEvent(evt);
      // 兜底：没监听到的话用本地
      await new Promise(resolve => setTimeout(resolve, 400));
      setConfig(loadStandbyHomeConfig());
      onNotice("台词已刷新");
    } catch {
      onNotice("台词刷新失败，请稍后再试");
    }
  };

  return (
    <div className="theme-section-page" data-bottom-reserve style={{ gap: 14 }}>
      {/* 启动开关 */}
      <div className="g-card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 12 }}>
        <div className="card-icon card-icon-glass">
          <MessageCircle size={20} strokeWidth={1.8} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ts-15 font-semibold text-[var(--c-text)]">App 启动进入待机首页</div>
          <div className="ts-12 text-[var(--c-icon)]" style={{ marginTop: 2 }}>
            开启后启动先看到角色立绘，上滑或点「和 ta 聊聊」进桌面 / 聊天室
          </div>
        </div>
        <Toggle checked={config.showOnLaunch} onChange={onToggleLaunch} />
      </div>

      {config.showOnLaunch && (
        <button
          type="button"
          className="ui-btn ui-btn-outline"
          style={{ alignSelf: "stretch" }}
          onClick={() => {
            onNotice("正在进入待机首页预览…");
            requestStandbyNow();
          }}
        >
          立即进入待机首页预览
        </button>
      )}

      {/* 角色切换 */}
      {characters.length > 1 && (
        <div className="g-card" style={{ padding: 14 }}>
          <div className="ts-12 text-[var(--c-icon)]" style={{ marginBottom: 10 }}>选择角色（左右滑动也能切换）</div>
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
            {characters.map(char => {
              const asset = getStandbyCharacterAsset(config, char.id);
              const isActive = (activeChar?.id ?? "") === char.id;
              const img = asset.sprite || char.avatar || "";
              return (
                <button
                  key={char.id}
                  type="button"
                  className="ui-btn"
                  onClick={() => setActiveCharId(char.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 12px",
                    borderRadius: 999,
                    border: isActive ? "1px solid var(--c-accent, #7c98ff)" : "1px solid var(--c-divider, #2c2f36)",
                    background: isActive ? "var(--c-accent-soft, rgba(124,152,255,0.12))" : "transparent",
                    color: "var(--c-text)",
                    fontSize: 13,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  {img ? (
                    <img src={img} alt="" style={{ width: 20, height: 20, borderRadius: "50%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ width: 20, height: 20, borderRadius: "50%", background: "rgba(255,255,255,0.08)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>
                      {char.name.slice(0, 1)}
                    </span>
                  )}
                  {char.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 素材上传 */}
      {activeChar && activeAsset && (
        <>
          <AssetCard
            title={`${activeChar.name} 的透明立绘`}
            desc="PNG 透明背景最佳；建议半身 / 全身，非立绘则使用头像兜底"
            current={activeAsset.sprite}
            placeholder="尚未上传立绘（待机首页会用头像兜底）"
            onChoose={() => openFile("sprite")}
            onClear={() => clearAsset(activeChar.id, "sprite")}
          />
          <AssetCard
            title={`${activeChar.name} 的待机背景`}
            desc="非立绘专用时可以留空，待机首页会回落到桌面壁纸"
            current={activeAsset.background}
            placeholder="未上传（回落到桌面壁纸）"
            onChoose={() => openFile("background")}
            onClear={() => clearAsset(activeChar.id, "background")}
          />
        </>
      )}

      {/* 台词管理 */}
      {activeChar && (
        <div className="g-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div className="ts-15 font-semibold text-[var(--c-text)]">今日待机台词（{lines.length}/{STANDBY_LINES_PER_DAY}）</div>
              <div className="ts-12 text-[var(--c-icon)]" style={{ marginTop: 2 }}>
                {linesFresh ? "今日已生成 · 每天凌晨自动刷新 5 条" : "今日还没生成 · 进入待机首页时会自动生成"}
              </div>
            </div>
            <button
              className="ui-btn ui-btn-ghost"
              onClick={() => regenLines(activeChar)}
            >
              <RefreshCw size={14} strokeWidth={1.8} /> 换一批
            </button>
          </div>

          {lines.length > 0 ? (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
              {lines.map((line: StandbyLine, idx: number) => (
                <li
                  key={line.id}
                  style={{
                    padding: "9px 12px",
                    borderRadius: 10,
                    background: "var(--c-list-item-bg, rgba(255,255,255,0.04))",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                  }}
                >
                  <span style={{ width: 20, height: 20, borderRadius: "50%", background: "rgba(255,255,255,0.08)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, flexShrink: 0, marginTop: 1 }}>
                    {idx + 1}
                  </span>
                  <span style={{ fontSize: 13, lineHeight: 1.55, color: "var(--c-text)" }}>{line.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="ts-12 text-[var(--c-icon)]">暂无台词，进入待机首页会自动生成。</div>
          )}
        </div>
      )}

      {!activeChar && (
        <div className="g-card" style={{ padding: 16, textAlign: "center" }}>
          <div className="ts-15 font-semibold text-[var(--c-text)]">还没有角色</div>
          <div className="ts-12 text-[var(--c-icon)]" style={{ marginTop: 4 }}>先在「角色」里创建角色，再来配置立绘和背景吧。</div>
        </div>
      )}

      {/* hidden input */}
      {activeChar && (
        <>
          <input
            ref={fileSpriteRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => handleFile(e.target.files?.[0] ?? null, "sprite", activeChar.id)}
          />
          <input
            ref={fileBgRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => handleFile(e.target.files?.[0] ?? null, "background", activeChar.id)}
          />
        </>
      )}

      <p className="ts-12 text-[var(--c-icon)]" style={{ padding: "0 4px", lineHeight: 1.7 }}>
        说明：点击立绘说话会随机抽取一条待机台词，「换一句」切换到下一句；每天凌晨自动刷新新一批。
      </p>
    </div>
  );
}

function AssetCard({
  title,
  desc,
  current,
  placeholder,
  onChoose,
  onClear,
}: {
  title: string;
  desc: string;
  current: string;
  placeholder: string;
  onChoose: () => void;
  onClear: () => void;
}) {
  return (
    <div className="g-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div className="ts-15 font-semibold text-[var(--c-text)]">{title}</div>
        <div className="ts-12 text-[var(--c-icon)]" style={{ marginTop: 2 }}>{desc}</div>
      </div>

      {current ? (
        <div
          role="img"
          aria-label={title}
          style={{
            width: "100%",
            aspectRatio: "9 / 16",
            maxHeight: 220,
            borderRadius: 12,
            backgroundImage: `url("${current}")`,
            backgroundSize: "contain",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            backgroundColor: "rgba(0,0,0,0.3)",
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            aspectRatio: "9 / 16",
            maxHeight: 220,
            borderRadius: 12,
            background: "var(--c-list-item-bg, rgba(255,255,255,0.04))",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--c-icon)",
            fontSize: 12,
          }}
        >
          {placeholder}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="ui-btn ui-btn-primary" onClick={onChoose}>
          <ImagePlus size={15} strokeWidth={1.8} /> 选择图片
        </button>
        {current && (
          <button type="button" className="ui-btn ui-btn-outline" onClick={onClear}>
            <Trash2 size={15} strokeWidth={1.8} /> 移除
          </button>
        )}
      </div>
    </div>
  );
}
