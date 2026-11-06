"use client";

// 桌面小组件设置面板：开关 + 角色 + 头像 + 排版模板 + 实时预览 + 推送桌面。
//
// 设计要点：
//  · **模板开放整段 HTML+CSS**，不给死板的开关组。理由见 lib/widget/template.ts：
//    渲染本来就经过 WebView，CSS 能做的都能做，没理由拦着。内置模板只是起点示例。
//  · **实时预览是本页的核心**：改一个字、调一个色号，预览立刻变。
//    预览用 iframe + srcDoc 渲染同一份 HTML——与原生离屏渲染走同一套输入，
//    所以「预览里什么样，桌面上就什么样」。
//  · 默认全关。这是角色往你桌面放东西，属于主动性行为，该由用户明确开启。
//
// 挂载方式与 DeviceActionSettings 一致：直接渲染内容，不套 PageShell、不收 onBack。

import { useCallback, useEffect, useMemo, useState } from "react";

import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import {
  DEFAULT_WIDGET_TEMPLATE,
  WIDGET_LIMITS,
  WIDGET_PLACEHOLDERS,
  WIDGET_UPDATED_EVENT,
  canGenerateAvatar,
  deleteWidgetProfile,
  deleteWidgetProfileNative,
  injectWidgetCss,
  loadWidgetProfiles,
  pushWidgetProfileHtml,
  requestPinWidgetProfile,
  saveWidgetProfile,
  syncWidgetProfilesToNative,
  type WidgetProfile,
  hasWidgetBridge,
  isWidgetPlaced,
  loadWidgetConfig,
  loadWidgetData,
  pushWidgetHtml,
  readWidgetDiagnostics,
  renderWidgetHtml,
  requestPinWidget,
  saveWidgetConfig,
  saveWidgetData,
  type WidgetConfig,
} from "@/lib/widget";

