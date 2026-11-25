package app.floatphone.shell

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Durable, one-shot native wake-up hints for WebView-owned work.
 *
 * Alarms never take screenshots or execute AI code. If the WebView is unavailable,
 * the receiver stores a pending marker and asks the user to reopen the app.
 * All alarms are inexact; exact-alarm access is deliberately not required.
 */
object BackgroundEnhancementManager {
    private const val PREFS = "background_enhancement_v1"
    private const val KEY_MODE = "mode"
    private const val KEY_TASKS = "checkin_tasks"
    private const val KEY_FOREGROUND = "host_foreground"
    private const val CHANNEL_ID = "background_task_alerts"
    private const val NOTIFICATION_BASE = 8400
    private const val MODE_SMART = "smart"
    private const val MODE_ENHANCED = "enhanced"

    @Volatile private var hostForeground = false
    private val lock = Any()

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun mode(context: Context): String =
        prefs(context).getString(KEY_MODE, MODE_SMART) ?: MODE_SMART

    fun setMode(context: Context, value: String): Boolean {
        val normalized = if (value == MODE_ENHANCED) MODE_ENHANCED else MODE_SMART
        val saved = prefs(context).edit().putString(KEY_MODE, normalized).commit()
        if (!saved) return false
        synchronized(lock) {
            val tasks = readTasks(context)
            if (normalized == MODE_ENHANCED) {
                val now = System.currentTimeMillis()
                for (i in 0 until tasks.length()) {
                    val task = tasks.optJSONObject(i) ?: continue
                    if (task.optBoolean("fired")) continue
                    val due = if (task.optBoolean("backgroundOnly")) {
                        if (hostForeground || prefs(context).getBoolean(KEY_FOREGROUND, true)) continue
                        now + task.optLong("remainingMs", 0L).coerceAtLeast(0L)
                    } else task.optLong("dueAt", now).coerceAtLeast(now)
                    task.put("dueAt", due)
                    scheduleAlarm(context, task.optString("id"), due)
                }
            } else {
                for (i in 0 until tasks.length()) {
                    val task = tasks.optJSONObject(i) ?: continue
                    cancelAlarm(context, task.optString("id"))
                    if (task.optBoolean("backgroundOnly")) task.put("dueAt", 0L)
                }
                writeTasks(context, tasks)
            }
        }
        return true
    }

    fun onHostBackground(context: Context) {
        hostForeground = false
        prefs(context).edit().putBoolean(KEY_FOREGROUND, false).commit()
        if (mode(context) != MODE_ENHANCED) return
        synchronized(lock) {
            val tasks = readTasks(context)
            for (i in 0 until tasks.length()) {
                val task = tasks.optJSONObject(i) ?: continue
                if (!task.optBoolean("backgroundOnly") || task.optBoolean("fired")) continue
                val remaining = task.optLong("remainingMs", 0L).coerceAtLeast(0L)
                val dueAt = System.currentTimeMillis() + remaining
                task.put("dueAt", dueAt)
                scheduleAlarm(context, task.optString("id"), dueAt)
            }
            writeTasks(context, tasks)
        }
    }

    fun onHostForeground(context: Context) {
        hostForeground = true
        prefs(context).edit().putBoolean(KEY_FOREGROUND, true).commit()
        synchronized(lock) {
            val tasks = readTasks(context)
            val now = System.currentTimeMillis()
            for (i in 0 until tasks.length()) {
                val task = tasks.optJSONObject(i) ?: continue
                if (!task.optBoolean("backgroundOnly")) continue
                cancelAlarm(context, task.optString("id"))
                val dueAt = task.optLong("dueAt", 0L)
                if (dueAt > 0L && !task.optBoolean("fired")) {
                    task.put("remainingMs", (dueAt - now).coerceAtLeast(0L))
                }
                task.put("dueAt", 0L)
            }
            writeTasks(context, tasks)
        }
    }

