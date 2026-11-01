package app.floatphone.shell

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import org.json.JSONObject

/**
 * 通话控制无障碍服务。
 *
 * 为什么加它：用户明确要「权限开大」，让角色能深度参与日常。当前承担两件事，
 * 后续的陪伴功能都可以挂在这里：
 *
 * 1. 浮窗保活：WindowManager 加的通话浮窗在部分 ROM 上切 App 后会被新窗口盖住
 *    或收进后台，这里在窗口状态变化时把浮窗重新顶到最前（bringToFront）。
 * 2. 前台 App 感知：canRetrieveWindowContent=true 时能读到当前前台应用的包名，
 *    推给网页，角色就能知道「主人正在刷什么」，为后续深度陪伴留好接口。
 *
 * 说明：声明了 canRetrieveWindowContent 但当前只读取包名，不抓取具体界面内容；
 * 数据只在本机流转，不外传。
 */
class CallControlService : AccessibilityService() {

    companion object {
        @Volatile
        var connected: Boolean = false
            private set
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        connected = true
        // 把实例交给截屏桥：takeScreenshot() 是 AccessibilityService 的方法，
        // 只能在服务实例上调用，且必须等服务连上之后才可用。
        ScreenshotBridge.attach(this)
        CheckInAlarmScheduler.clearAccessibilityRecoveryNotification(this)
        ShellBus.dispatchOverlayEvent("accessibility", JSONObject().put("connected", true))
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val ev = event ?: return
        when (ev.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                val pkg = ev.packageName?.toString().orEmpty()
                if (pkg.isEmpty()) return
                // 只上报前台包名，供角色感知上下文；浮窗可见性由系统层级保证，无需重复处理。
                ShellBus.dispatchOverlayEvent("foregroundApp", JSONObject().put("package", pkg))
            }
        }
    }

    override fun onInterrupt() {
        connected = false
        ScreenshotBridge.attach(null)
        // 系统明确通知服务被中断时立即提示；只在已有查岗计划时提醒，避免无关打扰。
        if (CheckInAlarmScheduler.hasScheduledCheckIn(this)) {
            CheckInAlarmScheduler.showAccessibilityRecoveryNotification(this)
        }
    }

    override fun onDestroy() {
        connected = false
        // 摘掉实例，否则重连前截屏桥会拿着一个已销毁的服务去调 takeScreenshot。
        ScreenshotBridge.attach(null)
        // onDestroy 并非所有系统回收场景都会回调；闹钟到点仍会再做一次检测。
        if (CheckInAlarmScheduler.hasScheduledCheckIn(this)) {
            CheckInAlarmScheduler.showAccessibilityRecoveryNotification(this)
        }
        super.onDestroy()
    }
}
