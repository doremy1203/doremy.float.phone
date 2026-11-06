package app.floatphone.shell

import android.accessibilityservice.AccessibilityService
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * 通话控制无障碍服务。
 *
 * 除原有浮窗/前台应用事件外，负责 Android 原生连续应用停留计时：
 * - 阈值与开关由网页感知面板同步到 SharedPreferences；
 * - 计时不依赖 WebView 的 setInterval；
 * - 达到阈值后把事件放入持久队列，经站点登录态 API 写入个人云现实桥收件箱；
 * - 云端继续复用既有 push-bridge 规则匹配、冷却、角色回复和推送链路。
 *
 * 本服务只读取前台包名，不读取其他应用界面内容。用户关闭「前台应用」感知或总开关后，
 * 原生计时立即停止。Android/厂商仍可能在强制停止、关闭无障碍权限或杀进程时中断服务。
 */
class CallControlService : AccessibilityService() {

    companion object {
        @Volatile
        var connected: Boolean = false
            private set
        private const val PREFS = "native_background_perception"
        private const val QUEUE_KEY = "pending_events"
        private const val CURRENT_PACKAGE_KEY = "current_package"
        private const val DWELL_START_KEY = "dwell_start_at"
        private const val REPORTED_PACKAGE_KEY = "reported_package"
        private const val CHECK_INTERVAL_MS = 15_000L
    }

    private val handler = Handler(Looper.getMainLooper())
    private val pendingLock = Any()
    @Volatile private var delivering = false

    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .writeTimeout(12, TimeUnit.SECONDS)
        .build()

    private val dwellTicker = object : Runnable {
        override fun run() {
            checkDwellThreshold()
            checkUsageThresholds()
            deliverPendingEvents()
            handler.postDelayed(this, CHECK_INTERVAL_MS)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        connected = true
        ScreenshotBridge.attach(this)
        ShellBus.dispatchOverlayEvent("accessibility", JSONObject().put("connected", true))

        // 恢复上次计时基准。若进程中断期间系统也重启了服务，仍能继续判断；
        // 下次收到应用切换事件会重新建立准确基准。
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        currentPackage = prefs.getString(CURRENT_PACKAGE_KEY, "").orEmpty()
        dwellStartAt = prefs.getLong(DWELL_START_KEY, 0L)
        reportedPackage = prefs.getString(REPORTED_PACKAGE_KEY, "").orEmpty()
        handler.removeCallbacks(dwellTicker)
        handler.post(dwellTicker)
    }

    @Volatile private var currentPackage: String = ""
    @Volatile private var dwellStartAt: Long = 0L
    @Volatile private var reportedPackage: String = ""

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val ev = event ?: return
        if (ev.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = ev.packageName?.toString().orEmpty()
        if (pkg.isEmpty()) return

        updateForegroundPackage(pkg)
        // 原有网页感知与其他壳功能继续收到前台应用变化事件。
        ShellBus.dispatchOverlayEvent("foregroundApp", JSONObject().put("package", pkg))
    }

    private fun updateForegroundPackage(pkg: String) {
        if (pkg == currentPackage) return
        currentPackage = pkg
        dwellStartAt = System.currentTimeMillis()
        reportedPackage = ""
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(CURRENT_PACKAGE_KEY, currentPackage)
            .putLong(DWELL_START_KEY, dwellStartAt)
            .putString(REPORTED_PACKAGE_KEY, "")
            .apply()
    }

    private fun checkDwellThreshold() {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean("enabled", false) || !prefs.getBoolean("foregroundAppEnabled", false)) return
        val pkg = currentPackage
        val startedAt = dwellStartAt
        if (pkg.isBlank() || pkg == packageName || startedAt <= 0L || reportedPackage == pkg) return

        val thresholdMinutes = prefs.getInt("thresholdMinutes", 20).coerceIn(2, 180)
        val dueAt = startedAt + thresholdMinutes * 60_000L
        if (System.currentTimeMillis() < dueAt) return

        val label = try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        } catch (_: Throwable) {
            pkg
        }
        if (!hasMatchingRule(prefs, "长时间使用", label)) return
        val event = JSONObject()
            .put("id", "dwell_${Integer.toHexString(pkg.hashCode())}_${startedAt}")
            .put("type", "长时间使用")
            .put("payload", "${label} 已连续使用 ${thresholdMinutes} 分钟")
            .put("createdAt", java.time.Instant.ofEpochMilli(dueAt).toString())

