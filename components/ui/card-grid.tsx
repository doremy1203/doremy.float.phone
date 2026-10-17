"use client";

import type { CSSProperties, ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { GlassIcon } from "./glass-icon";

/* ── Card item definition ── */
export type CardItem = {
  id: string;
  /** Lucide 线性图标；也可以改用下面的 glassIcon / iconNode */
  icon?: LucideIcon;
  label: string;
  desc?: string;
  iconColor: string;
  /** 传了就用 <GlassIcon name={glassIcon}> 那张玻璃图标，替代上面的线性 icon */
  glassIcon?: string;
  /** 自定义图标节点（例如桌面应用的 glyph / 图标皮肤）。传了它优先，忽略 icon 与 glassIcon */
  iconNode?: ReactNode;
  onClick: () => void;
};

const cardIconStyle = (color: string): CSSProperties => ({
  "--icon-color": color,
} as CSSProperties);

/* ── 2-column card grid ── */
export function CardGrid({
  items,
  label,
  labelClassName,
}: {
  items: CardItem[];
  label?: string;
  labelClassName?: string;
}) {
  return (
    <div>
      {label && <h3 className={labelClassName ?? "card-section-label"}>{label}</h3>}
      <div className="card-grid" style={label ? { marginTop: 10 } : undefined}>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className="app-card card-card"
              type="button"
              onClick={item.onClick}
            >
              <span
                className={`card-icon${item.glassIcon ? " card-icon-glass" : ""}`}
                style={item.glassIcon ? undefined : cardIconStyle(item.iconColor)}
              >
                {item.iconNode
                  ? item.iconNode
                  : item.glassIcon
                    ? <GlassIcon name={item.glassIcon} />
                    : Icon
                      ? <Icon size={22} strokeWidth={1.75} />
                      : null}
              </span>
              <span className="card-card-body">
                <span className="card-label">{item.label}</span>
                {item.desc && <span className="card-desc">{item.desc}</span>}
              </span>
              <ChevronRight size={16} strokeWidth={1.5} className="card-card-chevron" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Full-width featured card ── */
export type FeaturedCardItem = CardItem & { desc: string };

export function FeaturedCard({ item }: { item: FeaturedCardItem }) {
  const Icon = item.icon;
  return (
    <button
      className="app-card card-featured"
      type="button"
      onClick={item.onClick}
    >
      <span
        className={`card-icon${item.glassIcon ? " card-icon-glass" : ""}`}
        style={item.glassIcon ? undefined : cardIconStyle(item.iconColor)}
      >
        {item.glassIcon ? <GlassIcon name={item.glassIcon} /> : <Icon size={22} strokeWidth={1.75} />}
      </span>
      <div className="card-featured-body">
        <div className="card-featured-label">{item.label}</div>
        <div className="card-featured-desc">{item.desc}</div>
      </div>
      <ChevronRight size={18} className="card-featured-chevron" />
    </button>
  );
}

/* ── Hero card (large visual card) ── */
export type HeroCardItem = {
  id: string;
  icon: LucideIcon;
  label: string;
  description: string;
  color: string;
  glow: string;
  actionText?: string;
  onClick: () => void;
};

export function HeroCard({ item }: { item: HeroCardItem }) {
  return (
    <button
      className="app-card card-hero"
      type="button"
      onClick={item.onClick}
    >
      <span
        className="card-icon"
        style={{
          background: `linear-gradient(135deg, ${item.color}, color-mix(in srgb, ${item.color} 80%, transparent))`,
          "--icon-glow": item.glow,
        } as React.CSSProperties}
      >
        <item.icon size={32} strokeWidth={1.5} />
      </span>
      <span className="card-hero-title">{item.label}</span>
      <span className="card-hero-desc">{item.description}</span>
      {item.actionText && <span className="card-hero-action">{item.actionText}</span>}
    </button>
  );
}

/* ── Section label (standalone) ── */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="card-section-label">{children}</h3>;
}
