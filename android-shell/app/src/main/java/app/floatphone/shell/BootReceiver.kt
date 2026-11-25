package app.floatphone.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restore persisted native alarms after reboot; OEM autostart settings may still block delivery. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            // Restore one-shot reminders first. Background-only intervals restart from boot;
            // powered-off time is not counted as active background time.
            runCatching { BackgroundEnhancementManager.restore(context) }
            // 专注通行证查岗：重启后把还没到点的原生查岗闹钟重新排上。
            runCatching { FocusPassCheckInScheduler.restore(context) }
            // Keep the existing push behavior unchanged for compatibility.
            runCatching { NativeRealityBridge.capture(context, "设备启动", "手机已重新启动") }
            runCatching { PushService.start(context) }
            // 锁机会话恢复（elapsed 基准重锚；改系统时间无法绕过剩余计算）
            runCatching { FocusLockService.restore(context) }
            // 专注倒计时桌面组件：重设 Chronometer 基准（重启后 elapsed 清零）
            runCatching { FocusWidgetProvider.pushAll(context) }
        }
    }
}