    /**
     * dueAtMillis is used for wall-clock mode. remainingBackgroundMs is used for
     * background-only mode and is armed only while the Activity is stopped.
     */
    fun scheduleCheckIn(
        context: Context,
        characterId: String,
        characterName: String,
        dueAtMillis: Long,
        remainingBackgroundMs: Long,
        backgroundOnly: Boolean,
    ): Boolean = runCatching {
        val id = characterId.trim()
        require(id.isNotEmpty())
        synchronized(lock) {
            val tasks = readTasks(context)
            val existing = findTask(tasks, id)
            val nextDueAt = if (backgroundOnly) 0L else dueAtMillis.coerceAtLeast(0L)
            val nextRemaining = if (backgroundOnly) remainingBackgroundMs.coerceAtLeast(0L) else 0L
            val foreground = hostForeground || prefs(context).getBoolean(KEY_FOREGROUND, true)
            val desiredBackgroundDueAt = if (backgroundOnly && !foreground) System.currentTimeMillis() + nextRemaining else 0L
            if (existing != null) {
                val sameMode = existing.optBoolean("backgroundOnly") == backgroundOnly
                val sameTarget = sameMode && if (backgroundOnly) {
                    if (foreground) existing.optLong("remainingMs") == nextRemaining
                    else existing.optLong("dueAt") > 0L && kotlin.math.abs(existing.optLong("dueAt") - desiredBackgroundDueAt) < 60_000L
                } else existing.optLong("dueAt") == nextDueAt
                if (sameTarget && !existing.optBoolean("fired")) return@synchronized true
                cancelAlarm(context, id)
                existing.put("name", characterName.take(80))
                    .put("backgroundOnly", backgroundOnly)
                    .put("dueAt", nextDueAt)
                    .put("remainingMs", nextRemaining)
                    .put("fired", false)
            } else {
                tasks.put(JSONObject()
                    .put("id", id)
                    .put("name", characterName.take(80))
                    .put("backgroundOnly", backgroundOnly)
                    .put("dueAt", nextDueAt)
                    .put("remainingMs", nextRemaining)
                    .put("fired", false))
            }
            writeTasks(context, tasks)
            if (mode(context) != MODE_ENHANCED) return@synchronized Unit
            if (backgroundOnly) {
                if (!foreground) {
                    val due = System.currentTimeMillis() + nextRemaining
                    findTask(tasks, id)?.put("dueAt", due)
                    writeTasks(context, tasks)
                    scheduleAlarm(context, id, due)
                } else {
                    Unit
                }
            } else {
                scheduleAlarm(context, id, nextDueAt)
            }
            Unit
        }
        true
    }.getOrDefault(false)

    fun cancelCheckIn(context: Context, characterId: String): Boolean = runCatching {
        synchronized(lock) {
            cancelAlarm(context, characterId)
            runCatching {
                NotificationManagerCompat.from(context).cancel(NOTIFICATION_BASE + (characterId.hashCode() and 0x7fff))
            }
            val tasks = readTasks(context)
            val remaining = JSONArray()
            for (i in 0 until tasks.length()) {
                val item = tasks.optJSONObject(i) ?: continue
                if (item.optString("id") != characterId) remaining.put(item)
            }
            writeTasks(context, remaining)
        }
        true
    }.getOrDefault(false)

    /** Re-arm persisted tasks after BOOT_COMPLETED. Background intervals restart from boot. */
    fun restore(context: Context) {
        hostForeground = false
        prefs(context).edit().putBoolean(KEY_FOREGROUND, false).commit()
        if (mode(context) != MODE_ENHANCED) return
        synchronized(lock) {
            val tasks = readTasks(context)
            val now = System.currentTimeMillis()
            for (i in 0 until tasks.length()) {
                val task = tasks.optJSONObject(i) ?: continue
                if (task.optBoolean("fired")) continue
                val due = if (task.optBoolean("backgroundOnly")) {
                    now + task.optLong("remainingMs", 0L).coerceAtLeast(0L)
                } else {
                    task.optLong("dueAt", now).coerceAtLeast(now)
                }
                task.put("dueAt", due)
                scheduleAlarm(context, task.optString("id"), due)
            }
            writeTasks(context, tasks)
        }
    }

    internal fun onAlarm(context: Context, characterId: String) {
        var name = "角色"
        var shouldNotify = false
        synchronized(lock) {
            val tasks = readTasks(context)
            val task = findTask(tasks, characterId) ?: return
            if (task.optBoolean("fired")) return
            name = task.optString("name").ifBlank { "角色" }
            task.put("fired", true).put("dueAt", 0L)
            writeTasks(context, tasks)
            shouldNotify = !(hostForeground || prefs(context).getBoolean(KEY_FOREGROUND, false))
        }
        if (shouldNotify) postDueNotification(context, characterId, name)
    }

