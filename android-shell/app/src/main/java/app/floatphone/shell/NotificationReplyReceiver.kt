package app.floatphone.shell

import androidx.core.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * 通知栏「直接回复」的接收端。
 * 原生队列采用 peek + ack：网页完成本地持久化后才确认，避免读走即清空造成进程中断丢消息。
 */
class NotificationReplyReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_REPLY = "app.floatphone.shell.NOTIF_REPLY"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_SCENE_ID = "life_scene_id"
        const val EXTRA_REPLY_MODE = "life_reply_mode"
        const val KEY_REPLY_TEXT = "reply_text"

        private const val PREFS = "shell_pending_replies"
        private const val KEY_QUEUE = "queue"
        private const val MAX_QUEUE = 100
        private const val TAG = "NotificationReply"
        private val queueLock = Any()

        /** Append and synchronously persist a reply before notifying the WebView. */
        fun enqueue(context: Context, sessionId: String, text: String, sceneId: String = "", replyMode: String = "chat"): Boolean = synchronized(queueLock) {
            runCatching {
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val current = JSONArray(prefs.getString(KEY_QUEUE, "[]") ?: "[]")
                if (current.length() >= MAX_QUEUE) {
                    Log.w(TAG, "Pending notification reply queue is full; refusing to drop an older reply.")
                    false
                } else {
                    current.put(
                        JSONObject()
                            .put("id", "r_" + UUID.randomUUID().toString())
                            .put("sessionId", sessionId)
                            .put("text", text)
                            .put("sceneId", sceneId)
                            .put("replyMode", replyMode)
                            .put("at", System.currentTimeMillis()),
                    )
                    check(prefs.edit().putString(KEY_QUEUE, current.toString()).commit()) { "无法持久化通知回复队列" }
                    true
                }
            }.getOrElse { error ->
                Log.e(TAG, "Unable to persist notification reply.", error)
                false
            }
        }
        /** Read without removing; JavaScript must acknowledge only after its own write succeeds. */
        fun peekPendingReplies(context: Context): String = synchronized(queueLock) {
            runCatching {
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_QUEUE, "[]") ?: "[]"
            }.getOrDefault("[]")
        }

        /** Remove only the IDs whose web-side persistence has completed. */
        fun acknowledgePendingReplies(context: Context, idsJson: String): Boolean = synchronized(queueLock) {
            runCatching {
                val idsArray = JSONArray(idsJson)
                val ids = buildSet { for (i in 0 until idsArray.length()) add(idsArray.optString(i)) }
                if (ids.isEmpty()) return@synchronized true
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val current = JSONArray(prefs.getString(KEY_QUEUE, "[]") ?: "[]")
                val remaining = JSONArray()
                for (i in 0 until current.length()) {
                    val item = current.optJSONObject(i) ?: continue
                    if (!ids.contains(item.optString("id"))) remaining.put(item)
                }
                prefs.edit().putString(KEY_QUEUE, remaining.toString()).commit()
            }.getOrDefault(false)
        }

        /** Legacy bridge for older web builds; new builds use peek + acknowledge. */
        fun consumePendingReplies(context: Context): String = synchronized(queueLock) {
            runCatching {
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val raw = prefs.getString(KEY_QUEUE, "[]") ?: "[]"
                prefs.edit().putString(KEY_QUEUE, "[]").commit()
                raw
            }.getOrDefault("[]")
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_REPLY) return
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        val sceneId = intent.getStringExtra(EXTRA_SCENE_ID).orEmpty()
        val replyMode = intent.getStringExtra(EXTRA_REPLY_MODE).orEmpty().ifEmpty { "chat" }
        if (sessionId.isEmpty()) return
        val results = RemoteInput.getResultsFromIntent(intent) ?: return
        val text = results.getCharSequence(KEY_REPLY_TEXT)?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        if (!enqueue(context, sessionId, text, sceneId, replyMode)) {
            Log.e(TAG, "Notification reply was not queued; refusing to report successful delivery.")
            Toast.makeText(context, "回复暂时未保存，请打开小手机后重试。", Toast.LENGTH_LONG).show()
            return
        }
        if (ShellBus.isWebAlive()) {
            ShellBus.dispatchOverlayEvent(
                "userReply",
                JSONObject().put("sessionId", sessionId).put("sceneId", sceneId).put("replyMode", replyMode),
            )
            return
        }
        runCatching {
            context.startActivity(
                Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    putExtra(
                        MainActivity.EXTRA_OPEN_URL,
                        MainActivity.SITE_URL.trimEnd('/') +
                            (if (sceneId.isNotEmpty()) "/life?sceneId=" + android.net.Uri.encode(sceneId) else "/#open-chat=" + android.net.Uri.encode(sessionId)),
                    )
                },
            )
        }
    }
}