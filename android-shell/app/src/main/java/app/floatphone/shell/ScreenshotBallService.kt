package app.floatphone.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.res.Configuration
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File
import kotlin.math.abs

/**
 * 截屏悬浮球：一个贴边的圆点，轻点一下就截当前屏。
 *
 * 为什么要有它——截屏的另一半动机：
 *   「主动查岗」是角色想看你；但很多时候是**你自己**想给角色看点什么
 *   （刚拼好的乐高、正在排队、路上遇到的猫）。没有悬浮球时，你只能先
 *   进小手机、翻设置、点测试——等真截到时那个瞬间早过去了。
 *
 * 与查岗共用的部分：
 *   点击后**不自己截**，而是把活交给 CheckInService（source=user）。
 *   预览、审批、回复框、超时丢弃——整套都是同一份实现。这里只负责
 *   「一个能拖动的圆点」和「把点击转成一次截屏请求」。
 *
 * 设计边界（改这个文件前先读）：
 *  - **只在用户点它时才截**：没有定时、没有监听、不响应任何自动触发。
 *  - 默认不显示：由网页在用户打开「截屏悬浮球」开关时拉起（此刻 App 在前台，
 *    才能合法启动前台服务），关掉即收。
 *  - 图仍然只在本机流转：真正的截屏与审批在 CheckInService，隐私约定与查岗完全一致。
 */
class ScreenshotBallService : Service() {

    companion object {
        private const val CH = "shell_screenshot_ball"
        private const val NOTIF_ID = 5

        private const val ACTION_PREPARE = "app.floatphone.shell.BALL_PREPARE"
        private const val ACTION_STOP = "app.floatphone.shell.BALL_STOP"

        private const val PREFS = "screenshot_ball_prefs"

        /** 默认位置与屏幕边缘的间距。 */
        private const val EDGE_DP = 6

        /** 松手靠近边缘时，只露出这一小段，减少遮挡但仍可抓住拖回。 */
        private const val EDGE_PEEK_DP = 12

        /** 只有拖到边缘附近才进入内缩状态；屏幕中间松手不吸边。 */
        private const val EDGE_TRIGGER_DP = 24

        /** 直径默认值（用户可在设置里改，32~96）。 */
        private const val DEFAULT_DIAMETER_DP = 50

        /** 外观默认值：蓝底白字「截」。 */
        private const val DEFAULT_TEXT = "截"
        private const val DEFAULT_COLOR = 0xE65B7CFA.toInt()

        // ── 外观配置（由网页下发，落 SharedPreferences）──
        //
        // 为什么存盘而不是只放内存：球是原生画的，而用户改外观的那一刻
        // 网页在前台；改完可能要过很久再重启 App（服务被系统拉起），
        // 那时网页还没加载，只能读盘。

        /** 球上的文字（空串 = 不显示文字，只画圆点）。 */
        @Volatile
        private var ballText: String = DEFAULT_TEXT

        /** 球的主色。 */
        @Volatile
        private var ballColor: Int = DEFAULT_COLOR

        /** 球直径（dp）。 */
        @Volatile
        private var ballDiameterDp: Int = DEFAULT_DIAMETER_DP

        /** 自定义图片的落盘路径（空串 = 没有，用纯色圆点）。 */
        @Volatile
        private var ballImagePath: String = ""

        /** 从盘里读一次外观配置。 */
        private fun loadStyle(context: Context) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            ballText = prefs.getString("text", DEFAULT_TEXT) ?: DEFAULT_TEXT
            ballColor = prefs.getInt("color", DEFAULT_COLOR)
            ballDiameterDp = prefs.getInt("diameter", DEFAULT_DIAMETER_DP).coerceIn(32, 96)
            // 图片路径也要校验文件还在：用户清过数据、或文件被系统清理时，
            // 路径还留在盘上但文件没了——这时必须退回纯色，否则球会变成空白。
            val savedImage = prefs.getString("image_path", "").orEmpty()
            ballImagePath = if (savedImage.isNotEmpty() && File(savedImage).exists()) savedImage else ""
        }

