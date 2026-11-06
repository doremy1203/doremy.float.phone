"use client";

/**
 * 桌面小组件的后台调度。
 *
 * 只做一件小事：隔一段时间问一次「该让角色换句话了吗」。
 * 与朋友圈/日记的调度同款——挂在 main-app 里，小手机开着时按间隔跑。
 *
 * 为什么不在设置页里跑：设置页只在用户打开时存在，而小组件的内容
 * 该在用户不碰设置的时候也在慢慢变化。
 */

import { useEffect } from "react";

import { bgSetTimeout } from "@/lib/bg-timer";
import { hydrateKvDb } from "@/lib/kv-db";
import { loadWidgetConfig, loadWidgetData } from "@/lib/widget/storage";
import { runWidgetAutoGenerate } from "@/lib/widget/engine";
import { renderWidgetHtml } from "@/lib/widget/template";
import { syncWidgetToNative } from "@/lib/widget/bridge";
import { loadCharacters } from "@/lib/character-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { WIDGET_UPDATED_EVENT } from "@/lib/widget/types";

/** 多久检查一次「该不该换」。真正的间隔判断在 runWidgetAutoGenerate 里。 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 角色还没留过话时推到桌面的占位文案。
 *
 * 为什么必须有它：原先没数据时直接 `return false`，原生收不到 HTML，
 * 小组件就只能退回显示应用图标——用户看到的是「加了个图标，模板没出来」。
 * 文案写明「还没有」，免得被当成角色真的留了话。
 */
const EMPTY_WIDGET_TEXT = "还没有留下话";

/** 把当前存储里的内容渲染并推给桌面。 */
export function pushWidgetToNative(): boolean {
  const config = loadWidgetConfig();
  if (!config.enabled) return false;
  const stored = loadWidgetData();
  // 没内容也照推一份占位：桌面先把模板显示出来，等角色留了话自然就换上了。
  const target = stored ?? {
    characterId: config.characterId,
    text: EMPTY_WIDGET_TEXT,
    status: "",
    avatar: "",
    updatedAt: new Date().toISOString(),
    source: "manual" as const,
  };
  const characterId = target.characterId || config.characterId;
  const character = loadCharacters().find(item => item.id === characterId);
  const userName = resolveUserIdentity(characterId)?.name || "用户";
  try {
    const html = renderWidgetHtml(
      config.useCustomTemplate ? config.customTemplate : "",
      // 没留过话时用角色卡头像兜底，与设置页预览的逻辑保持一致
      { ...target, avatar: target.avatar || character?.avatar || "" },
      character?.name ?? "角色",
      userName,
    );
    return syncWidgetToNative(html);
  } catch (err) {
    console.warn("[Widget] 渲染推送失败", err);
    return false;
  }
}

/**
 * 隐形调度器：挂在 main-app 里。
 *
 * 两件事：
 *   · 隔一会儿试着让角色自己换一句（受「让角色自己换」开关约束，默认关）；
 *   · 数据一变就推给原生，桌面立刻更新（这条走事件，不用等轮询）。
 */
export function WidgetScheduler() {
  useEffect(() => {
    let cancelTimer: (() => void) | null = null;
    let disposed = false;

    const tick = async () => {
      if (disposed) return;
      try {
        await hydrateKvDb();
        const config = loadWidgetConfig();
        if (config.enabled) {
          let contentChanged = false;
          if (config.autoEnabled) {
            contentChanged = await runWidgetAutoGenerate();
            if (contentChanged) pushWidgetToNative();
          }
          // Keep virtual time/current activity fresh even when the character's message is unchanged.
          // runWidgetAutoGenerate emits the normal update event when content changes.
          if (!contentChanged) pushWidgetToNative();
        }
      } catch (err) {
        console.warn("[Widget] 调度失败", err);
      }
      schedule();
    };

    const schedule = () => {
      if (disposed) return;
      // 与追问/朋友圈同款走 bg-timer：iOS 后台会冻结主线程 setTimeout，
      // 用 Worker 心跳才能在保活期间照常跑。
      cancelTimer = bgSetTimeout(() => { void tick(); }, CHECK_INTERVAL_MS);
    };

    // 启动时稍等一会儿再跑第一次：别和首屏渲染抢资源
    const cancelStart = bgSetTimeout(() => {
      // 冷启动先推一次：App 关着期间角色可能只留了话没推成功
      pushWidgetToNative();
      void tick();
    }, 3000);

    // 内容一变立刻推：角色刚用工具留了话，桌面应该马上变，不该等下一轮检查
    const onUpdated = () => { pushWidgetToNative(); };
    const onLifeUpdated = () => { pushWidgetToNative(); };
    window.addEventListener(WIDGET_UPDATED_EVENT, onUpdated);
    // The native widget shares the same virtual-life source as the Life app.
    // A location, activity, clock or schedule change refreshes its rendered card immediately.
    window.addEventListener("virtual-life-state-updated", onLifeUpdated);

    return () => {
      disposed = true;
      cancelStart();
      if (cancelTimer) cancelTimer();
      window.removeEventListener(WIDGET_UPDATED_EVENT, onUpdated);
      window.removeEventListener("virtual-life-state-updated", onLifeUpdated);
    };
  }, []);

  return null;
}
