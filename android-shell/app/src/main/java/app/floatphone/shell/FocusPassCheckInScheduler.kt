package app.floatphone.shell

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

/**
 * 专注通行证查岗的原生定时器。
 *
 * 与 BackgroundEnhancementManager 的区别：那个到点只发通知，等网页回来处理；
 * 这个到点直接拉起 CheckInService 的查岗浮层，所以即使 float 进程已经被杀，
 * 用户在白名单应用里也能看到「TA 想看看你在干嘛…」。
 *
 * 结果由 CheckInService 落盘（pending_result），网页下次活着时消费并送进聊天室；
 * 角色判定仍走 focus App 的 passVerdict 工具。
 */
object FocusPassCheckInScheduler {
    const val ACTION_DUE = "app.floatphone.shell.FOCUS_PASS_CHECKIN_DUE"
    const val EXTRA_PASS_ID = "pass_id"

    private const val PREFS = "focus_pass_checkin_v1"
    private const val KEY_TASKS = "tasks"

    fun schedule(
        context: Context,
        passId: String,
        app: String,
        characterId: String,
        name: String,
        avatar: String,
        dueAtMillis: Long,
    ): Boolean = runCatching {
        val id = passId.trim()
        if (id.isEmpty()) return@runCatching false
        val tasks = readTasks(context)
        val task = JSONObject()
            .put("passId", id)
            .put("app", app.take(120))
            .put("characterId", characterId.take(120))
            .put("name", name.take(80))
            .put("avatar", avatar.take(400_000))
            .put("dueAt", dueAtMillis)
        tasks.put(id, task)
        writeTasks(context, tasks)
        scheduleAlarm(context, id, dueAtMillis)
        true
    }.getOrDefault(false)

    fun cancel(context: Context, passId: String): Boolean = runCatching {
        val id = passId.trim()
        if (id.isEmpty()) return@runCatching false
        val tasks = readTasks(context)
        tasks.remove(id)
        writeTasks(context, tasks)
        cancelAlarm(context, id)
        true
    }.getOrDefault(false)

    fun restore(context: Context) {
        val tasks = readTasks(context)
        val now = System.currentTimeMillis()
        val keys = tasks.keys()
        while (keys.hasNext()) {
            val id = keys.next()
            val task = tasks.optJSONObject(id) ?: continue
            val due = task.optLong("dueAt", 0L)
            if (due <= 0L) continue
            // 重启期间错过的，尽快补一次，而不是静默丢掉。
            scheduleAlarm(context, id, if (due <= now) now + 5_000L else due)
        }
    }

    internal fun onAlarm(context: Context, passId: String) {
        val id = passId.trim()
        if (id.isEmpty()) return
        val tasks = readTasks(context)
        val task = tasks.optJSONObject(id) ?: return
        // 一次性：先摘掉，避免重复弹。
        tasks.remove(id)
        writeTasks(context, tasks)
        CheckInService.showFromAlarm(
            context,
            task.optString("characterId"),
            task.optString("name").ifBlank { "TA" },
            task.optString("avatar"),
            id,
            task.optString("app"),
        )
    }

    private fun scheduleAlarm(context: Context, passId: String, requestedAt: Long) {
        val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val triggerAt = requestedAt.coerceAtLeast(System.currentTimeMillis() + 1_000L)
        val pending = pendingIntent(context, passId)
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarm.canScheduleExactAlarms()
        if (canExact) {
            runCatching { alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending) }
                .onFailure { alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending) }
        } else {
            alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
        }
    }

    private fun cancelAlarm(context: Context, passId: String) {
        val pending = pendingIntent(context, passId)
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pending)
        pending.cancel()
    }

    private fun pendingIntent(context: Context, passId: String): PendingIntent {
        val intent = Intent(context, FocusPassCheckInAlarmReceiver::class.java)
            .setAction(ACTION_DUE)
            .putExtra(EXTRA_PASS_ID, passId)
        return PendingIntent.getBroadcast(
            context,
            passId.hashCode() and 0x7fffffff,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun readTasks(context: Context): JSONObject {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_TASKS, "") ?: ""
        return runCatching { if (raw.isBlank()) JSONObject() else JSONObject(raw) }.getOrDefault(JSONObject())
    }

    private fun writeTasks(context: Context, tasks: JSONObject) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_TASKS, tasks.toString())
            .apply()
    }
}
