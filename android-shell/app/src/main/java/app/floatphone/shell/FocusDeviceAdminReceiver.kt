package app.floatphone.shell

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent

/**
 * L3 防绕过的设备管理员接收器（force-lock：锁屏）。
 * 用户在网页「锁机卡 → L3」里点引导后激活；激活后 DevicePolicyManager 提供：
 *  · lockNow()（一键锁屏，配合承诺书可做「失败即锁屏」）
 *  · 卸载保护（取消激活路径明确，防止静默绕过）
 * 本接收器只做最小实现：激活/禁用时给一条系统通知（用户知情）。
 */
class FocusDeviceAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        notify(context, "🛡 设备管理员已启用", "L3 死锁的防绕过能力已就绪（锁屏/卸载保护）。")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        notify(context, "设备管理员已停用", "L3 死锁的防绕过能力随之下线。")
    }

    private fun notify(context: Context, title: String, body: String) {
        runCatching {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                manager.createNotificationChannel(
                    android.app.NotificationChannel("focus_admin", "锁机·设备管理员", android.app.NotificationManager.IMPORTANCE_DEFAULT),
                )
            }
            val notification: android.app.Notification = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                android.app.Notification.Builder(context, "focus_admin")
                    .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setAutoCancel(true)
                    .build()
            } else {
                @Suppress("DEPRECATION")
                android.app.Notification.Builder(context)
                    .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setAutoCancel(true)
                    .build()
            }
            manager.notify(4701, notification)
        }
    }
}
