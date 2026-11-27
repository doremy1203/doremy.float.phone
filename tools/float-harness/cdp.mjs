// Float Harness Bridge — Chrome DevTools Protocol transport.
// No npm dependencies; Node 22+ (global WebSocket) is required.
import { execFileSync } from "node:child_process";

const DEFAULT_CDP_HTTP = process.env.FLOAT_CDP_URL || "http://127.0.0.1:9222";
const ADB = process.env.ADB || "adb";
const SERIAL = process.env.FLOAT_ADB_SERIAL || "";

function adbArgs(args) {
  return SERIAL ? ["-s", SERIAL, ...args] : args;
}

function adb(args, options = {}) {
  return execFileSync(ADB, adbArgs(args), { encoding: "utf8", ...options }).trim();
}

async function listTargets(httpUrl = DEFAULT_CDP_HTTP) {
  try {
    const res = await fetch(`${httpUrl.replace(/\/$/, "")}/json/list`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function findPageTarget(targets) {
  const pages = targets.filter(target => target.type === "page" && target.webSocketDebuggerUrl);
  const preferredId = process.env.FLOAT_CDP_TARGET_ID;
  if (preferredId) return pages.find(target => target.id === preferredId) || pages[0] || null;
  return pages.find(target => /localhost:3001|127\.0\.0\.1:3001/.test(target.url || ""))
    || pages.find(target => /float/i.test(target.title || ""))
    || pages[0]
    || null;
}

function resolveWebViewPid() {
  for (const packageName of ["app.floatphone.shell.dev", "app.floatphone.shell"]) {
    try {
      const out = adb(["shell", "pidof", packageName]);
      const pid = out.split(/\s+/).find(Boolean);
      if (pid) return { pid, packageName };
    } catch { /* package not running */ }
  }
  return null;
}

export async function connectToFloat(options = {}) {
  const httpUrl = options.httpUrl || DEFAULT_CDP_HTTP;
  let targets = await listTargets(httpUrl);
  let target = findPageTarget(targets);
  if (!target) {
    const running = resolveWebViewPid();
    if (!running) {
      throw new Error(
        "找不到 Float WebView。请先启动 DEV 壳，或设置 FLOAT_CDP_URL 指向可调试的浏览器/CDP 端点。",
      );
    }
    try {
      adb(["forward", "tcp:9222", `localabstract:webview_devtools_remote_${running.pid}`]);
    } catch (error) {
      throw new Error(`adb forward 失败：${error instanceof Error ? error.message : error}`);
    }
    targets = await listTargets(httpUrl);
    target = findPageTarget(targets);
  }
  if (!target) throw new Error("CDP 已连接，但没有找到 page target。");
  return { target, httpUrl, targets };
}

export class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.url = webSocketDebuggerUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    if (this.ws) return this;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else resolve(message.result || {});
      }
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    await this.send("Runtime.enable");
    return this;
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP 未连接"));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 120_000);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || "页面 JS 执行失败");
    }
    const remote = result.result || {};
    if (remote.type === "undefined") return undefined;
    if ("value" in remote) return remote.value;
    return remote.description ?? null;
  }

  async screenshot() {
    const result = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    return result.data;
  }

  async reload() {
    await this.send("Page.reload", { ignoreCache: false });
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.pending.clear();
  }
}

export { DEFAULT_CDP_HTTP };
