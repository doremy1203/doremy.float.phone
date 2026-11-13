import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_FISH_AUDIO_BASE_URL = "https://api.fish.audio/v1";

function normalizeBaseUrl(value: unknown): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_FISH_AUDIO_BASE_URL;
    return raw.replace(/\/$/, "");
}

function normalizeSpeed(speed: unknown): number {
    if (typeof speed === "number" && Number.isFinite(speed)) {
        return Math.min(2, Math.max(0.5, speed));
    }
    return 1.0;
}

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const baseUrl = normalizeBaseUrl(body.baseUrl);
        const model = typeof body.model === "string" ? body.model.trim() : "";
        const referenceId = typeof body.referenceId === "string" ? body.referenceId.trim() : "";
        const text = typeof body.text === "string" ? body.text : "";

        if (!apiKey) {
            return NextResponse.json({ error: "missing_api_key", message: "Fish Audio API Key 未配置" }, { status: 400 });
        }
        if (!referenceId) {
            return NextResponse.json({ error: "missing_reference_id", message: "Fish Audio 音色 ID（reference_id）未配置" }, { status: 400 });
        }
        if (!text.trim()) {
            return NextResponse.json({ error: "empty_text", message: "合成文本为空" }, { status: 400 });
        }

        const headers: Record<string, string> = {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        };
        // Fish Audio 通过 `model` 请求头选择引擎（s2.1-pro 等）。
        if (model) headers["model"] = model;

        const upstream = await proxyFetch(`${baseUrl}/tts`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                text,
                reference_id: referenceId,
                format: "mp3",
                normalize: true,
                prosody: {
                    speed: normalizeSpeed(body.speed),
                    volume: 0,
                },
            }),
        });

        if (!upstream.ok) {
            const errText = await upstream.text().catch(() => "");
            let message = `Fish Audio 请求失败 (${upstream.status})`;
            try {
                const data = JSON.parse(errText) as { message?: unknown; reason?: unknown; error?: unknown };
                message = String(data.message || data.reason || data.error || message);
            } catch {
                // 非 JSON 错误体，保留默认 message
            }
            return NextResponse.json({ error: "fish_audio_tts_failed", message: message.slice(0, 500) }, { status: 502 });
        }

        const arrayBuffer = await upstream.arrayBuffer();
        return new NextResponse(arrayBuffer, {
            status: 200,
            headers: {
                "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
                "Cache-Control": "no-store",
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: "fish_audio_tts_failed", message: message.slice(0, 500) }, { status: 502 });
    }
}
