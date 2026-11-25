package app.floatphone.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 专注通行证查岗原生闹钟：到点直接拉起 CheckInService 浮层。 */
class FocusPassCheckInAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != FocusPassCheckInScheduler.ACTION_DUE) return
        val passId = intent.getStringExtra(FocusPassCheckInScheduler.EXTRA_PASS_ID)?.trim().orEmpty()
        if (passId.isEmpty()) return
        FocusPassCheckInScheduler.onAlarm(context, passId)
    }
}
