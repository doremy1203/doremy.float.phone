"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronUp, Delete, Lock } from "lucide-react";

import { type LockScreenConfig } from "@/lib/lock-screen-storage";

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function useCurrentTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const KEYPAD: Array<string | "clear" | "delete"> = [
  "1", "2", "3",
  "4", "5", "6",
  "7", "8", "9",
  "clear", "0", "delete",
];

type LockScreenProps = {
  config: LockScreenConfig;
  /** 锁屏显示时，若未设置专用壁纸，可回落到桌面壁纸样式 */
  fallbackBackground?: CSSProperties;
  onUnlock: () => void;
};

export function LockScreen({ config, fallbackBackground, onUnlock }: LockScreenProps) {
  const now = useCurrentTime();
  const hasPassword = config.password.length > 0;

  const [input, setInput] = useState("");
  const [error, setError] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const swipeStartY = useRef<number | null>(null);
  const unlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (unlockTimer.current) clearTimeout(unlockTimer.current);
  }, []);

  const triggerUnlock = useCallback(() => {
    if (unlocking) return;
    setUnlocking(true);
    unlockTimer.current = setTimeout(() => onUnlock(), 320);
  }, [onUnlock, unlocking]);

  const timeText = useMemo(() => `${pad2(now.getHours())}:${pad2(now.getMinutes())}`, [now]);
  const dateText = useMemo(
    () => `${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAYS[now.getDay()]}`,
    [now],
  );

  const handleDigit = useCallback((digit: string) => {
    if (unlocking || error) return;
    if (input.length >= config.password.length) return;
    const next = input + digit;
    setInput(next);
    if (next.length === config.password.length) {
      if (next === config.password) {
        triggerUnlock();
        return;
      }
      setError(true);
      window.setTimeout(() => {
        setInput("");
        setError(false);
      }, 420);
    }
  }, [config.password, error, input, triggerUnlock, unlocking]);

  const handleDelete = useCallback(() => {
    if (unlocking) return;
    setError(false);
    setInput(prev => prev.slice(0, -1));
  }, [unlocking]);

  const handleClear = useCallback(() => {
    if (unlocking) return;
    setError(false);
    setInput("");
  }, [unlocking]);

  const backgroundStyle: CSSProperties = config.wallpaper
    ? { backgroundImage: `url("${config.wallpaper}")`, backgroundSize: "cover", backgroundPosition: "center" }
    : fallbackBackground ?? {
        background: "linear-gradient(160deg, #1a2233 0%, #0b0f16 55%, #05070b 100%)",
      };

  return (
    <div
      className={`lock-screen${unlocking ? " is-unlocking" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="锁屏"
      onPointerDown={event => {
        if (!hasPassword) swipeStartY.current = event.clientY;
      }}
      onPointerUp={event => {
        if (hasPassword) return;
        const start = swipeStartY.current;
        swipeStartY.current = null;
        if (start !== null && start - event.clientY > 40) triggerUnlock();
      }}
    >
      <div className="lock-screen-bg" style={backgroundStyle} />
      <div className="lock-screen-scrim" />

      <div className="lock-screen-clock">
        <div className="lock-screen-lock-icon" aria-hidden="true">
          <Lock size={15} strokeWidth={1.9} />
        </div>
        <div className="lock-screen-time">{timeText}</div>
        <div className="lock-screen-date">{dateText}</div>
      </div>

      {hasPassword ? (
        <div className="lock-screen-password">
          <div className={`lock-screen-dots${error ? " is-error" : ""}`} aria-hidden="true">
            {Array.from({ length: config.password.length }).map((_, index) => (
              <span key={index} className={index < input.length ? "is-filled" : ""} />
            ))}
          </div>
          <p className="lock-screen-hint">{error ? "密码不正确" : "输入密码解锁"}</p>

          <div className="lock-screen-keypad" role="group" aria-label="数字键盘">
            {KEYPAD.map(key => {
              if (key === "clear") {
                return (
                  <button key={key} type="button" className="lock-key lock-key-ghost" onClick={handleClear} aria-label="清空">
                    清空
                  </button>
                );
              }
              if (key === "delete") {
                return (
                  <button key={key} type="button" className="lock-key lock-key-ghost" onClick={handleDelete} aria-label="删除">
                    <Delete size={22} strokeWidth={1.8} />
                  </button>
                );
              }
              return (
                <button
                  key={key}
                  type="button"
                  className="lock-key"
                  onClick={() => handleDigit(key)}
                  aria-label={key}
                >
                  {key}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <button type="button" className="lock-screen-swipe" onClick={triggerUnlock}>
          <ChevronUp size={20} strokeWidth={1.8} className="lock-screen-swipe-arrow" />
          <span>上滑解锁</span>
        </button>
      )}
    </div>
  );
}
