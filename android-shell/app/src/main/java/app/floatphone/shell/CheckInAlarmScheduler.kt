package app.floatphone.shell

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/**
 * Native check-in reminder scheduler.
 *
 * The WebView owns character policy and computes the next due time. Android owns
 * the one-shot wake-up and reminder, so the schedule does not depend on a JS timer.
 * A screenshot is NEVER taken by this receiver. The user must tap the notification;
 * only after the app is foregrounded does the web check-in flow request the native
 * preview and explicit approval.
 */
object CheckInAlarmScheduler {
    private const val PREFS = "native_check_in_schedule"
    private const val KEY_SCHEDULE = "schedule"
    private const val KEY_PENDING = "pending"
    private const val KEY_OPENED = "opened"
    const val ACTION_OPEN_REMINDER = "app.floatphone.shell.OPEN_CHECKIN_REMINDER"
    const val ACTION_OPEN_ACCESSIBILITY_SETTINGS = "app.floatphone.shell.OPEN_ACCESSIBILITY_SETTINGS"
    private const val ACTION_ALARM = "app.floatphone.shell.CHECKIN_ALARM"
    private const val CHANNEL = "shell_check_in_reminders"
    private const val NOTIFICATION_ID = 4107
    private const val ACCESSIBILITY_NOTICE_ID = 4108

