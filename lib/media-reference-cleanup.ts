"use client";

import { isKvHydrated, kvEntries, kvSetAsync } from "./kv-db";
import { loadMomentPosts, saveMomentPosts } from "./moments-storage";
import { loadPhotoWallState, savePhotoWallState } from "./photo-wall-storage";

/**
 * Remove direct media references from the durable features we can safely rewrite:
 * photo wall (photos/background), Moments post photoUrl, and custom-app __media_refs.
 *
 * Chat messages are intentionally not rewritten here: deleting a message's image out
 * from under a conversation is more destructive than leaving a broken thumbnail.
 * The archive force-delete dialog reports this so the user can decide.
 */
export async function purgeMediaReferences(ref: string): Promise<{ photoWall: number; moments: number; customApps: number }> {
  const id = ref.startsWith("media-store://") ? ref.slice("media-store://".length) : ref;
  if (!id) return { photoWall: 0, moments: 0, customApps: 0 };
  let photoWall = 0;
  let moments = 0;
  let customApps = 0;

  try {
    const state = loadPhotoWallState();
    const photos = state.photos.filter(photo => photo.mediaRef !== ref);
    photoWall += state.photos.length - photos.length;
    const next = {
      ...state,
      photos,
      wallBackgroundRef: state.wallBackgroundRef === ref ? undefined : state.wallBackgroundRef,
    };
    if (next.photos.length !== state.photos.length || next.wallBackgroundRef !== state.wallBackgroundRef) {
      savePhotoWallState(next);
    }
  } catch { /* damaged photo-wall data must not block other cleanup */ }

  try {
    const posts = loadMomentPosts();
    let changed = false;
    const next = posts.map(post => {
      const photoUrl = String(post.photoUrl || "");
      if (!photoUrl || (!photoUrl.includes(ref) && !photoUrl.includes(id))) return post;
      changed = true;
      moments += 1;
      return { ...post, photoUrl: undefined, photoGenerationStatus: undefined, photoGenerationError: undefined };
    });
    if (changed) saveMomentPosts(next);
  } catch { /* ignore */ }

  try {
    if (isKvHydrated()) {
      for (const { key, value } of kvEntries()) {
        if (!key.startsWith("ai_phone_custom_app_data_v1:") || !key.endsWith("/__media_refs")) continue;
        let rows: unknown = null;
        try { rows = JSON.parse(value); } catch { continue; }
        if (!Array.isArray(rows)) continue;
        const next = rows.filter(row => String((row as { id?: unknown })?.id || "") !== id);
        if (next.length === rows.length) continue;
        customApps += rows.length - next.length;
        await kvSetAsync(key, JSON.stringify(next));
      }
    }
  } catch { /* ignore */ }

  return { photoWall, moments, customApps };
}
