import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 120;

const FISH_BASE_URL = "https://api.fish.audio";

/**
 * Fish Audio TTS 的同源代理。
 *
 * 浏览器直连 Fish 会被 CORS 拦住；密钥放请求体里只到本站后端，
 * 目标地址固定为官方域名，避免把代理做成任意 URL 的 SSRF 跳板。
 */
export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (!apiKey) return NextResponse.json({ error: "missing_api_key" }, { status: 400 });
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) return NextResponse.json({ error: "missing_text" }, { status: 400 });
        const format = typeof body.format === "string" ? body.format : "mp3";
        const payload: Record<string, unknown> = {
            text,
            format,
            ...(typeof body.voiceId === "string" && body.voiceId.trim() ? { reference_id: body.voiceId.trim() } : {}),
            ...(typeof body.speed === "number" && Number.isFinite(body.speed) ? { speed: body.speed } : {}),
        };

        const response = await proxyFetch(`${FISH_BASE_URL}/v1/tts`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const textResponse = await response.text().catch(() => "");
            return NextResponse.json(
                { error: "fish_tts_failed", status: response.status, message: textResponse.slice(0, 500) },
                { status: 502 },
            );
        }

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const data = await response.json().catch(() => ({}));
            const raw = (data as { audio?: unknown; data?: { audio?: unknown } }).audio
                || (data as { data?: { audio?: unknown } }).data?.audio;
            if (typeof raw === "string" && raw) {
                const bytes = Buffer.from(raw, "base64");
                return new NextResponse(bytes, {
                    status: 200,
                    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
                });
            }
            return NextResponse.json({ error: "fish_tts_no_audio" }, { status: 502 });
        }

        const audio = await response.arrayBuffer();
        return new NextResponse(audio, {
            status: 200,
            headers: { "Content-Type": contentType || "audio/mpeg", "Cache-Control": "no-store" },
        });
    } catch (error) {
        return NextResponse.json(
            { error: "fish_tts_proxy_failed", message: error instanceof Error ? error.message : String(error) },
            { status: 502 },
        );
    }
}
