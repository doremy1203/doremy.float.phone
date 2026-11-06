"use client";

import { useEffect, useMemo, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";

/**
 * 生图“这张图里有谁”选择器。
 *
 * 参考图只能按角色 ID 附加；只在图片描述里写“两个女孩”无法可靠匹配。
 * 重新生图时显式勾选出镜角色，比让模型猜名字稳。
 */
export function ImageParticipantPicker({
  value,
  onChange,
  busy = false,
  compact = false,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  busy?: boolean;
  compact?: boolean;
}) {
  const [characters, setCharacters] = useState<Character[]>([]);
  useEffect(() => {
    setCharacters(loadCharacters());
  }, []);
  const selected = useMemo(() => new Set(value), [value]);
  const toggle = (id: string) => {
    if (busy) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };
  if (characters.length === 0) return null;
  return (
    <div className={compact ? "text-xs" : "text-sm"}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-medium text-stone-700">这张图里有谁（决定用谁的参考图）</span>
        <span className="text-[10px] text-stone-400">只勾选实际出镜的角色</span>
      </div>
      <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-stone-200 bg-white/70 p-2">
        <label className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${selected.has("__user__") ? "border-[var(--life-accent,#b88768)] bg-[#f7eee5]" : "border-stone-200 bg-white"}`}>
          <input type="checkbox" checked={selected.has("__user__")} disabled={busy} onChange={() => toggle("__user__")} />
          <span>我（用户本人）</span>
        </label>
        {characters.map(character => (
          <label key={character.id} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${selected.has(character.id) ? "border-[var(--life-accent,#b88768)] bg-[#f7eee5]" : "border-stone-200 bg-white"}`}>
            <input type="checkbox" checked={selected.has(character.id)} disabled={busy} onChange={() => toggle(character.id)} />
            <span className="max-w-28 truncate">{character.name}</span>
          </label>
        ))}
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-stone-400">
        不勾选的角色不会附加参考图；描述里写名字只用于辅助，最终以这里的选择为准。
      </p>
    </div>
  );
}
