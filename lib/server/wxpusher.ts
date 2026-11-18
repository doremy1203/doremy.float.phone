// WxPusher 极简推送（SPT）：把测试通知 / 连接确认转发给 WxPusher。
// SPT 只保存在用户设备本地，服务端按请求里的 spt 转发，不做持久化。

const WXPUSHER_SIMPLE_PUSH_URL = "https://wxpusher.zjiecode.com/api/send/message/simple-push";

export type WxPusherResponse = {
  code?: number;
  msg?: string;
  data?: unknown;
  success?: boolean;
};

export function cleanWxPusherSpt(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, "").slice(0, 200);
}

export function isValidWxPusherSpt(value: string): boolean {
  return /^SPT_[A-Za-z0-9_-]{8,}$/.test(value);
}

/** 通过 WxPusher 极简推送接口发送一条消息；失败时抛出可读错误。 */
export async function sendWxPusherMessage(
  spt: string,
  message: { summary: string; content: string; url?: string },
): Promise<WxPusherResponse> {
  if (!isValidWxPusherSpt(spt)) throw new Error("SPT 格式不正确，应以 SPT_ 开头。");
  const response = await fetch(WXPUSHER_SIMPLE_PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      spt,
      summary: message.summary.slice(0, 100),
      content: message.content.slice(0, 40000),
      contentType: 1,
      ...(message.url ? { url: message.url } : {}),
    }),
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as WxPusherResponse;
  if (!response.ok) {
    throw new Error(data.msg || `WxPusher 请求失败（HTTP ${response.status}）。`);
  }
  if (data.success === false || (typeof data.code === "number" && data.code !== 1000)) {
    throw new Error(data.msg || `WxPusher 返回错误码 ${data.code ?? "未知"}。`);
  }
  return data;
}
