package app.floatphone.shell

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.widget.RemoteViews

/**
 * 桌面小组件：在桌面上显示角色留下的话。
 *
 * 实现方式（改之前先读）：
 *   小组件本身**只放一个 ImageView**，图由 PhoneWidgetRenderer 用离屏 WebView
 *   渲染网页模板得到。为什么绕这一圈：Android 的 RemoteViews 只允许
 *   LinearLayout/TextView/ImageView 这类基础控件，写不了 CSS——
 *   而用户要的正是「自己排版、自己写样式」，只能靠网页渲染成图。
 *   代价：图里不能有独立可点的按钮，整块点一下是打开小手机。
 *
 * 更新时机：
 *   · 网页侧内容一变 → widgetUpdate → renderAndPush → updateAll（立刻，无频率限制）；
 *   · 系统定时（updatePeriodMillis，最快 30 分钟）→ onUpdate → 用缓存 HTML 重画。
 *   后者是「小手机完全关闭」时的兜底。
 */
class PhoneWidgetProvider : AppWidgetProvider() {

    companion object {
        /** 尺寸信息从 RemoteViews 拿不到，用户在设置页配的值由网页传来。
         *  这里存一份，供 onUpdate（系统定时，网页不在场）重画时用。 */
        private const val PREFS = "shell_phone_widget"
        private const val KEY_W = "width_dp"
        private const val KEY_H = "height_dp"
        private const val KEY_SCALE = "scale"
        private const val PROFILE_MAP_PREFS = "shell_phone_widget_profile_map"
        const val EXTRA_PROFILE_ID = "phone_widget_profile_id"
        const val ACTION_WIDGET_PINNED = "app.floatphone.shell.action.WIDGET_PINNED"

        private fun safeProfileKey(profileId: String): String = profileId.replace(Regex("[^A-Za-z0-9_-]"), "_").take(64).ifBlank { "default" }
        private fun profileMapKey(widgetId: Int) = "profile_$widgetId"
        private fun scopedSizeKey(base: String, profileId: String) = if (profileId == "default") base else base + "_" + safeProfileKey(profileId)

        fun saveSize(context: Context, widthDp: Int, heightDp: Int, scale: Int, profileId: String = "default") {
            runCatching {
                val app = context.applicationContext
                val edit = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                edit.putInt(scopedSizeKey(KEY_W, profileId), widthDp)
                    .putInt(scopedSizeKey(KEY_H, profileId), heightDp)
                    .putInt(scopedSizeKey(KEY_SCALE, profileId), scale)
                    .apply()
            }
        }

        fun loadSize(context: Context, profileId: String = "default"): Triple<Int, Int, Int> {
            val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return Triple(
                prefs.getInt(scopedSizeKey(KEY_W, profileId), prefs.getInt(KEY_W, 300)),
                prefs.getInt(scopedSizeKey(KEY_H, profileId), prefs.getInt(KEY_H, 150)),
                prefs.getInt(scopedSizeKey(KEY_SCALE, profileId), prefs.getInt(KEY_SCALE, 2)),
            )
        }

        /** Existing manually placed widgets remain on the legacy default profile. */
        fun profileFor(context: Context, widgetId: Int): String = runCatching {
            context.applicationContext.getSharedPreferences(PROFILE_MAP_PREFS, Context.MODE_PRIVATE)
                .getString(profileMapKey(widgetId), "default") ?: "default"
        }.getOrDefault("default")

        fun assignProfile(context: Context, widgetId: Int, profileId: String) {
            context.applicationContext.getSharedPreferences(PROFILE_MAP_PREFS, Context.MODE_PRIVATE).edit()
                .putString(profileMapKey(widgetId), profileId.ifBlank { "default" }).apply()
        }

        fun removeProfileAssignment(context: Context, widgetId: Int) {
            context.applicationContext.getSharedPreferences(PROFILE_MAP_PREFS, Context.MODE_PRIVATE).edit()
                .remove(profileMapKey(widgetId)).apply()
        }

        /** 桌面上是否已经放了至少一个本小组件实例。 */
        fun isPlaced(context: Context): Boolean {
            return runCatching {
                val manager = AppWidgetManager.getInstance(context)
                manager.getAppWidgetIds(ComponentName(context, PhoneWidgetProvider::class.java)).isNotEmpty()
            }.getOrDefault(false)
        }

        /**
         * 拉起系统的「添加到桌面」引导。
         * Android 8+ 用 requestPinAppWidget；更低版本降级为提示用户手动添加。
         */
        fun requestPin(context: Context) {
            requestPinProfile(context, "default")
        }

        /** Register a completion callback so the new launcher instance gets the chosen profile. */
        fun requestPinProfile(context: Context, profileId: String): Boolean = runCatching {
            val app = context.applicationContext
            val manager = AppWidgetManager.getInstance(app)
            if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O || !manager.isRequestPinAppWidgetSupported) return false
            val provider = ComponentName(app, PhoneWidgetProvider::class.java)
            val safeProfile = profileId.ifBlank { "default" }
            val callbackIntent = Intent(app, PhoneWidgetPinReceiver::class.java)
                .setAction(ACTION_WIDGET_PINNED)
                // 某些启动器/系统版本会丢掉自定义 extra；data URI 作为第二份身份。
                .setData(Uri.parse("floatshell://widget-pin/" + Uri.encode(safeProfile)))
                .putExtra(EXTRA_PROFILE_ID, safeProfile)
            val requestCode = 7100 + kotlin.math.abs(profileId.hashCode() % 100000)
            val callback = PendingIntent.getBroadcast(app, requestCode, callbackIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            manager.requestPinAppWidget(provider, null, callback)
        }.getOrDefault(false)

        /** Reset any instances bound to this profile before its cached render is deleted. */
        fun deleteProfile(context: Context, profileId: String): Boolean {
            if (profileId.isBlank() || profileId == "default") return false
            return runCatching {
                val app = context.applicationContext
                val manager = AppWidgetManager.getInstance(app)
                val ids = manager.getAppWidgetIds(ComponentName(app, PhoneWidgetProvider::class.java))
                ids.filter { profileFor(app, it) == profileId }.forEach { id ->
                    assignProfile(app, id, "default")
                    updateOne(app, manager, id)
                }
                PhoneWidgetRenderer.deleteProfile(app, profileId)
                app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .remove(scopedSizeKey(KEY_W, profileId)).remove(scopedSizeKey(KEY_H, profileId))
                    .remove(scopedSizeKey(KEY_SCALE, profileId)).apply()
                true
            }.getOrDefault(false)
        }

        /** Update only instances that use this HTML/CSS profile. */
        fun updateProfile(context: Context, profileId: String) {
            runCatching {
                val app = context.applicationContext
                val manager = AppWidgetManager.getInstance(app)
                manager.getAppWidgetIds(ComponentName(app, PhoneWidgetProvider::class.java))
                    .filter { profileFor(app, it) == profileId }
                    .forEach { updateOne(app, manager, it) }
            }
        }

        /** 刷新桌面上所有实例。内容更新后调用。 */
        fun updateAll(context: Context) {
            runCatching {
                val manager = AppWidgetManager.getInstance(context)
                val ids = manager.getAppWidgetIds(ComponentName(context, PhoneWidgetProvider::class.java))
                for (id in ids) {
                    updateOne(context, manager, id)
                }
            }
        }

        /** 画一个实例：读渲染好的 PNG，贴进 RemoteViews。 */
        fun updateOne(context: Context, manager: AppWidgetManager, widgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.phone_widget)
            val profileId = profileFor(context, widgetId)
            val file = PhoneWidgetRenderer.pngFile(context, profileId)
            val bitmap = if (file.exists()) runCatching { BitmapFactory.decodeFile(file.absolutePath) }.getOrNull() else null
            if (bitmap != null) {
                views.setImageViewBitmap(R.id.widget_image, bitmap)
            } else {
                // 还没渲染过：放占位图，不要显示成空白块
                views.setImageViewResource(R.id.widget_image, R.drawable.appicon)
            }

            // 整块可点：打开小手机。用包名显式构造 Intent，避免被别家 App 截获。
            val launch = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pending = PendingIntent.getActivity(
                context,
                0,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            views.setOnClickPendingIntent(R.id.widget_image, pending)
            manager.updateAppWidget(widgetId, views)
        }
    }

