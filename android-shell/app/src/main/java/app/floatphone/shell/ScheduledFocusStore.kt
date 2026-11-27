package app.floatphone.shell

import android.content.Context
import org.json.JSONObject

/**
 * 原生定时锁机启动时留下的“待同步专注记录”。
 *
 * 网页可能被冻结/杀掉；等它恢复后取走这条记录，补成正常 session，
 * 这样定时锁机的时长也能进入专注统计和专注币结算。
 */
object ScheduledFocusStore {
    private const val PREFS = "scheduled_focus_v1"
    private const val KEY_PENDING = "pending"

    fun start(
        context: Context,
        id: String,
        startAt: Long,
        endAt: Long,
        task: String,
        charIds: String,
        minutes: Int,
    ) {
        val record = JSONObject()
            .put("id", id)
            .put("startAt", startAt)
            .put("endAt", endAt)
            .put("task", task.take(80))
            .put("charIds", charIds)
            .put("minutes", minutes.coerceIn(1, 600))
            .put("createdAt", System.currentTimeMillis())
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_PENDING, record.toString()).apply()
    }

    /** 取走即清，避免网页重复补 session / 重复发币。 */
    fun consume(context: Context): String {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = p.getString(KEY_PENDING, "") ?: ""
        if (raw.isNotBlank()) p.edit().remove(KEY_PENDING).apply()
        return raw
    }
}
