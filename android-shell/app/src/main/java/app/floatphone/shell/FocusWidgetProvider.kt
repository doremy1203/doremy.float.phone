package app.floatphone.shell

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.SystemClock
import android.widget.RemoteViews

/**
 * FocusWidgetProvider — 专注倒计时桌面小组件（原生 RemoteViews，v2 可换肤）。
 *
 * 与 PhoneWidgetProvider（HTML→离屏 WebView→Bitmap→ImageView）不同：
 * 本组件用 **原生 RemoteViews 布局**，核心是 Chronometer 的
 * setChronometerCountDown（API 24+）—— 系统自己每秒走表，**不需要网页每秒推送**。
 * 网页只在「会话事件」时推一次状态（开始/换阶段/完成任务/暂停/结束），
 * 组件即持续动态倒计时 —— 这就是「动态 widget」的正确实现。
 *
 * v2 样式：网页「小组件设置页」可编辑 背景(色+不透明度)/文字色/次要文字不透明度/
 * 圆角档位/任务行与 TA 行开关，随 update 载荷的 style 字段推来（styleOnly=true
 * 表示只换肤不动会话状态）。底图是纯白圆角 drawable，用 setColorFilter 上色
 * （SRC_ATOP 只染不透明像素，圆角外保持透明）；圆角换 drawable 档位。
 *
 * 多实例：与 PhoneWidgetProvider 同一套 widgetId→state 的映射思路。
 * 专注会话同一时刻只有一场，多个桌面实例是同一份状态的镜像（互相一致）。
 */
class FocusWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) push(context, manager, id)
    }

    override fun onDeleted(context: Context, ids: IntArray) { /* 状态是全局一份，无需按 id 清理 */ }

    /** 样式字段（全部有默认值，缺字段保持上一次/默认外观）。 */
    private data class WidgetStyle(
        val bg: Int,
        val bgAlphaPct: Int,
        val textColor: Int,
        val dimAlphaPct: Int,
        val radius: Int,
        val showTask: Boolean,
        val showTa: Boolean,
    )

    companion object {
        private const val PREFS = "focus_widget_v1"

        private fun prefs(context: Context) =
            context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        private fun parseColorSafe(raw: String?, fallback: Int): Int = runCatching {
            Color.parseColor((raw ?: "").trim())
        }.getOrDefault(fallback)

        private fun readStyle(p: android.content.SharedPreferences): WidgetStyle {
            val s = runCatching { org.json.JSONObject(p.getString("style", "{}") ?: "{}") }.getOrDefault(org.json.JSONObject())
            return WidgetStyle(
                bg = parseColorSafe(s.optString("bg", "#1B2030"), Color.parseColor("#1B2030")),
                bgAlphaPct = s.optInt("bgAlpha", 92).coerceIn(0, 100),
                textColor = parseColorSafe(s.optString("textColor", "#E8ECF5"), Color.parseColor("#E8ECF5")),
                dimAlphaPct = s.optInt("dimAlpha", 55).coerceIn(0, 100),
                radius = s.optInt("radius", 18).coerceIn(8, 24),
                showTask = s.optBoolean("showTask", true),
                showTa = s.optBoolean("showTa", true),
            )
        }

        private fun withAlpha(color: Int, alphaPct: Int): Int =
            Color.argb(alphaPct * 255 / 100, Color.red(color), Color.green(color), Color.blue(color))

        private fun bgDrawableFor(radius: Int): Int = when {
            radius <= 10 -> R.drawable.focus_widget_bg_r8
            radius <= 18 -> R.drawable.focus_widget_bg_r16
            else -> R.drawable.focus_widget_bg_r24
        }

        /** 网页推送一份会话状态（可带 style）并刷新所有专注小组件实例。
         *  json: {running:boolean, remainingMs:long, progress:int, task:String, ta:String, charName:String,
         *         styleOnly?:boolean, style?:{bg,bgAlpha,textColor,dimAlpha,radius,showTask,showTa}}
         *  styleOnly=true：只换肤，不动会话状态（设置页保存样式用）。 */
        fun update(context: Context, json: String): Boolean = runCatching {
            val p = prefs(context)
            val obj = org.json.JSONObject(json)
            val styleOnly = obj.optBoolean("styleOnly", false)
            val styleObj = obj.optJSONObject("style")
            if (styleObj != null) {
                p.edit().putString("style", styleObj.toString()).apply()
            }
            if (!styleOnly) {
                p.edit()
                    .putBoolean("running", obj.optBoolean("running", false))
                    .putLong("remainingMs", obj.optLong("remainingMs", 0))
                    .putLong("updateElapsed", SystemClock.elapsedRealtime())
                    .putInt("progress", obj.optInt("progress", 0).coerceIn(0, 100))
                    .putString("task", obj.optString("task", ""))
                    .putString("ta", obj.optString("ta", ""))
                    .putString("charName", obj.optString("charName", ""))
                    .apply()
            }
            pushAll(context)
            true
        }.getOrDefault(false)

        /** 移除小组件（清状态即可，实例由桌面管理）。 */
        fun remove(context: Context): Boolean {
            prefs(context).edit().clear().apply()
            pushAll(context)
            return true
        }

        /** 拉起系统的「添加到桌面」引导（Android 8+）。 */
        fun requestPin(context: Context): Boolean = runCatching {
            val manager = AppWidgetManager.getInstance(context)
            if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O || !manager.isRequestPinAppWidgetSupported) return false
            manager.requestPinAppWidget(ComponentName(context, FocusWidgetProvider::class.java), null, null)
        }.getOrDefault(false)

        /** 重算剩余毫秒：以 elapsedRealtime 为基准 —— 用户改系统时间不影响倒计时。 */
        private fun remainingNow(context: Context): Long {
            val p = prefs(context)
            if (!p.getBoolean("running", false)) return 0
            val elapsed = SystemClock.elapsedRealtime()
            val left = p.getLong("remainingMs", 0) - (elapsed - p.getLong("updateElapsed", elapsed))
            return if (left > 0) left else 0
        }

        private fun fmt(ms: Long): String {
            val total = (ms / 1000L).toInt()
            val h = total / 3600
            val m = (total % 3600) / 60
            val sec = total % 60
            return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%02d:%02d".format(m, sec)
        }

        /** 构建 RemoteViews 并推给指定实例。 */
        private fun push(context: Context, manager: AppWidgetManager, id: Int) {
            val p = prefs(context)
            val running = p.getBoolean("running", false)
            val remaining = remainingNow(context)
            val st = readStyle(p)
            val views = RemoteViews(context.packageName, R.layout.focus_widget)

            // 背景：白底圆角 drawable 上色（色值带不透明度），圆角换档位
            views.setInt(R.id.focus_widget_bg, "setImageResource", bgDrawableFor(st.radius))
            views.setInt(R.id.focus_widget_bg, "setColorFilter", withAlpha(st.bg, st.bgAlphaPct))

            // 文字：主色 + 次要色（标题/TA 行用 dim）
            val mainText = st.textColor
            val dimText = withAlpha(st.textColor, st.dimAlphaPct)
            views.setTextColor(R.id.focus_widget_title, dimText)
            views.setTextColor(R.id.focus_widget_chrono, mainText)
            views.setTextColor(R.id.focus_widget_paused, mainText)
            views.setTextColor(R.id.focus_widget_task, mainText)
            views.setTextColor(R.id.focus_widget_ta, dimText)
            views.setViewVisibility(R.id.focus_widget_task, if (st.showTask) android.view.View.VISIBLE else android.view.View.GONE)
            views.setViewVisibility(R.id.focus_widget_ta, if (st.showTa) android.view.View.VISIBLE else android.view.View.GONE)

            views.setTextViewText(R.id.focus_widget_title, "专注 · FOCUS")
            if (running && remaining > 0) {
                views.setViewVisibility(R.id.focus_widget_chrono, android.view.View.VISIBLE)
                views.setViewVisibility(R.id.focus_widget_paused, android.view.View.GONE)
                views.setChronometer(R.id.focus_widget_chrono, SystemClock.elapsedRealtime() + remaining, null, false)
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
                    views.setChronometerCountDown(R.id.focus_widget_chrono, true)
                }
            } else {
                views.setViewVisibility(R.id.focus_widget_chrono, android.view.View.GONE)
                views.setViewVisibility(R.id.focus_widget_paused, android.view.View.VISIBLE)
                views.setTextViewText(R.id.focus_widget_paused, if (running) fmt(remaining) else "未在专注")
            }
            views.setProgressBar(R.id.focus_widget_progress, 100, p.getInt("progress", 0), false)
            views.setTextViewText(R.id.focus_widget_task, p.getString("task", "")?.ifBlank { "今天能做的那件事" })
            val charName = p.getString("charName", "") ?: ""
            val ta = p.getString("ta", "") ?: ""
            views.setTextViewText(R.id.focus_widget_ta, if (ta.isBlank()) (if (charName.isBlank()) "" else "$charName · 陪你把这段时间走完") else ta)
            val open = PendingIntent.getActivity(
                context, 21,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            views.setOnClickPendingIntent(R.id.focus_widget_root, open)
            manager.updateAppWidget(id, views)
        }

        fun pushAll(context: Context) {
            runCatching {
                val manager = AppWidgetManager.getInstance(context)
                val ids = manager.getAppWidgetIds(ComponentName(context, FocusWidgetProvider::class.java))
                for (id in ids) push(context, manager, id)
            }
        }
    }
}
