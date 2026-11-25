"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, MessageCircle, RefreshCw, Trash2 } from "lucide-react";

import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
  getStandbyCharacterAsset,
  loadStandbyHomeConfig,
  normalizeSpriteScale,
  readFileAsDataUrl,
  requestStandbyNow,
  saveStandbyCharacterAsset,
  saveStandbyHomeConfig,
  STANDBY_REGENERATE_LINES_EVENT,
  type StandbyCharacterAsset,
  type StandbyHomeConfig,
} from "@/lib/standby-storage";
import {
  isStandbyBundleFresh,
  buildFallbackStandbyLines,
  loadStandbyLines,
  saveStandbyLines,
  STANDBY_LINES_PER_DAY,
  type StandbyLine,
} from "@/lib/standby-lines";
import { generateStandbyLinesForCharacter } from "@/lib/standby-lines-generator";

type StandbySettingsPageProps = {
  onNotice: (text: string) => void;
};

type AssetKind = "sprite" | "speakingSprite" | "background";

const ASSET_LABELS: Record<AssetKind, { saved: string; cleared: string }> = {
  sprite: { saved: "立绘已保存", cleared: "已清除立绘" },
  speakingSprite: { saved: "说话立绘已保存", cleared: "已清除说话立绘" },
  background: { saved: "背景已保存", cleared: "已清除背景" },
};

export function StandbySettingsPage({ onNotice }: StandbySettingsPageProps) {
  const [config, setConfig] = useState<StandbyHomeConfig>(() => loadStandbyHomeConfig());
  const [characters, setCharacters] = useState<Character[]>(() => loadCharacters());
  const [activeCharId, setActiveCharId] = useState<string | null>(null);
  const fileSpriteRef = useRef<HTMLInputElement>(null);
  const fileSpeakingRef = useRef<HTMLInputElement>(null);
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
    kind: AssetKind,
    activeId: string,
  ) => {
    if (!file || !activeId) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const next = saveStandbyCharacterAsset(activeId, { [kind]: dataUrl });
      setConfig(next);
      onNotice(ASSET_LABELS[kind].saved);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "读取图片失败");
    }
  }, [onNotice]);

  const clearAsset = (activeId: string, kind: AssetKind) => {
    const next = saveStandbyCharacterAsset(activeId, { [kind]: "" });
    setConfig(next);
    onNotice(ASSET_LABELS[kind].cleared);
  };

  // 立绘大小：拖动时只更新本地预览，松手才落盘，避免频繁写入大图配置
  const [scaleDraft, setScaleDraft] = useState(1);
  useEffect(() => {
    setScaleDraft(normalizeSpriteScale(activeAsset?.spriteScale));
  }, [activeAsset?.characterId, activeAsset?.spriteScale]);

  const commitScale = (activeId: string, value: number) => {
    const next = normalizeSpriteScale(value);
    const current = normalizeSpriteScale(getStandbyCharacterAsset(config, activeId).spriteScale);
    if (next === current) {
      setScaleDraft(next);
      return;
    }
    setConfig(saveStandbyCharacterAsset(activeId, { spriteScale: next }));
    onNotice(`立绘大小已设为 ${Math.round(next * 100)}%`);
  };

  const openFile = (kind: AssetKind) => {
    if (kind === "sprite") fileSpriteRef.current?.click();
    else if (kind === "speakingSprite") fileSpeakingRef.current?.click();
    else fileBgRef.current?.click();
  };

  const [regenBusy, setRegenBusy] = useState(false);
  const regenLines = async (char: Character) => {
    if (regenBusy) return;
    setRegenBusy(true);
    onNotice("正在生成今日台词…");
    try {
      const existing = (loadStandbyLines(char.id)?.lines ?? []).map(line => line.text);
      const generated = await generateStandbyLinesForCharacter(char, existing);
      const texts = generated && generated.length > 0
        ? generated
        : buildFallbackStandbyLines(char.name);
      saveStandbyLines(char.id, texts);
      // 待机首页正挂着时同步刷新
      window.dispatchEvent(new CustomEvent(STANDBY_REGENERATE_LINES_EVENT, {
        detail: { characterId: char.id },
      }));
      setConfig(loadStandbyHomeConfig());
      onNotice(generated ? "台词已刷新" : "已用本地台词兜底（未配置 API）");
    } catch {
      onNotice("台词刷新失败，请稍后再试");
    } finally {
      setRegenBusy(false);
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
                    <span
                      role="img"
                      aria-label={char.name}
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        backgroundImage: `url("${img}")`,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                        flexShrink: 0,
                      }}
                    />
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
          <div className="g-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div>
                <div className="ts-15 font-semibold text-[var(--c-text)]">立绘大小</div>
                <div className="ts-12 text-[var(--c-icon)]" style={{ marginTop: 2 }}>
                  觉得太大或太小都能调，待机首页底部也能快捷调整
                </div>
              </div>
              <button
                type="button"
                className="ui-btn ui-btn-ghost"
                onClick={() => commitScale(activeChar.id, 1)}
              >
                重置
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="ts-12 text-[var(--c-icon)]">50%</span>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={scaleDraft}
                aria-label="立绘大小"
                style={{ flex: 1, minWidth: 0, accentColor: "var(--c-accent, #7c98ff)" }}
                onChange={e => setScaleDraft(Number(e.target.value))}
                onPointerUp={e => commitScale(activeChar.id, Number(e.currentTarget.value))}
                onKeyUp={e => commitScale(activeChar.id, Number(e.currentTarget.value))}
                onBlur={e => commitScale(activeChar.id, Number(e.currentTarget.value))}
              />
              <span
                className="ts-12 text-[var(--c-text)]"
                style={{ minWidth: 42, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
              >
                {Math.round(scaleDraft * 100)}%
              </span>
            </div>
          </div>
          <AssetCard
            title={`${activeChar.name} 的说话立绘`}
            desc="点击立绘说话时临时切换（如害羞 / 张嘴差分），说完自动恢复"
            current={activeAsset.speakingSprite}
            placeholder="未上传（说话时沿用普通立绘）"
            onChoose={() => openFile("speakingSprite")}
            onClear={() => clearAsset(activeChar.id, "speakingSprite")}
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
              disabled={regenBusy}
              onClick={() => void regenLines(activeChar)}
            >
              <RefreshCw size={14} strokeWidth={1.8} className={regenBusy ? "spin" : ""} /> {regenBusy ? "生成中…" : "换一批"}
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
            ref={fileSpeakingRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => handleFile(e.target.files?.[0] ?? null, "speakingSprite", activeChar.id)}
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