        /**
         * 下发外观并即时重画。参数形如 {"text","color","diameter","image"}。
         *
         * image 的语义：空串 = 清除自定义图片回到纯色；非空 = base64 PNG；
         * **字段不存在 = 这次不改图片**。三者必须分开，否则「只改颜色」
         * 会把用户上传的图弄丢。
         */
        fun setStyle(context: Context, json: String): Boolean = runCatching {
            val obj = JSONObject(json)
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val editor = prefs.edit()
            if (obj.has("text")) {
                val text = obj.optString("text", DEFAULT_TEXT).take(4)
                ballText = text
                editor.putString("text", text)
            }
            if (obj.has("color")) {
                val parsed = parseColor(obj.optString("color", ""))
                if (parsed != null) {
                    ballColor = parsed
                    editor.putInt("color", parsed)
                }
            }
            if (obj.has("diameter")) {
                val size = obj.optInt("diameter", DEFAULT_DIAMETER_DP).coerceIn(32, 96)
                ballDiameterDp = size
                editor.putInt("diameter", size)
            }
            if (obj.has("image")) {
                val base64 = obj.optString("image", "")
                if (base64.isEmpty()) {
                    ballImagePath = ""
                    editor.putString("image_path", "")
                } else {
                    // 落成文件而不是塞进 prefs：几十 KB 的 base64 放 prefs 里
                    // 会让每次读写都变慢，而 prefs 是同步提交、会卡主线程。
                    val target = File(context.filesDir, "screenshot_ball_custom.png")
                    val saved = runCatching {
                        target.writeBytes(Base64.decode(base64, Base64.DEFAULT))
                        // 落盘后立刻验证能解码成图：解不出来就当没设，
                        // 免得球变成一个空白方块
                        BitmapFactory.decodeFile(target.absolutePath) != null
                    }.getOrDefault(false)
                    if (saved) {
                        ballImagePath = target.absolutePath
                        editor.putString("image_path", ballImagePath)
                    }
                }
            }
            editor.apply()
            // 球正显示着就当场重画——改完能立刻看到效果，不用重开开关
            liveInstance?.let { it.main.post { it.rebuildBall() } }
            true
        }.getOrDefault(false)

        /** 读当前外观（设置页回显用）。 */
        fun styleJson(context: Context): String {
            loadStyle(context)
            return JSONObject()
                .put("text", ballText)
                .put("color", colorToHex(ballColor))
                .put("diameter", ballDiameterDp)
                // 只报「有没有自定义图片」，不回图本身——设置页不需要
                // 拿回几万字符的 base64，它自己那边还留着原图。
                .put("hasImage", ballImagePath.isNotEmpty())
                .toString()
        }

        /** #RRGGBB 或 #AARRGGBB → 颜色 int；解析不了返回 null（保持原色）。 */
        private fun parseColor(raw: String): Int? {
            val hex = raw.trim().removePrefix("#")
            return runCatching {
                when (hex.length) {
                    6 -> (0xFF000000L or hex.toLong(16)).toInt()
                    8 -> hex.toLong(16).toInt()
                    else -> null
                }
            }.getOrNull()
        }

        /** 颜色 int → #AARRGGBB（带透明度，设置页回显用）。 */
        private fun colorToHex(color: Int): String = "#%08X".format(color)

        /** 超过这个位移（dp）就算拖动，不算点击。 */
        private const val TAP_SLOP_DP = 8

        @Volatile
        private var running = false

        @Volatile
        private var liveInstance: ScreenshotBallService? = null

        /** 浮窗权限是否已授予（与通话浮窗、查岗共用同一个系统权限）。 */
        fun canDraw(context: Context): Boolean =
            Build.VERSION.SDK_INT < 23 || android.provider.Settings.canDrawOverlays(context)

        /**
         * 拉起悬浮球。返回是否成功发起；false 多半是没给浮窗权限。
         * 必须由网页在 App 前台时调用（Android 12+ 禁止后台启动前台服务）。
         */
        fun prepare(context: Context): Boolean {
            if (!canDraw(context)) return false
            return runCatching {
                val intent = Intent(context, ScreenshotBallService::class.java).apply { action = ACTION_PREPARE }
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
                else context.startService(intent)
                true
            }.getOrDefault(false)
        }

        /** 收掉悬浮球（用户关闭开关时调用）。 */
        fun stop(context: Context) {
            runCatching {
                context.startService(
                    Intent(context, ScreenshotBallService::class.java).apply { action = ACTION_STOP },
                )
            }
        }

        fun isRunning(): Boolean = running

