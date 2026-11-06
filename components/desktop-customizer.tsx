import { useState, useEffect } from "react"
import type { ThemeProfile } from "@/lib/theme-types"
import { IconGlyph } from "@/components/icon-glyph"
import { X, Palette } from "lucide-react"
import { ICONS, type IconId } from "@/lib/desktop-config"

type DesktopCustomizerProps = {
  draft: ThemeProfile
  onDraftChange: (next: ThemeProfile) => void
  onApply: (next: ThemeProfile) => void
  onClose: () => void
}

function parseColorAlpha(val: string): { hex: string; alpha: number } {
  const rgbaMatch = val.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/)
  if (rgbaMatch) {
    const r = Number(rgbaMatch[1]), g = Number(rgbaMatch[2]), b = Number(rgbaMatch[3])
    const a = rgbaMatch[4] !== undefined ? Number(rgbaMatch[4]) : 1
    const hex = `#${[r, g, b].map(c => c.toString(16).padStart(2, "0")).join("")}`
    return { hex, alpha: a }
  }
  if (val.startsWith("#")) {
    if (val.length === 9) {
      const a = parseInt(val.slice(7, 9), 16) / 255
      return { hex: val.slice(0, 7), alpha: a }
    }
    return { hex: val.length === 4 ? `#${val[1]}${val[1]}${val[2]}${val[2]}${val[3]}${val[3]}` : val, alpha: 1 }
  }
  return { hex: "#000000", alpha: 1 }
}

