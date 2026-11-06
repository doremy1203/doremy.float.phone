import { NextRequest, NextResponse } from "next/server";
import { resolveAndCache } from "@/lib/watch-resolver";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * 一起看 · 内置解析（自部署零配置）。
 * POST { url } → 展开短链 → 提取直链 → 下载到本地缓存 → 返回 /api/watch-resolver/video/<id>。
 * 同一视频再次调用直接命中缓存秒开；文件持久保留直到手动删除或超过总容量上限。
 * Serverless 平台（Netlify/Vercel）函数时长与磁盘受限，大文件请在自部署环境使用，
 * 失败时前端会自动回退外部解析服务或官方嵌入。
 */
export async function POST(req: NextRequest) {
    try {
        const { url } = await req.json() as { url?: string };
        if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
            return NextResponse.json({ ok: false, error: "请提供 http/https 视频链接" }, { status: 400 });
        }
        const result = await resolveAndCache(url);
        return NextResponse.json({ ok: true, ...result });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, error: message }, { status: 422 });
    }
}
