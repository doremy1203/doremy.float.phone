import type { LifeLocation, LifeLocationFieldOrigin, LifeLocationSourceRef } from "./life-types";

export type ImportedLifeLocation = {
  name: string;
  aliases?: string[];
  description?: string;
  atmosphere?: string;
  layout?: string;
  props?: string[];
  relation?: LifeLocationSourceRef["relation"];
  sourceRefs: LifeLocationSourceRef[];
};

const normalize = (value: string) => value.trim().normalize("NFKC").replace(/[\s\u3000·•/\\|｜、，,。.!！?？:：;；()（）\[\]【】_-]+/g, "").toLocaleLowerCase();

function slug(value: string) {
  const result = value.trim().normalize("NFKD").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 42);
  return result || "place";
}

function mergeUnique(current: string[] = [], incoming: string[] = []) {
  const result = [...current];
  const seen = new Set(current.map(normalize));
  for (const value of incoming) {
    const clean = value.trim();
    const key = normalize(clean);
    if (clean && key && !seen.has(key)) {
      result.push(clean);
      seen.add(key);
    }
  }
  return result;
}

function mergeText(
  current: string | undefined,
  incoming: string | undefined,
  currentOrigin: LifeLocationFieldOrigin | undefined,
) {
  const value = incoming?.trim();
  if (!value) return { value: current, changed: false };
  if (!current?.trim() || currentOrigin === "ai") return { value, changed: value !== current };
  return { value: current, changed: false };
}

/**
 * Merge imported place profiles into the existing canonical library.
 * Matching is exact on normalized names/aliases only: similar-looking places
 * are not silently collapsed. Existing non-empty, untracked fields are treated
 * as user-authored and are therefore preserved.
 */
export function mergeImportedLifeLocations(
  existing: LifeLocation[],
  imported: ImportedLifeLocation[],
): { locations: LifeLocation[]; added: number; updated: number; sourcesAdded: number } {
  const locations = [...existing];
  let added = 0, updated = 0, sourcesAdded = 0;
  for (const candidate of imported) {
    const name = candidate.name.trim();
    const key = normalize(name);
    if (!key || name.length > 100) continue;
    const sources = candidate.sourceRefs.filter(source => source.sourceKey.trim());
    const sourceCharacterId = sources.find(source => source.characterId)?.characterId;
    const homeOwnerId = candidate.relation === "own-home" ? sourceCharacterId : undefined;
    const canonicalResidence = homeOwnerId
      ? locations.find(location => location.id === "home-" + homeOwnerId)
      : candidate.relation === "shared-home"
        ? locations.find(location => location.id === "home" || (location.residents ?? []).includes(sourceCharacterId ?? ""))
        : undefined;
    const exactMatch = locations.find(location => {
      const keys = [location.name, ...(location.aliases ?? [])].map(normalize);
      return keys.includes(key) || (candidate.aliases ?? []).some(alias => keys.includes(normalize(alias)));
    });
    const match = canonicalResidence ?? ((candidate.relation === "own-home" || candidate.relation === "shared-home") ? undefined : exactMatch);
    const aliases = mergeUnique([], [
      ...(candidate.aliases ?? []).filter(value => value.length <= 100),
      ...(match && (candidate.relation === "own-home" || candidate.relation === "shared-home") && match.name !== name ? [name] : []),
      ...(exactMatch?.id.startsWith("schedule-place-") && exactMatch.name !== name ? [name] : []),
    ]);
    if (!match) {
      const base = homeOwnerId ? "home-" + homeOwnerId : candidate.relation === "shared-home" ? "home" : "imported-place-" + slug(name);
      let id = base, suffix = 2;
      const ids = new Set(locations.map(location => location.id));
      while (ids.has(id)) id = base + "-" + suffix++;
      locations.push({
        id, name, aliases,
        description: candidate.description?.trim() || "",
        atmosphere: candidate.atmosphere?.trim() || "",
        layout: candidate.layout?.trim() || "",
        props: mergeUnique([], candidate.props ?? []),
        ...(candidate.relation === "shared-home" && sourceCharacterId ? { residents: [sourceCharacterId] } : {}),
        visibility: candidate.relation === "own-home" || candidate.relation === "shared-home" ? "private" : "public",
        sourceRefs: mergeUniqueSources([], sources),
        fieldOrigins: {
          ...(candidate.description?.trim() ? { description: "ai" as const } : {}),
          ...(candidate.atmosphere?.trim() ? { atmosphere: "ai" as const } : {}),
          ...(candidate.layout?.trim() ? { layout: "ai" as const } : {}),
          ...((candidate.props ?? []).length ? { props: "ai" as const } : {}),
          ...(aliases.length ? { aliases: "ai" as const } : {}),
        },
      });
      added++;
      sourcesAdded += sources.length;
      continue;
    }
    const origins = match.fieldOrigins ?? {};
    const mergeOrigins = match.id.startsWith("schedule-place-")
      ? {
        description: origins.description === "user" ? "user" as const : "ai" as const,
        atmosphere: origins.atmosphere === "user" ? "user" as const : "ai" as const,
        layout: origins.layout === "user" ? "user" as const : "ai" as const,
        props: origins.props === "user" ? "user" as const : "ai" as const,
        aliases: origins.aliases === "user" ? "user" as const : "ai" as const,
      }
      : origins;
    const description = mergeText(match.description, candidate.description, mergeOrigins.description);
    const atmosphere = mergeText(match.atmosphere, candidate.atmosphere, mergeOrigins.atmosphere);
    const layout = mergeText(match.layout, candidate.layout, mergeOrigins.layout);
    const incomingProps = candidate.props ?? [];
    const props = incomingProps.length
      ? (!match.props?.length ? mergeUnique([], incomingProps)
        : mergeOrigins.props === "ai" ? mergeUnique([], incomingProps) : match.props)
      : (match.props ?? []);
    const nextSources = mergeUniqueSources(match.sourceRefs ?? [], sources);
    sourcesAdded += nextSources.length - (match.sourceRefs?.length ?? 0);
    const nextAliases = aliases.length
      ? (!match.aliases?.length ? mergeUnique([], aliases)
        : mergeOrigins.aliases === "ai" ? mergeUnique(match.aliases ?? [], aliases) : match.aliases)
      : (match.aliases ?? []);
    const next: LifeLocation = {
      ...match,
      aliases: nextAliases,
      ...(candidate.relation === "shared-home" && sourceCharacterId
        ? { residents: mergeUnique(match.residents ?? [], [sourceCharacterId]) }
        : {}),
      description: description.value,
      atmosphere: atmosphere.value,
      layout: layout.value,
      props,
      sourceRefs: nextSources,
      fieldOrigins: {
        ...mergeOrigins,
        ...(description.changed ? { description: "ai" as const } : {}),
        ...(atmosphere.changed ? { atmosphere: "ai" as const } : {}),
        ...(layout.changed ? { layout: "ai" as const } : {}),
        ...((!match.props?.length && (candidate.props ?? []).length) ? { props: "ai" as const } : {}),
        ...((!match.aliases?.length && aliases.length) ? { aliases: "ai" as const } : {}),
      },
    };
    if (JSON.stringify(next) !== JSON.stringify(match)) {
      locations[locations.indexOf(match)] = next;
      updated++;
    }
  }
  return { locations, added, updated, sourcesAdded };
}