        // 先标记再排队：即使网络重试，也不会为同一段停留不断造新事件。
        reportedPackage = pkg
        prefs.edit().putString(REPORTED_PACKAGE_KEY, pkg).apply()
        enqueueEvent(event)
        showReturnToStudyNotification(label, "已连续使用 ${thresholdMinutes} 分钟", prefs)
    }

    /** 每分钟检查系统当天累计使用时长，处理「抖音今天累计超过 N 分钟」规则。 */
    private fun checkUsageThresholds() {
        val now = System.currentTimeMillis()
        if (now - lastUsageCheckAt < 60_000L) return
        lastUsageCheckAt = now

        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean("enabled", false) || !prefs.getBoolean("usageStatsEnabled", false)) return

        val raw = try { PerceptionBridge(this).usageStatsJson(50) } catch (_: Throwable) { "[]" }
        val entries = try { JSONArray(raw) } catch (_: Throwable) { JSONArray() }
        if (entries.length() == 0) return

        val today = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(now))
        val savedDate = prefs.getString("usageSignalDate", "").orEmpty()
        val tiers = try {
            JSONObject(if (savedDate == today) prefs.getString("usageSignalTiers", "{}") ?: "{}" else "{}")
        } catch (_: Throwable) { JSONObject() }
        val overrides = try { JSONArray(prefs.getString("usageOverrides", "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
        val defaultThreshold = prefs.getInt("usageSignalMinutes", 60).coerceIn(0, 720)

        for (i in 0 until entries.length()) {
            val entry = entries.optJSONObject(i) ?: continue
            val pkg = entry.optString("package")
            val label = entry.optString("label").ifBlank { pkg }
            val minutes = entry.optInt("minutes", 0)
            if (pkg.isBlank() || minutes <= 0) continue

            var threshold = defaultThreshold
            for (j in 0 until overrides.length()) {
                val override = overrides.optJSONObject(j) ?: continue
                val pattern = override.optString("pattern").trim()
                if (pattern.isBlank()) continue
                if (label.contains(pattern, ignoreCase = true) || pkg.contains(pattern, ignoreCase = true)) {
                    threshold = override.optInt("minutes", defaultThreshold).coerceIn(0, 720)
                    break
                }
            }
            if (threshold <= 0) continue
            val tier = minutes / threshold
            if (tier <= 0 || tier <= tiers.optInt(pkg, 0)) continue

            if (!hasMatchingRule(prefs, "应用用太久", label)) continue
            val event = JSONObject()
                .put("id", "usage_${Integer.toHexString(pkg.hashCode())}_${today.replace("-", "")}_${tier}")
                .put("type", "应用用太久")
                .put("payload", "${label} 今天已累计使用 ${minutes} 分钟")
                .put("createdAt", java.time.Instant.ofEpochMilli(now).toString())
            enqueueEvent(event)
            tiers.put(pkg, tier)
            showReturnToStudyNotification(label, "今天已累计使用 ${minutes} 分钟", prefs)
        }

        prefs.edit()
            .putString("usageSignalDate", today)
            .putString("usageSignalTiers", tiers.toString())
            .apply()
    }

    @Volatile private var lastUsageCheckAt: Long = 0L

    /** 仅上传能命中用户已启用现实桥规则的应用事件，避免把无关应用名送上云。 */
    private fun hasMatchingRule(
        prefs: android.content.SharedPreferences,
        eventType: String,
        label: String,
    ): Boolean {
        val rules = try { JSONArray(prefs.getString("ruleFilters", "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
        for (i in 0 until rules.length()) {
            val rule = rules.optJSONObject(i) ?: continue
            val type = rule.optString("matchType")
            if (type != "*" && type != eventType) continue
            val filter = rule.optString("payloadFilter").trim()
            val terms = filter.split("|", ",").map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            if (terms.isEmpty() || terms.any { label.lowercase().contains(it) }) return true
        }
        return false
    }

    /**
     * Android 不保证允许后台服务直接抢前台打开另一个 App。
     * 因此提供本地通知的一键返回操作；用户点击后由 PendingIntent 正常启动目标学习软件。
     */
    private fun showReturnToStudyNotification(label: String, detail: String, prefs: android.content.SharedPreferences) {
        val targetPackage = prefs.getString("targetPackage", "").orEmpty()
        if (targetPackage.isBlank()) return
        val filter = prefs.getString("targetFilter", "").orEmpty()
        val terms = filter.split("|", ",").map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        if (terms.isNotEmpty() && terms.none { label.lowercase().contains(it) }) return

        val launchIntent = packageManager.getLaunchIntentForPackage(targetPackage) ?: return
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pendingIntent = PendingIntent.getActivity(
            this,
            targetPackage.hashCode(),
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel("native_focus_reminder", "专注提醒", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "应用连续使用达到设定时长时，提供返回学习软件的快捷操作"
                    setShowBadge(false)
                },
            )
        }
        val notification = NotificationCompat.Builder(this, "native_focus_reminder")
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("小手机 · 专注提醒")
            .setContentText("${label} ${detail}，点此返回学习软件")
            .setContentIntent(pendingIntent)
            .addAction(NotificationCompat.Action(0, "返回学习软件", pendingIntent))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        runCatching { manager.notify(42_013, notification) }
    }

    private fun enqueueEvent(event: JSONObject) {
        synchronized(pendingLock) {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val queue = try { JSONArray(prefs.getString(QUEUE_KEY, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
            val id = event.optString("id")
            for (i in 0 until queue.length()) {
                if (queue.optJSONObject(i)?.optString("id") == id) return
            }
            queue.put(event)
            // 网络长期不可用时限制队列长度，避免无限占用本机存储。
            val bounded = JSONArray()
            for (i in (queue.length() - 20).coerceAtLeast(0) until queue.length()) bounded.put(queue.getJSONObject(i))
            prefs.edit().putString(QUEUE_KEY, bounded.toString()).apply()
        }
        // 同一事件立即交给本机现实桥执行器；云端补传仍独立保留，Cookie/网络失败不影响本地规则。
        runCatching {
            NativeRealityBridge.capture(
                applicationContext,
                event.optString("type"),
                event.optString("payload"),
            )
        }
    }

    private fun deliverPendingEvents() {
        if (delivering) return
        val events = synchronized(pendingLock) {
            val raw = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(QUEUE_KEY, "[]") ?: "[]"
            try { JSONArray(raw) } catch (_: Throwable) { JSONArray() }
        }
        if (events.length() == 0) return
        val cookie = runCatching { CookieManager.getInstance().getCookie(MainActivity.SITE_URL).orEmpty() }.getOrDefault("")
        if (cookie.isBlank()) return

        delivering = true
        Thread({
            try {
                for (i in 0 until events.length()) {
                    val event = events.optJSONObject(i) ?: continue
                    val id = event.optString("id")
                    if (id.isBlank()) continue
                    val body = JSONObject()
                        .put("id", id)
                        .put("type", event.optString("type"))
                        .put("payload", event.optString("payload"))
                        .put("createdAt", event.optString("createdAt"))
                        .toString()
                        .toRequestBody("application/json; charset=utf-8".toMediaType())
                    val request = Request.Builder()
                        .url("${MainActivity.SITE_URL.trimEnd('/')}/api/push/bridge-native-event")
                        .header("Cookie", cookie)
                        .header("Accept", "application/json")
                        .post(body)
                        .build()
                    val accepted = runCatching {
                        client.newCall(request).execute().use { response ->
                            // 410 表示事件过期，确认丢弃；其余失败留在本地待重试。
                            response.isSuccessful || response.code == 410
                        }
                    }.getOrDefault(false)
                    if (accepted) removePendingEvent(id)
                }
            } finally {
                delivering = false
            }
        }, "native-perception-upload").start()
    }

    private fun removePendingEvent(id: String) {
        synchronized(pendingLock) {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val old = try { JSONArray(prefs.getString(QUEUE_KEY, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
            val next = JSONArray()
            for (i in 0 until old.length()) {
                val item = old.optJSONObject(i) ?: continue
                if (item.optString("id") != id) next.put(item)
            }
            prefs.edit().putString(QUEUE_KEY, next.toString()).apply()
        }
    }

    override fun onInterrupt() {
        // 无需处理：本服务不阻塞任何交互
    }

    override fun onDestroy() {
        connected = false
        handler.removeCallbacks(dwellTicker)
        ScreenshotBridge.attach(null)
        super.onDestroy()
    }
}