    /** 系统定时触发（最快 30 分钟一次）：用缓存 HTML 重画，不联网。 */
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, manager, appWidgetIds)
        // A single provider may host many independently styled profiles. Re-render each distinct profile once.
        appWidgetIds.map { profileFor(context, it) }.distinct().forEach { profileId ->
            val (w, h, scale) = loadSize(context, profileId)
            PhoneWidgetRenderer.renderCached(context, profileId, w, h, scale)
        }
        for (id in appWidgetIds) updateOne(context, manager, id)
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        manager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        super.onAppWidgetOptionsChanged(context, manager, appWidgetId, newOptions)
        // 用户拖动了小组件尺寸：用新尺寸重画。用户配的 dp 仍是基准，
        // 这里只让渲染跟上系统给的框（超出的部分会被裁掉，不做拉伸以免变形）。
        val minW = newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
        val minH = newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
        val profileId = profileFor(context, appWidgetId)
        if (minW > 0 && minH > 0) {
            val (_, _, scale) = loadSize(context, profileId)
            PhoneWidgetRenderer.renderCached(context, profileId, minW, minH, scale)
        }
        updateOne(context, manager, appWidgetId)
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        appWidgetIds.forEach { removeProfileAssignment(context, it) }
    }
}

/** Receives Android's confirmation that a pinned widget instance was really added. */
class PhoneWidgetPinReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val widgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return
        val profileId = intent?.getStringExtra(PhoneWidgetProvider.EXTRA_PROFILE_ID)
            ?: intent?.data?.lastPathSegment?.let { Uri.decode(it) }
            ?: "default"
        PhoneWidgetProvider.assignProfile(context, widgetId, profileId)
        val (widthDp, heightDp, scale) = PhoneWidgetProvider.loadSize(context, profileId)
        PhoneWidgetRenderer.renderCached(context, profileId, widthDp, heightDp, scale)
        PhoneWidgetProvider.updateOne(context, AppWidgetManager.getInstance(context), widgetId)
    }
}
