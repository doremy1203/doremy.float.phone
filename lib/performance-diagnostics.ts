export type PerformanceMetricSnapshot = {
  name: string;
  count: number;
  totalMs: number;
  averageMs: number;
  maxMs: number;
  lastMs: number;
  lastAt: string;
  metadata?: Record<string, number | string | boolean>;
};

export type PerformanceEventSnapshot = {
  name: string;
  durationMs: number;
  at: string;
  metadata?: Record<string, number | string | boolean>;
};

export type PerformanceDiagnosticsSnapshot = {
  startedAt: string;
  metrics: PerformanceMetricSnapshot[];
  events: PerformanceEventSnapshot[];
  longTasks: PerformanceEventSnapshot[];
};

const MAX_EVENTS = 160;
const metricStore = new Map<string, PerformanceMetricSnapshot>();
const eventStore: PerformanceEventSnapshot[] = [];
const longTaskStore: PerformanceEventSnapshot[] = [];
let observer: PerformanceObserver | null = null;
let installCount = 0;
let startedAt = new Date().toISOString();

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function pushBounded(target: PerformanceEventSnapshot[], event: PerformanceEventSnapshot): void {
  target.push(event);
  if (target.length > MAX_EVENTS) target.splice(0, target.length - MAX_EVENTS);
}

/** 只记录耗时、计数和非敏感元数据；绝不记录消息正文、角色名或用户内容。 */
export function recordPerformanceMetric(
  name: string,
  durationMs: number,
  metadata?: Record<string, number | string | boolean>,
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const safeDuration = Math.round(durationMs * 100) / 100;
  const current = metricStore.get(name);
  const next: PerformanceMetricSnapshot = current
    ? {
        ...current,
        count: current.count + 1,
        totalMs: Math.round((current.totalMs + safeDuration) * 100) / 100,
        averageMs: Math.round(((current.totalMs + safeDuration) / (current.count + 1)) * 100) / 100,
        maxMs: Math.max(current.maxMs, safeDuration),
        lastMs: safeDuration,
        lastAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      }
    : {
        name,
        count: 1,
        totalMs: safeDuration,
        averageMs: safeDuration,
        maxMs: safeDuration,
        lastMs: safeDuration,
        lastAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      };
  metricStore.set(name, next);
  pushBounded(eventStore, {
    name,
    durationMs: safeDuration,
    at: next.lastAt,
    ...(metadata ? { metadata } : {}),
  });
}

export function getPerformanceDiagnosticsSnapshot(): PerformanceDiagnosticsSnapshot {
  return {
    startedAt,
    metrics: [...metricStore.values()].sort((a, b) => b.maxMs - a.maxMs),
    events: [...eventStore].reverse(),
    longTasks: [...longTaskStore].reverse(),
  };
}

export function resetPerformanceDiagnostics(): void {
  metricStore.clear();
  eventStore.length = 0;
  longTaskStore.length = 0;
  startedAt = new Date().toISOString();
}

export function installPerformanceDiagnostics(): () => void {
  if (typeof window === "undefined") return () => undefined;
  installCount += 1;
  if (!observer && typeof PerformanceObserver !== "undefined") {
    try {
      const supported = PerformanceObserver.supportedEntryTypes;
      if (supported?.includes("longtask")) {
        observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            pushBounded(longTaskStore, {
              name: "main_thread_long_task",
              durationMs: Math.round(entry.duration * 100) / 100,
              at: new Date().toISOString(),
              metadata: { startTimeMs: Math.round(entry.startTime * 100) / 100 },
            });
          }
        });
        observer.observe({ type: "longtask", buffered: true });
      }
    } catch {
      observer = null;
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    installCount = Math.max(0, installCount - 1);
    if (installCount === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}
