package app.floatphone.shell

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/** 专注结束/进程被杀后，把 App 开启的勿扰恢复，避免手机一直静音。 */
object DndAutoRestore {
    const val ACTION = "app.floatphone.shell.DND_AUTO_RESTORE"
    private const val PREFS = "device_action_dnd_v1"
    private const val KEY_UNTIL = "auto_restore_at"

    fun schedule(context: Context, untilMs: Long) {
        if (untilMs <= System.currentTimeMillis()) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong(KEY_UNTIL, untilMs).apply()
        val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = pending(context)
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarm.canScheduleExactAlarms()
        if (canExact) {
            runCatching { alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, untilMs, pending) }
                .onFailure { alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, untilMs, pending) }
        } else {
            alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, untilMs, pending)
        }
    }

    fun cancel(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_UNTIL).apply()
        val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = pending(context)
        alarm.cancel(pending)
        pending.cancel()
    }

    fun restore(context: Context) {
        val until = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getLong(KEY_UNTIL, 0L)
        if (until <= 0L) return
        if (until > System.currentTimeMillis()) {
            schedule(context, until)
            return
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_UNTIL).apply()
        runCatching { DeviceActionBridge(context).setDnd(false) }
    }

    private fun pending(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context,
        0x0D0D,
        Intent(context, DndAutoRestoreReceiver::class.java).setAction(ACTION),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

class DndAutoRestoreReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != DndAutoRestore.ACTION) return
        DndAutoRestore.restore(context)
    }
}
