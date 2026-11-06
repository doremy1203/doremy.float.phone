// Cloud-resident life schedule evaluator.
// One durable push_jobs row is reused per scene/character. This function never
// creates an unbounded chain of + suffixed jobs.
type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };
type LifePushSubscription = { endpoint: string; p256dh: string; auth: string };

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
  return out;
}
function bytesToB64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
const utf8 = (value: string) => new TextEncoder().encode(value);
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as unknown as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as unknown as BufferSource, info: info as unknown as BufferSource },
    key, length * 8,
  );
  return new Uint8Array(bits);
}
async function encryptWebPushPayload(p256dhB64: string, authB64: string, payload: string): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(p256dhB64), authSecret = b64urlToBytes(authB64);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as unknown as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const ikm = await hkdf(authSecret, ecdh, concatBytes(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek as unknown as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as unknown as BufferSource }, aesKey,
    concatBytes(utf8(payload), new Uint8Array([2])) as unknown as BufferSource,
  ));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length; header.set(asPublic, 21);
  return concatBytes(header, ciphertext);
}
async function buildVapidAuth(endpoint: string, subject: string, publicKeyB64: string, privateKeyB64: string): Promise<string> {
  const publicBytes = b64urlToBytes(publicKeyB64);
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: privateKeyB64,
    x: bytesToB64url(publicBytes.slice(1, 33)), y: bytesToB64url(publicBytes.slice(33, 65)),
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(utf8(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput) as unknown as BufferSource,
  ));
  return `vapid t=${signingInput}.${bytesToB64url(signature)}, k=${publicKeyB64}`;
}
async function sendWebPushRaw(
  subscription: LifePushSubscription,
  payload: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
): Promise<number> {
  const body = await encryptWebPushPayload(subscription.p256dh, subscription.auth, payload);
  const authorization = await buildVapidAuth(subscription.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "high" },
    body: body as unknown as BodyInit,
  });
  await response.text().catch(() => "");
  return response.status;
}

type ScheduleSlot = {
  ownerType?: string; ownerId?: string; startAt?: string; endAt?: string;
  title?: string; kind?: string; source?: string; plannedLocationId?: string; plannedLocationName?: string;
};
type ActorState = {
  ownerType?: string; ownerId?: string; activity?: string;
  actualLocationId?: string; actualLocationName?: string; actualLocationUntil?: string | null; currentLocationName?: string;
};
type Snapshot = {
  version?: number; updatedAt?: string; scheduleVersion?: string;
  enabled?: boolean; autonomyEnabled?: boolean; proactiveEnabled?: boolean;
  playerLocationId?: string; scenes?: Array<{ id?: string; locationId?: string; characterIds?: string[] }>;
  characterLocations?: Record<string, string>; scheduleSlots?: ScheduleSlot[]; actorStates?: ActorState[];
  onlineChatCharacterId?: string; onlineChatLeaseUntil?: string;
  proactiveIntervalMin?: number; proactiveIntervalMax?: number;
};
type JobRow = { id: string; trigger_key: string; status: string; execute_at: string; updated_at?: string; result_note?: string | null };
type RuntimeRow = {
  user_id: string; scene_id: string; character_id: string; schedule_version: string; state_version: number;
  activity: string; location_id: string; location_name: string;
  player_activity: string; player_location_id: string; player_location_name: string;
  next_transition_at: string | null;
  next_run_at: string | null; last_status: string; last_error: string | null; updated_at: string;
};

const jsonHeaders = (serviceKey: string) => ({
  apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json",
});
const sleepPattern = /睡眠|睡觉|入睡|午休|休息中/;
const WEEK_MS = 7 * 24 * 60 * 60_000;
const isWeeklyRule = (slot: ScheduleSlot) => slot.source === "weekly-generation" && !["special", "appointment"].includes(slot.kind || "");
const isSleep = (value: string) => sleepPattern.test(value || "");
const parseTime = (value?: string | null) => value ? Date.parse(value) : Number.NaN;
const iso = (value: number) => new Date(value).toISOString();

