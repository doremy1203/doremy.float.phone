"use client";
import { useState, useRef, useEffect } from "react";
import type { DIYWidgetTemplate, DIYTemplateSlot, WidgetSize, WidgetType } from "@/lib/widget-types";
import { WIDGET_SIZE_CELLS } from "@/lib/widget-types";
import { saveThemeAssetFromBlob, getThemeAssetMap } from "@/lib/theme-storage";

type DIYWidgetEditorProps = {
  template?: DIYWidgetTemplate;
  onSave: (template: DIYWidgetTemplate) => void;
  onClose: () => void;
};

const SIZES: WidgetSize[] = ["2x2", "2x4", "4x4"];

export function DIYWidgetEditor({ template, onSave, onClose }: DIYWidgetEditorProps) {
  const [mode, setMode] = useState<"image" | "code">(template?.mode === "code" ? "code" : "image");
  const [size, setSize] = useState<WidgetSize>(template?.size || "2x2");
  const [name, setName] = useState(template?.name || "DIY组件");
  
  // Image Mode State
  const [bgAssetId, setBgAssetId] = useState<string | undefined>(template?.bgAssetId);
  const [bgPreviewUrl, setBgPreviewUrl] = useState<string | null>(null);
  const [slots, setSlots] = useState<DIYTemplateSlot[]>(template?.slots || []);
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Code Mode State
  const [htmlString, setHtmlString] = useState(
    template?.htmlString || `<style>\n  body { margin: 0; padding: 12px; font-family: sans-serif; color: white; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #FF6B6B, #4ECDC4); }\n  h1 { font-size: calc(24px*var(--app-text-scale,1)); }\n</style>\n<body>\n  <h1 id="time">00:00</h1>\n  <script>\n    setInterval(() => {\n      document.getElementById('time').innerText = new Date().toLocaleTimeString();\n    }, 1000);\n  </script>\n</body>`
  );

  useEffect(() => {
    if (template) {
       setMode(template.mode === "code" ? "code" : "image");
       setSize(template.size);
       setName(template.name);
       if (template.mode === "image") {
         setBgAssetId(template.bgAssetId);
         setSlots(template.slots || []);
       } else {
         setHtmlString(template.htmlString || "");
       }
    } else {
       setMode("image");
       setSize("2x2");
       setName("DIY组件");
       setBgAssetId(undefined);
       setSlots([]);
    }
  }, [template]);

  useEffect(() => {
    if (bgAssetId) {
      getThemeAssetMap([bgAssetId]).then(map => {
        if (map[bgAssetId]) setBgPreviewUrl(map[bgAssetId]);
      });
    } else {
      setBgPreviewUrl(null);
    }
  }, [bgAssetId]);

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const id = await saveThemeAssetFromBlob(file, 'bg');
      setBgAssetId(id);
    } catch (e) {
      console.error(e);
      window.alert("上传失败");
    }
  }

  function handleSave() {
    const newTemplate: DIYWidgetTemplate = {
      id: template?.id || `diy-${Date.now()}`,
      name,
      size,
      mode: mode,
    };
    if (mode === "image") {
      newTemplate.bgAssetId = bgAssetId;
      newTemplate.slots = slots;
    } else {
      newTemplate.htmlString = htmlString;
    }
    onSave(newTemplate);
  }

  function addSlot() {
    const newSlot: DIYTemplateSlot = {
      id: `slot-${Date.now()}`,
      top: 10,
      bottom: 10,
      left: 10,
      right: 10,
    };
    setSlots([...slots, newSlot]);
    setActiveSlotId(newSlot.id);
  }

  function updateActiveSlot(key: keyof DIYTemplateSlot, val: number) {
    if (!activeSlotId) return;
    setSlots(slots.map(s => s.id === activeSlotId ? { ...s, [key]: val } : s));
  }

  const [rows, cols] = WIDGET_SIZE_CELLS[size];

  return (
    <div className="flex flex-col bg-white/40 backdrop-blur-3xl rounded-[32px] border border-white/60 shadow-[0_30px_60px_rgba(0,0,0,0.12)] overflow-hidden flex-shrink-0 animate-in fade-in slide-in-from-top-6 duration-500">
      <style>{`
        .diy-range-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 44px; margin: -19px 0; background: transparent; border-radius: 4px; outline: none; cursor: pointer; touch-action: none; -webkit-tap-highlight-color: transparent; }
        .diy-range-slider::-webkit-slider-runnable-track { height: 6px; border-radius: 4px; background: rgba(0,0,0,0.1); }
        .diy-range-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #3b82f6; cursor: pointer; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.2); transition: transform 0.1s; }
        .diy-range-slider::-webkit-slider-thumb:active { transform: scale(1.2); }
        .diy-range-slider::-moz-range-track { height: 6px; border-radius: 4px; background: rgba(0,0,0,0.1); }
        .blueprint-bg {
          background-color: #f4f5f7;
          background-image: linear-gradient(rgba(0, 0, 0, 0.05) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(0, 0, 0, 0.05) 1px, transparent 1px);
          background-size: 20px 20px;
        }
      `}</style>

      {/* Glass Header */}
      <div className="flex flex-col gap-4 p-5 bg-white/50 backdrop-blur-xl border-b border-black/5 z-20">
        
        {/* Toggle (Centered now since close button removed) */}
        <div className="flex justify-center items-center">
          <div className="flex bg-black/5 p-1 rounded-full relative shadow-inner w-fit">
            <button 
              className={`py-1.5 rounded-full text-[calc(13px*var(--app-text-scale,1))] font-bold transition-all relative z-10 w-[96px] flex justify-center ${mode === "image" ? 'text-black' : 'text-gray-500 hover:text-gray-700'}`}
              onClick={() => setMode("image")}
            >
              🖼️ 图形挖图
            </button>
            <button 
              className={`py-1.5 rounded-full text-[calc(13px*var(--app-text-scale,1))] font-bold transition-all relative z-10 w-[96px] flex justify-center ${mode === "code" ? 'text-black' : 'text-gray-500 hover:text-gray-700'}`}
              onClick={() => setMode("code")}
            >
              💻 代码沙盒
            </button>
            {/* Absolute positioning animated active background block */}
            <div 
               className="absolute top-1 bottom-1 w-[96px] bg-white rounded-full shadow-sm transition-all duration-300 z-0 left-1"
               style={{ transform: mode === "image" ? "translateX(0)" : "translateX(100%)" }}
            />
          </div>
        </div>

        {/* Global Settings */}
        <div className="flex items-center gap-4 bg-white/60 p-2 pl-4 rounded-2xl shadow-[inset_0_1px_3px_rgba(0,0,0,0.02)]">
          <input 
            type="text" 
            className="flex-1 bg-transparent text-[calc(13px*var(--app-text-scale,1))] font-bold text-gray-800 placeholder-gray-400 outline-none"
            value={name} 
            onChange={e => setName(e.target.value)} 
            placeholder="组件名称" 
          />
          <div className="w-[1px] h-6 bg-black/10" />
          <select 
            className="bg-black/5 border border-transparent hover:bg-black/10 text-[calc(13px*var(--app-text-scale,1))] font-bold text-gray-700 px-3 py-1.5 rounded-xl outline-none cursor-pointer transition-colors shadow-inner"
            value={size}
            onChange={e => setSize(e.target.value as WidgetSize)}
          >
            {Object.keys(WIDGET_SIZE_CELLS).map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button className="ml-2 bg-gradient-to-r from-blue-500 to-indigo-500 text-white font-bold text-[calc(13px*var(--app-text-scale,1))] px-6 py-1.5 rounded-xl shadow-md cursor-pointer hover:opacity-90 hover:shadow-lg active:scale-95 transition-all" onClick={handleSave}>
            保存
          </button>
        </div>
      </div>

      {/* Editor Body */}
      <div className="flex flex-col flex-1 pb-6 h-[55vh] overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
        
        {/* The Blueprint Stage */}
        <div className="flex flex-col items-center py-8 blueprint-bg border-b border-black/5 shadow-inner">
          <div className="flex items-center gap-3 mb-6 opacity-40">
            <span className="w-12 h-[1px] bg-black"></span>
            <span className="text-[calc(10px*var(--app-text-scale,1))] font-black tracking-[0.3em] text-black">PREVIEW ARENA</span>
            <span className="w-12 h-[1px] bg-black"></span>
          </div>

          <div 
            className="bg-transparent rounded-[24px] relative shadow-[0_15px_35px_rgba(0,0,0,0.15)] ring-4 ring-white/60 backdrop-blur-sm"
            style={{ 
              width: cols * 74 + (cols - 1) * 16,
              height: rows * 74 + (rows - 1) * 16,
              transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)'
            }}
          >
            {mode === "code" ? (
              <iframe 
                srcDoc={htmlString} 
                sandbox="allow-scripts" 
                className="w-full h-full border-none rounded-[20px] bg-white"
                style={{ pointerEvents: 'none' }} 
              />
            ) : (
              <div className="w-full h-full relative rounded-[20px] overflow-hidden" style={{ backgroundColor: bgPreviewUrl ? 'transparent' : '#e5e7eb' }}>
                {!bgPreviewUrl && <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-gray-400">尚未上传底图</div>}
                
                {/* Background overlay on bottom or just as base */}
                <div 
                  className="absolute inset-0 z-0 pointer-events-none"
                  style={{ backgroundImage: bgPreviewUrl ? `url("${bgPreviewUrl}")` : 'none', backgroundSize: 'cover', backgroundPosition: 'center', transition: 'all 0.3s ease' }}
                />
                
                <div className="absolute inset-0 z-10">
                  {slots.map((s, i) => (
                    <div 
                      key={s.id} 
                      className={`absolute transition-all cursor-pointer ${activeSlotId === s.id ? 'border-[3px] border-blue-500 bg-blue-500/20 shadow-[0_0_20px_rgba(59,130,246,0.6)]' : 'border-[2px] border-dashed border-gray-500/50 hover:bg-black/10'}`}
                      style={{
                        top: `${s.top}%`, bottom: `${s.bottom}%`, left: `${s.left}%`, right: `${s.right}%`
                      }}
                      onClick={() => setActiveSlotId(s.id)}
                    >
                      <div className="absolute inset-0 flex items-center justify-center text-[calc(11px*var(--app-text-scale,1))] text-white font-black drop-shadow-md bg-black/30 backdrop-blur-[2px]">槽位 {i+1}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Controls Section */}
        <div className="px-6 flex-1 mt-6">
          {mode === "image" ? (
            <div className="flex flex-col gap-4">
              {/* Image Upload Card */}
              <div className="bg-white/60 backdrop-blur-md rounded-2xl p-5 border border-white flex flex-col gap-4 shadow-sm">
                 <div className="flex justify-between items-center gap-4">
                   <div className="flex-1">
                     <h4 className="text-[calc(13px*var(--app-text-scale,1))] font-bold text-gray-800">1. 上传绝美底图</h4>
                     <p className="text-[calc(11px*var(--app-text-scale,1))] text-gray-500 mt-1 font-medium leading-snug">推荐使用带透明镂空的 PNG 作为相框</p>
                   </div>
                   <button className="shrink-0 bg-white text-blue-600 font-bold border border-blue-100 shadow-sm px-4 py-2 rounded-xl text-[calc(12px*var(--app-text-scale,1))] hover:bg-blue-50 hover:shadow-md active:scale-95 transition-all" onClick={() => fileInputRef.current?.click()}>
                     选择图片
                   </button>
                   <input type="file" ref={fileInputRef} className="hidden" accept="image/png,image/jpeg" onChange={handleImageUpload} />
                 </div>
              </div>

              {/* Slot Settings Card */}
              <div className="bg-white/60 backdrop-blur-md rounded-2xl p-5 border border-white flex flex-col gap-4 shadow-sm transition-all duration-300">
                 <div className="flex justify-between items-center gap-4">
                   <div className="flex-1">
                     <h4 className="text-[calc(13px*var(--app-text-scale,1))] font-bold text-gray-800">2. 预留相册槽位</h4>
                     <p className="text-[calc(11px*var(--app-text-scale,1))] text-gray-500 mt-1 font-medium leading-snug">在底图下方预留出的图片显示区域</p>
                   </div>
                   <button className="shrink-0 bg-[#1c1c1e] text-white font-bold shadow-md px-4 py-2 rounded-xl text-[calc(12px*var(--app-text-scale,1))] flex items-center justify-center gap-1 hover:shadow-lg active:scale-95 transition-all" onClick={addSlot}>
                     <span>+</span> 新增槽位
                   </button>
                 </div>
                 
                 {activeSlotId ? (() => {
                   const activeSlot = slots.find(s => s.id === activeSlotId);
                   if (!activeSlot) return null;
                   return (
                     <div className="flex flex-col gap-4 mt-2 bg-black/5 p-5 rounded-2xl border border-black/5 shadow-inner">
                       <div className="grid grid-cols-2 gap-x-8 gap-y-5">
                         {['top', 'bottom', 'left', 'right'].map(key => (
                           <label key={key} className="flex flex-col gap-2">
                             <div className="flex justify-between items-end">
                               <span className="text-[calc(10px*var(--app-text-scale,1))] font-black text-gray-400 tracking-wider uppercase">{key}</span>
                               <span className="text-xs font-black text-blue-600">{Math.round(Number(activeSlot[key as keyof DIYTemplateSlot]))}%</span>
                             </div>
                             <input type="range" min="0" max="100" step="any" className="diy-range-slider" value={activeSlot[key as keyof DIYTemplateSlot]} onChange={e => updateActiveSlot(key as keyof DIYTemplateSlot, Number(e.target.value))} />
                           </label>
                         ))}
                       </div>
                       <button className="text-xs font-bold text-red-500 bg-red-50/80 w-fit px-4 py-2 rounded-lg ml-auto hover:bg-red-100 hover:shadow-sm transition-all" onClick={() => {
                         setSlots(slots.filter(s => s.id !== activeSlotId));
                         setActiveSlotId(null);
                       }}>删除当前槽位</button>
                     </div>
                   );
                 })() : (
                   <div className="mt-2 py-6 border-2 border-dashed border-gray-300 rounded-2xl flex items-center justify-center bg-white/30">
                     <p className="text-[calc(12px*var(--app-text-scale,1))] font-bold text-gray-400 tracking-wide">在上方蓝图中点击刚添加的槽位进行编辑</p>
                   </div>
                 )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 h-full pb-4">
              <div className="flex justify-between items-center px-1">
                <div>
                  <h4 className="text-[calc(13px*var(--app-text-scale,1))] font-bold text-gray-800">沙盒源代码</h4>
                  <p className="text-[calc(11px*var(--app-text-scale,1))] text-gray-500 leading-snug mt-1 font-medium">支持纯净的 HTML/CSS/JS。<br/>使用 <code className="bg-red-50 border border-red-100 px-1 rounded text-red-500 font-mono text-[calc(10px*var(--app-text-scale,1))]">window.parent.postMessage</code> 触发系统指令。</p>
                </div>
              </div>
              
              {/* Fake Window Frame for Code Editor */}
              <div className="flex flex-col rounded-2xl overflow-hidden shadow-[0_10px_30px_rgba(0,0,0,0.15)] border border-black/20 flex-1 min-h-[300px] bg-[#1e1e1e]">
                <div className="bg-[#2d2d2d] px-4 py-2.5 flex items-center gap-2 border-b border-black/40">
                  <div className="w-3 h-3 rounded-full bg-[#ff5f56] shadow-sm"></div>
                  <div className="w-3 h-3 rounded-full bg-[#ffbd2e] shadow-sm"></div>
                  <div className="w-3 h-3 rounded-full bg-[#27c93f] shadow-sm"></div>
                  <span className="ml-3 text-[#aaaaaa] text-[calc(11px*var(--app-text-scale,1))] font-mono select-none tracking-wide font-medium">index.html</span>
                </div>
                <textarea 
                  className="w-full flex-1 p-5 bg-[#1e1e1e] text-[#d4d4d4] font-mono text-[calc(12px*var(--app-text-scale,1))] leading-relaxed focus:outline-none resize-none"
                  value={htmlString}
                  onChange={e => setHtmlString(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>
          )}
        </div>
        
      </div>
    </div>
  );
}
