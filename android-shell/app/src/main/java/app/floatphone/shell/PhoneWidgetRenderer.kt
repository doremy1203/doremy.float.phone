package app.floatphone.shell

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebView
import java.io.File
import java.io.FileOutputStream

/**
 * 桌面小组件的渲染器：把网页给来的 HTML 画成一张 PNG。
 *
 * 为什么由原生渲染而不是网页自己转图：
 *   网页侧 canvas.toDataURL 一旦遇到跨域图片就会污染画布直接失败；
 *   交给离屏 WebView 渲染没有这个限制，而且小手机完全关闭时，
 *   原生还能用上次缓存的 HTML 自己重画（系统定时刷新那条路）。
 *
 * 线程：@JavascriptInterface 方法由 WebView 的 JavaBridge 线程调用，
 * **不在主线程**——而 WebView 只能在主线程创建/操作，所以这里统一 post 回主线程。
 *
 * 尺寸：小组件通过 RemoteViews.setImageViewBitmap 更新，走 Binder 传输，
 * 单次上限约 1MB。所以渲染像素被 MAX_DIMEN 夹住，宁可略糊也不能超限
 * （超了会直接抛 TransactionTooLargeException，小组件显示不出来）。
 */
object PhoneWidgetRenderer {

    private const val PREFS = "shell_phone_widget"
    private const val KEY_HTML = "last_html"

    /** 渲染出的图片文件名。 */
    const val PNG_NAME = "phone_widget.png"

    /** 单边最大像素。约 1200×600 的 PNG 通常只有一两百 KB，离 1MB 上限很远。 */
    private const val MAX_DIMEN = 1200

    /** 页面加载完成后再等一小会儿才截图：字体、data URL 图片解码都需要一点时间。 */
    private const val DRAW_DELAY_MS = 160L

    /**
     * 不依赖 onPageFinished 的固定绘制时机（毫秒）。
     *
     * 为什么非要这样一个时机：实测反馈是诊断面板长时间停在「正在渲染」、PNG 永不落盘。
     * 根因是 **onPageFinished 并不保证会来**——模板里若引了 http(s) 图片，
     * 而我们为了不卡住设了 blockNetworkLoads=true，那张图就会一直保持 pending，
     * 浏览器因此认为页面「没加载完」，回调可能拖到资源超时甚至永不触发。
     * 而模板本身是**本地 HTML 字符串**，解析只要几毫秒，真正该等的只有字体与
     * data URL 图片的解码——400ms 足够画出成品。
     * 所以到点就画，不再把「出图」这件事押在那个回调上。
     */
    private const val FALLBACK_PAINT_MS = 400L

    /** 画出来是空白时的重试次数与间隔（见 renderToFile 里的 paint）。 */
    private const val MAX_PAINT_ATTEMPTS = 3
    private const val REPAINT_INTERVAL_MS = 300L

    /**
     * 最近一次渲染的结论。
     *
     * 为什么必须记：渲染失败原来一律静默（`runCatching {}` 把异常吞掉），
     * 桌面只会退回成应用图标——用户看到「加了个图标、模板没出来」，
     * 而我们从代码里看不出卡在哪一步，只能反复猜（实测已经来回好几轮）。
     * 把结论留在这里，由 diagnosticsJson 回给网页设置页。
     */
    @Volatile private var lastRenderAt: Long = 0L
    @Volatile private var lastRenderOk: Boolean = false
    @Volatile private var lastRenderError: String = ""
    /** 是否有一次渲染正在进行中：用来区分「还没跑过」和「跑了没结果」。 */
    @Volatile private var renderInFlight: Boolean = false

    /** 存下这次的 HTML，供系统定时刷新（onUpdate）时重画。 */
    private fun safeProfileKey(profileId: String): String = profileId.replace(Regex("[^A-Za-z0-9_-]"), "_").take(64).ifBlank { "default" }
    private fun htmlKey(profileId: String) = if (profileId == "default") KEY_HTML else KEY_HTML + "_" + safeProfileKey(profileId)

    fun saveHtml(context: Context, html: String, profileId: String = "default") {
        runCatching {
            context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(htmlKey(profileId), html).apply()
        }
    }

    fun loadHtml(context: Context, profileId: String = "default"): String? = runCatching {
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(htmlKey(profileId), null)
    }.getOrNull()

    fun pngFile(context: Context, profileId: String = "default"): File {
        val name = if (profileId == "default") PNG_NAME else "phone_widget_" + safeProfileKey(profileId) + ".png"
        return File(context.applicationContext.filesDir, name)
    }

    fun deleteProfile(context: Context, profileId: String) {
        if (profileId.isBlank() || profileId == "default") return
        runCatching {
            context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(htmlKey(profileId)).apply()
            pngFile(context, profileId).delete()
        }
    }