function fromBase64(value: string): Uint8Array {
  const raw = atob(value); const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
function toBase64(value: Uint8Array): string {
  let raw = ""; for (const byte of value) raw += String.fromCharCode(byte); return btoa(raw);
}
async function decryptPayload(payload: EncryptedPayload, secret: string): Promise<string> {
  if (!payload || payload.v !== 1) throw new Error("unsupported encrypted schedule snapshot");
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const ct = fromBase64(payload.ct), tag = fromBase64(payload.tag), combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct); combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(payload.iv) }, key, combined);
  return new TextDecoder().decode(plain);
}
async function encryptPayload(plain: string, secret: string): Promise<EncryptedPayload> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  return { v: 1, iv: toBase64(iv), tag: toBase64(combined.slice(-16)), ct: toBase64(combined.slice(0, -16)) };
}
function projectedWeeklySlots(snapshot: Snapshot, ownerType: string, ownerId: string, now: number, weeks = 2): ScheduleSlot[] {
  const projected: ScheduleSlot[] = [];
  for (const slot of snapshot.scheduleSlots || []) {
    if (slot.ownerType !== ownerType || slot.ownerId !== ownerId || !isWeeklyRule(slot)) continue;
    const start = parseTime(slot.startAt), end = parseTime(slot.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const duration = end - start;
    const offset = Math.max(0, Math.floor((now - start) / WEEK_MS));
    for (let week = offset; week <= offset + weeks; week += 1) {
      const projectedStart = start + week * WEEK_MS;
      projected.push({ ...slot, startAt: iso(projectedStart), endAt: iso(projectedStart + duration) });
    }
  }
  return projected;
}
function allScheduleSlots(snapshot: Snapshot, ownerType: string, ownerId: string, now: number): ScheduleSlot[] {
  return [
    ...(snapshot.scheduleSlots || []).filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId),
    ...projectedWeeklySlots(snapshot, ownerType, ownerId, now),
  ];
}
function activeSlot(snapshot: Snapshot, ownerType: string, ownerId: string, at: number): ScheduleSlot | null {
  const slots = allScheduleSlots(snapshot, ownerType, ownerId, at);
  return slots.find(slot => Number.isFinite(parseTime(slot.startAt)) && Number.isFinite(parseTime(slot.endAt))
    && parseTime(slot.startAt) <= at && at < parseTime(slot.endAt)) || null;
}
function actor(snapshot: Snapshot, ownerType: string, ownerId: string): ActorState | null {
  return (snapshot.actorStates || []).find(item => item.ownerType === ownerType && item.ownerId === ownerId) || null;
}
function locationAt(snapshot: Snapshot, ownerType: string, ownerId: string, at: number) {
  const current = actor(snapshot, ownerType, ownerId);
  const slot = activeSlot(snapshot, ownerType, ownerId, at);
  const until = parseTime(current?.actualLocationUntil);
  const temporary = Boolean(current?.actualLocationId && Number.isFinite(until) && until > at);
  const expiredOverride = Boolean(current?.actualLocationUntil && Number.isFinite(until) && until <= at);
  const manual = Boolean(current?.actualLocationId && current.actualLocationUntil == null
    && current.actualLocationId !== (slot?.plannedLocationId || ""));
  const useActual = temporary || manual;
  const fallbackActualId = expiredOverride ? "" : current?.actualLocationId;
  const fallbackActualName = expiredOverride ? "" : current?.actualLocationName;
  const id = (useActual ? current?.actualLocationId : slot?.plannedLocationId)
    || fallbackActualId
    || (ownerType === "player" ? snapshot.playerLocationId : snapshot.characterLocations?.[ownerId])
    || "";
  const name = (useActual ? current?.actualLocationName : slot?.plannedLocationName)
    || fallbackActualName || "";
  return { id, name, activity: slot?.title || current?.activity || "自由活动", slot };
}
function nextTransition(snapshot: Snapshot, ownerType: string, ownerId: string, now: number): number | null {
  const boundaries = allScheduleSlots(snapshot, ownerType, ownerId, now)
    .flatMap(slot => [parseTime(slot.startAt), parseTime(slot.endAt)]);
  const overrideUntil = parseTime(actor(snapshot, ownerType, ownerId)?.actualLocationUntil);
  if (Number.isFinite(overrideUntil)) boundaries.push(overrideUntil);
  return boundaries.filter(value => Number.isFinite(value) && value > now).sort((a, b) => a - b)[0] ?? null;
}
function nextOverlap(snapshot: Snapshot, characterId: string, now: number): number {
  const boundaries = [
    ...allScheduleSlots(snapshot, "player", "player", now),
    ...allScheduleSlots(snapshot, "character", characterId, now),
  ].flatMap(slot => [parseTime(slot.startAt), parseTime(slot.endAt)]);
  boundaries.push(
    parseTime(actor(snapshot, "player", "player")?.actualLocationUntil),
    parseTime(actor(snapshot, "character", characterId)?.actualLocationUntil),
  );
  boundaries.splice(0, boundaries.length, ...boundaries
    .filter(value => Number.isFinite(value) && value > now)
    .sort((a, b) => a - b));
  for (const boundary of boundaries) {
    const at = boundary + 1000;
    const player = locationAt(snapshot, "player", "player", at);
    const character = locationAt(snapshot, "character", characterId, at);
    if (player.id && player.id === character.id) return at;
  }
  return now + 24 * 60 * 60_000;
}
function jitterInterval(snapshot: Snapshot): number {
  const min = Math.max(3, Math.min(120, Number(snapshot.proactiveIntervalMin) || 5));
  const max = Math.max(min, Math.min(180, Number(snapshot.proactiveIntervalMax) || 15));
  return Math.round((min + Math.random() * (max - min)) * 60_000);
}

