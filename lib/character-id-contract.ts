/**
 * Canonical identity contract shared by chat, life, tools and persisted sessions.
 *
 * Character.id is the only durable internal actor key. ChatContact.id and
 * ChatSession.contactId are relationship/session references and must never be
 * passed to character-scoped services.
 */
export type CharacterIdentityContact = { id: string; characterId: string };
export type CharacterIdentitySession = {
  contactId: string;
  characterId?: string | null;
  isGroup?: boolean;
};

export function resolveCharacterIdReference(
  contactRef: unknown,
  explicitCharacterId: unknown,
  contacts: readonly CharacterIdentityContact[],
  characterIds: ReadonlySet<string>,
): string | null {
  if (typeof contactRef !== "string" || !contactRef.trim()) return null;
  if (typeof explicitCharacterId === "string" && explicitCharacterId.trim()
    && characterIds.has(explicitCharacterId.trim())) {
    return explicitCharacterId.trim();
  }
  const reference = contactRef.trim();
  const mapped = contacts.find(contact => contact.id === reference)?.characterId?.trim();
  if (mapped && characterIds.has(mapped)) return mapped;
  return characterIds.has(reference) ? reference : null;
}

export function resolveSessionCharacterIdentity(
  session: CharacterIdentitySession,
  contacts: readonly CharacterIdentityContact[],
  characterIds: ReadonlySet<string>,
): string | null {
  if (session.isGroup) return null;
  return resolveCharacterIdReference(session.contactId, session.characterId, contacts, characterIds);
}
