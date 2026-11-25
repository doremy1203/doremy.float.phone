"use client";

// 主动查岗设置：**每个角色各一套**开关与节奏，嵌在「截屏」设置页里。
//
// 为什么按角色而不是一个全局开关：查岗是「TA 想看看你在干嘛」，
// 这件事的合适程度完全取决于你和这个角色的关系——黏人的那位想半小时看一次，
// 正经的那位一天一次都嫌多。一个总开关只能逼你二选一。
//
// 三条硬边界写在界面上，用户才知道自己给了什么：
//  ① 每次都会弹浮层让你过目，你点「给它看」才发得出去；
//  ② 你点「不给」，那张图当场丢弃，从未离开这台设备；
//  ③ 默认关闭，且只对开了的角色生效。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, Loader2, ShieldAlert } from "lucide-react";

import { Toggle, Textarea } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import {
  checkInReadiness,
  disableAllCheckIn,
  loadCheckInConfig,
  prepareCheckInService,
  readCheckInDiagnostics,
  readCheckInScheduleSnapshot,
  resetCheckInRuntime,
  runCheckIn,
  saveCharacterCheckIn,
  stopCheckInService,
  type CheckInConfigMap,
  type CheckInScheduleSnapshot,
  loadCheckInGuidance,
  saveCheckInGuidance,
  type CheckInGuidance,
} from "@/lib/screenshot";
import { isShellEnvironment as isShell } from "@/lib/shell-call-overlay";

/** 每日上限与间隔的允许范围，与 lib/screenshot/checkin-config.ts 里的钳制保持一致。 */
const MIN_ALLOWED = 5;
const MAX_ALLOWED = 720;
const DAILY_ALLOWED = 20;

/**
 * 用一句人话回答「下一次什么时候会查」。
 *
 * 这是查岗最常被问、也最没法自己算出来的问题：间隔是**随机**的，
 * 用户设了 30~90 分钟，就没法从「上次是几点」推出「下次是几点」。
 * 与其让他对着两个数字发愣，不如直接把剩余时间算给他。
 */
function describeSchedule(s: CheckInScheduleSnapshot): string {
  if (!s.enabled) return "这个角色没开查岗";
  if (s.dailyReached) return `今天已经查过 ${s.countToday} 次，到上限了，明天恢复`;
  if (s.lastFiredAt <= 0) {
    return s.triggerMode === "background"
      ? "首次进入后台后开始累计随机间隔"
      : "首次启用后开始累计随机间隔";
  }
  if (s.due) return `已到点，等待下一次有效扫描（上次是 ${s.minutesSinceLast} 分钟前）`;
  return s.triggerMode === "background"
    ? "只累计 App 真正处于后台的时间"
    : "按实际经过时间等待下一次查岗";
}