function mergeUniqueSources(current: LifeLocationSourceRef[], incoming: LifeLocationSourceRef[]) {
  const result = [...current];
  const indexes = new Map<string, number>();
  current.forEach((source, index) => indexes.set(source.sourceKey, index));
  for (const source of incoming) {
    const index = indexes.get(source.sourceKey);
    if (index === undefined) {
      indexes.set(source.sourceKey, result.length);
      result.push(source);
    } else {
      // Re-import refreshes mutable source labels/metadata without duplicating provenance.
      result[index] = { ...result[index], ...source };
    }
  }
  return result;
}

export function parseImportedLifeLocations(value: unknown, sourceMap: Map<string, LifeLocationSourceRef>): ImportedLifeLocation[] {
  if (!Array.isArray(value)) return [];
  const result: ImportedLifeLocation[] = [];
  for (const item of value.slice(0, 80)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name || name.length > 100) continue;
    const sourceKeys = Array.isArray(record.sourceKeys) ? record.sourceKeys.filter((key): key is string => typeof key === "string") : [];
    const sourceRefs = sourceKeys.map(key => sourceMap.get(key)).filter((source): source is LifeLocationSourceRef => Boolean(source));
    if (!sourceRefs.length) continue;
    const strings = (input: unknown, max: number) => Array.isArray(input)
      ? input.filter((entry): entry is string => typeof entry === "string").map(entry => entry.trim()).filter(Boolean).slice(0, max)
      : [];
    const text = (input: unknown, max: number) => typeof input === "string" ? input.trim().slice(0, max) : "";
    const relation = ["own-home", "shared-home", "workplace", "frequent", "mentioned", "unknown"].includes(String(record.relation))
      ? record.relation as LifeLocationSourceRef["relation"] : "unknown";
    result.push({
      name,
      aliases: strings(record.aliases, 12),
      description: text(record.description, 1600),
      atmosphere: text(record.atmosphere, 1000),
      layout: text(record.layout, 1200),
      props: strings(record.props, 24),
      relation,
      sourceRefs: sourceRefs.map(source => ({ ...source, relation })),
    });
  }
  return result;
}
