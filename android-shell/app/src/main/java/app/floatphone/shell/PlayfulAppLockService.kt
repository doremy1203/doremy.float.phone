package app.floatphone.shell

import android.app.AppOpsManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.inputmethod.InputMethodManager
import org.json.JSONObject
import java.security.SecureRandom

/**
 * 角色应用限制：只限制一个指定应用。
 *
 * 这是轻量互动限制，不是设备安全锁；用户可返回与发起角色的私聊协商解除。
 * 锁定有最长时限，且不会覆盖另一个角色尚未结束的锁。
 */
class PlayfulAppLockService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var polling = false
    private var lastShowAt = 0L
    private lateinit var prefs: android.content.SharedPreferences

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        when (intent?.getStringExtra("action")) {
            "stop" -> {
                stopLock()
                return START_NOT_STICKY
            }
            "temporary-pass" -> {
                val minutes = (intent.getIntExtra("minutes", 1)).coerceIn(1, 5)
                prefs.edit().putLong("passUntil", System.currentTimeMillis() + minutes * 60_000L).apply()
                PlayfulLockActivity.dismissCurrent()
                if (!polling && (prefs.getString("target", "") ?: "").isNotBlank()) {
                    polling = true
                    startForegroundInternal()
                    handler.postDelayed(poll, 1200)
                }
                return if (prefs.getBoolean("running", false)) START_STICKY else START_NOT_STICKY
            }
        }

        val target = intent?.getStringExtra("target") ?: prefs.getString("target", "") ?: ""
        if (target.isBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        val expiresAt = intent?.getLongExtra("expiresAt", 0L)?.takeIf { it > 0L }
            ?: prefs.getLong("expiresAt", 0L).takeIf { it > 0L }
            ?: (System.currentTimeMillis() + 30 * 60_000L)
        if (expiresAt > 0L && expiresAt <= System.currentTimeMillis()) {
            stopLock()
            return START_NOT_STICKY
        }
        prefs.edit()
            .putBoolean("running", true)
            .putString("target", target)
            .putString("label", intent?.getStringExtra("label") ?: prefs.getString("label", "") ?: "")
            .putString("password", intent?.getStringExtra("password") ?: prefs.getString("password", "") ?: "")
            .putString("charId", intent?.getStringExtra("charId") ?: prefs.getString("charId", "") ?: "")
            .putString("sessionId", intent?.getStringExtra("sessionId") ?: prefs.getString("sessionId", "") ?: "")
            .putString("charName", intent?.getStringExtra("charName") ?: prefs.getString("charName", "") ?: "")
            .putString("avatar", intent?.getStringExtra("avatar") ?: prefs.getString("avatar", "") ?: "")
            .putString("style", intent?.getStringExtra("style") ?: prefs.getString("style", "{}") ?: "{}")
            .putLong("expiresAt", expiresAt)
            .apply()
        if (!polling) {
            polling = true
            startForegroundInternal()
            handler.postDelayed(poll, 1200)
        }
        return START_STICKY
    }

    private val poll = object : Runnable {
        override fun run() {
            if (!polling) return
            if (!prefs.getBoolean("running", false)) {
                stopLock()
                return
            }
            val now = System.currentTimeMillis()
            var expiresAt = prefs.getLong("expiresAt", 0L)
            if (expiresAt <= 0L) {
                expiresAt = now + 30 * 60_000L
                prefs.edit().putLong("expiresAt", expiresAt).apply()
            }
            if (expiresAt > 0L && now >= expiresAt) {
                stopLock()
                return
            }
            // 专注锁优先：专注期间不弹应用限制页，避免两套锁页抢焦点。
            val focus = FocusLockService.status(this@PlayfulAppLockService)
            if (focus.optBoolean("running") && focus.optLong("until") > now) {
                handler.postDelayed(this, 1500)
                return
            }
            if (prefs.getLong("passUntil", 0L) > now) {
                handler.postDelayed(this, 1000)
                return
            }
            val target = prefs.getString("target", "") ?: ""
            val fg = currentForegroundPackage()
            // 按较短冷却重试：用户按返回离开锁页后，不会在目标应用里长时间裸奔。
            if (target.isNotBlank() && fg == target && now - lastShowAt > 2500L) {
                lastShowAt = now
                runCatching {
                    startActivity(
                        Intent(this@PlayfulAppLockService, PlayfulLockActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                            .putExtra(PlayfulLockActivity.EXTRA_TARGET, target)
                            .putExtra(PlayfulLockActivity.EXTRA_LABEL, prefs.getString("label", "") ?: "")
                            .putExtra(PlayfulLockActivity.EXTRA_CHAR_NAME, prefs.getString("charName", "") ?: "")
                            .putExtra(PlayfulLockActivity.EXTRA_AVATAR, prefs.getString("avatar", "") ?: "")
                            .putExtra(PlayfulLockActivity.EXTRA_STYLE, prefs.getString("style", "{}") ?: "{}")
                            .putExtra(PlayfulLockActivity.EXTRA_EXPIRES_AT, expiresAt)
                    )
                }
            }
            handler.postDelayed(this, 1200)
        }
    }

    private fun currentForegroundPackage(): String {
        val usagePackage = try {
            val usm = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
            val now = System.currentTimeMillis()
            val events = usm.queryEvents(now - 12_000L, now)
            var last = ""
            val ev = UsageEvents.Event()
            while (events.hasNextEvent()) {
                events.getNextEvent(ev)
                if (ev.eventType == UsageEvents.Event.ACTIVITY_RESUMED) last = ev.packageName ?: ""
            }
            last
        } catch (_: Throwable) { "" }
        return usagePackage.ifBlank { accessibilityForegroundPackage() }
    }

    private fun accessibilityForegroundPackage(): String {
        val perception = getSharedPreferences("native_background_perception", Context.MODE_PRIVATE)
        val updatedAt = perception.getLong("current_package_updated_at", 0L)
        if (updatedAt <= 0L || System.currentTimeMillis() - updatedAt > 30_000L) return ""
        return perception.getString("current_package", "") ?: ""
    }

    private fun startForegroundInternal() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "角色应用限制", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val open = PendingIntent.getActivity(
            this, 31,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val characterName = prefs.getString("charName", "角色") ?: "角色"
        val appLabel = prefs.getString("label", "指定应用") ?: "指定应用"
        val notification: Notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("${characterName}设置的应用限制")
                .setContentText("正在限制使用「${appLabel}」")
                .setContentIntent(open).setOngoing(true).build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("${characterName}设置的应用限制")
                .setContentText("正在限制使用「${appLabel}」")
                .setContentIntent(open).setOngoing(true).build()
        }
        startForeground(NOTIFICATION_ID, notification)
    }

    private fun stopLock() {
        polling = false
        prefs.edit()
            .putBoolean("running", false)
            .putLong("passUntil", 0L)
            .putLong("expiresAt", 0L)
            .remove("password")
            .remove("sessionId")
            .remove("charId")
            .remove("charName")
            .remove("target")
            .remove("label")
            .remove("avatar")
            .remove("style")
            .apply()
        PlayfulLockActivity.dismissCurrent()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        polling = false
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    companion object {
        private const val PREFS = "playful_app_lock_v1"
        private const val CHANNEL = "playful_app_lock"
        private const val NOTIFICATION_ID = 4621
        private val random = SecureRandom()

        private fun hasUsageStatsAccess(context: Context): Boolean = runCatching {
            val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED
        }.getOrDefault(false)

        private fun hasFreshAccessibilityHeartbeat(context: Context): Boolean {
            val perception = context.getSharedPreferences("native_background_perception", Context.MODE_PRIVATE)
            val updatedAt = perception.getLong("current_package_updated_at", 0L)
            return updatedAt > 0L && System.currentTimeMillis() - updatedAt <= 30_000L
                && !perception.getString("current_package", "").isNullOrBlank()
        }

        private fun isProtectedTarget(context: Context, target: String): Boolean {
            val normalized = target.trim().lowercase()
            val hardBlocked = setOf(
                context.packageName,
                "android",
                "com.android.systemui",
                "com.android.settings",
                "com.android.phone",
                "com.android.server.telecom",
                "com.android.providers.telephony",
                "com.google.android.dialer",
                "com.android.dialer",
            )
            if (normalized in hardBlocked || normalized.startsWith("com.android.inputmethod")) return true
            return try {
                val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                val homePackage = context.packageManager.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
                val dialPackage = context.packageManager.resolveActivity(Intent(Intent.ACTION_DIAL), PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
                val smsPackage = context.packageManager.resolveActivity(
                    Intent(Intent.ACTION_SENDTO, android.net.Uri.parse("smsto:")),
                    PackageManager.MATCH_DEFAULT_ONLY,
                )?.activityInfo?.packageName
                val imePackages = (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                    .enabledInputMethodList.map { it.packageName }
                target == homePackage || target == dialPackage || target == smsPackage || target in imePackages
            } catch (_: Throwable) { false }
        }

        fun start(
            context: Context,
            target: String,
            label: String,
            charId: String,
            charName: String,
            avatar: String,
            styleJson: String = "{}",
            durationMinutes: Int = 30,
            sessionId: String = "",
        ): JSONObject {
            if (target.isBlank()) return JSONObject().put("ok", false).put("reason", "没有选择应用")
            if (isProtectedTarget(context, target)) {
                return JSONObject().put("ok", false).put("reason", "系统关键应用不能被角色锁定")
            }
            val installed = runCatching { context.packageManager.getApplicationInfo(target, 0) }.isSuccess
            if (!installed) return JSONObject().put("ok", false).put("reason", "目标应用已不存在或未安装")
            if (!hasUsageStatsAccess(context) && !hasFreshAccessibilityHeartbeat(context)) {
                return JSONObject().put("ok", false).put("reason", "缺少前台应用监测能力，请先开启使用情况访问或 Float 无障碍服务")
            }
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (prefs.getBoolean("running", false) && prefs.getLong("expiresAt", 0L) > System.currentTimeMillis()) {
                val existingCharId = prefs.getString("charId", "") ?: ""
                val existingTarget = prefs.getString("target", "") ?: ""
                if (existingCharId != charId || existingTarget != target) {
                    return JSONObject().put("ok", false).put("reason", "已有角色应用限制正在生效，请先结束当前限制，避免覆盖另一位角色的设置")
                }
            }
            val password = (100000 + random.nextInt(900000)).toString()
            val boundedMinutes = durationMinutes.coerceIn(1, 360)
            prefs.edit().putLong("passUntil", 0L).apply()
            val expiresAt = System.currentTimeMillis() + boundedMinutes * 60_000L
            val intent = Intent(context, PlayfulAppLockService::class.java)
                .putExtra("target", target)
                .putExtra("label", label)
                .putExtra("charId", charId)
                .putExtra("charName", charName)
                .putExtra("avatar", avatar)
                .putExtra("password", password)
                .putExtra("style", styleJson)
                .putExtra("expiresAt", expiresAt)
                .putExtra("sessionId", sessionId)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
            return JSONObject().put("ok", true).put("expiresAt", expiresAt).put("durationMinutes", boundedMinutes)
        }

        fun stop(context: Context): JSONObject {
            context.startService(Intent(context, PlayfulAppLockService::class.java).putExtra("action", "stop"))
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("running", false)
                .putLong("expiresAt", 0L)
                .putLong("passUntil", 0L)
                .remove("password")
                .apply()
            return JSONObject().put("ok", true)
        }

        fun temporaryPass(context: Context, minutes: Int): JSONObject {
            val bounded = minutes.coerceIn(1, 5)
            context.startService(
                Intent(context, PlayfulAppLockService::class.java)
                    .putExtra("action", "temporary-pass")
                    .putExtra("minutes", bounded),
            )
            return JSONObject().put("ok", true).put("minutes", bounded)
        }

        fun status(context: Context): JSONObject {
            val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val perception = context.getSharedPreferences("native_background_perception", Context.MODE_PRIVATE)
            val fallbackUpdatedAt = perception.getLong("current_package_updated_at", 0L)
            val fallbackPackage = if (fallbackUpdatedAt > 0L && System.currentTimeMillis() - fallbackUpdatedAt <= 30_000L)
                perception.getString("current_package", "") ?: "" else ""
            val usageAccess = hasUsageStatsAccess(context)
            val running = p.getBoolean("running", false) && p.getLong("expiresAt", 0L) > System.currentTimeMillis()
            return JSONObject()
                .put("ok", true)
                .put("running", running)
                .put("target", p.getString("target", "") ?: "")
                .put("label", p.getString("label", "") ?: "")
                .put("charId", p.getString("charId", "") ?: "")
                .put("charName", p.getString("charName", "") ?: "")
                .put("expiresAt", p.getLong("expiresAt", 0L))
                .put("passUntil", p.getLong("passUntil", 0L))
                .put("usageStatsAccess", usageAccess)
                .put("accessibilityFallbackAvailable", fallbackPackage.isNotBlank())
                .put("monitoringAvailable", usageAccess || fallbackPackage.isNotBlank())
        }

        /** 仅由 Float 内置角色工具调用；自定义 App SDK 不暴露此接口。 */
        fun reveal(context: Context): String {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (!prefs.getBoolean("running", false)) return ""
            val expiresAt = prefs.getLong("expiresAt", 0L)
            if (expiresAt > 0L && expiresAt <= System.currentTimeMillis()) return ""
            return prefs.getString("password", "") ?: ""
        }
    }
}
