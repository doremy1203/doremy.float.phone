import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [receiver, activity, bridge] = await Promise.all([
  read("../android-shell/app/src/main/java/app/floatphone/shell/NotificationReplyReceiver.kt"),
  read("../android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt"),
  read("../lib/notification-reply.ts"),
]);

assert.match(receiver, /fun peekPendingReplies\(context: Context\): String/);
assert.match(receiver, /fun acknowledgePendingReplies\(context: Context, idsJson: String\): Boolean/);
assert.match(receiver, /synchronized\(queueLock\)/);
assert.match(receiver, /prefs\.edit\(\)\.putString\(KEY_QUEUE, remaining\.toString\(\)\)\.commit\(\)/);
assert.match(receiver, /fun consumePendingReplies\(context: Context\): String/);
assert.match(receiver, /import androidx\.core\.app\.RemoteInput/);
assert.match(receiver, /current\.length\(\) >= MAX_QUEUE/);
assert.match(receiver, /refusing to drop an older reply/);

assert.match(activity, /fun peekPendingReplies\(\): String = NotificationReplyReceiver\.peekPendingReplies/);
assert.match(activity, /fun acknowledgePendingReplies\(idsJson: String\): Boolean/);
assert.match(activity, /fun consumePendingReplies\(\): String = NotificationReplyReceiver\.consumePendingReplies/);

assert.match(bridge, /api\.peekPendingReplies\(\)/);
assert.match(bridge, /acknowledgePendingReplies\?\.\(JSON\.stringify\(completedIds\)\)/);
assert.match(bridge, /const chatMessageId = "notification-reply-chat-" \+ item\.id/);
assert.match(bridge, /enqueuePendingLifeSceneReply/);
const persistIndex = bridge.indexOf("const result = mirrorNotificationReplyToLifeScene(item, text)");
const ackIndex = bridge.indexOf("if (durableBridge && completedIds.length > 0)", persistIndex);
assert.ok(persistIndex >= 0 && ackIndex > persistIndex, "native reply must be acknowledged only after web persistence");
assert.match(bridge, /result === "retry"/);
assert.match(bridge, /notificationReplyFlushPromise/);
assert.match(bridge, /flushPendingNotificationRepliesInternal/);
assert.match(bridge, /life-scene-notification-queue-updated/);
assert.match(bridge, /onLifeQueueUpdated/);
assert.match(bridge, /未确认原生通知队列/);

console.log("Life notification bridge durability checks passed.");