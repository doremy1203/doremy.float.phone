"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronUp, Home, MessageCircle, Settings, RefreshCw, FileText, X, Maximize2 } from "lucide-react";

import type { Character } from "@/lib/character-types";
import {
  getStandbyCharacterAsset,
  loadStandbyHomeConfig,
  normalizeSpriteScale,
  saveStandbyCharacterAsset,
  type StandbyHomeConfig,
} from "@/lib/standby-storage";
import {
  buildFallbackStandbyLines,
  isStandbyBundleFresh,
  loadStandbyLines,
  pickRandomLine,
  saveStandbyLines,
  STANDBY_LINES_PER_DAY,
  todayIsoDate,
  type StandbyLine,
} from "@/lib/standby-lines";
import { generateStandbyLinesForCharacter } from "@/lib/standby-lines-generator";
import { STANDBY_REGENERATE_LINES_EVENT } from "@/lib/standby-storage";

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function useCurrentTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

type GestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  startTime: number;
  moved: boolean;
};

export type StandbyHomeProps = {
  /** 当前已安装角色（用于左右滑动切换） */
  characters: Character[];
  /** 当前展示的角色 id（空 → 默认第一个） */
  characterId?: string;
  /** 兜底背景样式（当角色无背景时回落到桌面壁纸） */
  fallbackBackground?: CSSProperties;
  /** 进入聊天室按钮 */
  onEnterChat?: (characterId: string) => void;
  /** 上滑 / 返回桌面 */
  onExitHome?: () => void;
  /** 打开设置 */
  onOpenSettings?: () => void;
  /** 角色切换 */
  onCharacterChange?: (characterId: string) => void;
};

