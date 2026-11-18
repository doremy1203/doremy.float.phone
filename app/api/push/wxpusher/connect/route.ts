import { NextResponse } from "next/server";

import { cleanWxPusherSpt, isValidWxPusherSpt, sendWxPusherMessage } from "@/lib/server/wxpusher";

/** 填写 SPT 后自动调用：发一条连接确认，同时验证 SPT 是否可用。 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { spt?: unknown };
    const spt = cleanWxPusherSpt(body.spt);
    if (!isValidWxPusherSpt(spt)) {
      return NextResponse.json({ ok: false, error: "SPT 格式不正确，应以 SPT_ 开头。" }, { status: 400 });
    }
    const origin = new URL("/", request.url);
    const url = origin.protocol === "http:" || origin.protocol === "https:" ? origin.toString() : undefined;
    await sendWxPusherMessage(spt, {
      summary: "小手机 · WxPusher 已连接",
      content: "WxPusher 连接成功。\n\n之后可以在小手机的「离线推送」设置里发送测试通知。",
      url,
    });
    return NextResponse.json({ ok: true, message: "WxPusher 已连接。" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "WxPusher 连接失败。" },
      { status: 502 },
    );
  }
}
