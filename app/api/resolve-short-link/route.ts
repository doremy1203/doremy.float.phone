import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

/**
 * b23.tv 短链接换算：在服务端跟随 302（Location 里就是真实视频地址），
 * 返回最终 URL。不能在浏览器里做——CORS 拿不到跨站 Location。
 * 只允许 B 站自己的短链/站点，手动逐跳跟随并复检每一跳，避免开放重定向代理。
 */
const ALLOWED_HOSTS = new Set(["b23.tv", "bilibili.com", "www.bilibili.com", "m.bilibili.com"]);

function hostAllowed(rawUrl: string): boolean {
    try {
        const url = new URL(rawUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") return false;
        const host = url.hostname.toLowerCase();
        return ALLOWED_HOSTS.has(host) || ALLOWED_HOSTS.has(host.replace(/^www\./, ""));
    } catch {
        return false;
    }
}

export async function POST(req: NextRequest) {
    try {
        const { url } = await req.json() as { url?: string };
        if (!url || typeof url !== "string" || !hostAllowed(url)) {
            return NextResponse.json({ ok: false, error: "只支持 b23.tv / bilibili.com 短链接" }, { status: 400 });
        }
        let current = url;
        for (let hop = 0; hop < 5; hop += 1) {
            const res = await fetch(current, {
                method: "GET",
                redirect: "manual",
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36" },
                signal: AbortSignal.timeout(15000),
            });
            const location = res.headers.get("location");
            if (res.status >= 300 && res.status < 400 && location) {
                const next = new URL(location, current).toString();
                if (!hostAllowed(next)) {
                    return NextResponse.json({ ok: false, error: "重定向目标不在允许的站点内" }, { status: 400 });
                }
                current = next;
                continue;
            }
            if (res.ok) break;
            return NextResponse.json({ ok: false, error: `短链接请求失败（HTTP ${res.status}）` }, { status: 502 });
        }
        return NextResponse.json({ ok: true, url: current });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, error: `短链接换算失败：${message}` }, { status: 502 });
    }
}