    /**
     * 小组件的当前状态，给网页设置页的「检查状态」按钮用。
     *
     * 只如实回读，不做任何判断——卡在哪一步由用户看着数值判断（或转述给我们）。
     * 包含：有没有缓存 HTML、PNG 有没有落盘、多大、最后一次渲染是成功还是败在哪一句。
     */
    fun diagnosticsJson(context: Context): String = runCatching {
        val appContext = context.applicationContext
        val html = loadHtml(appContext)
        val file = pngFile(appContext)
        org.json.JSONObject()
            .put("hasHtml", html != null)
            .put("htmlChars", html?.length ?: 0)
            .put("pngExists", file.exists())
            .put("pngBytes", if (file.exists()) file.length() else 0L)
            .put("pngAt", if (file.exists()) file.lastModified() else 0L)
            .put("renderAt", lastRenderAt)
            .put("renderOk", lastRenderOk)
            .put("renderError", lastRenderError)
            .put("rendering", renderInFlight)
            .put("placed", PhoneWidgetProvider.isPlaced(appContext))
            .toString()
    }.getOrDefault("{}")

    /** 用当前缓存的 HTML 重画一次（系统定时刷新、或桌面需要重新贴图时）。 */
    fun renderCached(context: Context, widthDp: Int = 300, heightDp: Int = 150, scale: Int = 2) {
        renderCached(context, "default", widthDp, heightDp, scale)
    }

    fun renderCached(context: Context, profileId: String, widthDp: Int = 300, heightDp: Int = 150, scale: Int = 2) {
        val html = loadHtml(context, profileId) ?: return
        renderAndPush(context, profileId, html, widthDp, heightDp, scale)
    }

    /**
     * 渲染并刷新桌面。
     *
     * 立即返回：真正的渲染是异步的（要等 WebView 加载完）。
     * 网页把返回值当作「已受理」，不当作「已显示」——这是刻意的，
     * 因为渲染要走主线程 + 网络无关的本地 HTML，通常几十毫秒内完成。
     */
    fun renderAndPush(context: Context, html: String, widthDp: Int, heightDp: Int, scale: Int) {
        renderAndPush(context, "default", html, widthDp, heightDp, scale)
    }

    fun renderAndPush(context: Context, profileId: String, html: String, widthDp: Int, heightDp: Int, scale: Int) {
        val appContext = context.applicationContext
        saveHtml(appContext, html, profileId)
        PhoneWidgetProvider.saveSize(appContext, widthDp, heightDp, scale, profileId)
        Handler(Looper.getMainLooper()).post {
            renderToFile(appContext, profileId, html, widthDp, heightDp, scale) {
                PhoneWidgetProvider.updateProfile(appContext, profileId)
            }
        }
    }

