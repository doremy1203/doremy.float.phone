package app.floatphone.shell

import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject

/**
 * 通知栏「直接回复」的接收端。
 *
 * 场景：角色发来一条消息（含查岗的反馈），通知横幅上带一个回复框，
 * 用户就地打一句发出去——不用点开 App。
 *
 * 为什么走「先入队、再戳网页」两步，而不是直接把文本塞给 WebView：
 *   聊天引擎整个跑在 WebView 的 JS 里。App 切到后台时页面还在，但 App 被系统
 *   回收时页面就没了——那一刻事件根本送不到。若只走事件，用户从通知里打的
 *   那句话会凭空消失。所以先把回复落进持久队列（SharedPreferences），
 *   页面活着就当场拉走，页面没了就等它下次挂载时补发。
 *
 * 边界：
 *  - 只处理「用户主动从通知里回的话」，不读通知内容、不改任何会话数据。
 *  - 队列有上限，超出后丢最旧的，不会无限增长。
 */
class NotificationReplyReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_REPLY = "app.floatphone.shell.NOTIF_REPLY"
        const val EXTRA_SESSION_ID = "session_id"

        /** RemoteInput 的键名；发通知与读结果必须用同一个。 */
        const val KEY_REPLY_TEXT = "reply_text"

        private const val PREFS = "shell_pending_replies"
        private const val KEY_QUEUE = "queue"

        /** 队列上限：够覆盖「用户连回几句、页面一直没起来」的情况。 */
        private const val MAX_QUEUE = 20
        private val queueLock = Any()

        /** 追加一条待发回复。 */
        fun enqueue(context: Context, sessionId: String, text: String) {
            runCatching {
                synchronized(queueLock) {
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val current = JSONArray(prefs.getString(KEY_QUEUE, "[]") ?: "[]")
                current.put(
                    JSONObject()
                        .put("id", "r_${System.currentTimeMillis()}_${(0..9999).random()}")
                        .put("sessionId", sessionId)
                        .put("text", text)
                        .put("at", System.currentTimeMillis()),
                )
                // 只留最近 MAX_QUEUE 条：队列是「怕丢」的兜底，不是历史存档。
                val trimmed = JSONArray()
                val start = (current.length() - MAX_QUEUE).coerceAtLeast(0)
                for (i in start until current.length()) trimmed.put(current.get(i))
                prefs.edit().putString(KEY_QUEUE, trimmed.toString()).commit()
                }
            }
        }

        /** 旧网页兼容接口：读取并清空，保持旧版 WebView 桥接行为。 */
        fun consumePendingReplies(context: Context): String =
            runCatching {
                synchronized(queueLock) {
                    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    val raw = prefs.getString(KEY_QUEUE, "[]") ?: "[]"
                    prefs.edit().putString(KEY_QUEUE, "[]").commit()
                    raw
                }
            }.getOrDefault("[]")

        /** 新网页使用 peek + ack，页面异常退出时未确认的回复会保留待重试。 */
        fun readPendingReplies(context: Context): String =
            runCatching {
                synchronized(queueLock) {
                    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    prefs.getString(KEY_QUEUE, "[]") ?: "[]"
                }
            }.getOrDefault("[]")

        /** 仅删除网页已成功写入聊天的回复；未确认项会在下次页面启动时重试。 */
        fun ackPendingReplies(context: Context, idsJson: String) {
            runCatching {
                synchronized(queueLock) {
                val ids = JSONArray(idsJson)
                val acknowledged = (0 until ids.length()).mapNotNull { ids.optString(it).takeIf { value -> value.isNotBlank() } }.toSet()
                if (acknowledged.isEmpty()) return
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val current = JSONArray(prefs.getString(KEY_QUEUE, "[]") ?: "[]")
                val remaining = JSONArray()
                for (i in 0 until current.length()) {
                    val item = current.optJSONObject(i) ?: continue
                    if (item.optString("id") !in acknowledged) remaining.put(item)
                }
                prefs.edit().putString(KEY_QUEUE, remaining.toString()).commit()
                }
            }
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_REPLY) return
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        if (sessionId.isEmpty()) return

        val results = RemoteInput.getResultsFromIntent(intent) ?: return
        val text = results.getCharSequence(KEY_REPLY_TEXT)?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return

        // 先落队列：无论页面现在活不活着，这句话都不会丢。
        enqueue(context, sessionId, text)

        if (ShellBus.isWebAlive()) {
            // 页面还在（App 只是切到后台）：戳一下，它立刻把队列拉走发出去。
            ShellBus.dispatchOverlayEvent(
                "userReply",
                JSONObject().put("sessionId", sessionId),
            )
            return
        }

        // 页面已被系统回收：必须把 App 拉起来才能跑聊天引擎（它整个在 JS 里）。
        // 这是本地方案的真实代价——页面活着时回复无感，页面没了就得开一次 App。
        // 回复本身仍在队列里，不会因为这次拉起失败而丢。
        runCatching {
            context.startActivity(
                Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    putExtra(
                        MainActivity.EXTRA_OPEN_URL,
                        MainActivity.SITE_URL.trimEnd('/') +
                            "/#open-chat=" + android.net.Uri.encode(sessionId),
                    )
                },
            )
        }
    }
}
