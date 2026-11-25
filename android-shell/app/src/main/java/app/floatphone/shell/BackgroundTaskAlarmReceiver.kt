package app.floatphone.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Native alarm receiver. It records a due marker and never captures the screen itself. */
class BackgroundTaskAlarmReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_CHECK_IN_DUE = "app.floatphone.shell.BACKGROUND_CHECK_IN_DUE"
        const val EXTRA_CHARACTER_ID = "character_id"
    }

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != ACTION_CHECK_IN_DUE) return
        val id = intent.getStringExtra(EXTRA_CHARACTER_ID)?.trim().orEmpty()
        if (id.isEmpty()) return
        BackgroundEnhancementManager.onAlarm(context, id)
    }
}
