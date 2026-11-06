export type VideoTranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

function timestampSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^\[|\]$/g, "").replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const last = Number(parts[parts.length - 1]);
  const middle = Number(parts[parts.length - 2]);
  const first = parts.length === 3 ? Number(parts[0]) : 0;
  if (![first, middle, last].every(Number.isFinite) || first < 0 || middle < 0 || last < 0) return null;
  if (middle > 59 && parts.length === 3) return null;
  if (last >= 60) return null;
  return first * 3600 + middle * 60 + last;
}

function normalizeSegment(startValue: unknown, endValue: unknown, textValue: unknown): VideoTranscriptSegment | null {
  const start = timestampSeconds(startValue);
  const endParsed = timestampSeconds(endValue);
  const text = typeof textValue === "string" ? textValue.replace(/\s+/g, " ").trim() : "";
  if (start === null || !text) return null;
  const end = endParsed !== null && endParsed >= start ? endParsed : start + 5;
  return { start, end, text: text.slice(0, 1600) };
}

/** Parses JSON segments, SRT/VTT blocks and plain timestamped transcript lines. */
export function parseVideoTranscript(input: string): VideoTranscriptSegment[] {
  const source = input.slice(0, 2_000_000).replace(/^\uFEFF/, "");
  if (!source.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(source);
    const records = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { segments?: unknown }).segments)
        ? (parsed as { segments: unknown[] }).segments
        : null;
    if (records) {
      return records.map(item => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        return normalizeSegment(row.start ?? row.startTime ?? row.from, row.end ?? row.endTime ?? row.to, row.text ?? row.content ?? row.transcript);
      }).filter((item): item is VideoTranscriptSegment => Boolean(item)).sort((a, b) => a.start - b.start).slice(0, 20000);
    }
  } catch { /* Not JSON; continue with subtitle/text parsing. */ }

  const blocks = source.replace(/\r/g, "").split(/\n\s*\n/);
  const segments: VideoTranscriptSegment[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map(line => line.trim()).filter(Boolean);
    if (!lines.length || /^WEBVTT(?:\s|$)/i.test(lines[0]) || /^NOTE(?:\s|$)/i.test(lines[0])) continue;
    const timeLineIndex = lines.findIndex(line => line.includes("-->"));
    if (timeLineIndex >= 0) {
      const [left, rightRaw] = lines[timeLineIndex].split("-->");
      const right = rightRaw.trim().split(/\s+/)[0];
      const text = lines.slice(timeLineIndex + 1).filter(line => !/^(?:Kind:|Language:)/i.test(line)).join(" ");
      const item = normalizeSegment(left.trim(), right, text);
      if (item) segments.push(item);
      continue;
    }
    for (const line of lines) {
      const match = line.match(/^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?\s+(.+)$/);
      if (!match) continue;
      const start = timestampSeconds(match[1]);
      const item = start === null ? null : normalizeSegment(start, start + 6, match[2]);
      if (item) segments.push(item);
    }
  }
  if (segments.length) return segments.sort((a, b) => a.start - b.start).slice(0, 20000);
  // Plain .txt transcripts may lack timestamps. Keep them usable as broad context,
  // but the caller should label them as unsynchronised instead of claiming exact timing.
  const plainText = source.split(/\n+/).map(line => line.trim()).filter(Boolean).join(" ").slice(0, 16000);
  return plainText ? [{ start: 0, end: 86400, text: plainText }] : [];
}

export function formatTranscriptTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return hours > 0
    ? String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0")
    : String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
}
