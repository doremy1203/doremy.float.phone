package app.floatphone.shell

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

/**
 * 长时段「定时锁机」的原生排程（类似番茄 Todo 的定时锁机）。
 *
 * 网页只需要在预约/时间段保存时调用一次；到点由 AlarmManager 拉起
 * FocusLockService，所以即使 Float 进程被冻结、没有打开，也会自行锁机。
 * 白名单仍由 FocusLockService 的 packages 快照执行；通行证变化由网页
 * 通过 lockUpdate 追加到当前锁。
 */
object FocusLockScheduler {
    const val ACTION_DUE = "app.floatphone.shell.FOCUS_LOCK_SCHEDULE_DUE"
    const val EXTRA_ID = "schedule_id"

    private const val PREFS = "focus_lock_schedule_v1"
    private const val KEY_TASKS = "tasks"
    private const val KEY_ACTIVE = "active_id"

    fun schedule(
        context: Context,
        id: String,
        startAt: Long,
        endAt: Long,
        packagesJson: String,
        taLine: String,
        charName: String,
        dnd: Boolean,
        task: String,
        charIds: String,
        minutes: Int,
    ): Boolean = runCatching {
        val key = id.trim()
        if (key.isEmpty() || startAt <= 0L || endAt <= startAt) return@runCatching false
        val tasks = readTasks(context)
        val task = JSONObject()
            .put("id", key)
            .put("startAt", startAt)
            .put("endAt", endAt)
            .put("packages", packagesJson.ifBlank { "[]" })
            .put("taLine", taLine.take(400))
            .put("charName", charName.take(80))
            .put("dnd", dnd)
            .put("task", task.take(80))
            .put("charIds", charIds)
            .put("minutes", minutes.coerceIn(1, 600))
        tasks.put(key, task)
        writeTasks(context, tasks)
        if (endAt <= System.currentTimeMillis()) {
            tasks.remove(key)
            writeTasks(context, tasks)
            return@runCatching false
        }
        if (startAt <= System.currentTimeMillis() + 1_000L) {
            startLock(context, task)
            tasks.remove(key)
            writeTasks(context, tasks)
        } else {
            scheduleAlarm(context, key, startAt)
        }
        true
    }.getOrDefault(false)

    fun cancel(context: Context, id: String): Boolean = runCatching {
        val key = id.trim()
        if (key.isEmpty()) return@runCatching false
        val tasks = readTasks(context)
        tasks.remove(key)
        writeTasks(context, tasks)
        cancelAlarm(context, key)
        // 如果这条排程已经到点并启动了看守锁，取消预约也要把锁收掉；
        // 否则用户取消了预约，手机仍会被锁到原定结束时间。
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_ACTIVE, "") == key) {
            runCatching { FocusLockService.stop(context) }
            runCatching { DeviceActionBridge(context).setDnd(false) }
            prefs.edit().remove(KEY_ACTIVE).apply()
        }
        true
    }.getOrDefault(false)

    fun restore(context: Context) {
        val tasks = readTasks(context)
        val now = System.currentTimeMillis()
        val keys = tasks.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val task = tasks.optJSONObject(key) ?: continue
            val startAt = task.optLong("startAt", 0L)
            val endAt = task.optLong("endAt", 0L)
            when {
                endAt <= now -> {
                    tasks.remove(key)
                    cancelAlarm(context, key)
                }
                startAt <= now -> {
                    startLock(context, task)
                    tasks.remove(key)
                    cancelAlarm(context, key)
                }
                else -> scheduleAlarm(context, key, startAt)
            }
        }
        writeTasks(context, tasks)
    }

    internal fun onAlarm(context: Context, id: String) {
        val key = id.trim()
        if (key.isEmpty()) return
        val tasks = readTasks(context)
        val task = tasks.optJSONObject(key) ?: return
        tasks.remove(key)
        writeTasks(context, tasks)
        val endAt = task.optLong("endAt", 0L)
        if (endAt <= System.currentTimeMillis()) return
        startLock(context, task)
    }

    private fun startLock(context: Context, task: JSONObject) {
        val endAt = task.optLong("endAt", 0L)
        if (endAt <= System.currentTimeMillis()) return
        // 已经有一场专注/看守锁在跑：不要用预约的 until 重置当前计时基准
        // （否则会在专注中途把结束时间改短，或者把用户手动开始的锁覆盖掉）。
        val existing = FocusLockService.status(context)
        if (existing.optBoolean("running") && existing.optLong("until") > System.currentTimeMillis()) return
        val packages = task.optString("packages", "[]")
        val startAt = task.optLong("startAt", System.currentTimeMillis())
        val id = task.optString("id")
        ScheduledFocusStore.start(
            context,
            id,
            startAt,
            endAt,
            task.optString("task"),
            task.optString("charIds", "[]"),
            task.optInt("minutes", 25),
        )
        FocusLockService.setTaLine(
            context,
            task.optString("taLine"),
            task.optString("charName"),
        )
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_ACTIVE, task.optString("id")).apply()
        // 锁机与免打扰一起开；DndAutoRestore 会在 endAt 自动恢复。
        if (task.optBoolean("dnd", false)) {
            runCatching { DeviceActionBridge(context).setDnd(true, endAt) }
        }
        // 厂商后台限制/Android 12+ FGS 限制可能在这里抛异常；别让闹钟 receiver 崩掉。
        runCatching { FocusLockService.start(context, packages, endAt) }
    }

    private fun scheduleAlarm(context: Context, id: String, requestedAt: Long) {
        val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val triggerAt = requestedAt.coerceAtLeast(System.currentTimeMillis() + 1_000L)
        val pending = pendingIntent(context, id)
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarm.canScheduleExactAlarms()
        if (canExact) {
            runCatching { alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending) }
                .onFailure { alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending) }
        } else {
            alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
        }
    }

    private fun cancelAlarm(context: Context, id: String) {
        val pending = pendingIntent(context, id)
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pending)
        pending.cancel()
    }

    private fun pendingIntent(context: Context, id: String): PendingIntent {
        val intent = Intent(context, FocusLockScheduleReceiver::class.java)
            .setAction(ACTION_DUE)
            .putExtra(EXTRA_ID, id)
        return PendingIntent.getBroadcast(
            context,
            id.hashCode() and 0x7fffffff,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun readTasks(context: Context): JSONObject {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_TASKS, "{}") ?: "{}"
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    private fun writeTasks(context: Context, tasks: JSONObject) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_TASKS, tasks.toString()).apply()
    }
}

class FocusLockScheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != FocusLockScheduler.ACTION_DUE) return
        FocusLockScheduler.onAlarm(
            context,
            intent.getStringExtra(FocusLockScheduler.EXTRA_ID) ?: "",
        )
    }
}
