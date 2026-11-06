"use client";

import AppErrorBoundary from "./error";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppErrorBoundary error={error} reset={reset} />
      </body>
    </html>
  );
}