    /**
     * 真正干活的渲染。必须在主线程调用。
     *
     * 失败时静默返回：小组件显示不出来是「少个装饰」，不该影响任何主流程。
     */
    private fun renderToFile(
        context: Context,
        profileId: String,
        html: String,
        widthDp: Int,
        heightDp: Int,
        scale: Int,
        onDone: () -> Unit,
    ) {
        val density = context.resources.displayMetrics.density
        // scale 的语义：2 = 按 dp×density 的「标准清晰度」渲染，
        // 1 = 减半（更小的文件），3 = 加 1.5 倍（更清晰，仍受 MAX_DIMEN 夹住）。
        val factor = (scale.coerceIn(1, 3) / 2f)
        val widthPx = (widthDp * density * factor).toInt().coerceIn(widthDp, MAX_DIMEN)
        val heightPx = (heightDp * density * factor).toInt().coerceIn(heightDp, MAX_DIMEN)

        renderInFlight = true
        lastRenderAt = System.currentTimeMillis()
        lastRenderOk = false
        lastRenderError = ""

        var webView: WebView? = null
        // 收尾只能走一次：onPageFinished 与超时兜底谁先到谁负责。
        // 不加这道锁的话两者都会销毁 WebView 并回调 onDone（桌面被重复刷新）。
        var settled = false
        val finish: (Boolean, String) -> Unit = { ok, error ->
            if (!settled) {
                settled = true
                lastRenderOk = ok
                lastRenderError = error
                renderInFlight = false
                runCatching { webView?.destroy() }
                onDone()
            }
        }
        try {
            webView = WebView(context).apply {
                setBackgroundColor(Color.TRANSPARENT)
                // ★ 关键：离屏 WebView 默认走**硬件加速**渲染，而 view.draw(canvas)
                // 只能捕获软件层绘制的内容——不设这一句，画出来是一张全透明的空图。
                // 表现正是实测反馈的：PNG 文件确实落盘了（尺寸也对）、桌面也确实
                // 换掉了应用图标，但那张图上是空的、什么都不显示。
                // 之前几轮没往这里想，是因为所有「有没有出图」的判断都只看文件在不在。
                setLayerType(View.LAYER_TYPE_SOFTWARE, null)
                settings.javaScriptEnabled = false // 模板里的 <script> 不该运行
                settings.domStorageEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.blockNetworkLoads = true // 不联网：模板里的 http 图片不会加载，避免卡住
            }
            val view = webView
            // webViewClient 必须在 load 之前挂上。
            // 原来的顺序是先 load 再设回调：本地 HTML 字符串几乎瞬间加载完，
            // onPageFinished 会在回调挂上之前就触发，于是回调永远不来、
            // PNG 永远不落盘，桌面只能显示占位图——
            // 表现就是「加了小组件，显示出来却是个应用大图标」。
            // 绘制动作抽出来，给下面两条触发路径共用。
            // 异常必须**记下来**而不是吞掉：原来这里只有 runCatching，于是「画失败」
            // 与「画成功」在外部完全一样（桌面同样退回图标），从代码里根本看不出
            // 卡在哪一步——这也是这个问题来回好几轮的原因。
            // ⚠️ 这里必须是**局部函数**，不能写成 `val paint: () -> Unit = { ... paint() ... }`。
            // 后者是「在自己初始化时引用自己」，Kotlin 直接报 Unresolved reference（第 71 次
            // 构建就是这么挂的）。也考虑过 lateinit——但它只能修饰**类属性**，而 paint 捕获了
            // view / attempts / widthPx 这些局部变量，提升不上去。局部函数天然可递归，最干净。
            var attempts = 0
            fun paint() {
                // 两条触发路径（onPageFinished 与固定兜底）都可能调到这里，
                // 已经收尾过就直接返回：否则会重复写文件，还把重试次数白白耗掉。
                if (settled) return
                attempts += 1
                val result = runCatching { drawToFile(context, profileId, view, widthPx, heightPx) }
                when {
                    // 画出了东西：收工。
                    result.getOrDefault(false) -> finish(true, "")
                    // 还是空白：多半 WebView 尚未渲染完（onPageFinished 没来、或不及时），
                    // 隔一会儿再画一次。
                    attempts < MAX_PAINT_ATTEMPTS ->
                        Handler(Looper.getMainLooper()).postDelayed({ paint() }, REPAINT_INTERVAL_MS)
                    // 多次重试仍空白：如实报出来，别再让诊断停在「正在渲染」那种中间态——
                    // 「文件存在但图是空的」以前从任何信号里都看不出来（实测反馈）。
                    else -> finish(
                        false,
                        result.exceptionOrNull()?.let { "${it.javaClass.simpleName}: ${it.message ?: ""}" }
                            ?: "画了 $attempts 次仍是空白（WebView 没有渲染出内容）",
                    )
                }
            }
            view.webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(v: WebView?, url: String?) {
                    v?.postDelayed({ paint() }, DRAW_DELAY_MS)
                }
            }
            // ── 绘制触发：两条路，谁先到谁画（settled 锁保证只画一次）──
            //   ① onPageFinished + 小延迟 —— 正常情况走这条，最快；
            //   ② 固定延迟兜底 —— **不等 onPageFinished**，理由见 FALLBACK_PAINT_MS。
            Handler(Looper.getMainLooper()).postDelayed({ paint() }, FALLBACK_PAINT_MS)
            view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        } catch (err: Throwable) {
            finish(false, "创建或加载离屏 WebView 失败：${err.javaClass.simpleName}: ${err.message ?: ""}")
        }
    }

    /**
     * 把已经加载好的 WebView 画进 Bitmap 并落盘。
     *
     * @return 画面上有没有内容。false = 全透明（WebView 还没渲染出东西）。
     *         **落盘了不等于画对了**：一张空白 PNG 贴到桌面上就是什么都不显示，
     *         与失败无异，调用方该据此重画或报错，而不是当成成功。
     */
    private fun drawToFile(context: Context, profileId: String, view: WebView, widthPx: Int, heightPx: Int): Boolean {
        val bitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        view.measure(
            View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, widthPx, heightPx)
        view.draw(canvas)

        val hasContent = !isBlank(bitmap)
        FileOutputStream(pngFile(context, profileId)).use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        }
        bitmap.recycle()
        return hasContent
    }

    /**
     * 抽样判断画面是不是一片空白（全透明）。
     *
     * 为什么要它：「PNG 已落盘、桌面也换了图，但图上什么都没有」这种状态，
     * 从「文件存不存在」这个信号里完全看不出来（实测反馈正是如此）。
     * 横竖各抽 24 个点扫一遍，只要有一个不透明像素就当有内容，成本可忽略。
     */
    private fun isBlank(bitmap: Bitmap): Boolean {
        val stepX = (bitmap.width / 24).coerceAtLeast(1)
        val stepY = (bitmap.height / 24).coerceAtLeast(1)
        var y = 0
        while (y < bitmap.height) {
            var x = 0
            while (x < bitmap.width) {
                if (Color.alpha(bitmap.getPixel(x, y)) != 0) return false
                x += stepX
            }
            y += stepY
        }
        return true
    }
}
