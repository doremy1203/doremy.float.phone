"use client";

import { useEffect, type ReactNode, type Ref } from "react";
import { ChevronLeft } from "lucide-react";

type PageShellProps = {
  title?: ReactNode;
  onBack?: () => void;
  leftAction?: ReactNode;
  rightAction?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyRef?: Ref<HTMLDivElement>;
};

export function PageShell({ title = "", onBack, leftAction, rightAction, children, footer, className, bodyRef }: PageShellProps) {
  useEffect(() => {
    if (!onBack) return;
    const handleSwipeBack = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      onBack();
    };
    document.addEventListener("phone-swipe-back", handleSwipeBack);
    return () => document.removeEventListener("phone-swipe-back", handleSwipeBack);
  }, [onBack]);

  return (
    <div className={`page-shell ${className ?? ""}`}>
      <header className="page-header" data-ui="header">
        <div className="page-header-safe-area" />
        <div className="page-header-content">
          {onBack ? (
            <button className="page-back-btn" type="button" onClick={onBack} aria-label="返回">
              <ChevronLeft size={24} strokeWidth={1.5} />
            </button>
          ) : leftAction ? (
            <span>{leftAction}</span>
          ) : (
            <span style={{ width: 40 }} />
          )}
          <span className="page-title">{title}</span>
          <span className="page-header-right">{rightAction ?? <span style={{ width: 40 }} />}</span>
        </div>
      </header>
      <div ref={bodyRef} className="page-body" data-ui="body">
        {children}
      </div>
      {footer}
    </div>
  );
}

/**
 * Floating overlay header for canvas-style pages (e.g. character page).
 * Uses absolute positioning + pointer-events-none so the canvas beneath
 * remains interactive. The back button uses pointer-events-auto.
 */
type PageOverlayHeaderProps = {
  title: ReactNode;
  onBack: () => void;
  rightAction?: ReactNode;
  className?: string;
};

export function PageOverlayHeader({ title, onBack, rightAction, className }: PageOverlayHeaderProps) {
  useEffect(() => {
    const handleSwipeBack = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      onBack();
    };
    document.addEventListener("phone-swipe-back", handleSwipeBack);
    return () => document.removeEventListener("phone-swipe-back", handleSwipeBack);
  }, [onBack]);

  return (
    <header className={`page-header pointer-events-none absolute top-0 left-0 right-0 z-10 ${className ?? ""}`}>
      <div className="page-header-safe-area" />
      <div className="page-header-content">
        <button className="page-back-btn pointer-events-auto" type="button" onClick={onBack} aria-label="返回">
          <ChevronLeft size={24} strokeWidth={1.5} />
        </button>
        <span className="page-title">{title}</span>
        <span className="page-header-right pointer-events-auto">{rightAction ?? <span style={{ width: 40 }} />}</span>
      </div>
    </header>
  );
}