export function StandbyHome({
  characters,
  characterId,
  fallbackBackground,
  onEnterChat,
  onExitHome,
  onOpenSettings,
  onCharacterChange,
}: StandbyHomeProps) {
  const now = useCurrentTime();
  const [config, setConfig] = useState<StandbyHomeConfig>(() => loadStandbyHomeConfig());
  const [lines, setLines] = useState<StandbyLine[]>([]);
  const [lineLoading, setLineLoading] = useState(false);
  const [currentLine, setCurrentLine] = useState<StandbyLine | null>(null);
  const [showLinesPanel, setShowLinesPanel] = useState(false);
  const [showScalePanel, setShowScalePanel] = useState(false);
  // 立绘大小拖动草稿（松手才落盘，避免频繁重写体积很大的立绘配置）
  const [scaleDraft, setScaleDraft] = useState<{ characterId: string; value: number } | null>(null);

  const validCharacters = useMemo(
    () => characters.filter(c => !!c.id && !!c.name),
    [characters],
  );

  const resolvedCharacter = useMemo(() => {
    if (characterId) {
      const found = validCharacters.find(c => c.id === characterId);
      if (found) return found;
    }
    if (config.lastCharacterId) {
      const found = validCharacters.find(c => c.id === config.lastCharacterId);
      if (found) return found;
    }
    return validCharacters[0] ?? null;
  }, [characterId, validCharacters, config.lastCharacterId]);

  const asset = useMemo(
    () => (resolvedCharacter ? getStandbyCharacterAsset(config, resolvedCharacter.id) : null),
    [config, resolvedCharacter],
  );

  // 监听配置变更
  useEffect(() => {
    const sync = () => setConfig(loadStandbyHomeConfig());
    const evt = "ai-phone-standby-home-updated";
    window.addEventListener(evt, sync);
    return () => window.removeEventListener(evt, sync);
  }, []);

  const refreshLines = useCallback(
    async (character: Character, existingFallback: StandbyLine[]) => {
      setLineLoading(true);
      try {
        // 优先调用户配置的 API；不可用时退回本地兜底台词
        const generated = await generateStandbyLinesForCharacter(
          character,
          existingFallback.map(line => line.text),
        );
        const texts = generated && generated.length > 0
          ? generated
          : buildFallbackStandbyLines(character.name);
        const saved = saveStandbyLines(character.id, texts);
        setLines(saved.lines);
        setCurrentLine(null);
      } catch {
        const saved = saveStandbyLines(character.id, buildFallbackStandbyLines(character.name));
        setLines(saved.lines);
      } finally {
        setLineLoading(false);
      }
    },
    [],
  );

  // 每次换角色 / 切天：当天没生成过就刷新一批
  useEffect(() => {
    if (!resolvedCharacter) return;
    const bundle = loadStandbyLines(resolvedCharacter.id);
    if (bundle && isStandbyBundleFresh(bundle) && bundle.lines.length > 0) {
      setLines(bundle.lines);
      return;
    }
    void refreshLines(resolvedCharacter, bundle?.lines ?? []);
  }, [resolvedCharacter, refreshLines]);

  // 设置页点「换一批」时，如果待机首页正挂着，同步刷新
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ characterId?: string }>).detail;
      if (!detail?.characterId || !resolvedCharacter) return;
      if (detail.characterId !== resolvedCharacter.id) return;
      void refreshLines(resolvedCharacter, lines);
    };
    window.addEventListener(STANDBY_REGENERATE_LINES_EVENT, handler);
    return () => window.removeEventListener(STANDBY_REGENERATE_LINES_EVENT, handler);
  }, [resolvedCharacter, lines, refreshLines]);

  // ---- 切换角色 ----
  const characterIndex = validCharacters.findIndex(c => c.id === resolvedCharacter?.id);
  const prevCharacter = useMemo(
    () => (validCharacters.length > 0
      ? validCharacters[(characterIndex - 1 + validCharacters.length) % validCharacters.length]
      : null),
    [validCharacters, characterIndex],
  );
  const nextCharacter = useMemo(
    () => (validCharacters.length > 0
      ? validCharacters[(characterIndex + 1) % validCharacters.length]
      : null),
    [validCharacters, characterIndex],
  );

  const goPrev = useCallback(() => {
    if (prevCharacter) onCharacterChange?.(prevCharacter.id);
  }, [prevCharacter, onCharacterChange]);

  const goNext = useCallback(() => {
    if (nextCharacter) onCharacterChange?.(nextCharacter.id);
  }, [nextCharacter, onCharacterChange]);

  // ---- 手势 ----
  const gestureRef = useRef<GestureState | null>(null);
  const [swipeHint, setSwipeHint] = useState<{ dir: "up" | "left" | "right"; progress: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    gestureRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startTime: performance.now(),
      moved: false,
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (!g.moved && Math.max(absX, absY) > 8) g.moved = true;
    if (!g.moved) return;

    if (absX > absY && absX > 20) {
      const dir = dx > 0 ? "right" : "left";
      setSwipeHint({ dir, progress: Math.min(1, absX / 120) });
    } else if (absY > absX && absY > 20 && dy < 0) {
      setSwipeHint({ dir: "up", progress: Math.min(1, absY / 140) });
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    setSwipeHint(null);
    if (!g || !g.moved) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const distance = Math.max(absX, absY);
    if (distance < 50) return;
    if (absX > absY) {
      if (dx < 0) goNext();
      else goPrev();
    } else {
      if (dy < 0) onExitHome?.();
    }
  }, [goNext, goPrev, onExitHome]);

  // ---- 时间显示 ----
  const timeText = useMemo(() => `${pad2(now.getHours())}:${pad2(now.getMinutes())}`, [now]);
  const dateText = useMemo(
    () => `${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAYS[now.getDay()]}`,
    [now],
  );

  if (!resolvedCharacter) {
    return (
      <div className="standby-empty" style={fallbackBackground}>
        <div className="standby-empty-copy">
          <h2>还没有角色</h2>
          <p>先在「角色」里创建一个角色吧。</p>
          <button className="ui-btn ui-btn-primary" onClick={onExitHome}>返回桌面</button>
        </div>
      </div>
    );
  }

  const bgStyle: CSSProperties = asset?.background
    ? { backgroundImage: `url("${asset.background}")`, backgroundSize: "cover", backgroundPosition: "center" }
    : fallbackBackground ?? {
        background: "linear-gradient(160deg, #0f1420 0%, #05070b 100%)",
      };

  const spriteUrl = asset?.sprite || resolvedCharacter.avatar || "";
  // 说话时优先用配套立绘（如害羞差分），没有就沿用普通立绘
  const displaySprite = (currentLine && asset?.speakingSprite) ? asset.speakingSprite : spriteUrl;
  // 立绘缩放倍率（可在设置页或待机首页快捷按钮调整）
  const spriteScale = normalizeSpriteScale(
    scaleDraft && scaleDraft.characterId === resolvedCharacter.id
      ? scaleDraft.value
      : asset?.spriteScale,
  );
  const commitSpriteScale = (value: number) => {
    const next = normalizeSpriteScale(value);
    if (next === normalizeSpriteScale(asset?.spriteScale)) {
      setScaleDraft(null);
      return;
    }
    setConfig(saveStandbyCharacterAsset(resolvedCharacter.id, { spriteScale: next }));
    setScaleDraft(null);
  };

  return (
    <div
      className="standby-home"
      role="dialog"
      aria-modal="true"
      aria-label="待机首页"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="standby-home-bg" style={bgStyle} />
      <div className="standby-home-scrim" />

      {/* 顶部：时间 + 按钮 */}
      <header className="standby-home-top">
        <button className="standby-home-icon-btn" onClick={onExitHome} aria-label="返回桌面">
          <Home size={18} strokeWidth={1.8} />
          <span>首页</span>
        </button>
        <div className="standby-home-clock">
          <div className="standby-home-time">{timeText}</div>
          <div className="standby-home-date">{dateText}</div>
        </div>
        <button className="standby-home-icon-btn" onClick={onOpenSettings} aria-label="设置">
          <Settings size={18} strokeWidth={1.8} />
        </button>
      </header>

      {/* 中央：立绘 + 名字 */}
      <div className="standby-home-stage">
        {prevCharacter && (
          <button
            className="standby-home-nav standby-home-prev"
            onClick={goPrev}
            aria-label={`上一个角色：${prevCharacter.name}`}
            tabIndex={-1}
          >
            <span className="standby-home-nav-name">{prevCharacter.name}</span>
          </button>
        )}

        <figure className="standby-home-character" onClick={() => {
          if (lineLoading) return;
          const pick = pickRandomLine({ characterId: resolvedCharacter.id, date: todayIsoDate(), lines, updatedAt: "" });
          setCurrentLine(pick);
        }}>
          {displaySprite ? (
            <div
              className="standby-home-sprite-frame"
              style={{ "--standby-sprite-scale": String(spriteScale) } as CSSProperties}
            >
              <div
                role="img"
                aria-label={resolvedCharacter.name}
                className={`standby-home-sprite${currentLine ? " is-speaking" : ""}`}
                style={{ backgroundImage: `url("${displaySprite}")` }}
              />
            </div>
          ) : (
            <div className="standby-home-sprite-fallback" aria-hidden="true">
              {resolvedCharacter.name.slice(0, 1)}
            </div>
          )}
          <figcaption>
            <div className="standby-home-char-name">{resolvedCharacter.name}</div>
            <div className="standby-home-char-meta">在你身边</div>
          </figcaption>
        </figure>

        {nextCharacter && (
          <button
            className="standby-home-nav standby-home-next"
            onClick={goNext}
            aria-label={`下一个角色：${nextCharacter.name}`}
            tabIndex={-1}
          >
            <span className="standby-home-nav-name">{nextCharacter.name}</span>
          </button>
        )}
      </div>

      {/* 台词气泡 */}
      {currentLine && (
        <div className="standby-home-line-bubble" role="status">
          <p className="standby-home-line-text">{currentLine.text}</p>
          <div className="standby-home-line-actions">
            <button
              className="standby-home-line-btn"
              onClick={() => setShowLinesPanel(v => !v)}
            >
              <FileText size={14} strokeWidth={1.8} /> 台词
            </button>
            <button
              className="standby-home-line-btn"
              onClick={() => {
                const pick = pickRandomLine({ characterId: resolvedCharacter.id, date: todayIsoDate(), lines, updatedAt: "" });
                if (pick) setCurrentLine(pick);
              }}
            >
              <RefreshCw size={14} strokeWidth={1.8} /> 换一句
            </button>
            <button
              className="standby-home-line-btn"
              onClick={() => setCurrentLine(null)}
            >
              <X size={14} strokeWidth={1.8} /> 收起
            </button>
          </div>
        </div>
      )}

      {/* 台词列表抽屉 */}
      {showLinesPanel && (
        <div className="standby-home-lines-panel" role="dialog" aria-label="今日台词">
          <div className="standby-home-lines-header">
            <span>今日台词（{lines.length}/{STANDBY_LINES_PER_DAY}）</span>
            <button
              className="standby-home-refresh-btn"
              disabled={lineLoading}
              onClick={() => void refreshLines(resolvedCharacter, lines)}
            >
              <RefreshCw size={14} className={lineLoading ? "spin" : ""} />
              {lineLoading ? "生成中…" : "换一批"}
            </button>
          </div>
          <ul>
            {lines.map(line => (
              <li
                key={line.id}
                className={currentLine?.id === line.id ? "is-current" : ""}
                onClick={() => setCurrentLine(line)}
              >
                {line.text}
              </li>
            ))}
            {lines.length === 0 && (
              <li className="is-empty">暂无台词，点上面「换一批」生成</li>
            )}
          </ul>
        </div>
      )}

      {/* 底部：上滑提示 + 和 ta 聊聊 + 手势提示 */}
      <footer className="standby-home-bottom">
        {showScalePanel && (
          <div
            className="standby-home-scale-panel"
            role="dialog"
            aria-label="立绘大小"
            onPointerDown={e => e.stopPropagation()}
            onPointerMove={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
          >
            <span className="standby-home-scale-label">立绘大小</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={spriteScale}
              aria-label="立绘大小"
              onChange={e => setScaleDraft({
                characterId: resolvedCharacter.id,
                value: Number(e.target.value),
              })}
              onPointerUp={e => commitSpriteScale(Number(e.currentTarget.value))}
              onKeyUp={e => commitSpriteScale(Number(e.currentTarget.value))}
              onBlur={e => commitSpriteScale(Number(e.currentTarget.value))}
            />
            <span className="standby-home-scale-value">{Math.round(spriteScale * 100)}%</span>
            <button
              type="button"
              className="standby-home-scale-reset"
              onClick={() => commitSpriteScale(1)}
            >
              重置
            </button>
          </div>
        )}
        <div className="standby-home-hint">
          轻点立绘说话 · 左右滑动换人 · 空白处上滑回桌面
        </div>
        <div className="standby-home-actions">
          <button className="standby-home-chat-btn" onClick={() => onEnterChat?.(resolvedCharacter.id)}>
            <MessageCircle size={16} strokeWidth={1.8} /> 和 ta 聊聊
          </button>
          <button
            className="standby-home-desktop-btn"
            onClick={() => setShowScalePanel(v => !v)}
            aria-label="调整立绘大小"
            aria-expanded={showScalePanel}
          >
            <Maximize2 size={16} strokeWidth={1.8} />
          </button>
          <button className="standby-home-desktop-btn" onClick={onExitHome} aria-label="上滑进入桌面">
            <ChevronUp size={16} strokeWidth={1.8} />
          </button>
        </div>
      </footer>

      {/* 手势视觉反馈 */}
      {swipeHint && (
        <div className={`standby-swipe-hint standby-swipe-${swipeHint.dir}`} style={{ opacity: swipeHint.progress }}>
          {swipeHint.dir === "up" ? (
            <>
              <ChevronUp size={18} />
              <span>进桌面</span>
            </>
          ) : (
            <>
              <span>{swipeHint.dir === "left" ? "下一位 →" : "← 上一位"}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