Deno.serve(async (req: Request) => {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return new Response("missing env", { status: 503 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = await req.json().catch(() => ({})) as { token?: string };
  const headers = jsonHeaders(serviceKey);
  const rest = (path: string, init?: RequestInit) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init, headers: { ...headers, ...(init?.headers || {}) },
  });

  const writeTraceEvent = async (input: {
    userId: string; traceId: string; stage: string; severity?: "info" | "warning" | "error";
    code: string; detail: string; actorId?: string; sessionId?: string; jobId?: string;
  }) => {
    await rest("life_schedule_diagnostic_events", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{
        id: `life-trace-${crypto.randomUUID()}`, trace_id: input.traceId, user_id: input.userId,
        stage: input.stage, severity: input.severity || "info", code: input.code,
        detail: input.detail.slice(0, 500), actor_id: input.actorId || null,
        session_id: input.sessionId || null, job_id: input.jobId || null,
      }]),
    }).catch(() => undefined);
  };

  const writeDiagnostic = async (
    userId: string, id: string, severity: "error" | "warning" | "info",
    code: string, detail: string, repairHint: string, traceId = id,
  ) => {
    const existingResponse = await rest(`life_schedule_diagnostics?id=eq.${encodeURIComponent(id)}&select=id,resolved_at&limit=1`);
    const existingRows = existingResponse.ok ? await existingResponse.json() as Array<{ resolved_at?: string | null }> : [];
    const shouldNotify = !existingRows[0] || Boolean(existingRows[0].resolved_at);
    await rest("life_schedule_diagnostics?on_conflict=id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{
        id, user_id: userId, severity, code, detail: detail.slice(0, 500),
        repair_hint: repairHint.slice(0, 500), updated_at: new Date().toISOString(), resolved_at: null,
      }]),
    });
    if (!shouldNotify) return;
    await writeTraceEvent({
      userId, traceId, stage: "日程调度异常", severity, code, detail,
      jobId: traceId !== id ? traceId : undefined,
    });
    // Android shell has a persistent Realtime channel. Send one alert when a new
    // unresolved cloud fault appears; repeated cron ticks only update the same row.
    const subscriptionsResponse = await rest(`push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=endpoint,p256dh,auth&limit=50`);
    const subscriptions = subscriptionsResponse.ok
      ? await subscriptionsResponse.json() as LifePushSubscription[]
      : [];
    const topics = subscriptions.filter(item => item.endpoint.startsWith("shell:"))
      .map(item => item.endpoint.slice("shell:".length).trim()).filter(Boolean)
      .map(owner => `shellpush:${owner}`);
    const notificationBody = (code + "：" + detail + "；修复：" + repairHint).slice(0, 180);
    if (topics.length) {
      await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
        method: "POST", headers,
        body: JSON.stringify({ messages: topics.map(topic => ({
          topic, event: "notify",
          payload: { title: "生活系统 · 云端诊断", body: notificationBody, url: "/life", kind: "life_diagnostic" },
        })) }),
      }).catch(() => undefined);
    }
    if (vapidPublicKey && vapidPrivateKey) {
      const webSubscriptions = subscriptions.filter(item => !item.endpoint.startsWith("shell:"));
      for (const subscription of webSubscriptions) {
        try {
          const status = await sendWebPushRaw(subscription, JSON.stringify({
            title: "生活系统 · 云端诊断", body: notificationBody, url: "/life", kind: "life_diagnostic",
          }), { publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject });
          if (status === 404 || status === 410) {
            await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}`, { method: "DELETE" });
          }
        } catch { /* notification failure remains visible in the cloud diagnostic panel */ }
      }
    }
  };
  const configResponse = await rest("push_server_config?id=eq.main&select=cron_secret,payload_key,vapid_public_key,vapid_private_key,site_origin&limit=1");
  if (!configResponse.ok) return new Response("config lookup failed", { status: 502 });
  const configs = await configResponse.json() as Array<{
    cron_secret?: string; payload_key?: string; vapid_public_key?: string; vapid_private_key?: string; site_origin?: string;
  }>;
  const cronSecret = configs[0]?.cron_secret || "", payloadKey = configs[0]?.payload_key || "";
  const vapidPublicKey = configs[0]?.vapid_public_key || "";
  const vapidPrivateKey = configs[0]?.vapid_private_key || "";
  const vapidSubject = configs[0]?.site_origin || "mailto:admin@localhost";
  if (!cronSecret || body.token !== cronSecret) return new Response("forbidden", { status: 403 });
  if (!payloadKey) return new Response("payload_key missing", { status: 503 });

  const snapshotsResponse = await rest("push_bridge_snapshots?rule_id=eq.life-schedule&select=user_id,payload,updated_at&limit=100");
  if (!snapshotsResponse.ok) return new Response("schedule snapshot lookup failed", { status: 502 });
  const rows = await snapshotsResponse.json() as Array<{ user_id: string; payload: EncryptedPayload; updated_at: string }>;
  const now = Date.now();
  const summary = { users: rows.length, evaluated: 0, armed: 0, cancelled: 0, skipped: 0, errors: 0 };

  for (const row of rows) {
    try {
      const snapshot = JSON.parse(await decryptPayload(row.payload, payloadKey)) as Snapshot;
      if (!snapshot || !Array.isArray(snapshot.scheduleSlots) || !Array.isArray(snapshot.scenes)) {
        throw new Error("schedule snapshot missing scheduleSlots/scenes");
      }
      const initialMetaResponse = await rest(
        `push_bridge_snapshots?user_id=eq.${encodeURIComponent(row.user_id)}&rule_id=eq.life-schedule&select=updated_at&limit=1`,
      );
      const initialMetaRows = initialMetaResponse.ok ? await initialMetaResponse.json() as Array<{ updated_at?: string }> : [];
      if (!initialMetaRows[0] || initialMetaRows[0].updated_at !== row.updated_at) {
        summary.skipped += 1;
        continue; // Client published a newer snapshot while this invocation was starting.
      }
      // The cloud life engine and user-visible proactive messaging are separate switches.
      // Schedule/location evaluation must continue even when proactive messages are disabled.
      const lifeEnabled = snapshot.enabled !== false && snapshot.autonomyEnabled !== false;
      const proactiveEnabled = snapshot.proactiveEnabled !== false;
      const enabled = lifeEnabled && proactiveEnabled;
      // Remove old finite-repeat children created by earlier life-scene releases.
      // The unsuffixed schedule row is retained and reused; '+' rows are obsolete history.
      const legacyJobsResponse = await rest(
        `push_jobs?user_id=eq.${encodeURIComponent(row.user_id)}&trigger_key=like.${encodeURIComponent("life-scene:%:schedule+%")}&select=id,status`,
      );
      if (legacyJobsResponse.ok) {
        const legacyJobs = await legacyJobsResponse.json() as Array<{ id: string; status: string }>;
        for (const legacyJob of legacyJobs) {
          if (legacyJob.status === "pending" || legacyJob.status === "running") {
            await rest(`push_jobs?id=eq.${encodeURIComponent(legacyJob.id)}`, {
              method: "PATCH", body: JSON.stringify({ status: "cancelled", result_note: "legacy finite life repeat chain retired", updated_at: new Date().toISOString() }),
            });
          } else {
            await rest(`push_jobs?id=eq.${encodeURIComponent(legacyJob.id)}`, { method: "DELETE" });
          }
        }
      }
      const activePairs = new Set<string>();
      const runtimeUpdates: RuntimeRow[] = [];
      const scenes = snapshot.scenes.filter(scene => Boolean(scene.id));
      const needsSubscription = scenes.some(scene => (scene.characterIds || []).length > 0);
      const subscriptionResponse = await rest(`push_subscriptions?user_id=eq.${encodeURIComponent(row.user_id)}&select=endpoint&limit=1`);
      const hasSubscription = subscriptionResponse.ok && (await subscriptionResponse.json() as unknown[]).length > 0;
      if (!hasSubscription && enabled && needsSubscription) {
        await writeDiagnostic(row.user_id, "life-scheduler:subscription", "warning", "life_push_subscription_missing",
          "云端生活日程仍会持续计算；当前没有可用推送订阅，因此角色主动消息会写入云端回传箱，但无法实时通知。",
          "重新打开小手机并在设置中启用离线推送；Android 壳需要先成功建立常驻通知长连接。");
      } else if (hasSubscription || !enabled || !needsSubscription) {
        await rest(`life_schedule_diagnostics?id=eq.${encodeURIComponent("life-scheduler:subscription")}`, {
          method: "PATCH", body: JSON.stringify({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
        }).catch(() => undefined);
      }
      for (const scene of scenes) {
        for (const characterId of scene.characterIds || []) {
          const key = `${scene.id}:${characterId}`;
          activePairs.add(key);
          const player = locationAt(snapshot, "player", "player", now);
          const character = locationAt(snapshot, "character", characterId, now);
          const samePlace = Boolean(player.id && character.id && player.id === character.id);
          const characterSleeping = isSleep(character.activity);
          const playerSleeping = isSleep(player.activity);
          const chatUntil = snapshot.onlineChatCharacterId === characterId ? parseTime(snapshot.onlineChatLeaseUntil) : Number.NaN;
          const chatActive = Number.isFinite(chatUntil) && chatUntil > now;
          const activity = character.activity || "自由活动";
          const currentLocationId = character.id || "";
          const currentLocationName = character.name || "";
          const previousResponse = await rest(
            `life_schedule_runtime?user_id=eq.${encodeURIComponent(row.user_id)}&scene_id=eq.${encodeURIComponent(scene.id!)}&character_id=eq.${encodeURIComponent(characterId)}&select=schedule_version,state_version,next_run_at,activity,location_id,player_activity,player_location_id,last_status&limit=1`,
          );
          const previousRows = previousResponse.ok ? await previousResponse.json() as Array<Partial<RuntimeRow>> : [];
          const previous = previousRows[0];
          const scheduleVersion = String(snapshot.scheduleVersion || "");
          const changed = previous?.activity !== activity || previous?.location_id !== currentLocationId
            || previous?.player_activity !== player.activity || previous?.player_location_id !== player.id
            || previous?.schedule_version !== scheduleVersion;
          const stateVersion = (Number(previous?.state_version) || 0) + (changed ? 1 : 0);
          const awakeAt = Math.max(
            playerSleeping ? nextAwake(snapshot, "player", "player", now) : now,
            characterSleeping ? nextAwake(snapshot, "character", characterId, now) : now,
          );
          const chatLeaseJustEnded = previous?.last_status === "chat_active" && !chatActive;
          const nextRun = !enabled
            ? null
            : playerSleeping || characterSleeping ? iso(awakeAt)
            : chatActive ? iso(chatUntil + 15_000)
            : !samePlace ? iso(nextOverlap(snapshot, characterId, now))
            : changed || chatLeaseJustEnded ? null
            : previous?.next_run_at || null;
          const transition = Math.min(
            nextTransition(snapshot, "player", "player", now) ?? Number.POSITIVE_INFINITY,
            nextTransition(snapshot, "character", characterId, now) ?? Number.POSITIVE_INFINITY,
          );
          runtimeUpdates.push({
            user_id: row.user_id, scene_id: scene.id!, character_id: characterId,
            schedule_version: scheduleVersion, state_version: stateVersion,
            activity, location_id: currentLocationId, location_name: currentLocationName,
            player_activity: player.activity, player_location_id: player.id, player_location_name: player.name,
            next_transition_at: Number.isFinite(transition) ? iso(transition) : null,
            next_run_at: nextRun, last_status: !lifeEnabled ? "autonomy_disabled" : !proactiveEnabled ? "proactive_disabled" : !hasSubscription ? "notification_unavailable" : !samePlace ? "not_co_located" : characterSleeping || playerSleeping ? "sleeping" : chatActive ? "chat_active" : "ready",
            last_error: null, updated_at: new Date().toISOString(),
          });
          summary.evaluated += 1;

          const triggerKey = `life-scene:${scene.id}:${characterId}:schedule`;
          const jobResponse = await rest(
            `push_jobs?user_id=eq.${encodeURIComponent(row.user_id)}&trigger_key=eq.${encodeURIComponent(triggerKey)}&select=id,status,execute_at,updated_at,result_note&limit=1`,
          );
          if (!jobResponse.ok) throw new Error("push_jobs lookup failed: " + jobResponse.status);
          const jobs = await jobResponse.json() as JobRow[];
          const job = jobs[0];
          if (!job) continue; // Client creates the first prompt/request template while the scene is open.
          const jobDiagnosticId = `life-scheduler:job:${scene.id}:${characterId}`;
          if (!enabled) {
            if (job.status === "pending" || job.status === "running") {
              await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
                method: "PATCH", body: JSON.stringify({ status: "cancelled", result_note: "life schedule disabled by user", updated_at: new Date().toISOString() }),
              });
              summary.cancelled += 1;
            }
            await rest(`life_schedule_diagnostics?id=eq.${encodeURIComponent(jobDiagnosticId)}`, {
              method: "PATCH", body: JSON.stringify({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
            }).catch(() => undefined);
            continue;
          }
          if (job.status === "pending" || job.status === "running") {
            // If the user leaves a direct chat before its lease expires, pull a deferred
            // life prompt forward instead of waiting for the stale lease timestamp.
            if (job.status === "pending" && !chatActive && samePlace && !characterSleeping && !playerSleeping
              && /direct chat is active; deferred until/i.test(job.result_note || "")) {
              const resumedAt = now + jitterInterval(snapshot);
              const resumed = await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.pending`, {
                method: "PATCH", body: JSON.stringify({
                  execute_at: iso(resumedAt),
                  result_note: "life schedule: direct chat ended; resumed deferred task",
                  updated_at: new Date().toISOString(),
                }),
              });
              if (!resumed.ok) throw new Error("life job resume after chat failed: " + resumed.status);
              runtimeUpdates[runtimeUpdates.length - 1].next_run_at = iso(resumedAt);
              runtimeUpdates[runtimeUpdates.length - 1].last_status = hasSubscription ? "ready" : "notification_unavailable";
            }
            const overdueBy = now - parseTime(job.execute_at);
            const runningFor = now - parseTime(job.updated_at);
            if (job.status === "pending" && Number.isFinite(overdueBy) && overdueBy > 5 * 60_000) {
              runtimeUpdates[runtimeUpdates.length - 1].last_status = "dispatch_stalled";
              runtimeUpdates[runtimeUpdates.length - 1].last_error = "到期生活任务超过 5 分钟仍未被云端执行器领取。";
              await writeDiagnostic(row.user_id, jobDiagnosticId, "error", "life_job_dispatch_stalled",
                "到期生活任务超过 5 分钟仍未被 push-generate 执行器领取。",
                "检查个人云 ai-phone-personal-push-jobs-scan Cron、push-generate Edge Function 部署和 push_jobs 表权限。", job.id);
              continue;
            }
            if (job.status === "running" && Number.isFinite(runningFor) && runningFor > 20 * 60_000) {
              runtimeUpdates[runtimeUpdates.length - 1].last_status = "execution_stalled";
              runtimeUpdates[runtimeUpdates.length - 1].last_error = "生活任务运行超过 20 分钟未完成。";
              await writeDiagnostic(row.user_id, jobDiagnosticId, "error", "life_job_execution_stalled",
                "生活任务运行超过 20 分钟未完成，可能卡在模型请求或消息写入。",
                "检查 push-generate Edge Function 日志、模型 API 超时和 push_outbox 写入；任务扫描器会尝试回收超时锁。", job.id);
              continue;
            }
            if (/daily generation cap reached/i.test(job.result_note || "")) {
              await writeDiagnostic(row.user_id, jobDiagnosticId, "warning", "life_generation_daily_cap",
                job.result_note || "云端生活主动生成达到每日额度上限，任务已延后。",
                "这不是日程故障；额度窗口重置后会自动恢复。可在个人云任务记录中查看下一次执行时间。");
            }
            continue;
          }
          if (job.status === "cancelled") {
            const cancelledAt = parseTime(job.updated_at);
            if (Number.isFinite(cancelledAt) && now - cancelledAt < 5 * 60_000) continue;
            await rest(`life_schedule_diagnostics?id=eq.${encodeURIComponent(jobDiagnosticId)}`, {
              method: "PATCH", body: JSON.stringify({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
            }).catch(() => undefined);
          }
          if (job.status === "failed") {
            runtimeUpdates[runtimeUpdates.length - 1].last_status = "generation_failed";
            runtimeUpdates[runtimeUpdates.length - 1].last_error = job.result_note || "生活主动生成任务失败。";
            await writeDiagnostic(row.user_id, jobDiagnosticId, "error", "life_generation_failed",
              job.result_note || "生活主动生成任务失败。",
              "检查角色模型配置、API额度、个人云 push-generate 部署和 push_jobs.result_note；修复后云端会自动重试。", job.id);
          } else if (/errors:|pushed 0/i.test(job.result_note || "")) {
            runtimeUpdates[runtimeUpdates.length - 1].last_status = "notification_delivery_warning";
            runtimeUpdates[runtimeUpdates.length - 1].last_error = job.result_note || "生活消息通知投递异常。";
            await writeDiagnostic(row.user_id, jobDiagnosticId, "warning", "life_notification_delivery_failed",
              job.result_note || "生活消息已生成，但通知投递可能失败。",
              "检查个人云 VAPID 配置、Android 壳 Realtime 连接和系统通知权限；聊天回传箱仍可在打开小手机后取回消息。", job.id);
          } else {
            await rest(`life_schedule_diagnostics?id=eq.${encodeURIComponent(jobDiagnosticId)}`, {
              method: "PATCH", body: JSON.stringify({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
            }).catch(() => undefined);
          }
          if (!samePlace || characterSleeping || playerSleeping || chatActive) continue;
          const nextRunAt = parseTime(previous?.next_run_at);
          if (Number.isFinite(nextRunAt) && nextRunAt > now) continue;
          const executeAt = now + jitterInterval(snapshot);
          const patch = await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}&status=in.(done,failed,cancelled)`, {
            method: "PATCH", headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              status: "pending", execute_at: iso(executeAt),
              result_note: "life schedule: durable task re-armed by cloud scheduler",
              updated_at: new Date().toISOString(),
            }),
          });
          if (!patch.ok) throw new Error("life job re-arm failed: " + patch.status);
          const patched = await patch.json().catch(() => []) as unknown[];
          if (patched.length) {
            summary.armed += 1;
            runtimeUpdates[runtimeUpdates.length - 1].next_run_at = iso(executeAt);
            await writeTraceEvent({
              userId: row.user_id, traceId: job.id, stage: "任务已预约", code: "life_job_armed",
              detail: "云端日程已将持久化任务重新预约到 " + iso(executeAt) + "。",
              actorId: characterId, jobId: job.id,
            });
          }
        }
      }

      // Cancel orphaned schedule tasks when a scene/participant disappears from the latest snapshot.
      const latestMetaResponse = await rest(
        `push_bridge_snapshots?user_id=eq.${encodeURIComponent(row.user_id)}&rule_id=eq.life-schedule&select=updated_at&limit=1`,
      );
      const latestMetaRows = latestMetaResponse.ok ? await latestMetaResponse.json() as Array<{ updated_at?: string }> : [];
      if (latestMetaRows[0]?.updated_at === row.updated_at) {
        const jobsResponse = await rest(
          `push_jobs?user_id=eq.${encodeURIComponent(row.user_id)}&trigger_key=like.life-scene:*:schedule&select=id,trigger_key,status`,
        );
        if (jobsResponse.ok) {
          const jobs = await jobsResponse.json() as Array<{ id: string; trigger_key: string; status: string }>;
          for (const job of jobs) {
            const match = job.trigger_key.match(/^life-scene:(.+):([^:]+):schedule$/);
            if (!match || !activePairs.has(`${match[1]}:${match[2]}`) || !enabled) {
              const orphanDiagnosticId = match ? `life-scheduler:job:${match[1]}:${match[2]}` : "";
              if (job.status !== "cancelled") {
                await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
                  method: "PATCH", body: JSON.stringify({ status: "cancelled", result_note: "life schedule: scene/participant removed or autonomy disabled", updated_at: new Date().toISOString() }),
                });
                summary.cancelled += 1;
              }
              if (orphanDiagnosticId) {
                await rest(`life_schedule_diagnostics?id=eq.${encodeURIComponent(orphanDiagnosticId)}`, {
                  method: "PATCH", body: JSON.stringify({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
                }).catch(() => undefined);
              }
            }
          }
        }
      }
      for (const runtime of runtimeUpdates) {
        const response = await rest("life_schedule_runtime?on_conflict=user_id,scene_id,character_id", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([runtime]),
        });
        if (!response.ok) throw new Error("life runtime upsert failed: " + response.status);
      }

      // Refresh the encrypted snapshot's computed location/activity. The generator reads
      // this immediately before every LLM call, so a stale scene-location snapshot cannot
      // make a character keep acting in yesterday's room.
      const playerNow = locationAt(snapshot, "player", "player", now);
      snapshot.playerLocationId = playerNow.id;
      snapshot.characterLocations = { ...(snapshot.characterLocations || {}) };
      const allCharacterIds = new Set([
        ...Object.keys(snapshot.characterLocations || {}),
        ...(snapshot.scheduleSlots || []).filter(slot => slot.ownerType === "character" && slot.ownerId).map(slot => slot.ownerId!),
        ...(snapshot.scenes || []).flatMap(scene => scene.characterIds || []),
      ]);
      for (const characterId of allCharacterIds) {
        snapshot.characterLocations[characterId] = locationAt(snapshot, "character", characterId, now).id;
      }
      snapshot.actorStates = (snapshot.actorStates || []).map(item => {
        const current = item.ownerType === "player"
          ? playerNow
          : item.ownerType === "character" && item.ownerId
            ? locationAt(snapshot, "character", item.ownerId, now)
            : null;
        // Keep manual override metadata intact; only refresh the derived activity.
        return current ? { ...item, activity: current.activity, currentLocationName: current.name } : item;
      });
      snapshot.scenes = (snapshot.scenes || []).map(scene => {
        const participantLocations = (scene.characterIds || []).map(id => locationAt(snapshot, "character", id, now).id);
        return scene.characterIds?.length && participantLocations.some(id => id && id === playerNow.id)
          ? { ...scene, locationId: playerNow.id }
          : scene;
      });
      const updatedPayload = await encryptPayload(JSON.stringify({ ...snapshot, updatedAt: new Date().toISOString() }), payloadKey);
      await rest(
        `push_bridge_snapshots?user_id=eq.${encodeURIComponent(row.user_id)}&rule_id=eq.life-schedule&updated_at=eq.${encodeURIComponent(row.updated_at)}`,
        { method: "PATCH", body: JSON.stringify({ payload: updatedPayload, updated_at: new Date().toISOString() }) },
      );
      await rest(`life_schedule_diagnostics?id=eq.${encodeURIComponent("life-scheduler:" + row.user_id)}`, {
        method: "PATCH",
        body: JSON.stringify({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      }).catch(() => undefined);
      await rest(`life_schedule_diagnostics?id=eq.${encodeURIComponent("life-scheduler:" + row.user_id + ":stale")}`, {
        method: "PATCH",
        body: JSON.stringify({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      }).catch(() => undefined);
    } catch (error) {
      summary.errors += 1;
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await writeDiagnostic(row.user_id, `life-scheduler:${row.user_id}`, "error", "cloud_schedule_evaluation_failed",
        detail,
        "检查个人云部署、life-schedule 快照和 life_schedule_runtime 表；重新打开生活系统同步日程后再运行云服务自检。").catch(() => undefined);
    }
  }
  return Response.json({ ok: true, ...summary });
});

function nextAwake(snapshot: Snapshot, ownerType: string, ownerId: string, now: number): number {
  const future = allScheduleSlots(snapshot, ownerType, ownerId, now)
    .filter(slot => parseTime(slot.startAt) > now && !isSleep(slot.title || ""))
    .sort((a, b) => parseTime(a.startAt) - parseTime(b.startAt));
  return future.length ? parseTime(future[0].startAt) : now + 30 * 60_000;
}
