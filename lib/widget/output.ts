/**
 * Strict output boundary for automatic desktop-widget messages.
 *
 * The widget generator is a one-shot text request, not a chat tool runner.
 * Never turn malformed model output, tool directives, or prompt scaffolding
 * into user-visible desktop content.
 */
export type WidgetLineOutput = { text: string; status: string };

const WIDGET_PROTOCOL_MARKERS = [
  /\[\s*执行动作\s*:/i,
  /\[\s*获取指令\s*:/i,
  /<\s*(?:tool_call|action_call|action_result)\b/i,
  /以下是你获取指令的返回结果/,
  /(?:^|\n)\s*动作\s*[:：]\s*在桌面留句话/,
];

export function parseWidgetLineOutput(raw: string): WidgetLineOutput | null {
  const source = String(raw ?? "").trim();
  if (!source || WIDGET_PROTOCOL_MARKERS.some(marker => marker.test(source))) return null;

  // Accept a single JSON object, optionally wrapped in a plain JSON code fence.
  const cleaned = source
    .replace(/^\uFEFF/, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== "string") return null;
  if (record.status !== undefined && typeof record.status !== "string") return null;

  const text = record.text.trim();
  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!text || WIDGET_PROTOCOL_MARKERS.some(marker => marker.test(text)) ||
      WIDGET_PROTOCOL_MARKERS.some(marker => marker.test(status))) return null;

  return {
    text: Array.from(text).slice(0, 60).join(""),
    status: Array.from(status).slice(0, 12).join(""),
  };
}