    fun diagnosticsJson(context: Context): String = runCatching {
        val app = context.applicationContext
        val power = app.getSystemService(Context.POWER_SERVICE) as PowerManager
        val accessibility = Settings.Secure.getString(
            app.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ).orEmpty()
        val tasks = readTasks(app)
        val pending = JSONArray()
        for (i in 0 until tasks.length()) {
            val item = tasks.optJSONObject(i) ?: continue
            pending.put(JSONObject()
                .put("name", item.optString("name"))
                .put("backgroundOnly", item.optBoolean("backgroundOnly"))
                .put("fired", item.optBoolean("fired"))
                .put("dueAt", item.optLong("dueAt")))
        }
        val exactAlarmAccess = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (app.getSystemService(Context.ALARM_SERVICE) as AlarmManager).canScheduleExactAlarms()
        } else true
        JSONObject()
            .put("available", true)
            .put("mode", mode(app))
            .put("manufacturer", Build.MANUFACTURER)
            .put("model", Build.MODEL)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("batteryOptimizationIgnored", power.isIgnoringBatteryOptimizations(app.packageName))
            .put("notificationsEnabled", NotificationManagerCompat.from(app).areNotificationsEnabled())
            .put("overlayGranted", Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(app))
            .put("accessibilityEnabled", accessibility.contains("CallControlService"))
            .put("exactAlarmAccess", exactAlarmAccess)
            .put("exactAlarmUsed", false)
            .put("foreground", hostForeground || prefs(app).getBoolean(KEY_FOREGROUND, true))
            .put("pendingCheckIns", pending)
            .toString()
    }.getOrDefault("{\"available\":false}")

    fun openSettings(context: Context, kind: String): Boolean = runCatching {
        val app = context.applicationContext
        val intent = when (kind) {
            "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, app.packageName)
            "overlay" -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + app.packageName))
            "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            "autostart", "app" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + app.packageName))
            else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + app.packageName))
        }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(intent)
        true
    }.getOrDefault(false)

    private fun readTasks(context: Context): JSONArray = runCatching {
        JSONArray(prefs(context).getString(KEY_TASKS, "[]") ?: "[]")
    }.getOrDefault(JSONArray())

    private fun writeTasks(context: Context, tasks: JSONArray) {
        prefs(context).edit().putString(KEY_TASKS, tasks.toString()).commit()
    }

    private fun findTask(tasks: JSONArray, id: String): JSONObject? {
        for (i in 0 until tasks.length()) {
            val item = tasks.optJSONObject(i) ?: continue
            if (item.optString("id") == id) return item
        }
        return null
    }

    private fun scheduleAlarm(context: Context, id: String, requestedAt: Long) {
        val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val triggerAt = requestedAt.coerceAtLeast(System.currentTimeMillis() + 1000L)
        val intent = Intent(context, BackgroundTaskAlarmReceiver::class.java)
            .setAction(BackgroundTaskAlarmReceiver.ACTION_CHECK_IN_DUE)
            .putExtra(BackgroundTaskAlarmReceiver.EXTRA_CHARACTER_ID, id)
        val pending = PendingIntent.getBroadcast(
            context, id.hashCode() and 0x7fffffff, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Inexact allow-while-idle alarm: a wake-up hint, not a promise of exact timing.
        alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
    }

    private fun cancelAlarm(context: Context, id: String) {
        val intent = Intent(context, BackgroundTaskAlarmReceiver::class.java)
            .setAction(BackgroundTaskAlarmReceiver.ACTION_CHECK_IN_DUE)
            .putExtra(BackgroundTaskAlarmReceiver.EXTRA_CHARACTER_ID, id)
        val pending = PendingIntent.getBroadcast(
            context, id.hashCode() and 0x7fffffff, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pending)
        pending.cancel()
    }

    private fun postDueNotification(context: Context, id: String, name: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_ID, "后台任务提醒", NotificationManager.IMPORTANCE_DEFAULT
            ).apply { description = "提醒你打开小手机处理已到期的后台任务。" })
        }
        val open = PendingIntent.getActivity(
            context, NOTIFICATION_BASE + (id.hashCode() and 0x7fff),
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("查岗时间到了")
            .setContentText("$name 已到查岗时间。打开小手机后继续处理；不会在后台偷偷截屏。")
            .setStyle(NotificationCompat.BigTextStyle().bigText("$name 已到查岗时间。系统已保存提醒；打开小手机后会重新检查角色状态并继续处理。截图仍需经过现有权限与用户确认流程。"))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { manager.notify(NOTIFICATION_BASE + (id.hashCode() and 0x7fff), notification) }
    }
}
