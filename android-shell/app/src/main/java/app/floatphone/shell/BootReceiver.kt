package app.floatphone.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机恢复原生查岗提醒与推送服务（部分国产 ROM 需用户允许自启动）。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            runCatching { CheckInAlarmScheduler.restore(context) }
            runCatching { PushService.start(context) }
        }
    }
}