function buildColor(hex: string, alpha: number): string {
  if (alpha >= 1) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const DEFAULT_COLOR_VALUES: Record<string, string> = {
  "--c-desktop-icon-box": "rgba(255, 255, 255, 0.01)",
  "--c-desktop-icon": "#ffffff",
  "--c-desktop-icon-bg": "#c7b8ff",
  "--c-home-label": "#4A4A4A",
  "--c-home-text": "rgba(0, 0, 0, 0.65)",
  "--c-home-sub": "rgba(0, 0, 0, 0.35)",
  "--c-home-card": "rgba(255, 255, 255, 0.01)",
  "--c-home-border": "rgba(0, 0, 0, 0.06)",
  "--c-home-pink": "rgba(255, 160, 175, 0.5)",
};

function ColorField({ label, colorKey, draft, onChange }: { label: string, colorKey: string, draft: ThemeProfile, onChange: (k: string, v: string) => void }) {
  const cssValue = draft.cssOverrides[colorKey] || DEFAULT_COLOR_VALUES[colorKey] || "#ffffff00"
  const { hex, alpha } = parseColorAlpha(cssValue)

  return (
    <div className="flex flex-col gap-1 w-full max-w-[140px]">
      <div className="text-[calc(10px*var(--app-text-scale,1))] text-gray-500 whitespace-nowrap overflow-hidden text-ellipsis text-center">{label}</div>
      <div 
        className="relative w-full h-8 rounded-full overflow-hidden border border-gray-200/50 shadow-sm shrink-0"
        style={{ backgroundColor: hex }}
      >
        <input 
          type="color" 
          value={hex}
          onChange={e => onChange(colorKey, buildColor(e.target.value, alpha))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </div>
      <input 
        type="range" min="0" max="1" step="any" value={alpha}
        onChange={e => onChange(colorKey, buildColor(hex, Number(e.target.value)))}
        className="w-full h-1.5 mt-2 customizer-slider bg-gray-200 rounded-full outline-none"
        title="透明度"
      />
    </div>
  )
}

function SegmentControl({ options, value, onChange }: { options: {label: string, value: string}[], value: string, onChange: (val: string) => void }) {
  return (
    <div className="flex bg-black/5 p-1 rounded-xl w-full">
      {options.map(opt => (
        <button 
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex-1 text-xs py-1.5 rounded-lg transition-all ${value === opt.value ? 'bg-white shadow text-black font-medium' : 'text-gray-500 hover:bg-white/50'}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function DesktopCustomizer({ draft, onDraftChange, onApply, onClose }: DesktopCustomizerProps) {
  const [activeTab, setActiveTab] = useState<"icons" | "widgets" | "global">("icons")

  useEffect(() => {
    const timer = setTimeout(() => {
      onApply(draft);
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, onApply]);

  const handleUpdate = (key: string, value: string) => {
    const next = { ...draft, cssOverrides: { ...draft.cssOverrides, [key]: value } }
    onDraftChange(next)
  }

  const handlePropUpdate = <K extends keyof ThemeProfile,>(key: K, value: ThemeProfile[K]) => {
    const next = { ...draft, [key]: value } as ThemeProfile;
    onDraftChange(next);
  }

  const handleIconUrlUpdate = (iconId: IconId, value: string) => {
    const nextSkins = { ...draft.iconSkins };
    const normalized = value.trim();
    if (normalized) nextSkins[iconId] = normalized;
    else delete nextSkins[iconId];
    const updatedAt = new Date().toISOString();
    const nextSchemes = draft.iconSchemes.map(scheme => scheme.id === draft.activeIconSchemeId
      ? { ...scheme, iconSkins: nextSkins, updatedAt }
      : scheme);
    onDraftChange({ ...draft, iconSkins: nextSkins, iconSchemes: nextSchemes, updatedAt });
  }

  const iconEffect = draft.cssOverrides["--desktop-icon-effect"] || "glass"
  const widgetEffect = draft.cssOverrides["--desktop-widget-effect"] || "glass"
  const outlineWidth = draft.cssOverrides["--desktop-outline-width"] || "1.5"
  const outlineOpacity = draft.cssOverrides["--desktop-outline-opacity"] || "1"
  const shadowOpacity = draft.cssOverrides["--desktop-global-shadow"] ?? "0.5"
  return (
    <div 
      className="absolute bottom-0 left-0 right-0 z-[9999] bg-white/90 backdrop-blur-2xl border-t border-gray-200/50 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] rounded-t-[32px] pb-6 overflow-hidden text-black customizer-drawer"
      onPointerDown={e => e.stopPropagation()} // Prevent closing edit mode
    >
      <style>{`
        .customizer-slider {
          -webkit-appearance: none;
          appearance: none;
          height: 44px !important;
          background: transparent !important;
          cursor: pointer;
          touch-action: none;
          -webkit-tap-highlight-color: transparent;
        }
        .customizer-slider.mt-2 {
          margin: -11px 0 -19px !important;
        }
        .customizer-slider:not(.mt-2) {
          margin: -19px 0 !important;
        }
        .customizer-slider::-webkit-slider-runnable-track {
          height: 6px;
          border-radius: 999px;
          background: #e5e7eb;
        }
        .customizer-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          box-sizing: border-box;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: #4B5563; /* gray-600 */
          cursor: pointer;
          border: 2px solid #fff;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
          /* WebKit aligns the thumb to the track top; pull it back to the
             6px track's vertical center: (6 - 20) / 2 = -7px */
          margin-top: -7px;
        }
        .customizer-slider::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: #4B5563;
          cursor: pointer;
          border: 2px solid #fff;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        .customizer-slider::-moz-range-track {
          height: 6px;
          border-radius: 999px;
          background: #e5e7eb;
        }
      `}</style>
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <span className="ts-16 font-medium text-[var(--c-text-title)] flex items-center gap-2">
          <Palette size={18} /> 个性化装扮
        </span>
        <button onClick={onClose} className="p-1.5 bg-gray-100 rounded-full text-gray-500 hover:bg-gray-200 transition-colors">
          <X size={18} />
        </button>
      </div>

      <div className="px-6 py-3 flex gap-2 w-full">
        {[
          { id: "icons", label: "图标设定" },
          { id: "widgets", label: "组件设定" },
          { id: "global", label: "效果调节" }
        ].map(tab => (
          <button 
            key={tab.id}
            onClick={() => setActiveTab(tab.id as "icons" | "widgets" | "global")}
            className={`flex-1 flex justify-center py-1.5 rounded-full text-[calc(13px*var(--app-text-scale,1))] font-medium transition-colors ${activeTab === tab.id ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="px-6 pt-2 h-[280px] overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
        {activeTab === "icons" && (
          <div className="space-y-6">
            <SegmentControl 
              options={[
                { label: "扁平纯色", value: "flat" },
                { label: "毛玻璃态", value: "glass" }
              ]}
              value={iconEffect}
              onChange={v => handleUpdate("--desktop-icon-effect", v)}
            />

            <div className="grid grid-cols-2 gap-x-4 gap-y-6 justify-items-center bg-gray-50/50 p-5 rounded-2xl shadow-inner border border-gray-100/50">
              <ColorField label="图标底色" colorKey="--c-desktop-icon-box" draft={draft} onChange={handleUpdate} />
              <ColorField label="图标主色" colorKey="--c-desktop-icon" draft={draft} onChange={handleUpdate} />
              <ColorField label="标题字色" colorKey="--c-home-label" draft={draft} onChange={handleUpdate} />
            </div>

            <div className="space-y-2 bg-gray-50/50 p-4 rounded-2xl shadow-inner border border-gray-100/50">
              <div className="text-[calc(13px*var(--app-text-scale,1))] font-medium text-gray-800">每个 App 的图标 URL</div>
              <div className="text-[calc(10px*var(--app-text-scale,1))] text-gray-500">粘贴可直接访问的图片地址；清空后恢复当前图标方案。</div>
              <div className="space-y-2 pt-1">
                {(Object.values(ICONS) as Array<(typeof ICONS)[IconId]>).map(icon => {
                  const iconUrl = draft.iconSkins[icon.id] || "";
                  return (
                    <label key={icon.id} className="flex items-center gap-2 rounded-xl bg-white/80 px-2.5 py-2 border border-gray-100">
                      <span className="w-8 h-8 rounded-lg overflow-hidden bg-gray-100 flex items-center justify-center shrink-0">
                        {iconUrl && /^(?:https?:|data:|blob:)/i.test(iconUrl)
                          ? <img src={iconUrl} alt="" className="w-full h-full object-cover" />
                          : <IconGlyph id={icon.id} className="w-5 h-5" />}
                      </span>
                      <span className="w-14 shrink-0 text-[calc(11px*var(--app-text-scale,1))] text-gray-700 truncate">{icon.label}</span>
                      <input
                        type="url"
                        value={/^(?:https?:|data:|blob:)/i.test(iconUrl) ? iconUrl : ""}
                        onChange={event => handleIconUrlUpdate(icon.id, event.target.value)}
                        placeholder="https://..."
                        className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[calc(10px*var(--app-text-scale,1))] outline-none focus:border-gray-400"
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {activeTab === "widgets" && (
          <div className="space-y-6">
            <SegmentControl 
              options={[
                { label: "扁平纯色", value: "flat" },
                { label: "毛玻璃态", value: "glass" }
              ]}
              value={widgetEffect}
              onChange={v => handleUpdate("--desktop-widget-effect", v)}
            />

            <div className="grid grid-cols-2 gap-x-4 gap-y-6 justify-items-center bg-gray-50/50 p-5 rounded-2xl shadow-inner border border-gray-100/50">
              <ColorField label="面板底色" colorKey="--c-home-card" draft={draft} onChange={handleUpdate} />
              <ColorField label="面板辅助色" colorKey="--c-home-border" draft={draft} onChange={handleUpdate} />
              <ColorField label="文字主色" colorKey="--c-home-text" draft={draft} onChange={handleUpdate} />
              <ColorField label="文字辅色" colorKey="--c-home-sub" draft={draft} onChange={handleUpdate} />
              <ColorField label="强调色" colorKey="--c-home-pink" draft={draft} onChange={handleUpdate} />
            </div>
          </div>
        )}

        {activeTab === "global" && (
          <div className="space-y-6 pt-2">
            
            <div className="space-y-5 bg-gray-50/50 p-5 rounded-2xl shadow-inner border border-gray-100/50 text-gray-800">
              
              {/* 描边与阴影在一排 */}
              <div className="flex items-center gap-4 border-b border-gray-200/50 pb-4">
                <div className="flex items-center justify-between flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[calc(14px*var(--app-text-scale,1))] font-medium">描边</span>
                    {draft.enableGlobalBorder && (
                      <div 
                        className="relative w-5 h-5 rounded-full overflow-hidden border-2 border-white shadow-sm shrink-0"
                        style={{ backgroundColor: draft.globalBorderColor || "#ffffff" }}
                      >
                        <input 
                          type="color" 
                          value={draft.globalBorderColor || "#ffffff"}
                          onChange={e => handlePropUpdate("globalBorderColor", e.target.value)}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        />
                      </div>
                    )}
                  </div>
                  <button 
                    onClick={() => handlePropUpdate("enableGlobalBorder", !draft.enableGlobalBorder)}
                    className={`w-10 h-5.5 rounded-full transition-colors relative ${draft.enableGlobalBorder ? 'bg-gray-800' : 'bg-gray-200'}`}
                  >
                    <div className={`absolute top-1 w-3.5 h-3.5 rounded-full bg-white transition-all shadow-sm ${draft.enableGlobalBorder ? 'left-5' : 'left-1'}`} />
                  </button>
                </div>
                
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex justify-between text-[calc(13px*var(--app-text-scale,1))] font-medium">
                    <span>阴影强度</span>
                    <span>{Math.round(Number(shadowOpacity) * 100)}%</span>
                  </div>
                  <input
                    type="range" min="0" max="1" step="any"
                    value={shadowOpacity}
                    onChange={e => handleUpdate("--desktop-global-shadow", e.target.value)}
                    className="w-full h-1.5 customizer-slider bg-gray-200 rounded-full"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-[calc(13px*var(--app-text-scale,1))] font-medium">
                    <span>外轮廓宽度</span>
                    <span>{Number(outlineWidth).toFixed(2)}</span>
                  </div>
                  <input
                    type="range" min="0.5" max="4.0" step="any"
                    value={outlineWidth}
                    onChange={e => handleUpdate("--desktop-outline-width", e.target.value)}
                    className="w-full h-1.5 customizer-slider bg-gray-200 rounded-full"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-[calc(13px*var(--app-text-scale,1))] font-medium">
                    <span>外轮廓透明度</span>
                    <span>{Math.round(Number(outlineOpacity) * 100)}%</span>
                  </div>
                  <input
                    type="range" min="0" max="1" step="any"
                    value={outlineOpacity}
                    onChange={e => handleUpdate("--desktop-outline-opacity", e.target.value)}
                    className="w-full h-1.5 customizer-slider bg-gray-200 rounded-full"
                  />
                </div>

              </div>

            </div>
          </div>
        )}
      </div>
    </div>
  )
}
