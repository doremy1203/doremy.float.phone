package app.floatphone.shell

import android.app.Activity
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/** 角色应用限制互动页：角色留言、返回私聊、密码解锁与倒计时。 */
class PlayfulLockActivity : Activity() {
    private var input: EditText? = null
    private var errorText: TextView? = null
    private var expiryText: TextView? = null
    private lateinit var prefs: android.content.SharedPreferences
    private var styleObj = JSONObject()
    private val handler = Handler(Looper.getMainLooper())
    private var expiresAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        prefs = getSharedPreferences("playful_app_lock_v1", MODE_PRIVATE)
        val label = intent.getStringExtra(EXTRA_LABEL) ?: prefs.getString("label", "") ?: "这个应用"
        val charName = intent.getStringExtra(EXTRA_CHAR_NAME) ?: prefs.getString("charName", "") ?: "TA"
        expiresAt = intent.getLongExtra(EXTRA_EXPIRES_AT, prefs.getLong("expiresAt", 0L))
        styleObj = runCatching {
            JSONObject(intent.getStringExtra(EXTRA_STYLE) ?: prefs.getString("style", "{}") ?: "{}")
        }.getOrElse { JSONObject() }
        buildUi(label, charName)
        updateCountdown()
    }

    private fun buildUi(label: String, charName: String) {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(22), dp(26), dp(22), dp(22))
            val bitmap = decodeImage(styleObj.optString("background", ""))
            background = if (bitmap != null) {
                android.graphics.drawable.LayerDrawable(arrayOf(
                    BitmapDrawable(resources, bitmap).apply { gravity = Gravity.FILL },
                    android.graphics.drawable.ColorDrawable(0xCC101522.toInt()),
                ))
            } else GradientDrawable(GradientDrawable.Orientation.TL_BR,
                intArrayOf(0xFF111827.toInt(), 0xFF202B43.toInt(), 0xFF302844.toInt()))
        }
        val scroll = ScrollView(this).apply { isFillViewport = true; addView(root) }

        root.addView(TextView(this).apply {
            text = "TA 的专属小手段"
            setTextColor(0xFFC9B9FF.toInt()); textSize = 12f; letterSpacing = 0.12f; gravity = Gravity.CENTER
        }, matchWrap().apply { bottomMargin = dp(18) })

        val showAvatar = styleObj.optBoolean("showAvatar", true)
        val avatarRaw = styleObj.optString("avatar", "").ifBlank { intent.getStringExtra(EXTRA_AVATAR) ?: "" }
        val avatarBitmap = if (showAvatar) decodeImage(avatarRaw) else null
        if (avatarBitmap != null) {
            root.addView(ImageView(this).apply {
                setImageBitmap(avatarBitmap); scaleType = ImageView.ScaleType.CENTER_CROP
                outlineProvider = object : android.view.ViewOutlineProvider() {
                    override fun getOutline(view: View, outline: android.graphics.Outline) { outline.setOval(0, 0, view.width, view.height) }
                }
                clipToOutline = true; elevation = dp(8).toFloat()
            }, LinearLayout.LayoutParams(dp(104), dp(104)).apply { gravity = Gravity.CENTER })
        } else if (showAvatar) {
            root.addView(TextView(this).apply {
                text = "✦"; textSize = 54f; gravity = Gravity.CENTER; setTextColor(0xFFE0D7FF.toInt())
            }, LinearLayout.LayoutParams(dp(104), dp(104)).apply { gravity = Gravity.CENTER })
        }

        if (styleObj.optBoolean("showTitle", true)) {
            root.addView(TextView(this).apply {
                text = styleObj.optString("title", "").trim().ifBlank { "${charName} 想和你商量一件事" }
                setTextColor(Color.WHITE); textSize = 25f; typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER; setPadding(0, dp(18), 0, dp(8))
            }, matchWrap())
        }
        val message = styleObj.optString("message", "").trim()
            .ifBlank { styleObj.optString("subtitle", "").trim() }
            .ifBlank { "「${label}」先放一放吧。回来和我聊两句，好吗？" }
        if (styleObj.optBoolean("showSubtitle", true)) {
            root.addView(TextView(this).apply {
                text = "“${message}”"; setTextColor(0xFFE1E5F0.toInt()); textSize = 15f
                gravity = Gravity.CENTER; setLineSpacing(dp(4).toFloat(), 1.08f)
                setPadding(dp(8), 0, dp(8), dp(18))
            }, matchWrap())
        }

        val appCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(dp(18), dp(14), dp(18), dp(14)); background = rounded(0x33232D45, 0x66FFFFFF, 18)
        }
        appCard.addView(TextView(this).apply {
            text = "本次限制的应用"; setTextColor(0xFFB7C0D3.toInt()); textSize = 11f; gravity = Gravity.CENTER
        })
        appCard.addView(TextView(this).apply {
            text = label; setTextColor(Color.WHITE); textSize = 20f; typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER; setPadding(0, dp(5), 0, dp(3))
        })
        expiryText = TextView(this).apply { setTextColor(0xFFC9B9FF.toInt()); textSize = 12f; gravity = Gravity.CENTER }
        appCard.addView(expiryText)
        root.addView(appCard, matchWrap().apply { bottomMargin = dp(18) })

        input = EditText(this).apply {
            hint = "输入解锁密码"; setTextColor(Color.WHITE); setHintTextColor(0xFF9BA6BA.toInt())
            textSize = 17f; gravity = Gravity.CENTER
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            filters = arrayOf(InputFilter.LengthFilter(6))
            setSingleLine(true); background = rounded(0xCC20283A.toInt(), 0x66FFFFFF, 14)
            setPadding(dp(16), dp(13), dp(16), dp(13))
        }
        root.addView(input, matchWrap())
        errorText = TextView(this).apply {
            text = ""; setTextColor(0xFFFFA0AE.toInt()); textSize = 12f; gravity = Gravity.CENTER
            setPadding(0, dp(6), 0, 0)
        }
        root.addView(errorText, matchWrap())

        root.addView(actionButton("去找TA求情", 0xFF8976D8.toInt(), Color.WHITE) {
            val sessionId = prefs.getString("sessionId", "") ?: ""
            val chatUrl = if (sessionId.isNotBlank()) MainActivity.SITE_URL.trimEnd('/') + "/#open-chat=" + android.net.Uri.encode(sessionId) else ""
            startActivity(Intent(this@PlayfulLockActivity, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                if (chatUrl.isNotBlank()) putExtra(MainActivity.EXTRA_OPEN_URL, chatUrl)
            })
            finish()
        }, matchWrap().apply { topMargin = dp(12) })
        root.addView(actionButton("确认解锁", 0x332C3852, 0xFFE3E8F4.toInt(), true) { tryUnlock() },
            matchWrap().apply { topMargin = dp(9) })
        root.addView(TextView(this).apply {
            text = "本次限制会在倒计时结束后自动解除；想提前结束，可以回到聊天和 ${charName} 商量。"
            setTextColor(0xFF9BA6BA.toInt()); textSize = 10f; gravity = Gravity.CENTER
            setPadding(dp(8), dp(18), dp(8), dp(4))
        }, matchWrap())
        setContentView(scroll)
        input?.requestFocus()
    }

    private fun actionButton(label: String, color: Int, textColor: Int, outlined: Boolean = false, action: () -> Unit): TextView =
        TextView(this).apply {
            text = label; setTextColor(textColor); textSize = 14f; typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER; setPadding(dp(14), dp(15), dp(14), dp(15))
            background = rounded(color, if (outlined) 0x55FFFFFF else 0, 15)
            isClickable = true; isFocusable = true; setOnClickListener { action() }
        }

    private fun tryUnlock() {
        val expected = prefs.getString("password", "") ?: ""
        val entered = input?.text?.toString()?.trim().orEmpty()
        if (entered.isNotEmpty() && entered == expected) {
            PlayfulAppLockService.stop(this)
            Toast.makeText(this, "已解锁。", Toast.LENGTH_SHORT).show()
            finish()
        } else {
            input?.setText("")
            errorText?.text = "密码不正确，可以回到聊天问问 TA。"
            input?.animate()?.translationX(18f)?.setDuration(60)?.withEndAction {
                input?.animate()?.translationX(-18f)?.setDuration(60)?.withEndAction {
                    input?.animate()?.translationX(0f)?.setDuration(60)?.start()
                }?.start()
            }?.start()
        }
    }

    private fun updateCountdown() {
        if (expiresAt <= 0L) { expiryText?.text = "等待角色解除"; return }
        val remaining = expiresAt - System.currentTimeMillis()
        if (remaining <= 0L) {
            expiryText?.text = "本次限制已结束"
            PlayfulAppLockService.stop(this); finish(); return
        }
        val totalMinutes = remaining / 60_000L
        val hours = totalMinutes / 60L
        val minutes = totalMinutes % 60L
        val seconds = (remaining / 1000L) % 60L
        expiryText?.text = if (hours > 0) "本次限制还剩 ${hours}小时${minutes}分" else "本次限制还剩 ${minutes}分${seconds}秒"
        handler.postDelayed({ updateCountdown() }, 1000L)
    }

    override fun onBackPressed() { finish() }

    private fun decodeImage(raw: String): android.graphics.Bitmap? {
        val value = raw.trim()
        if (value.isBlank()) return null
        return runCatching {
            if (value.startsWith("data:image") && value.contains(",")) {
                val bytes = Base64.decode(value.substringAfter(","), Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            } else if (value.startsWith("/")) BitmapFactory.decodeFile(value) else null
        }.getOrNull()
    }

    private fun rounded(color: Int, stroke: Int, radius: Int): GradientDrawable = GradientDrawable().apply {
        cornerRadius = dp(radius).toFloat(); setColor(color); if (stroke != 0) setStroke(dp(1), stroke)
    }
    private fun matchWrap() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_TARGET = "target"
        const val EXTRA_LABEL = "label"
        const val EXTRA_CHAR_NAME = "char_name"
        const val EXTRA_AVATAR = "avatar"
        const val EXTRA_STYLE = "style"
        const val EXTRA_EXPIRES_AT = "expires_at"
        @Volatile private var current: PlayfulLockActivity? = null
        fun dismissCurrent() { current?.finish() }
    }

    override fun onResume() { super.onResume(); current = this }
    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (current === this) current = null
        super.onDestroy()
    }
}
