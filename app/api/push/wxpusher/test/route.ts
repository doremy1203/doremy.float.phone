import { NextResponse } from "next/server";

import { cleanWxPusherSpt, isValidWxPusherSpt, sendWxPusherMessage } from "@/lib/server/wxpusher";

/** WxPusher 测试通知接口：POST { spt, title?, content?, url? }。 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { spt?: unknown; title?: unknown; content?: unknown; url?: unknown };
    const spt = cleanWxPusherSpt(body.spt);
    if (!isValidWxPusherSpt(spt)) {
      return NextResponse.json({ ok: false, error: "SPT 格式不正确，应以 SPT_ 开头。" }, { status: 400 });
    }
    const title = String(body.title ?? "").trim() || "小手机 · 测试通知";
    const content = String(body.content ?? "").trim() || "WxPusher 测试通知已送达。";
    let url: string | undefined = String(body.url ?? "").trim();
    if (!url) {
      const origin = new URL("/", request.url);
      url = origin.protocol === "http:" || origin.protocol === "https:" ? origin.toString() : undefined;
    }
    await sendWxPusherMessage(spt, { summary: title, content, url });
    return NextResponse.json({ ok: true, message: "测试通知已发送。" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "WxPusher 测试通知发送失败。" },
      { status: 502 },
    );
  }
}