        /** 能力与状态快照，给设置面板显示三态。 */
        fun capabilitiesJson(): String = JSONObject()
            .put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
            .put("accessibilityOn", ScreenshotBridge.isAccessibilityOn())
            .put("running", running)
            .toString()
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var windowManager: WindowManager
    private var ballView: View? = null

    /** 当前位置（px，相对屏幕左上角）。 */
    private var posX = 0
    private var posY = 0
    private var diameterPx = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        loadStyle(this)
        diameterPx = dp(ballDiameterDp)
        createChannel()
        startForeground(NOTIF_ID, buildNotification())
    }

    /**
     * 按当前外观重画球（用户改配置时调用）。
     *
     * 先拆再建而不是就地改属性：直径变了窗口尺寸也得变，
     * 而窗口尺寸只能在 addView 时定，updateViewLayout 改不了大小。
     */
    private fun rebuildBall() {
        ballView?.let { view -> runCatching { windowManager.removeView(view) } }
        ballView = null
        diameterPx = dp(ballDiameterDp)
        showBall()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PREPARE -> {
                running = true
                liveInstance = this
                main.post { showBall() }
            }
            ACTION_STOP -> {
                teardown()
                return START_NOT_STICKY
            }
            // START_STICKY 被系统重新拉起时 intent 可能为 null：
            // 照常把球挂回去，不然「被系统杀过一次就再也不出现」。
            null -> {
                running = true
                liveInstance = this
                main.post { showBall() }
            }
        }
        return START_STICKY
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        main.post {
            if (ballView != null) {
                diameterPx = dp(ballDiameterDp)
                clamp(allowTucked = true)
                applyPosition()
            }
        }
    }

    override fun onDestroy() {
        teardown()
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    /**
     * 读自定义图片并裁成圆形。没有图片、读失败都返回 null（调用方退回纯色）。
     *
     * 裁剪必须在这里做：直接把方图设成背景会露出四角，而球是个圆。
     * 用 Canvas + SRC_IN 涂一遍是最省事的圆裁法——先把整个圆画成不透明，
     * 再把图叠上去按 SRC_IN 混合，圆外的部分自然被切掉。
     */
    private fun loadBallImage(): Bitmap? {
        val path = ballImagePath
        if (path.isEmpty()) return null
        return runCatching {
            val source = BitmapFactory.decodeFile(path) ?: return null
            val size = diameterPx.coerceAtLeast(1)
            val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(output)
            val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
            val rect = android.graphics.RectF(0f, 0f, size.toFloat(), size.toFloat())
            paint.color = Color.WHITE
            canvas.drawOval(rect, paint)
            paint.xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN)
            // 等比缩到正方形再画。非正方形的源图会被拉一下——
            // 球就那么大，用户传的多半也是头像类方图，不值得为它做复杂裁切。
            canvas.drawBitmap(Bitmap.createScaledBitmap(source, size, size, true), 0f, 0f, paint)
            output
        }.getOrNull()
    }

    private fun loadPosition() {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels
        val hasSavedX = prefs.contains("x")
        val savedX = prefs.getInt("x", -1)
        val savedY = prefs.getInt("y", -1)
        // 负数 X 代表用户主动把球收进左边缘，不能当成「没有保存过位置」。
        diameterPx = dp(ballDiameterDp)
        posX = if (hasSavedX) savedX else screenW - diameterPx - dp(EDGE_DP)
        posY = if (prefs.contains("y")) savedY else screenH / 3
        clamp(allowTucked = true)
    }

    /**
     * 普通拖动时球必须完整留在屏幕内；旋转/恢复位置时则允许保留已内缩的边缘状态。
     */
    private fun clamp(allowTucked: Boolean = false) {
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels
        val peekPx = dp(EDGE_PEEK_DP).coerceAtMost(diameterPx)
        val wasTuckedLeft = allowTucked && posX < 0
        val wasTuckedRight = allowTucked && posX + diameterPx > screenW
        val minX = if (wasTuckedLeft) -(diameterPx - peekPx) else 0
        val maxX = if (wasTuckedRight) maxOf(0, screenW - peekPx) else maxOf(0, screenW - diameterPx)
        posX = posX.coerceIn(minX, maxX)
        posY = posY.coerceIn(0, maxOf(0, screenH - diameterPx))
    }

    private fun savePosition() {
        runCatching {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt("x", posX).putInt("y", posY).apply()
        }
    }

    private fun showBall() {
        if (!canDraw(this)) return
        if (ballView != null) return
        loadStyle(this)
        loadPosition()

        // 有自定义图片就用图片当球面，否则用纯色圆点。
        // 图片模式不显示文字——图上的内容才是主体，再叠个字只会糊成一团。
        val customImage = loadBallImage()
        val view = TextView(this).apply {
            text = if (customImage != null) "" else ballText
            setTextColor(Color.WHITE)
            // 字号跟着直径走：球调大了字还是 16sp 会显得又小又空
            setTextSize(TypedValue.COMPLEX_UNIT_SP, (ballDiameterDp * 0.32f).coerceIn(12f, 28f))
            gravity = Gravity.CENTER
            background = if (customImage != null) {
                BitmapDrawable(resources, customImage)
            } else {
                GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(ballColor)
                    setStroke(dp(2), 0x66FFFFFF)
                }
            }
            // 让整块圆都吃触摸事件（否则只有文字那一小块能拖）
            isClickable = true
        }

        var downRawX = 0f
        var downRawY = 0f
        var originX = 0
        var originY = 0
        var moved = false

        view.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = event.rawX
                    downRawY = event.rawY
                    originX = posX
                    originY = posY
                    moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downRawX
                    val dy = event.rawY - downRawY
                    if (!moved && abs(dx) + abs(dy) > dp(TAP_SLOP_DP)) moved = true
                    if (moved) {
                        posX = (originX + dx).toInt()
                        posY = (originY + dy).toInt()
                        clamp()
                        applyPosition()
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (moved) {
                        // 平时自由停在松手位置；只有松手点靠近左右边缘时才内缩避让。
                        snapToEdge()
                        savePosition()
                    } else {
                        onBallTapped()
                    }
                    true
                }
                else -> false
            }
        }

        ballView = view
        val params = buildLayoutParams()
        runCatching { windowManager.addView(view, params) }
    }

    /**
     * 不再强制左右吸边：中间区域松手就留在原地。
     * 只有拖到边缘触发区时，才把大部分球身收进屏幕外，留下可点击/可拖回的边缘。
     */
    private fun snapToEdge() {
        val screenW = resources.displayMetrics.widthPixels
        val triggerPx = dp(EDGE_TRIGGER_DP)
        val peekPx = dp(EDGE_PEEK_DP).coerceAtMost(diameterPx)
        when {
            posX <= triggerPx -> posX = -(diameterPx - peekPx)
            posX + diameterPx >= screenW - triggerPx -> posX = maxOf(0, screenW - peekPx)
            else -> clamp()
        }
        posY = posY.coerceIn(0, maxOf(0, resources.displayMetrics.heightPixels - diameterPx))
        applyPosition()
    }

    private fun buildLayoutParams(): WindowManager.LayoutParams {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        return WindowManager.LayoutParams(
            diameterPx,
            diameterPx,
            type,
            // NOT_FOCUSABLE：不抢你正在用的 App 的输入焦点；
            // NOT_TOUCH_MODAL：点到球以外的地方照常传给下面的 App。
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = posX
            y = posY
        }
    }

    private fun applyPosition() {
        val view = ballView ?: return
        val params = (view.layoutParams as? WindowManager.LayoutParams) ?: return
        params.x = posX
        params.y = posY
        runCatching { windowManager.updateViewLayout(view, params) }
    }

    /**
     * 轻点球：交给 CheckInService 截屏并弹预览浮层。
     *
     * characterId 传空——「发给谁」等用户点完「发给它」由网页决定
     * （取最近的私聊会话）。这样即便点击那一刻网页已被系统回收，
     * 截屏与审批照样能进行，不会出现「点了球没反应」。
     */
    private fun onBallTapped() {
        CheckInService.show(this, "", "", "", CheckInService.SOURCE_USER)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        runCatching {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CH, "截屏悬浮球", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "桌面上那个点一下就能截屏的小圆点"
                    setShowBadge(false)
                },
            )
        }
    }

    /** 常驻通知做成静默：球本身已经在桌面上了，不该再刷一条通知。 */
    private fun buildNotification(): android.app.Notification {
        val open = PendingIntent.getActivity(
            this, 91,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("小手机")
            .setContentText("截屏悬浮球已开启")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
    }

    private fun teardown() {
        running = false
        if (liveInstance === this) liveInstance = null
        ballView?.let { view -> runCatching { windowManager.removeView(view) } }
        ballView = null
        stopForeground(true)
        stopSelf()
    }
}
