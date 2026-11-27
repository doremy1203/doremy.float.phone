"use client";

export function WalletHeaderIsolationStyle() {
  return (
    <style>{`
      .wallet-private-bank-shell.page-shell,
      .wallet-page-root.page-shell {
        --page-header-content-height: 42px !important;
        --page-header-safe-top: var(--phone-titlebar-safe-top, 48px) !important;
      }
      .wallet-private-bank-shell.page-shell > .page-header.wallet-app-header,
      .wallet-page-root.page-shell > .page-header.wallet-app-header {
        position: absolute !important;
        inset: 0 0 auto !important;
        display: flex !important;
        flex-direction: column !important;
        background: #f7f6f0 !important;
        background-color: #f7f6f0 !important;
        background-image: none !important;
        -webkit-backdrop-filter: none !important;
        backdrop-filter: none !important;
        box-shadow: 0 5px 18px rgba(38, 39, 30, .045) !important;
        border-bottom: 1px solid rgba(135, 123, 91, .18) !important;
        isolation: isolate !important;
        z-index: 50 !important;
      }
      .wallet-private-bank-shell.page-shell > .page-header.wallet-app-header::before,
      .wallet-private-bank-shell.page-shell > .page-header.wallet-app-header::after,
      .wallet-page-root.page-shell > .page-header.wallet-app-header::before,
      .wallet-page-root.page-shell > .page-header.wallet-app-header::after {
        content: none !important;
        display: none !important;
        background: none !important;
        -webkit-backdrop-filter: none !important;
        backdrop-filter: none !important;
      }
      .wallet-private-bank-shell.page-shell > .page-header.wallet-app-header .page-header-safe-area,
      .wallet-page-root.page-shell > .page-header.wallet-app-header .page-header-safe-area {
        height: var(--page-header-safe-top, 48px) !important;
        flex: 0 0 var(--page-header-safe-top, 48px) !important;
        background: transparent !important;
      }
      .wallet-private-bank-shell.page-shell > .page-header.wallet-app-header .page-header-content,
      .wallet-page-root.page-shell > .page-header.wallet-app-header .page-header-content {
        display: grid !important;
        grid-template-columns: 40px minmax(0, 1fr) 40px !important;
        align-items: center !important;
        height: 42px !important;
        min-height: 42px !important;
        padding: 1px 14px !important;
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
        color: #30352d !important;
      }
      .wallet-private-bank-shell.page-shell > .page-header.wallet-app-header .page-back-btn,
      .wallet-page-root.page-shell > .page-header.wallet-app-header .page-back-btn {
        display: grid !important;
        width: 40px !important;
        height: 40px !important;
        place-items: center !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 50% !important;
        background: transparent !important;
        box-shadow: none !important;
        color: #77796f !important;
      }
      .wallet-private-bank-shell.page-shell > .page-header.wallet-app-header .page-title,
      .wallet-page-root.page-shell > .page-header.wallet-app-header .page-title {
        display: block !important;
        margin: 0 !important;
        padding: 0 !important;
        background: transparent !important;
        color: #30352d !important;
        font-family: inherit !important;
        font-size: 15px !important;
        font-weight: 650 !important;
        line-height: 1.35 !important;
        letter-spacing: .01em !important;
        text-align: center !important;
        text-shadow: none !important;
      }
      .wallet-private-bank-shell.page-shell > .page-header.wallet-app-header .page-header-right,
      .wallet-page-root.page-shell > .page-header.wallet-app-header .page-header-right {
        display: flex !important;
        min-width: 40px !important;
        align-items: center !important;
        justify-content: flex-end !important;
        background: transparent !important;
        color: #77796f !important;
      }
    `}</style>
  );
}
