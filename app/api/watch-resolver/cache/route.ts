import { NextResponse } from "next/server";
import { deleteCacheEntry, listCacheEntries } from "@/lib/watch-resolver";

export const dynamic = "force-dynamic";

/**
 * 一起看 · 站内缓存管理。
 * GET    列出全部缓存（标题/大小/最近观看时间）。
 * DELETE 清空全部站内缓存（默认缓存长期保留以便下次接着看，这里提供一键清理）。
 */
export async function GET() {
    try {
        const entries = await listCacheEntries();
        return NextResponse.json({
            ok: true,
            entries: entries.map(entry => ({ id: entry.id, title: entry.title, platform: entry.platform, size: entry.size, lastAccess: entry.lastAccess })),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
}

export async function DELETE() {
    try {
        const entries = await listCacheEntries();
        let removed = 0;
        for (const entry of entries) {
            if (await deleteCacheEntry(entry.id)) removed += 1;
        }
        return NextResponse.json({ ok: true, removed });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
}