/** 预览用的示例数据：用户还没让角色留话时，先让模板有东西可显示。 */
const SAMPLE_TEXT = "今天路过那家店，想起你说想吃他家的小笼包";
const SAMPLE_STATUS = "在想你";

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function WidgetSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [config, setConfig] = useState<WidgetConfig>(() => loadWidgetConfig());
  const [templateDraft, setTemplateDraft] = useState(() => {
    const current = loadWidgetConfig();
    return current.useCustomTemplate && current.customTemplate ? current.customTemplate : DEFAULT_WIDGET_TEMPLATE;
  });
  const [templateExpanded, setTemplateExpanded] = useState(false);
  const [placed, setPlaced] = useState(() => isWidgetPlaced());
  // 预览要跟着「内容版本」重算：角色刚留了新话时，预览也该变
  const [dataVersion, setDataVersion] = useState(0);
  /** 诊断结果（逐行）。null = 还没点过「检查」。 */
  const [diagnosis, setDiagnosis] = useState<string[] | null>(null);
  const [profiles, setProfiles] = useState<WidgetProfile[]>(() => loadWidgetProfiles());
  const [profileDraft, setProfileDraft] = useState<WidgetProfile | null>(null);

  const characters = useMemo(() => loadCharacters().map(c => ({ id: c.id, name: c.name, avatar: c.avatar ?? "" })), []);

  const refresh = useCallback(() => {
    setConfig(loadWidgetConfig());
    setPlaced(isWidgetPlaced());
    setProfiles(loadWidgetProfiles());
    setDataVersion(v => v + 1);
  }, []);

  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener(WIDGET_UPDATED_EVENT, onChange);
    window.addEventListener("virtual-life-state-updated", onChange);
    const onVisible = () => { if (document.visibilityState === "visible") { setPlaced(isWidgetPlaced()); refresh(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(WIDGET_UPDATED_EVENT, onChange);
      window.removeEventListener("virtual-life-state-updated", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  /* 角色还没选时自动落在第一个角色上：小组件必须知道「这是谁留的话」。 */
  useEffect(() => {
    if (!config.characterId && characters.length > 0) {
      const next = { ...config, characterId: characters[0].id };
      setConfig(next);
      saveWidgetConfig(next);
    }
  }, [config, characters]);

  const activeCharacterName = characters.find(c => c.id === config.characterId)?.name ?? "角色";
  const activeCharacterAvatar = characters.find(c => c.id === config.characterId)?.avatar ?? "";

  /**
   * 预览 HTML。
   *
   * 用「真实数据优先、没有就用示例」：用户已经让角色留过话时看到的就是真的那一条，
   * 还没留过则显示示例，免得预览区一片空白让人以为坏了。
   */
  const previewHtml = useMemo(() => {
    void dataVersion; // 依赖它：数据变了要重算
    const real = loadWidgetData();
    // 头像优先级：已有头像 > 角色卡头像。
    // 没开「生成状态头像」、也从没生成过时，以前一律空着 → 预览只剩首字，
    // 跟角色卡里设的头像对不上（用户实报「头像不同步」）。
    const data = real && real.characterId === config.characterId
      ? { ...real, avatar: real.avatar || activeCharacterAvatar }
      : {
        characterId: config.characterId,
        text: SAMPLE_TEXT,
        status: SAMPLE_STATUS,
        avatar: activeCharacterAvatar,
        updatedAt: new Date().toISOString(),
        source: "manual" as const,
      };
    return renderWidgetHtml(templateDraft, data, activeCharacterName, "你");
  }, [templateDraft, config.characterId, activeCharacterName, activeCharacterAvatar, dataVersion]);

  const update = useCallback((patch: Partial<WidgetConfig>) => {
    setConfig(prev => {
      const next = { ...prev, ...patch };
      saveWidgetConfig(next);
      return next;
    });
  }, []);

  const saveTemplate = useCallback(() => {
    update({ useCustomTemplate: true, customTemplate: templateDraft });
    onNotice?.("模板已保存");
  }, [templateDraft, update, onNotice]);

  const resetTemplate = useCallback(() => {
    setTemplateDraft(DEFAULT_WIDGET_TEMPLATE);
    update({ useCustomTemplate: false, customTemplate: "" });
    onNotice?.("已恢复内置模板");
  }, [update, onNotice]);

  /** 把当前预览推到原生，立刻画到桌面上。 */
  const pushToNative = useCallback(() => {
    if (!hasWidgetBridge()) {
      onNotice?.("当前 App 版本不支持桌面小组件，需要更新安卓壳");
      return;
    }
    const ok = pushWidgetHtml(previewHtml, {
      widthDp: config.widthDp,
      heightDp: config.heightDp,
      scale: config.scale,
    });
    onNotice?.(ok ? "已推送到桌面" : "推送失败，请检查壳版本");
  }, [previewHtml, config.widthDp, config.heightDp, config.scale, onNotice]);

  const placeWidget = useCallback(() => {
    if (!hasWidgetBridge()) {
      onNotice?.("当前 App 版本不支持桌面小组件，需要更新安卓壳");
      return;
    }
    const ok = requestPinWidget();
    onNotice?.(ok ? "已请求系统添加桌面小组件。所有实例共用当前角色、内容和样式。" : "当前启动器不支持从应用内添加，请手动在桌面添加小组件。");
  }, [onNotice]);

  /** 手动塞一条示例内容，方便用户先看看桌面上长什么样。 */
  const writeSample = useCallback(() => {
    if (!config.characterId) return;
    saveWidgetData({
      characterId: config.characterId,
      text: SAMPLE_TEXT,
      status: SAMPLE_STATUS,
      avatar: loadWidgetData()?.avatar || activeCharacterAvatar,
      updatedAt: new Date().toISOString(),
      source: "manual",
    });
    setDataVersion(v => v + 1);
    onNotice?.("已写入示例内容");
  }, [config.characterId, activeCharacterAvatar, onNotice]);

  const createProfile = useCallback(() => {
    const now = new Date().toISOString();
    const profile: WidgetProfile = {
      id: "widget-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      name: "自定义小组件 " + (profiles.length + 1),
      characterId: config.characterId || characters[0]?.id || "",
      template: templateDraft || DEFAULT_WIDGET_TEMPLATE,
      customCss: "",
      widthDp: config.widthDp,
      heightDp: config.heightDp,
      scale: config.scale,
      createdAt: now,
      updatedAt: now,
    };
    setProfileDraft(profile);
    onNotice?.("已创建独立配置。可以分别选择角色、编辑 HTML/CSS，再添加到真实桌面。");
  }, [profiles.length, config, characters, templateDraft, onNotice]);

  const profilePreviewHtml = useMemo(() => {
    if (!profileDraft) return "";
    const character = characters.find(item => item.id === profileDraft.characterId);
    const actual = loadWidgetData(profileDraft.characterId);
    const data = actual ?? {
      characterId: profileDraft.characterId,
      text: SAMPLE_TEXT,
      status: SAMPLE_STATUS,
      avatar: character?.avatar ?? "",
      updatedAt: new Date().toISOString(),
      source: "manual" as const,
    };
    return injectWidgetCss(
      renderWidgetHtml(profileDraft.template || DEFAULT_WIDGET_TEMPLATE, data, character?.name ?? "角色", "你"),
      profileDraft.customCss,
    );
  }, [profileDraft, characters, dataVersion]);

  const patchProfileDraft = (patch: Partial<WidgetProfile>) => {
    setProfileDraft(current => current ? { ...current, ...patch } : current);
  };

  const persistProfileDraft = () => {
    if (!profileDraft) return;
    saveWidgetProfile(profileDraft);
    setProfiles(loadWidgetProfiles());
    onNotice?.("已保存「" + profileDraft.name + "」配置。");
  };

  const pushProfileDraft = () => {
    if (!profileDraft) return;
    saveWidgetProfile(profileDraft);
    setProfiles(loadWidgetProfiles());
    if (!hasWidgetBridge()) { onNotice?.("当前 App 版本没有桌面小组件桥，请安装新版 APK。"); return; }
    const ok = pushWidgetProfileHtml(profileDraft.id, profilePreviewHtml, {
      widthDp: profileDraft.widthDp, heightDp: profileDraft.heightDp, scale: profileDraft.scale,
    });
    onNotice?.(ok ? "已提交该配置的原生渲染。添加前请确认桌面诊断显示渲染成功。" : "当前 APK 尚不支持独立小组件配置，需要更新安卓壳。");
  };

  const placeProfileDraft = () => {
    if (!profileDraft) return;
    if (!hasWidgetBridge()) { onNotice?.("当前 App 版本没有桌面小组件桥，请安装新版 APK。"); return; }

    // 每次「添加到真实桌面」都生成新的 profile ID。否则重复添加同一份草稿时，
    // Android 会把多个 appWidgetId 绑定到同一缓存，导致第二块小组件与第一块完全相同。
    const now = new Date().toISOString();
    const instanceProfile: WidgetProfile = {
      ...profileDraft,
      id: "widget-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      name: (profileDraft.name.trim() || "桌面实例") + " · 实例 " + (profiles.length + 1),
      createdAt: now,
      updatedAt: now,
    };
    saveWidgetProfile(instanceProfile);
    setProfiles(loadWidgetProfiles());

    const pushed = pushWidgetProfileHtml(instanceProfile.id, profilePreviewHtml, {
      widthDp: instanceProfile.widthDp, heightDp: instanceProfile.heightDp, scale: instanceProfile.scale,
    });
    if (!pushed) { onNotice?.("原生侧没有接受这份模板，无法继续添加；配置已保留，可检查 APK 版本后重试。"); return; }
    const accepted = requestPinWidgetProfile(instanceProfile.id);
    if (accepted) setProfileDraft(instanceProfile);
    onNotice?.(accepted
      ? "已请求系统添加「" + instanceProfile.name + "」。每次添加都会使用新的实例 ID 和独立缓存；请在桌面确认流程中完成添加。"
      : "当前 APK 或启动器不支持按配置添加，需要更新安卓壳或在桌面手动添加默认小组件。");
  };

  const removeProfileDraft = () => {
    if (!profileDraft) return;
    const removed = deleteWidgetProfileNative(profileDraft.id);
    deleteWidgetProfile(profileDraft.id);
    setProfiles(loadWidgetProfiles());
    setProfileDraft(null);
    onNotice?.(removed ? "已删除配置；关联的桌面实例已恢复为默认小组件。" : "已删除本地配置。旧 APK 里的桌面实例无法按配置清理，更新新版 APK 后即可管理独立实例。");
  };

  const bridgeOk = hasWidgetBridge();
  const previewWidth = clampInt(config.widthDp, WIDGET_LIMITS.widthDp.min, WIDGET_LIMITS.widthDp.max);
  const previewHeight = clampInt(config.heightDp, WIDGET_LIMITS.heightDp.min, WIDGET_LIMITS.heightDp.max);

  /**
   * 逐段检查小组件链路，把每一步的真实状态列出来。
   *
   * 为什么要它：桌面上只显示应用图标时，网页侧和原生侧**各自看起来都正常**——
   * 预览是 iframe 自己画的（走不到原生），而原生渲染失败原来是静默的。
   * 两边都「正常」、只有桌面不对，用户和我们都没有依据可判断，只能猜。
   *
   * 分两段：
   *   ① 网页侧（旧壳也能查）：桥在不在、总开关开没开、桌面上放没放、这次推送受不受理；
   *   ② 原生侧（需要新壳）：HTML 收到没、PNG 落盘没、最后一次渲染成败与原因。
   */
  const runDiagnosis = useCallback(() => {
    const lines: string[] = [];
    const bridgeOk = hasWidgetBridge();
    lines.push(bridgeOk ? "✓ 壳提供了小组件桥" : "✗ 当前 App 版本没有小组件桥（需要更新安卓壳）");
    const cfg = loadWidgetConfig();
    lines.push(cfg.enabled
      ? "✓ 总开关已打开"
      : "✗ 总开关关着——网页不会推任何内容给桌面，桌面只能显示应用图标");
    if (bridgeOk) {
      lines.push(isWidgetPlaced() ? "✓ 桌面上已有小组件实例" : "✗ 桌面上还没放小组件");
    }
    // 刻意**不**在这里推一次 HTML。
    // 诊断一旦顺手触发渲染，就会自己把状态变成「正在渲染」——看到的永远是
    // 「正在渲染」而不是结论；而且每点一次就堆一个离屏 WebView，越点越卡。
    // 要重推请用旁边的「推送到桌面」，两件事分开做。
    const diag = readWidgetDiagnostics();
    lines.push("");
    if (!diag) {
      lines.push("原生侧详情需要新壳才有——现在只能判断上面这几项。");
      lines.push("更新安卓壳后，这里会显示 PNG 是否落盘、渲染成败与原因。");
    } else {
      lines.push(diag.hasHtml ? `✓ 壳已收到 HTML（${diag.htmlChars} 字）` : "✗ 壳手里没有 HTML");
      lines.push(diag.pngExists
        ? `✓ PNG 已落盘（约 ${Math.max(1, Math.round(diag.pngBytes / 1024))} KB）`
        : "✗ PNG 还没落盘——桌面只能显示应用图标");
      if (diag.rendering) lines.push("… 正在渲染");
      else if (diag.renderAt <= 0) lines.push("… 还没渲染过");
      else if (diag.renderOk) lines.push("✓ 上一次渲染成功");
      else lines.push(`✗ 上一次渲染失败：${diag.renderError || "原生没有记录原因"}`);
    }
    setDiagnosis(lines);
  }, [previewHtml]);

  return (
    <div className="widget-settings">
      {/* ── 实时预览 ── */}
      <div className="ws-preview-card">
        <div className="ws-preview-head">
          <b>桌面预览</b>
          <span>{previewWidth} × {previewHeight} dp</span>
        </div>
        <div className="ws-preview-stage">
          {/* 用 iframe 而不是 dangerouslySetInnerHTML：
              模板是用户可自由编辑的 HTML，塞进主文档会污染全局样式，
              而且一旦里面带 <style> 就会影响整个设置页。 */}
          {/* key 用渲染结果本身：内容一变就强制重建 iframe。
              只更新 srcDoc 属性时，浏览器有时会沿用旧的内部文档、看上去「改了没反应」。 */}
          <iframe
            key={previewHtml}
            title="小组件预览"
            className="ws-preview-frame"
            srcDoc={previewHtml}
            sandbox=""
            style={{ width: `${previewWidth}px`, height: `${previewHeight}px` }}
          />
        </div>
        <div className="ws-preview-actions">
          <button type="button" className="ws-btn ghost" onClick={writeSample} disabled={!config.characterId}>
            写入示例内容
          </button>
          <button type="button" className="ws-btn" onClick={pushToNative}>
            推送到桌面
          </button>
        </div>
        {/* 桌面不对时，用户和我们都得有个依据——别让人只能看着图标干着急。 */}
        <div className="ws-preview-actions">
          <button type="button" className="ws-btn ghost" onClick={runDiagnosis}>
            检查桌面为什么不对
          </button>
        </div>
        {diagnosis ? (
          <div className="ws-diagnosis">
            {diagnosis.map((line, index) => (
              <p
                key={index}
                className={line.startsWith("✓") ? "is-ok" : line.startsWith("✗") ? "is-bad" : "is-plain"}
              >{line || "\u00a0"}</p>
            ))}
          </div>
        ) : null}
      </div>

      {/* ── 开关与角色 ── */}
      <div className="ws-card">
        <div className="ws-row">
          <div className="ws-row-text">
            <b>开启桌面小组件</b>
            <p>角色可以在你手机桌面上留一句话，不打开 App 也能看见</p>
          </div>
          <Toggle checked={config.enabled} onChange={v => update({ enabled: v })} />
        </div>

        {config.enabled ? (
          <>
            <label className="ws-field">
              显示哪个角色
              <select value={config.characterId} onChange={e => update({ characterId: e.target.value })}>
                {characters.length === 0 ? <option value="">还没有角色</option> : null}
                {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>

            {!bridgeOk ? (
              <p className="ws-warn">当前 App 版本不支持桌面小组件——需要更新安卓壳。</p>
            ) : (
              <div className="ws-inline-row">
                <span>{placed ? "桌面已有实例，可再添加一个同款小组件" : "还没有放到桌面上"}</span>
                <button type="button" className="ws-link" onClick={placeWidget}>{placed ? "新建独立实例" : "创建桌面实例"}</button>
              </div>
            )}
            <p className="ws-hint">桌面实例共用当前角色、内容和样式；不支持按实例分别配置。</p>
          </>
        ) : null}
      </div>

      {config.enabled ? (
        <>
          {/* ── 尺寸 ── */}
          <div className="ws-card">
            <span className="ws-card-title">尺寸</span>
            <div className="ws-grid2">
              <label className="ws-field">
                宽（dp）
                <input type="number" min={WIDGET_LIMITS.widthDp.min} max={WIDGET_LIMITS.widthDp.max}
                  value={config.widthDp}
                  onChange={e => update({ widthDp: clampInt(Number(e.target.value) || config.widthDp, WIDGET_LIMITS.widthDp.min, WIDGET_LIMITS.widthDp.max) })} />
              </label>
              <label className="ws-field">
                高（dp）
                <input type="number" min={WIDGET_LIMITS.heightDp.min} max={WIDGET_LIMITS.heightDp.max}
                  value={config.heightDp}
                  onChange={e => update({ heightDp: clampInt(Number(e.target.value) || config.heightDp, WIDGET_LIMITS.heightDp.min, WIDGET_LIMITS.heightDp.max) })} />
              </label>
            </div>
            <label className="ws-field">
              清晰度
              <select value={config.scale} onChange={e => update({ scale: Number(e.target.value) })}>
                <option value={1}>省空间（图更小）</option>
                <option value={2}>标准</option>
                <option value={3}>清晰（图更大）</option>
              </select>
            </label>
            <p className="ws-hint">尺寸只是申请的空间，桌面上实际显示多大由系统按图标格数决定，超出部分会被裁掉。</p>
          </div>

          {/* ── 模板 ── */}
          <div className="ws-card">
            <div className="ws-card-head">
              <span className="ws-card-title">排版模板</span>
              <button type="button" className="ws-link" onClick={() => setTemplateExpanded(v => !v)}>
                {templateExpanded ? "收起" : "编辑"}
              </button>
            </div>
            <p className="ws-hint">
              这里可以写任意 HTML 和 CSS——渐变、圆角、阴影、字体、透明度、对齐都能用。
              桌面上显示什么，就是这段代码渲染出来的样子。新增的生活状态占位符复用生活 APP 的虚拟时间、当前活动、地点线索和下一项日程，不用重复配置时钟。小手机运行且调度可用时会刷新；应用完全退出后不保证实时后台更新。
            </p>

            {templateExpanded ? (
              <>
                <textarea
                  className="ws-template"
                  spellCheck={false}
                  value={templateDraft}
                  onChange={e => setTemplateDraft(e.target.value)}
                  rows={16}
                  aria-label="小组件 HTML 模板"
                />
                <div className="ws-template-actions">
                  <button type="button" className="ws-btn ghost" onClick={resetTemplate}>恢复内置模板</button>
                  <button type="button" className="ws-btn" onClick={saveTemplate}>保存模板</button>
                </div>
              </>
            ) : null}

            <details className="ws-more">
              <summary>可用的占位符</summary>
              <div className="ws-placeholders">
                {WIDGET_PLACEHOLDERS.map(item => (
                  <div className="ws-placeholder-row" key={item.token}>
                    <code>{item.token}</code>
                    <span>{item.desc}</span>
                  </div>
                ))}
                <div className="ws-placeholder-row">
                  <code>{"{{avatarInner}}"}</code>
                  <span>已拼好的头像块（有图放图，没图放首字）</span>
                </div>
                <div className="ws-placeholder-row">
                  <code>{"{{statusChip}}"}</code>
                  <span>已拼好的状态胶囊（没状态时是空串）</span>
                </div>
              </div>
            </details>
          </div>

          {/* ── 状态头像 ── */}
          <div className="ws-card">
            <div className="ws-row">
              <div className="ws-row-text">
                <b>让角色生成状态头像</b>
                <p>每次留话时配一张图，而不是用角色卡里的头像</p>
              </div>
              <Toggle checked={config.useGeneratedAvatar} onChange={v => update({ useGeneratedAvatar: v })} />
            </div>
            {config.useGeneratedAvatar && !canGenerateAvatar() ? (
              <p className="ws-warn">你还没有配置图像生成 API——头像会自动降级成「角色名首字 + 底色」。在「设置 → 图像生成 API」里配置。</p>
            ) : null}
            <p className="ws-hint">
              生图比换句话慢很多，失败时静默沿用上一张，不会影响留话。
              没配生图或生成失败时，头像用角色名首字加一个稳定底色，每个角色颜色不同。
            </p>
          </div>

          {/* ── 主动生成 ── */}
          <div className="ws-card">
            <div className="ws-row">
              <div className="ws-row-text">
                <b>让角色自己换</b>
                <p>没跟你说话时，也会隔段时间在桌面上换一句</p>
              </div>
              <Toggle checked={config.autoEnabled} onChange={v => update({ autoEnabled: v })} />
            </div>
            {config.autoEnabled ? (
              <label className="ws-field">
                多久换一次（小时）
                {/* 自己填，不再给死档位：1~168 小时（一周）之间任意整数 */}
                <input
                  type="number"
                  inputMode="numeric"
                  min={WIDGET_LIMITS.autoIntervalHours.min}
                  max={WIDGET_LIMITS.autoIntervalHours.max}
                  value={config.autoIntervalHours}
                  onChange={e => update({
                    autoIntervalHours: clampInt(
                      Number(e.target.value) || config.autoIntervalHours,
                      WIDGET_LIMITS.autoIntervalHours.min,
                      WIDGET_LIMITS.autoIntervalHours.max,
                    ),
                  })}
                />
              </label>
            ) : null}
            <p className="ws-hint">
              自动生成会在小手机打开或后台保活时触发，错过的时间点不会补。
              它用「记忆总结」那条辅助 API 配置，没配就退回你第一条 API。
            </p>
          </div>

          {/* ── 角色工具 ── */}
          <div className="ws-card">
            <span className="ws-card-title">让角色也能主动留话</span>
            <p className="ws-hint">
              开启后角色会多一个「在桌面留句话」的动作。开关在
              「设置 → 聊天工具箱 → 内置能力」里——那是所有角色能力的总闸，
              这里不重复造一份，免得两处不一致。
            </p>
          </div>
        </>
      ) : null}

    </div>
  );
}