export function CheckInSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [configs, setConfigs] = useState<CheckInConfigMap>(() => loadCheckInConfig());
  const [busyId, setBusyId] = useState<string | null>(null);
  // 原生那侧的实时状态（服务在不在跑、窗口挂上没）。跟着 refresh 一起更新，
  // 用户从系统设置授完权回来就能看到「常驻服务」那一行变绿。
  const [diag, setDiag] = useState(() => readCheckInDiagnostics());
  // 反应指导语：查岗出结果后，额外告诉角色「这一刻该怎么回应」。
  // 全局一份（不分角色）——它是「这类事该怎么处理」的口径，不是某个角色的性格。
  const [guidance, setGuidance] = useState<CheckInGuidance>(() => loadCheckInGuidance());

  const characters = useMemo(() => loadCharacters(), []);
  const inShell = useMemo(() => isShell(), []);
  const readiness = checkInReadiness();

  const refresh = useCallback(() => {
    setConfigs(loadCheckInConfig());
    setDiag(readCheckInDiagnostics());
    setGuidance(loadCheckInGuidance());
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("check-in-config-changed", onChange);
    document.addEventListener("visibilitychange", onChange);
    return () => {
      window.removeEventListener("check-in-config-changed", onChange);
      document.removeEventListener("visibilitychange", onChange);
    };
  }, [refresh]);

  const anyEnabled = Object.values(configs).some(item => item.enabled);

  const toggle = useCallback((characterId: string, on: boolean) => {
    saveCharacterCheckIn(characterId, { enabled: on });
    refresh();
    if (!on) {
      // 关到最后一个时把常驻服务也收掉，不留一个空跑的前台服务
      if (!Object.values(loadCheckInConfig()).some(item => item.enabled)) stopCheckInService();
      return;
    }
    if (!inShell) { onNotice?.("当前不在小手机 App 内，查岗需要安卓壳"); return; }
    if (!readiness.supported) { onNotice?.("系统版本太低，查岗需要 Android 11 及以上"); return; }
    if (!readiness.accessibilityOn) { onNotice?.("还需要开启无障碍服务，查岗才能截到屏"); return; }
    // 开启时把服务暖起来（此刻 App 在前台，是唯一能合法启动前台服务的时机）
    if (!prepareCheckInService()) {
      onNotice?.("没能准备查岗浮层，请先授予「显示在其他应用上层」权限");
      return;
    }
    onNotice?.("查岗已开启。到点它会截屏，但会先弹窗问你要不要给它看");
  }, [refresh, inShell, readiness.supported, readiness.accessibilityOn, onNotice]);

  const patch = useCallback((characterId: string, next: { triggerMode?: "background" | "any"; minMinutes?: number; maxMinutes?: number; dailyLimit?: number }) => {
    saveCharacterCheckIn(characterId, next);
    refresh();
  }, [refresh]);

  const doTest = useCallback(async (characterId: string) => {
    if (busyId) return;
    setBusyId(characterId);
    try {
      const result = await runCheckIn(characterId, loadCheckInConfig()[characterId]);
      if (!result.ok) {
        onNotice?.(result.reason);
      } else if (result.accepted) {
        onNotice?.("已发给它，等它的回应");
      } else if (result.reason === "user_rejected") {
        onNotice?.("你选了不给——那张图已经丢弃");
      } else {
        onNotice?.("这次没能截图（已如实告诉它）");
      }
      refresh();
    } finally {
      setBusyId(null);
    }
  }, [busyId, onNotice, refresh]);

  const disableAll = useCallback(() => {
    disableAllCheckIn();
    stopCheckInService();
    refresh();
    onNotice?.("已关闭全部查岗");
  }, [refresh, onNotice]);

  return (
    <div>
      <div className="settings-menu-section-title">主动查岗</div>

      <div className="per-note is-warn" style={{ padding: "0 var(--ui-padding, 16px)", marginBottom: 10 }}>
        <div style={{ fontWeight: 600 }}>它会先截屏给你看，你点头才发给它</div>
        <div style={{ marginTop: 6, lineHeight: 1.65 }}>
          到点截屏 → 弹浮层问你 → 你点了才发。点「不给」当场丢弃，图没离开过本机。
        </div>
      </div>

      {!inShell && (
        <div className="per-note is-warn" style={{ padding: "0 var(--ui-padding, 16px)", marginBottom: 10 }}>
          当前不在小手机 App 内（浏览器/PWA）。查岗需要安卓壳，这里只能预览界面。
        </div>
      )}

      {characters.length === 0 ? (
        <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
          还没有角色。先创建角色，再回来给 TA 开启查岗。
        </div>
      ) : (
        <div className="page-menu" style={{ gap: 12 }}>
          {characters.map(character => {
            const config = configs[character.id];
            const enabled = config?.enabled === true;
            const min = config?.minMinutes ?? 30;
            const max = config?.maxMinutes ?? 90;
            const limit = config?.dailyLimit ?? 3;
            // 链路快照：即便没开启也给一份（「没开」本身就是要展示的状态）
            const snapshot = readCheckInScheduleSnapshot(character.id, config ?? {
              enabled: false,
              triggerMode: "background",
              minMinutes: 30,
              maxMinutes: 90,
              dailyLimit: 3,
            });
            return (
              <div className="menu-group" key={character.id}>
                <div className="menu-item" style={{ cursor: "default" }}>
                  <div className="menu-label-group">
                    <span className="menu-label">{character.name}</span>
                    <span className="menu-desc">
                      {enabled ? `每 ${min}~${max} 分钟一次，每天最多 ${limit} 次 · ${config?.triggerMode === "any" ? "前后台均可" : "仅后台"}` : "未开启"}
                    </span>
                    {enabled ? (
                      <span className="menu-desc" style={{ color: "var(--per-accent, #6f5bd6)" }}>
                        {describeSchedule(snapshot)} · 今天已查 {snapshot.countToday} 次
                      </span>
                    ) : null}
                  </div>
                  <Toggle checked={enabled} onChange={(v: boolean) => toggle(character.id, v)} />
                </div>

                {enabled && (
                  <>
                    <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                      <div className="menu-label-group">
                        <span className="menu-label">触发场景</span>
                        <span className="menu-desc">默认仅后台；前台正在和该角色私聊时始终暂缓</span>
                      </div>
                      <select
                        className="per-field-input"
                        aria-label="查岗触发场景"
                        value={config?.triggerMode ?? "background"}
                        onChange={e => patch(character.id, { triggerMode: e.target.value === "any" ? "any" : "background" })}
                      >
                        <option value="background">仅后台触发</option>
                        <option value="any">不限制前后台</option>
                      </select>
                    </div>

                    {/* 间隔：两个直接输入的分钟数，不再给固定档位——
                        「我要 47 分钟」这种需求给按钮满足不了。 */}
                    <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                      <div className="menu-label-group">
                        <span className="menu-label">间隔（分钟）</span>
                        <span className="menu-desc">
                          在这个范围里随机取，不做固定节拍
                        </span>
                      </div>
                      <div className="menu-right" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          className="per-field-input"
                          style={{ width: 62 }}
                          type="number"
                          inputMode="numeric"
                          min={MIN_ALLOWED}
                          max={MAX_ALLOWED}
                          value={min}
                          aria-label="间隔下限（分钟）"
                          onChange={e => patch(character.id, { minMinutes: Number(e.target.value) })}
                        />
                        <span className="menu-desc">~</span>
                        <input
                          className="per-field-input"
                          style={{ width: 62 }}
                          type="number"
                          inputMode="numeric"
                          min={MIN_ALLOWED}
                          max={MAX_ALLOWED}
                          value={max}
                          aria-label="间隔上限（分钟）"
                          onChange={e => patch(character.id, { maxMinutes: Number(e.target.value) })}
                        />
                      </div>
                    </div>

                    <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                      <div className="menu-label-group">
                        <span className="menu-label">每天最多（次）</span>
                        <span className="menu-desc">到上限就停，不会没完没了</span>
                      </div>
                      <input
                        className="per-field-input"
                        style={{ width: 62 }}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={DAILY_ALLOWED}
                        value={limit}
                        aria-label="每天最多查岗次数"
                        onChange={e => patch(character.id, { dailyLimit: Number(e.target.value) })}
                      />
                    </div>

                    <div className="menu-item" style={{ cursor: "default" }}>
                      <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                        <Eye size={17} strokeWidth={1.8} />
                      </div>
                      <div className="menu-label-group">
                        <span className="menu-label">现在试一次</span>
                        <span className="menu-desc">立刻走一遍完整流程：截屏 → 弹浮层 → 你决定</span>
                      </div>
                      <button
                        type="button"
                        className="ui-btn ui-btn-outline"
                        disabled={busyId !== null}
                        onClick={() => void doTest(character.id)}
                      >
                        {busyId === character.id ? <Loader2 size={16} className="animate-spin" /> : "试一次"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── 反应指导语 ──
          查岗出结果后，角色具体该怎么反应原先完全靠人设自由发挥。
          这里给四类结果各留一句话，填了就随那次回应一起交给它，
          留空则维持原样。刻意不做成必填或给默认模板：多数人不填就挺好。 */}
      <div className="settings-menu-section-title" style={{ marginTop: 18 }}>反应指导语</div>
      <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)", marginBottom: 10 }}>
        查岗有结果后，额外告诉角色该怎么回应。留空 = 完全交给它自己判断。
        可用 {"{name}"} 代替角色名。只在这一次回应生效，不会写进聊天记录。
      </div>
      <div className="menu-group">
        {([
          { key: "accepted", label: "你把屏幕给它看了", hint: "默认它自己决定怎么接话" },
          { key: "declined", label: "你点了「不给看」", hint: "比如提醒它别追问、别闹脾气" },
          { key: "timeout", label: "你没回应（超时）", hint: "比如让它别在同一个点上再试" },
          { key: "failed", label: "没能截到屏幕", hint: "权限或保存失败，不是你拒绝" },
        ] as const).map(item => (
          <div className="menu-item" key={item.key} style={{ cursor: "default", alignItems: "flex-start", flexDirection: "column", gap: 6 }}>
            <div className="menu-label-group">
              <span className="menu-label">{item.label}</span>
              <span className="menu-desc">{item.hint}</span>
            </div>
            <Textarea
              className="font-mono ts-11"
              rows={2}
              placeholder="留空 = 不加任何话"
              value={guidance[item.key]}
              onChange={e => setGuidance(saveCheckInGuidance({ [item.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      {/* ── 链路诊断 ──
          查岗不触发时，用户看到的只是「没弹」这一个事实，而真实原因可能是
          六七种（没开 / 次数用完 / 还没到点 / 服务没起来 / 权限没给……），
          它们长得一模一样。这里按「一次查岗要走完的每一环」逐条摊开，
          卡在哪一环一眼可见，不必一层层试。 */}
      <div className="settings-menu-section-title" style={{ marginTop: 18 }}>链路诊断</div>
      <div className="menu-group" style={{ marginTop: 10 }}>
        {[
          {
            label: "① 壳支持",
            value: readiness.bridgeAvailable ? "支持" : "当前 App 版本没有查岗浮层，请更新安卓壳",
            ok: readiness.bridgeAvailable,
          },
          {
            label: "② 系统版本",
            value: readiness.supported ? "支持（Android 11+）" : "太低，需要 Android 11 及以上",
            ok: readiness.supported,
          },
          {
            label: "③ 无障碍服务",
            value: readiness.accessibilityOn ? "已开启" : "未开启（查岗截屏的前提）",
            ok: readiness.accessibilityOn,
          },
          {
            label: "④ 浮窗权限",
            value: readiness.overlayReady ? "已授予" : "未授予（与你开通话浮窗用的是同一个权限）",
            ok: readiness.overlayReady,
          },
          {
            label: "⑤ 常驻服务",
            value: diag
              ? diag.running
                ? diag.hasInstance ? "运行中" : "在跑但没有实例（多半被系统回收过）"
                : "未运行（回一次小手机就会自动暖起来）"
              : "读不到状态（需要更新安卓壳）",
            ok: diag ? diag.running === true : undefined,
          },
          {
            label: "⑥ 有没有开启的角色",
            value: anyEnabled ? "有" : "一个都没开——查岗不会自己发生",
            ok: anyEnabled,
          },
          {
            label: "⑦ 扫描器",
            value: "统一调度器每 1 分钟扫描；后台模式只按原生累计后台时长计时",
            ok: true,
          },
        ].map(row => (
          <div className="menu-item" key={row.label} style={{ cursor: "default" }}>
            <div className="menu-label-group">
              <span className="menu-label" style={{ fontSize: 13 }}>{row.label}</span>
            </div>
            <span
              style={{
                fontSize: 12,
                color: row.ok === true
                  ? "var(--per-accent, #6f5bd6)"
                  : row.ok === false ? "var(--c-danger, #d9534f)" : "var(--c-text)",
                maxWidth: "62%",
                textAlign: "right",
                wordBreak: "break-all",
              }}
            >
              {row.value}
            </span>
          </div>
        ))}

        {diag?.lastError ? (
          <div className="menu-item" style={{ cursor: "default" }}>
            <div className="menu-label-group">
              <span className="menu-label" style={{ fontSize: 13 }}>最近失败</span>
            </div>
            <span style={{ fontSize: 12, color: "var(--c-danger, #d9534f)", maxWidth: "62%", textAlign: "right", wordBreak: "break-all" }}>
              {diag.lastError}
            </span>
          </div>
        ) : null}
      </div>

      <div className="menu-group" style={{ marginTop: 12 }}>
        <div className="menu-item" style={{ cursor: "default" }}>
          <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
            <ShieldAlert size={17} strokeWidth={1.8} />
          </div>
          <div className="menu-label-group">
            <span className="menu-label">浮层就绪状态</span>
            <span className="menu-desc">
              {readiness.bridgeAvailable
                ? readiness.ready
                  ? "查岗浮层已就绪，到点能弹出来"
                  : !readiness.supported
                    ? "系统版本太低（需要 Android 11 及以上）"
                    : !readiness.accessibilityOn
                      ? "无障碍服务未开启"
                      : "浮窗权限未授予（与你开通话浮窗用的是同一个权限）"
                : "当前 App 版本还没有查岗浮层，请更新安卓壳"}
            </span>
          </div>
        </div>
        <div className="menu-item" style={{ cursor: "default" }}>
          <div className="menu-label-group">
            <span className="menu-label">重置今日计数</span>
            <span className="menu-desc">刚测过一次、把今天的额度用掉了？点这里清掉，重新等一轮</span>
          </div>
          <button
            type="button"
            className="ui-btn ui-btn-outline"
            onClick={() => {
              for (const character of characters) resetCheckInRuntime(character.id);
              refresh();
              onNotice?.("已重置今日查岗计数与上次触发时间");
            }}
          >
            重置
          </button>
        </div>
      </div>

      {anyEnabled && (
        <div className="per-actions">
          <button type="button" className="ui-btn ui-btn-outline" onClick={disableAll}>
            全部关闭
          </button>
        </div>
      )}
    </div>
  );
}
