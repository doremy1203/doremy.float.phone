package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject

/**
 * FocusLockService — L2 看守锁的壳侧执行件（v1）。
 *
 * 职责：前台服务周期轮询 UsageStats 事件流拿到「当前前台应用」，
 * 命中锁机名单时：① 发一条高优先级系统通知（TA 的口吻由网页层决定，这里只报事实）；
 * ② 把小手机拉回前台（壳持有 SYSTEM_ALERT_WINDOW，后台起 Activity 属豁免路径）。
 *
 * 锁机名单/截止时间由网页层经 ShellBridge.focusLockStart 传入，
 * 存 SharedPreferences —— 进程被杀重启后 BootReceiver/网页层可据 status 恢复。
 *
 * v1 边界（诚实声明）：全屏封锁覆盖页（BlockingActivity）与无障碍实时拦截
 * 留给 v2；v1 用「带回小手机 + 通知」实现同等目标，无需额外权限。
 */
class FocusLockService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var polling = false
    private var lastBlockAt = 0L
    private var blockedCount = 0
    private lateinit var prefs: SharedPreferences

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val action = intent?.getStringExtra("action")
        when (action) {
            "stop" -> {
                polling = false
                prefs.edit().putBoolean("running", false).apply()
                BlockingActivity.dismissCurrent()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            "update" -> {
                val packages = intent.getStringExtra("packages") ?: "[]"
                val until = intent.getLongExtra("until", 0L)
                val nowWall = System.currentTimeMillis()
                val oldUntil = prefs.getLong("until", 0L)
                if (prefs.getBoolean("running", false) && oldUntil > nowWall) {
                    // 通行证变更/加时：只更新白名单与截止时间，不重置 elapsed 基准，
                    // 否则每次批一张通行证都会把倒计时重新拉长。
                    val effectiveUntil = maxOf(until, oldUntil)
                    val startedElapsed = prefs.getLong("startElapsed", android.os.SystemClock.elapsedRealtime())
                    val elapsed = (android.os.SystemClock.elapsedRealtime() - startedElapsed).coerceAtLeast(0)
                    prefs.edit()
                        .putString("packages", packages)
                        .putString("blocked", JSONArray(blockedFromWhitelist(this@FocusLockService, packages)).toString())
                        .putLong("until", effectiveUntil)
                        .putLong("durationMs", elapsed + (effectiveUntil - nowWall).coerceAtLeast(0))
                        .apply()
                    // 刚放行的应用如果正被覆盖页挡着，立即撤掉；仍被拦的应用下一轮会重新盖。
                    BlockingActivity.dismissCurrent()
                    if (!polling) {
                        polling = true
                        startForegroundInternal()
                        handler.postDelayed(pollRunnable, 1200)
                    }
                    return START_STICKY
                }
                // 没有在运行就按全新会话启动，继续走下面的 start 分支。
            }
        }
        val packages = intent?.getStringExtra("packages") ?: "[]"
        val until = intent?.getLongExtra("until", 0L) ?: 0L
        prefs.edit()
            .putString("packages", packages)
            // 语义：传入的 packages 是「白名单」（放行清单）。真正要拦的是
            // 可启动应用 − 白名单 − 自身。在启动时算一次冻结，轮询只查集合。
            .putString("blocked", JSONArray(blockedFromWhitelist(this@FocusLockService, packages)).toString())
            .putLong("until", until)
            // 时钟篡改免疫：elapsedRealtime 基准记录「开始时刻 + 总时长」，
            // 改系统墙钟不影响剩余计算；重启由 BootReceiver 调 restore 重锚。
            .putLong("startElapsed", android.os.SystemClock.elapsedRealtime())
            .putLong("durationMs", (until - System.currentTimeMillis()).coerceAtLeast(0))
            .putBoolean("running", true)
            .apply()
        if (!polling) {
            polling = true
            startForegroundInternal()
            handler.postDelayed(pollRunnable, 1200)
        }
        return START_STICKY
    }

    private val pollRunnable = object : Runnable {
        override fun run() {
            if (!polling) return
            val now = System.currentTimeMillis()
            if (now > prefs.getLong("until", 0) || remainingMs() <= 0) {
                // 到点自动收锁：通知 + 复位
                prefs.edit().putBoolean("running", false).apply()
                polling = false
                BlockingActivity.dismissCurrent()
                postNotify("🔒 看守锁已解除", "专注时段结束，手机应用恢复自由。")
                FocusWidgetProvider.pushAll(this@FocusLockService)
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return
            }
            val fg = currentForegroundPackage()
            if (fg.isNotEmpty() && fg != packageName && blockedPackages().contains(fg)
                && now - lastBlockAt > 4000) {
                lastBlockAt = now
                blockedCount++
                blockNow(fg)
            }
            handler.postDelayed(this, 1500)
        }
    }

    /** 剩余毫秒（elapsed 基准，时钟篡改免疫）。 */
    private fun remainingMs(): Long {
        val duration = prefs.getLong("durationMs", 0)
        if (duration <= 0) return 0
        val left = duration - (android.os.SystemClock.elapsedRealtime() - prefs.getLong("startElapsed", android.os.SystemClock.elapsedRealtime()))
        return if (left > 0) left else 0
    }

    private fun blockedPackages(): Set<String> {
        return try {
            val arr = JSONArray(prefs.getString("blocked", "[]") ?: "[]")
            val set = HashSet<String>()
            for (i in 0 until arr.length()) set.add(arr.getString(i))
            set
        } catch (e: Throwable) { emptySet() }
    }

    /** 可启动应用 − 白名单 − 自身（− 桌面/输入法/系统 UI）= 本次要拦的集合。 */
    private fun blockedFromWhitelist(context: Context, whitelistJson: String): List<String> {
        val allowed = runCatching {
            val arr = JSONArray(whitelistJson)
            (0 until arr.length()).map { arr.getString(it) }.toSet()
        }.getOrDefault(emptySet())
        val exempt = setOf(context.packageName, "com.android.systemui")
        val launchable = runCatching {
            val pm = context.packageManager
            val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            @Suppress("DEPRECATION")
            pm.queryIntentActivities(intent, 0).mapNotNull { it.activityInfo?.packageName }.toSet()
        }.getOrDefault(emptySet())
        return launchable.filter { it !in allowed && it !in exempt }
    }

    /** 事件流里最近一次 ACTIVITY_RESUMED 的包名 = 当前前台应用。 */
    private fun currentForegroundPackage(): String {
        return try {
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
        } catch (e: Throwable) { "" }
    }

    private fun blockNow(pkg: String) {
        val label = runCatching {
            val pm = getPackageManager()
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        }.getOrDefault("白名单外的应用")
        val taLine = prefs.getString("taLine", "") ?: ""
        val charName = prefs.getString("charName", "") ?: ""
        // v2：全屏封锁页盖上去（showWhenLocked），替代 v1 的纯通知
        runCatching {
            val intent = Intent(this, BlockingActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(BlockingActivity.EXTRA_APP_LABEL, label)
                .putExtra(BlockingActivity.EXTRA_APP_PKG, pkg)
                .putExtra(BlockingActivity.EXTRA_TA_LINE, taLine)
                .putExtra(BlockingActivity.EXTRA_CHAR_NAME, charName)
                .putExtra(BlockingActivity.EXTRA_REMAIN_MS, remainingMs())
            startActivity(intent)
        }
        postNotify("👀 TA 看到你在用其他应用", "「$label」被看守锁拦下 —— 回到小手机继续专注。")
        // 焦点交给 BlockingActivity（3 秒自动返回）；若覆盖页被系统拦截未能显示，
        // 2.8 秒后兜底拉回小手机。
        handler.postDelayed({ runCatching { bringSelfToFront() } }, 2800)
    }

    private fun bringSelfToFront() {
        runCatching {
            val intent = Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            startActivity(intent)
        }
    }

    private fun startForegroundInternal() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "看守锁", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val openSelf = PendingIntent.getActivity(
            this, 11,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("🔒 看守锁生效中")
                .setContentText("白名单外的手机应用会被带回小手机。")
                .setContentIntent(openSelf)
                .setOngoing(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("🔒 看守锁生效中")
                .setContentText("白名单外的手机应用会被带回小手机。")
                .setContentIntent(openSelf)
                .setOngoing(true)
                .build()
        }
        startForeground(NOTIFICATION_ID, notification)
    }

    private fun postNotify(title: String, body: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(BLOCK_CHANNEL, "看守锁提醒", NotificationManager.IMPORTANCE_HIGH),
            )
        }
        val openSelf = PendingIntent.getActivity(
            this, 12,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, BLOCK_CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(openSelf)
                .setAutoCancel(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(openSelf)
                .setAutoCancel(true)
                .build()
        }
        manager.notify(BLOCK_NOTIFY_ID, notification)
    }

    override fun onDestroy() {
        polling = false
        super.onDestroy()
    }

    companion object {
        private const val PREFS = "focus_lock_v1"
        private const val CHANNEL = "focus_lock"
        private const val BLOCK_CHANNEL = "focus_lock_block"
        private const val NOTIFICATION_ID = 4601
        private const val BLOCK_NOTIFY_ID = 4602
        private var serviceRunning = false

        fun start(context: Context, packagesJson: String, untilEpochMs: Long): JSONObject {
            val intent = Intent(context, FocusLockService::class.java)
                .putExtra("action", "start")
                .putExtra("packages", packagesJson)
                .putExtra("until", untilEpochMs)
            context.startForegroundService(intent)
            serviceRunning = true
            return JSONObject().put("ok", true).put("running", true).put("until", untilEpochMs)
        }

        /** 通行证/白名单变化：保留现有计时基准，只换白名单并（必要时）延长截止。 */
        fun update(context: Context, packagesJson: String, untilEpochMs: Long): JSONObject {
            val intent = Intent(context, FocusLockService::class.java)
                .putExtra("action", "update")
                .putExtra("packages", packagesJson)
                .putExtra("until", untilEpochMs)
            context.startForegroundService(intent)
            serviceRunning = true
            return JSONObject().put("ok", true).put("running", true).put("until", untilEpochMs)
        }

        fun stop(context: Context): JSONObject {
            val intent = Intent(context, FocusLockService::class.java).putExtra("action", "stop")
            context.startService(intent)
            serviceRunning = false
            return JSONObject().put("ok", true).put("running", false)
        }

        /** 开机后由 BootReceiver 调：重锚 elapsed 基准（重启会清零）并重启轮询。 */
        fun restore(context: Context): JSONObject {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (!prefs.getBoolean("running", false)) return JSONObject().put("ok", true).put("restored", false)
            val until = prefs.getLong("until", 0)
            if (System.currentTimeMillis() > until) {
                prefs.edit().putBoolean("running", false).apply()
                return JSONObject().put("ok", true).put("restored", false)
            }
            return start(context, prefs.getString("packages", "[]") ?: "[]", until)
        }

        /** 拦截页「申请用一会儿」：记下待处理申请，页面下次轮询取走并弹申请单。 */
        fun setPendingApply(context: Context, pkg: String, label: String) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("pending_apply", org.json.JSONObject().put("pkg", pkg).put("label", label).toString())
                .apply()
        }

        /** 只读待处理申请（不消费）。 */
        fun peekPendingApply(context: Context): String =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("pending_apply", "") ?: ""

        /** 取走待处理申请（取完即清，避免重复弹）。 */
        fun takePendingApply(context: Context): String {
            val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val raw = p.getString("pending_apply", "") ?: ""
            if (raw.isNotEmpty()) p.edit().putString("pending_apply", "").apply()
            return raw
        }

        /** 网页层设置看守锁覆盖页的 TA 提醒线。 */
        fun setTaLine(context: Context, taLine: String, charName: String): JSONObject {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("taLine", taLine).putString("charName", charName).apply()
            return JSONObject().put("ok", true)
        }

        fun status(context: Context): JSONObject {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return JSONObject()
                .put("ok", true)
                .put("running", prefs.getBoolean("running", false) && serviceRunning)
                .put("until", prefs.getLong("until", 0))
                .put("packages", prefs.getString("packages", "[]") ?: "[]")
        }
    }
}
