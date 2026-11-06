import { NextRequest, NextResponse } from "next/server";
import { deleteCacheEntry, streamCacheEntry } from "@/lib/watch-resolver";

export const dynamic = "force-dynamic";

/**
 * 一起看 · 本地缓存视频流。
 * GET    /api/watch-resolver/video/<id>  支持 Range（拖动进度条必需），同源返回，
 *        因此内置解析的视频天然可以截帧喂给视频理解，不再受跨域限制。
 * DELETE /api/watch-resolver/video/<id>  手动删除该缓存（默认永久保留，方便下次接着看）。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    if (!/^[a-f0-9]{6,40}$/i.test(id)) {
        return NextResponse.json({ error: "缓存 ID 不合法" }, { status: 400 });
    }
    try {
        const response = await streamCacheEntry(id, req.headers.get("range"));
        if (!response) return NextResponse.json({ error: "缓存不存在或已清理" }, { status: 404 });
        return response;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    if (!/^[a-f0-9]{6,40}$/i.test(id)) {
        return NextResponse.json({ error: "缓存 ID 不合法" }, { status: 400 });
    }
    const deleted = await deleteCacheEntry(id);
    return NextResponse.json({ ok: true, deleted });
}
