package app.floatphone.shell

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * 系统添加小组件时的配置页：让每个实例明确绑定一个 widget profile。
 * 之前依赖 requestPinAppWidget 回调 extra；部分启动器会丢，导致多个实例全落 default。
 */
class PhoneWidgetConfigActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val widgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(28), dp(24), dp(24))
            setBackgroundColor(0xFFF8F6F2.toInt())
        }
        root.addView(TextView(this).apply {
            text = "选择这个小手机桌面实例"
            textSize = 21f
            setTextColor(0xFF2B2B2B.toInt())
        })
        root.addView(TextView(this).apply {
            text = "每个实例可以使用不同角色、不同 HTML/CSS 和不同尺寸。"
            textSize = 13f
            setTextColor(0xFF6B6258.toInt())
            setPadding(0, dp(8), 0, dp(18))
        })

        val profiles = loadProfiles()
        if (profiles.isEmpty()) {
            root.addView(TextView(this).apply {
                text = "还没有独立配置。请先回小手机 → 设置 → 桌面小组件创建配置，再来添加。"
                textSize = 14f
                setTextColor(0xFF8A5A4A.toInt())
            })
        }
        for (profile in profiles) {
            root.addView(Button(this).apply {
                text = profile.second + "\n" + profile.first
                isAllCaps = false
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                setOnClickListener { choose(widgetId, profile.first) }
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(64)).apply { bottomMargin = dp(8) })
        }

        root.addView(Button(this).apply {
            text = "取消"
            isAllCaps = false
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(48)).apply { topMargin = dp(8) })

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun choose(widgetId: Int, profileId: String) {
        PhoneWidgetProvider.assignProfile(this, widgetId, profileId)
        val (w, h, scale) = PhoneWidgetProvider.loadSize(this, profileId)
        PhoneWidgetRenderer.renderCached(this, profileId, w, h, scale)
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        finish()
    }

    private fun loadProfiles(): List<Pair<String, String>> {
        val raw = getSharedPreferences("shell_phone_widget", MODE_PRIVATE).getString("profiles_json", "[]") ?: "[]"
        return runCatching {
            val array = org.json.JSONArray(raw)
            (0 until array.length()).mapNotNull { index ->
                val item = array.optJSONObject(index) ?: return@mapNotNull null
                val id = item.optString("id", "").trim()
                if (id.isBlank()) null else id to item.optString("name", id).ifBlank { id }
            }
        }.getOrDefault(emptyList()).ifEmpty { listOf("default" to "默认实例") }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