    fun schedule(context: Context, json: String): Boolean = runCatching {
        val item = JSONObject(json)
        val characterId = item.optString("characterId").trim()
        val name = item.optString("name").trim().ifBlank { "角色" }
        val dueAt = item.optLong("dueAt", 0L)
        val configKey = item.optString("configKey", "")
        require(characterId.isNotEmpty() && dueAt > 0L)
        val normalized = JSONObject()
            .put("characterId", characterId)
            .put("name", name)
            .put("dueAt", dueAt)
            .put("configKey", configKey)
            .toString()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_SCHEDULE, normalized)
            .apply()
        arm(context, dueAt)
        true
    }.getOrDefault(false)

    fun cancel(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove(KEY_SCHEDULE)
            .remove(KEY_PENDING)
            .remove(KEY_OPENED)
            .apply()
        val alarm = alarmPendingIntent(context)
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(alarm)
    }

    fun restore(context: Context) {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_SCHEDULE, "").orEmpty()
        if (raw.isBlank()) return
        runCatching {
            val dueAt = JSONObject(raw).optLong("dueAt", 0L)
            if (dueAt > 0L) arm(context, dueAt)
        }
    }

    fun markReminderOpened(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_OPENED, true).apply()
    }

    fun hasPending(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_OPENED, false) &&
            prefs.getString(KEY_PENDING, "").orEmpty().isNotBlank()
    }

    fun hasScheduledCheckIn(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_SCHEDULE, "").orEmpty().isNotBlank()

    fun consumePending(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_OPENED, false)) return ""
        val value = prefs.getString(KEY_PENDING, "").orEmpty()
        if (value.isNotBlank()) {
            prefs.edit().remove(KEY_PENDING).remove(KEY_OPENED).apply()
        }
        return value
    }

    fun diagnosticsJson(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val scheduled = runCatching { JSONObject(prefs.getString(KEY_SCHEDULE, "").orEmpty()) }.getOrNull()
        val pending = runCatching { JSONObject(prefs.getString(KEY_PENDING, "").orEmpty()) }.getOrNull()
        val notificationsEnabled = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 ||
                context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED)
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val ignoringBatteryOptimizations = powerManager.isIgnoringBatteryOptimizations(context.packageName)
        return JSONObject()
            .put("scheduled", scheduled != null)
            .put("characterName", scheduled?.optString("name", "").orEmpty())
            .put("characterId", scheduled?.optString("characterId", "").orEmpty())
            .put("configKey", scheduled?.optString("configKey", "").orEmpty())
            .put("dueAt", scheduled?.optLong("dueAt", 0L) ?: 0L)
            .put("pending", pending != null)
            .put("opened", prefs.getBoolean(KEY_OPENED, false))
            .put("accessibilityConnected", ScreenshotBridge.isAccessibilityOn())
            .put("accessibilityEnabledInSettings", isAccessibilityEnabledInSettings(context))
            .put("notificationsEnabled", notificationsEnabled)
            .put("ignoringBatteryOptimizations", ignoringBatteryOptimizations)
            .toString()
    }

    /** 系统设置中是否仍勾选本无障碍服务；与进程内已连接实例分开判断。 */
    fun isAccessibilityEnabledInSettings(context: Context): Boolean {
        val enabled = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ).orEmpty()
        val expected = ComponentName(context, CallControlService::class.java).flattenToString()
        return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }

    fun clearAccessibilityRecoveryNotification(context: Context) {
        runCatching {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .cancel(ACCESSIBILITY_NOTICE_ID)
        }
    }

    /** 只提示修复，不尝试偷偷重启无障碍或截屏。 */
    fun showAccessibilityRecoveryNotification(context: Context, characterName: String = "角色") {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return
        if (!androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()) return

        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "角色查岗提醒与故障提示", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "角色查岗提醒，以及无障碍服务断开时的修复提示"
                },
            )
        }

        val enabledInSettings = isAccessibilityEnabledInSettings(context)
        val title = if (enabledInSettings) "查岗暂时无法运行：无障碍服务已断连"
            else "查岗暂时无法运行：无障碍服务未开启"
        val detail = if (enabledInSettings) {
            "$characterName 到了查岗时间，但系统设置虽然仍显示已开启，服务实例却没有连接，可能被系统回收。请打开无障碍设置，关闭后重新开启「小手机/通话控制服务」，再返回小手机。"
        } else {
            "$characterName 到了查岗时间，但小手机的无障碍服务当前未启用。请打开无障碍设置，找到「小手机/通话控制服务」并开启，再返回小手机。"
        }

        val openApp = Intent(context, MainActivity::class.java)
            .setAction(ACTION_OPEN_REMINDER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val contentIntent = PendingIntent.getActivity(
            context, 4108, openApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val accessibilityIntent = PendingIntent.getBroadcast(
            context, 4109,
            Intent(context, CheckInAccessibilitySettingsReceiver::class.java)
                .setAction(ACTION_OPEN_ACCESSIBILITY_SETTINGS),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val batteryIntent = PendingIntent.getActivity(
            context, 4110,
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText("点开查看原因和修复步骤")
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                "$detail\n\n如果反复断开：在系统的应用启动/电池管理中允许小手机自启动和后台运行，并将小手机从最近任务锁定。部分荣耀/华为系统的菜单名称可能不同。"
            ))
            .setContentIntent(contentIntent)
            .addAction(0, "打开无障碍设置", accessibilityIntent)
            .addAction(0, "电池后台设置", batteryIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        runCatching { manager.notify(ACCESSIBILITY_NOTICE_ID, notification) }
    }

    private fun alarmPendingIntent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context, 4107,
            Intent(context, CheckInAlarmReceiver::class.java).setAction(ACTION_ALARM),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun arm(context: Context, dueAt: Long) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = alarmPendingIntent(context)
        // Inexact + allow-while-idle avoids the special exact-alarm permission.
        // Do not promise minute-level precision; OEM battery policies may delay it.
        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt.coerceAtLeast(System.currentTimeMillis() + 5_000L), pending)
    }

    internal fun onAlarm(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_SCHEDULE, "").orEmpty()
        if (raw.isBlank()) return
        val item = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val characterId = item.optString("characterId").trim()
        if (characterId.isEmpty()) return
        val name = item.optString("name").ifBlank { "角色" }
        val pending = JSONObject().put("characterId", characterId).put("name", name).toString()
        // Keep the request until the WebView confirms it has consumed the event.
        prefs.edit().putString(KEY_PENDING, pending).putBoolean(KEY_OPENED, false).remove(KEY_SCHEDULE).apply()
        if (!ScreenshotBridge.isAccessibilityOn()) {
            showAccessibilityRecoveryNotification(context, name)
        } else {
            showReminder(context, characterId, name)
        }
    }

    private fun showReminder(context: Context, characterId: String, name: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "角色查岗提醒", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "角色到达查岗时间后提醒你；点开后才会请求屏幕预览"
                },
            )
        }
        val open = Intent(context, MainActivity::class.java)
            .setAction(ACTION_OPEN_REMINDER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("pending_check_in_character_id", characterId)
        val content = PendingIntent.getActivity(
            context, characterId.hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("$name 想找你")
            .setContentText("到了约定的查岗时间。点开后可以选择是否给 TA 看屏幕。")
            .setStyle(NotificationCompat.BigTextStyle().bigText("到了约定的查岗时间。点开小手机后才会请求屏幕预览；不会在后台自动截屏。"))
            .setContentIntent(content)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        runCatching { manager.notify(NOTIFICATION_ID, notification) }
    }
}

class CheckInAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == "app.floatphone.shell.CHECKIN_ALARM") {
            CheckInAlarmScheduler.onAlarm(context)
        }
    }
}


/** 用户点击修复按钮：先保留并标记待处理查岗，再打开系统无障碍设置。 */
class CheckInAccessibilitySettingsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != CheckInAlarmScheduler.ACTION_OPEN_ACCESSIBILITY_SETTINGS) return
        CheckInAlarmScheduler.markReminderOpened(context)
        runCatching {
            context.startActivity(
                Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }
}
