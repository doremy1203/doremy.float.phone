package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/**
 * 专注悬浮倒计时 + 任务勾选。
 *
 * 网页是 session/task 的唯一真相；本服务只接收一份快照（phaseEndsAt/tasks），
 * 每秒自己算剩余时间，点任务时通过 ShellBus 把 index/done 发回网页。
 *
 * 为什么不用“灵动岛”：普通 Android 没有第三方灵动岛 API，荣耀胶囊也不开放；
 * 这里用可拖动的顶部胶囊 + 点击展开面板，权限缺失时网页侧退化为常驻通知。
 */
class FocusOverlayService : Service() {
    private lateinit var windowManager: WindowManager
    private lateinit var prefs: android.content.SharedPreferences
    private val handler = Handler(Looper.getMainLooper())
    private var pill: TextView? = null
    private var panel: LinearLayout? = null
    private var expanded = false
    private var lastTasksJson = "[]"
    private var paused = false
    private var phaseEndsAt = 0L
    private var phaseLabel = "专注"

    private val tick = object : Runnable {
        override fun run() {
            updateClock()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        startForegroundInternal()
        handler.post(tick)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.getStringExtra("action")) {
            "stop" -> {
                stopSelf()
                return START_NOT_STICKY
            }
            "update" -> {
                val raw = intent?.getStringExtra("json") ?: "{}"
                applyState(raw)
            }
            else -> {
                val raw = intent?.getStringExtra("json") ?: prefs.getString(KEY_STATE, "{}") ?: "{}"
                if (raw.isNotBlank() && raw != "{}") applyState(raw)
            }
        }
        return START_STICKY
    }

    private fun applyState(raw: String) {
        val state = runCatching { JSONObject(raw) }.getOrElse { return }
        if (state.optBoolean("active", false) != true) {
            stopSelf()
            return
        }
        prefs.edit().putString(KEY_STATE, raw).apply()
        phaseEndsAt = state.optLong("phaseEndsAt", 0L)
        paused = state.optBoolean("paused", false)
        phaseLabel = state.optString("phaseLabel", "专注").ifBlank { "专注" }
        val tasks = state.optJSONArray("tasks") ?: JSONArray()
        lastTasksJson = tasks.toString()
        if (pill == null) showPill()
        if (expanded) rebuildPanel(tasks)
        updateClock()
    }

