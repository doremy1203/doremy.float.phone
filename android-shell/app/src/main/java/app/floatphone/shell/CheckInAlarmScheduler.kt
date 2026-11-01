package app.floatphone.shell

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
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
    private const val ACTION_ALARM = "app.floatphone.shell.CHECKIN_ALARM"
    private const val CHANNEL = "shell_check_in_reminders"
    private const val NOTIFICATION_ID = 4107

    fun schedule(context: Context, json: String): Boolean = runCatching {
        val item = JSONObject(json)
        val characterId = item.optString("characterId").trim()
        val name = item.optString("name").trim().ifBlank { "角色" }
        val dueAt = item.optLong("dueAt", 0L)
        require(characterId.isNotEmpty() && dueAt > 0L)
        val normalized = JSONObject()
            .put("characterId", characterId)
            .put("name", name)
            .put("dueAt", dueAt)
            .toString()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_SCHEDULE, normalized)
            .apply()
        arm(context, dueAt)
        true
    }.getOrDefault(false)

    fun cancel(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove(KEY_SCHEDULE).apply()
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

    fun consumePending(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_OPENED, false)) return ""
        val value = prefs.getString(KEY_PENDING, "").orEmpty()
        if (value.isNotBlank()) {
            prefs.edit().remove(KEY_PENDING).remove(KEY_OPENED).apply()
        }
        return value
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
        prefs.edit().putString(KEY_PENDING, pending).remove(KEY_SCHEDULE).apply()
        showReminder(context, characterId, name)
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
