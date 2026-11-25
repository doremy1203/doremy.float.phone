/**
 * Stable names exposed to native function-calling providers.
 *
 * Keep this algorithm shared by tool registration and execution-time recovery:
 * changing it in only one place silently breaks calls that cross protocol layers.
 */
export function makeNativeToolName(displayName: string, used: Set<string>): string {
    let hash = 0;
    for (const char of displayName) {
        hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    }
    const suffix = hash.toString(36).slice(0, 6);
    const base = displayName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);
    const prefix = base && /^[a-zA-Z_]/.test(base) ? base : "action";
    let name = `${prefix}_${suffix}`.slice(0, 64);
    let index = 2;
    while (used.has(name)) {
        name = `${prefix}_${suffix}_${index}`.slice(0, 64);
        index += 1;
    }
    used.add(name);
    return name;
}
