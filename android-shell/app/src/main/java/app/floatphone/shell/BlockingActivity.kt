package app.floatphone.shell

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * L2 v2 — 全屏封锁页（FocusLockService 命中白名单外应用时拉起）。
 *
 * 与 v1（通知 + 把小手机带回前台）的区别：直接盖在全屏上给出明确出口，
 * 用户只有两个选择：回专注 / 关页继续被盯。纯代码构建 UI（同 IncomingCallActivity）。
 * showWhenLocked + turnScreenOn：亮屏瞬间就盖住，不给白名单外应用露脸机会。
 */
class BlockingActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_APP_LABEL = "app_label"
        const val EXTRA_TA_LINE = "ta_line"
        const val EXTRA_REMAIN_MS = "remain_ms"
        const val EXTRA_CHAR_NAME = "char_name"
        const val EXTRA_APP_PKG = "app_pkg"

        @Volatile private var current: BlockingActivity? = null

        /** 白名单更新/手动解锁时撤掉当前覆盖页；下一轮轮询会按新名单重新判断。 */
        fun dismissCurrent() {
            val activity = current ?: return
            current = null
            activity.runOnUiThread { runCatching { activity.finish() } }
        }
    }

    private val tickHandler = Handler(Looper.getMainLooper())
    private var countdown: Runnable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val appLabel = intent.getStringExtra(EXTRA_APP_LABEL) ?: ""
        val blockedPkg = intent.getStringExtra(EXTRA_APP_PKG) ?: ""
        val taLine = intent.getStringExtra(EXTRA_TA_LINE) ?: "刷别的 App 太久了 —— 回来，我陪着你。"
        val charName = intent.getStringExtra(EXTRA_CHAR_NAME) ?: "TA"
        val remainMs = intent.getLongExtra(EXTRA_REMAIN_MS, 0)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xFF080A14.toInt())
            setPadding(64, 64, 64, 64)
        }
        val icon = TextView(this).apply {
            text = "🚫"
            textSize = 52f
            gravity = Gravity.CENTER
        }
        val title = TextView(this).apply {
            text = "看守锁"
            textSize = 22f
            setTextColor(0xFFE8ECF5.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 40, 0, 16)
        }
        val locked = TextView(this).apply {
            text = if (appLabel.isBlank()) "白名单外的应用被拦下了" else "「$appLabel」被拦下了"
            textSize = 15f
            setTextColor(0xFF8B97AD.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 40)
        }
        val ta = TextView(this).apply {
            text = "$charName：$taLine"
            textSize = 16f
            setTextColor(0xFFB9C2FF.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 48)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        }
        val remain = TextView(this).apply {
            text = "剩余 ${fmt(remainMs)}"
            textSize = 30f
            setTextColor(0xFF5EEAD4.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 56)
        }
        // 覆盖页自己也走秒，不能一直停在创建时的「剩余 xx:xx」。
        val startedElapsed = SystemClock.elapsedRealtime()
        countdown = object : Runnable {
            override fun run() {
                val left = (remainMs - (SystemClock.elapsedRealtime() - startedElapsed)).coerceAtLeast(0)
                remain.text = "剩余 ${fmt(left)}"
                if (left > 0) tickHandler.postDelayed(this, 1000)
            }
        }
        tickHandler.post(countdown!!)
        val back = Button(this).apply {
            text = "▶️ 回去继续专注"
            setOnClickListener {
                val intent = Intent(this@BlockingActivity, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                startActivity(intent)
                finish()
            }
        }
        val applyBtn = Button(this).apply {
            text = "🎟 向 TA 申请用一会儿"
            setOnClickListener {
                FocusLockService.setPendingApply(this@BlockingActivity, blockedPkg, appLabel)
                startActivity(Intent(this@BlockingActivity, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                finish()
            }
        }
        val dismiss = TextView(this).apply {
            text = "我知道了（还会再盯）"
            textSize = 13f
            setTextColor(0xFF5F6B80.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 32, 0, 0)
            setOnClickListener { finish() }
        }
        root.addView(icon)
        root.addView(title)
        root.addView(locked)
        root.addView(ta)
        root.addView(remain)
        root.addView(back)
        root.addView(applyBtn)
        root.addView(dismiss)
        setContentView(root)

        // 键盘锁下也显示（锁屏覆盖由 showWhenLocked 处理；键_guard 仅锁屏时需要解锁才能点按钮）
        val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        if (km.inKeyguardRestrictedInputMode()) {
            // 锁屏状态：只展示，不允许交互穿透（按钮自然被锁屏挡住）
        }
    }

    override fun onDestroy() {
        if (current === this) current = null
        countdown?.let { tickHandler.removeCallbacks(it) }
        countdown = null
        super.onDestroy()
    }

    private fun fmt(ms: Long): String {
        val total = (ms / 1000L).toInt()
        val h = total / 3600
        val m = (total % 3600) / 60
        val sec = total % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%02d:%02d".format(m, sec)
    }
}
