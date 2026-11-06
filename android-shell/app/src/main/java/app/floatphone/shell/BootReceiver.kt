package app.floatphone.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机自启推送服务（部分国产 ROM 需用户在系统设置里允许自启动才会生效）。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            // 本机规则执行器不依赖推送服务或网页登录态。
            runCatching { NativeRealityBridge.capture(context, "设备启动", "手机已重新启动") }
            runCatching { PushService.start(context) }
        }
    }
}
