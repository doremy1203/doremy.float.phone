import { migrateCharacterMemoryIdentities } from "./memory-storage";
import { migrateCalendarOwnerIdentity } from "./calendar-storage";
import { migrateLifeCharacterIdentity } from "./life/life-storage";

export type LegacyCharacterIdentityMapping = { fromId: string; toId: string };

export type CharacterIdentityMigrationResult = {
  memoryEntries: number;
  memoryMetadata: number;
  memoryAvailable: boolean;
  calendarPlans: number;
  lifeRecords: number;
  errors: string[];
};

/**
 * Repair durable character-scoped data written by older releases with
 * ChatContact.id in place of Character.id. Each storage owns its own migration
 * semantics; a failure in one store must not block the others.
 */
export async function migrateLegacyCharacterIdentityData(
  mappings: LegacyCharacterIdentityMapping[],
): Promise<CharacterIdentityMigrationResult> {
  const normalized = [...new Map(mappings
    .filter(item => item.fromId && item.toId && item.fromId !== item.toId)
    .map(item => [item.fromId, item])).values()];
  const result: CharacterIdentityMigrationResult = {
    memoryEntries: 0,
    memoryMetadata: 0,
    memoryAvailable: true,
    calendarPlans: 0,
    lifeRecords: 0,
    errors: [],
  };
  if (normalized.length === 0) return result;

  try {
    const memory = await migrateCharacterMemoryIdentities(normalized);
    result.memoryEntries = memory.migratedEntries;
    result.memoryMetadata = memory.migratedMetadata;
    result.memoryAvailable = memory.available;
  } catch (error) {
    result.memoryAvailable = false;
    result.errors.push("记忆：" + (error instanceof Error ? error.message : String(error)));
  }

  for (const mapping of normalized) {
    try {
      result.calendarPlans += migrateCalendarOwnerIdentity(mapping.fromId, mapping.toId);
    } catch (error) {
      result.errors.push("日历 " + mapping.fromId + "：" + (error instanceof Error ? error.message : String(error)));
    }
    try {
      result.lifeRecords += migrateLifeCharacterIdentity(mapping.fromId, mapping.toId);
    } catch (error) {
      result.errors.push("生活状态 " + mapping.fromId + "：" + (error instanceof Error ? error.message : String(error)));
    }
  }
  return result;
}