    private fun showPill() {
        val text = TextView(this).apply {
            text = "⏱ --:--"
            setTextColor(Color.WHITE)
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(14), dp(7), dp(14), dp(7))
            background = GradientDrawable().apply {
                cornerRadius = dp(22).toFloat()
                setColor(0xE6232938.toInt())
                setStroke(dp(1), 0x55FFFFFF)
            }
        }
        text.setOnClickListener { togglePanel() }
        text.setOnTouchListener(DragTouchListener())
        val params = overlayParams(
            width = WindowManager.LayoutParams.WRAP_CONTENT,
            height = WindowManager.LayoutParams.WRAP_CONTENT,
            y = dp(8),
        )
        runCatching { windowManager.addView(text, params) }
        pill = text
    }

    private fun togglePanel() {
        expanded = !expanded
        if (expanded) rebuildPanel(runCatching { JSONArray(lastTasksJson) }.getOrElse { JSONArray() })
        else panel?.let { runCatching { windowManager.removeView(it) } }
        if (!expanded) panel = null
    }

    private fun rebuildPanel(tasks: JSONArray) {
        panel?.let { runCatching { windowManager.removeView(it) } }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                setColor(0xF21B2030.toInt())
                setStroke(dp(1), 0x55FFFFFF)
            }
        }
        root.addView(TextView(this).apply {
            text = "剩余 --:--"
            setTextColor(Color.WHITE)
            textSize = 22f
            typeface = Typeface.DEFAULT_BOLD
            tag = "remaining"
        })
        root.addView(TextView(this).apply {
            text = phaseLabel
            setTextColor(0xFF9FB0D0.toInt())
            textSize = 11f
            setPadding(0, dp(2), 0, dp(8))
        })
        if (tasks.length() == 0) {
            root.addView(TextView(this).apply {
                text = "这一轮还没有任务"
                setTextColor(0xFF9FB0D0.toInt())
                textSize = 12f
                setPadding(0, dp(6), 0, dp(4))
            })
        }
        for (i in 0 until tasks.length()) {
            val row = tasks.optJSONObject(i) ?: JSONObject()
            val label = row.optString("text").ifBlank { "任务 ${i + 1}" }
            val done = row.optBoolean("done", false)
            root.addView(CheckBox(this).apply {
                text = label
                isChecked = done
                setTextColor(if (done) 0xFF8B97AD.toInt() else Color.WHITE)
                textSize = 13f
                setPadding(0, dp(2), 0, dp(2))
                setOnCheckedChangeListener { _, checked ->
                    // 先更新本地快照，网页恢复后仍能看到这次勾选。
                    val next = runCatching { JSONArray(lastTasksJson) }.getOrElse { JSONArray() }
                    val copy = next.optJSONObject(i) ?: JSONObject()
                    copy.put("done", checked)
                    next.put(i, copy)
                    lastTasksJson = next.toString()
                    val state = runCatching { JSONObject(prefs.getString(KEY_STATE, "{}") ?: "{}") }.getOrElse { JSONObject() }
                    state.put("tasks", next)
                    prefs.edit().putString(KEY_STATE, state.toString()).apply()
                    val events = runCatching {
                        JSONArray(prefs.getString(KEY_EVENTS, "[]") ?: "[]")
                    }.getOrElse { JSONArray() }
                    events.put(JSONObject().put("index", i).put("done", checked).put("at", System.currentTimeMillis()))
                    prefs.edit().putString(KEY_EVENTS, events.toString()).apply()
                    ShellBus.dispatchOverlayEvent(
                        "focusTaskToggle",
                        JSONObject().put("index", i).put("done", checked),
                    )
                    setTextColor(if (checked) 0xFF8B97AD.toInt() else Color.WHITE)
                }
            })
        }
        root.addView(TextView(this).apply {
            text = "点上方胶囊收起 · 勾选会同步到 Float"
            setTextColor(0xFF77839A.toInt())
            textSize = 10f
            setPadding(0, dp(8), 0, 0)
        })
        val params = overlayParams(
            width = dp(280),
            height = WindowManager.LayoutParams.WRAP_CONTENT,
            y = dp(54),
        )
        runCatching { windowManager.addView(root, params) }
        panel = root
        updateClock()
    }

    private fun updateClock() {
        val left = ((phaseEndsAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
        val clock = String.format("%02d:%02d", left / 60, left % 60)
        pill?.text = if (paused) "⏸ 已暂停" else "⏱ $clock"
        panel?.findViewWithTag<TextView>("remaining")?.text = if (paused) "已暂停" else "剩余 $clock"
    }

    private fun overlayParams(width: Int, height: Int, y: Int): WindowManager.LayoutParams {
        return WindowManager.LayoutParams(
            width,
            height,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            this.y = y
        }
    }

    private inner class DragTouchListener : View.OnTouchListener {
        private var downX = 0f
        private var downY = 0f
        private var startX = 0
        private var startY = 0
        override fun onTouch(view: View, event: MotionEvent): Boolean {
            val params = view.layoutParams as? WindowManager.LayoutParams ?: return false
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX; downY = event.rawY
                    startX = params.x; startY = params.y
                    return false // 让点击事件继续走
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - downX).toInt()
                    val dy = (event.rawY - downY).toInt()
                    if (Math.abs(dx) + Math.abs(dy) > dp(4)) {
                        params.x = startX + dx
                        params.y = startY + dy
                        runCatching { windowManager.updateViewLayout(view, params) }
                    }
                    return true
                }
            }
            return false
        }
    }

    private fun startForegroundInternal() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "专注悬浮层", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val open = PendingIntent.getActivity(
            this, 21,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle("专注进行中")
                .setContentText("悬浮倒计时和任务在屏幕上")
                .setContentIntent(open).setOngoing(true).build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle("专注进行中")
                .setContentText("悬浮倒计时和任务在屏幕上")
                .setContentIntent(open).setOngoing(true).build()
        }
        startForeground(NOTIFICATION_ID, notification)
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        pill?.let { runCatching { windowManager.removeView(it) } }
        panel?.let { runCatching { windowManager.removeView(it) } }
        pill = null; panel = null
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val PREFS = "focus_overlay_v1"
        private const val KEY_STATE = "state"
        private const val KEY_EVENTS = "events"
        private const val CHANNEL = "focus_overlay"
        private const val NOTIFICATION_ID = 4611

        fun update(context: Context, json: String) {
            val intent = Intent(context, FocusOverlayService::class.java)
                .putExtra("action", "update")
                .putExtra("json", json)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, FocusOverlayService::class.java).putExtra("action", "stop")
            context.startService(intent)
        }

        /** 网页可能不在（被冻结/杀掉）：勾选事件先排队，网页恢复后一次性取走。 */
        fun consumeEvents(context: Context): String {
            val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val raw = p.getString(KEY_EVENTS, "[]") ?: "[]"
            if (raw != "[]") p.edit().putString(KEY_EVENTS, "[]").apply()
            return raw
        }

        fun restore(context: Context) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_STATE, "{}") ?: "{}"
            if (raw == "{}") return
            val state = runCatching { JSONObject(raw) }.getOrNull() ?: return
            val endsAt = state.optLong("phaseEndsAt", 0L)
            if (endsAt > 0L && endsAt <= System.currentTimeMillis()) {
                prefs.edit().remove(KEY_STATE).apply()
                return
            }
            update(context, raw)
        }
    }
}
