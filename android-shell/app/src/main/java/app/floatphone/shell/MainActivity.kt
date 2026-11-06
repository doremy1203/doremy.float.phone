package app.floatphone.shell

import android.content.pm.ActivityInfo
import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import android.view.WindowManager
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.content.ClipboardManager
import android.content.ClipData
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.health.connect.client.PermissionController
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.io.FileOutputStream
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Float 小手机安卓壳：全屏 WebView 直接加载线上站点。
 * 网页每次部署即时生效，本壳只负责原生能力（推送长连接、文件上下行、外链）。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        val SITE_URL: String = BuildConfig.SITE_URL
        val VERSION: String = BuildConfig.VERSION_NAME
        /** 来电接听等场景的站内深链（必须以 SITE_URL 开头，否则忽略） */
        const val EXTRA_OPEN_URL = "open_url"
        /** 外部 App（如桌宠）唤起本壳用的自定义 scheme：floatshell://open?url=<站内地址> */
        const val DEEP_LINK_SCHEME = "floatshell"
        /**
         * 网页消息通知用的渠道 id，与 PushService 的「角色消息」渠道刻意同名：
         * 离线推送和网页内提醒最终落到通知栏的同一个分组，用户在系统设置里
         * 只需要管一个开关。渠道一旦创建过，后建的只更新名称/描述，不会重置用户选择。
         */
        const val CH_MESSAGES = "shell_messages"
        @Volatile private var nativeCrashRecorderInstalled = false
        private const val MAX_WEB_CONSOLE_LOGS = 200
        private val webConsoleLogs = java.util.Collections.synchronizedList(mutableListOf<String>())
        private fun recordWebConsoleMessage(message: String) {
            synchronized(webConsoleLogs) {
                webConsoleLogs.add(message.take(1200))
                while (webConsoleLogs.size > MAX_WEB_CONSOLE_LOGS) webConsoleLogs.removeAt(0)
            }
        }
        private fun webConsoleLogsJson(): String = synchronized(webConsoleLogs) {
            org.json.JSONArray(webConsoleLogs.toList()).toString()
        }
    }

    /**
     * 将上一次未捕获的原生崩溃留在应用私有目录，供用户下次启动后主动导出诊断。
     * 不上传、不读取业务数据；写入失败时仍交给 Android 原始崩溃处理器。
     */
    private fun installNativeCrashRecorder() {
        synchronized(MainActivity::class.java) {
            if (nativeCrashRecorderInstalled) return
            nativeCrashRecorderInstalled = true
            val appContext = applicationContext
            val previous = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                try {
                    val writer = java.io.StringWriter()
                    throwable.printStackTrace(java.io.PrintWriter(writer))
                    val body = "time=" + System.currentTimeMillis() +
                        "\nthread=" + thread.name +
                        "\n" + writer.toString()
                    val clipped = if (body.length > 30000) body.takeLast(30000) else body
                    File(appContext.filesDir, "last-native-crash.txt").writeText(clipped)
                } catch (_: Throwable) {
                    // Crash recorder must never replace the real crash handling path.
                }
                if (previous != null) {
                    previous.uncaughtException(thread, throwable)
                } else {
                    android.os.Process.killProcess(android.os.Process.myPid())
                }
            }
        }
    }

    private lateinit var rootContainer: FrameLayout
    private lateinit var webView: WebView
    /**
     * 主文档 URL 的 UI 线程快照。
     *
     * @JavascriptInterface 方法运行在 WebView 的私有后台线程；直接读 webView.url
     * 会触发 “Java exception was raised during method invocation”，表现为保存图片、
     * 陪看诊断、位置读取等原生桥全部失败。这里只缓存 WebView 主线程回调里的 URL，
     * 桥方法只做纯字符串比较，不再跨线程访问 WebView。
     */
    @Volatile private var trustedShellUrl: String? = SITE_URL
    private val bridgeNonce = UUID.randomUUID().toString()
    private var secureBridgeDocumentStartInstalled = false

    /** 大文件分块写入会话：避免一次把几百 MB 的 Base64 字符串塞进 JS Bridge。 */
    private data class ChunkedFileWrite(
        val uri: Uri?,
        val file: File?,
        val stream: OutputStream,
        var bytes: Long = 0L,
    )
    private val chunkedFileWrites = ConcurrentHashMap<String, ChunkedFileWrite>()
    private var recoveryOverlay: View? = null
    private var recoveryBoot = false
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    // Native custom view used by HTML5 video players embedded in the WebView.
    private var webVideoCustomView: View? = null
    private var webVideoCustomViewCallback: WebChromeClient.CustomViewCallback? = null

    /** 系统状态栏实际高度（CSS px，即物理像素 / density），实时更新。 */
    @Volatile
    private var statusBarHeightCssPx: Int = 0

    /** 当前键盘（IME）高度（物理像素），0 = 键盘收起；用于给 WebView 让出底部空间。 */
    private var imeInsetPx: Int = 0

    /** 网页消息通知的自增 id：同一条消息覆盖同一 id 会让新通知顶掉旧的，故逐条递增。 */
    private var webNotifId = 500

    /** 感知桥：把电量/网络/应用名/步数交给网页（边界说明见 PerceptionBridge）。 */
    private val perception by lazy { PerceptionBridge(this) }

    /** 设备动作桥：让网页（进而让角色）在真实手机上做一件小事（边界说明见 DeviceActionBridge）。 */
    private val deviceAction by lazy { DeviceActionBridge(this) }

    /** 日历桥：让角色看见用户的真实日程，也能把纪念日写进系统日历（边界说明见 CalendarBridge）。 */
    private val calendar by lazy { CalendarBridge(this) }

    /** 位置桥：让角色知道用户大概在哪儿（只前台取点、坐标降精度，边界见 LocationBridge）。 */
    private val locationBridge by lazy { LocationBridge(this) }

    /** 健康桥：让角色知道用户昨晚睡了多久（只读睡眠、只回时长，边界见 HealthBridge）。 */
    private val healthBridge by lazy { HealthBridge(this) }

    /**
     * 睡眠读取权限的申请结果回调。
     *
     * Health Connect 的授权走它自己的 ActivityResultContract，不是系统的
     * requestPermissions；用户勾了哪几项由返回的集合告诉我们。
     * 结果记完就够——真正的读取由网页调 refreshHealth 触发，壳不替网页做判断。
     */
    private val healthPermissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) { grantedPermissions ->
        healthPermissionGranted = grantedPermissions.contains(HealthBridge.PERM_SLEEP)
    }

    /** 睡眠读取权限的最近一次申请结果（网页靠轮询 getHealthCapabilities 确认）。 */
    @Volatile
    private var healthPermissionGranted = false

    /**
     * 定位权限的申请结果回调。
     *
     * 与活动识别、日历同一套路：权限由网页主动申请，壳只记结果，
     * 由网页轮询 hasLocationPermission() 决定下一步——壳不替网页做判断，
     * 与位置桥「只读、零判断」的边界保持一致。
     */
    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        // 结果由 hasLocationPermission() 实时查询，这里不需要额外动作
    }

    /**
     * 日历权限（读/写）的申请结果回调。
     *
     * 与活动识别权限同一套路：网页主动申请，壳只记结果，
     * 由网页轮询 hasCalendarPermission() 决定下一步——壳不替网页做判断。
     */
    private val calendarPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        // 结果由 hasCalendarReadPermission() / hasCalendarWritePermission() 实时查询，
        // 这里不需要额外动作：权限状态本身就是答案。
    }

    /**
     * 活动识别权限的申请结果回调。
     *
     * 权限是网页侧主动申请的（用户在「感知」面板打开步数时），所以这里只把结果
     * 记下来，由网页轮询 hasStepPermission() 自己决定下一步——壳不替网页做判断，
     * 与感知桥「只读、零判断」的边界保持一致。
     */
    @Volatile
    private var stepPermissionGranted = false

    private val stepPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        stepPermissionGranted = granted
        // 刚拿到权限就挂上传感器：下一次采样就能读到值，用户不必重启 App
        if (granted) PerceptionBridge.attachStepSensor(this)
    }

    /** 拉取远程头像用；超时压短，头像拿不到就退回默认图标，不能拖住通知。 */
    private val avatarClient = OkHttpClient.Builder()
        .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
        .build()


    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        callback.onReceiveValue(collectChosenUris(result))
    }

    /**
     * 收集文件选择器返回的全部 URI。
     *
     * 网页的 input 带 multiple 时，FileChooserParams.createIntent() 会给系统 Intent 带上
     * EXTRA_ALLOW_MULTIPLE，多选结果只放进 clipData、data 为 null；华为/荣耀等 ROM 的文件
     * 管理器即使单选也常只填 clipData。此前只读 data?.data，于是回给 WebView 的是空数组：
     * 选择器正常弹出、关掉后页面毫无变化（网页侧 files.length 为 0，连格式提示都不会有）。
     */
    private fun collectChosenUris(result: ActivityResult): Array<Uri> {
        if (result.resultCode != android.app.Activity.RESULT_OK) return emptyArray()
        val data = result.data ?: return emptyArray()
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index)?.uri?.let { uris.add(it) }
            }
        }
        data.data?.let { uris.add(it) }
        return uris.distinct().toTypedArray()
    }

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) PushService.start(this)
    }

    // 网页侧 getUserMedia（通话按住说话、语音条录音、视频通话摄像头）触发的
    // WebView 权限请求：先要系统运行时权限，拿到后再转授给页面。
    // 不实现 onPermissionRequest 时 WebView 会静默拒绝，页面永远拿不到麦克风。
    private var pendingWebPermissionRequest: android.webkit.PermissionRequest? = null

    private val webPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val request = pendingWebPermissionRequest ?: return@registerForActivityResult
        pendingWebPermissionRequest = null
        val granted = request.resources.filter { resource ->
            webResourcePermissions(resource).all {
                ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
            }
        }
        if (granted.isEmpty()) request.deny() else request.grant(granted.toTypedArray())
    }

    private fun webResourcePermissions(resource: String): List<String> = when (resource) {
        android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO)
        android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
        else -> emptyList()
    }

    /**
     * 文件名安全化 + 避开重名。系统下载器遇到同名文件会直接失败（ERROR_FILE_ALREADY_EXISTS），
     * 所以这里先算一个「名字(1).ext」式的不冲突名称。
     */
    private fun safeDownloadName(fileName: String): String {
        val cleaned = fileName
            .replace(Regex("[\\\\/:*?\"<>|]"), "_")
            .trim()
            .ifBlank { "download" }
        val dot = cleaned.lastIndexOf('.')
        val stem = if (dot > 0) cleaned.substring(0, dot) else cleaned
        val ext = if (dot > 0) cleaned.substring(dot) else ""
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        var candidate = stem.take(100) + ext
        var index = 1
        while (File(dir, candidate).exists() && index < 100) {
            candidate = stem.take(100) + "($index)" + ext
            index++
        }
        return candidate
    }


    /**
     * Native recovery UI: remains usable when the website fails to load or the WebView
     * renderer dies. This is intentionally native, so it does not depend on React/JS.
     */
    /** WebView 渲染进程崩溃后落盘；下次启动恢复页和诊断报告都能看到。 */
    private fun recordWebViewCrash(reason: String, detail: String) {
        runCatching {
            val stamp = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date())
            val report = "time=$stamp\nreason=$reason\ndetail=$detail"
            File(filesDir, "last-webview-crash.txt").writeText(report)
            getSharedPreferences("float_startup_diagnostics", Context.MODE_PRIVATE)
                .edit()
                .putBoolean("launch_in_progress", true)
                .putLong("last_webview_crash_at", System.currentTimeMillis())
                .apply()
        }
    }

    private fun showNativeRecoveryScreen(title: String, detail: String) {
        if (!::rootContainer.isInitialized) return
        runOnUiThread {
            recoveryOverlay?.let { rootContainer.removeView(it) }
            val panel = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(28, 28, 28, 28)
                setBackgroundColor(android.graphics.Color.rgb(248, 246, 242))
            }
            panel.addView(TextView(this).apply {
                text = "小手机 · 启动恢复"
                textSize = 13f
                setTextColor(android.graphics.Color.DKGRAY)
            })
            panel.addView(TextView(this).apply {
                text = title
                textSize = 23f
                setTextColor(android.graphics.Color.rgb(35, 35, 35))
                setPadding(0, 12, 0, 10)
            })
            panel.addView(TextView(this).apply {
                text = detail + "\n\n你可以先复制诊断摘要反馈问题，或尝试重新加载。此页面不会清除聊天、角色记忆或应用数据。"
                textSize = 14f
                setTextColor(android.graphics.Color.DKGRAY)
                setPadding(0, 0, 0, 18)
            })
            fun action(label: String, run: () -> Unit) {
                panel.addView(Button(this).apply {
                    text = label
                    isAllCaps = false
                    setOnClickListener { run() }
                }, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = 8 })
            }
            action("退出恢复模式并重试（不清除数据）") {
                getSharedPreferences("float_startup_diagnostics", Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean("launch_in_progress", false)
                    .putLong("last_successful_page_at", System.currentTimeMillis())
                    .apply()
                recreate()
            }
            action("在系统浏览器打开站点") {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(SITE_URL))) }
                    .onFailure { showNativeRecoveryScreen("无法打开浏览器", it.message ?: "系统未找到可用浏览器") }
            }
            action("复制诊断摘要") {
                val summary = buildString {
                    appendLine("小手机原生恢复摘要")
                    appendLine("时间：${java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date())}")
                    appendLine("App：$packageName / $VERSION")
                    appendLine("Android：${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})")
                    appendLine("设备：${Build.MANUFACTURER} ${Build.MODEL}")
                    appendLine("WebView：${if (recoveryBoot) "安全模式下未初始化" else runCatching { WebView.getCurrentWebViewPackage()?.let { it.packageName + " " + it.versionName } }.getOrNull() ?: "未知"}")
                    appendLine("站点：${Uri.parse(SITE_URL).scheme}://${Uri.parse(SITE_URL).host}")
                    appendLine("问题：$title")
                    appendLine("详情：$detail")
                    val crashFile = File(filesDir, "last-native-crash.txt")
                    if (crashFile.exists()) appendLine("上次原生崩溃：${crashFile.readText().takeLast(12000)}")
                    val webCrashFile = File(filesDir, "last-webview-crash.txt")
                    if (webCrashFile.exists()) appendLine("上次 WebView 崩溃：${webCrashFile.readText().takeLast(12000)}")
                }
                runCatching {
                    val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("小手机诊断摘要", summary))
                    val copied = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString().orEmpty()
                    if (copied.isBlank()) throw IllegalStateException("系统剪贴板没有写入内容")
                    android.widget.Toast.makeText(this, "诊断摘要已复制；发送前请检查隐私信息", android.widget.Toast.LENGTH_LONG).show()
                }.onFailure {
                    // Android 13+ 某些 WebView/后台状态会静默拒绝剪贴板；至少把摘要落成文件。
                    val fallback = File(getExternalFilesDir(null) ?: filesDir, "last-diagnostic.txt")
                    runCatching { fallback.writeText(summary) }
                    android.widget.Toast.makeText(this, "剪贴板不可用，已保存诊断到：" + fallback.absolutePath, android.widget.Toast.LENGTH_LONG).show()
                }
            }
            recoveryOverlay = ScrollView(this).apply {
                isFillViewport = true
                addView(panel)
                setBackgroundColor(android.graphics.Color.rgb(248, 246, 242))
            }
            rootContainer.addView(recoveryOverlay, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ))
            recoveryOverlay?.bringToFront()
        }
    }


private data class CachedSharedVideo(val cacheId: String, val contentUri: String, val mediaUrl: String? = null, val embedUrl: String? = null)
private data class SharedVideoPage(val pageUrl: String, val html: String?, val directVideoUrl: String?)

private val sharedVideoExecutor = Executors.newFixedThreadPool(2)
private val sharedVideoClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .callTimeout(75, TimeUnit.SECONDS)
        .build()
}

private fun sharedVideoCacheDir(): File = File(cacheDir, "shared-video")

private fun isHostUnder(host: String, suffix: String): Boolean =
    host.equals(suffix, ignoreCase = true) || host.endsWith("." + suffix, ignoreCase = true)

/**
 * The native resolver runs only after a trusted app page explicitly asks for it.
 * Accept public DNS hostnames so ordinary video pages can be inspected too, while
 * rejecting local names and literal IPs to avoid turning the bridge into an SSRF tool.
 * Media URLs are still restricted to public hosts and direct MP4-like resources below.
 */
private fun isPublicResolverHost(host: String): Boolean {
    val lower = host.lowercase().trimEnd('.')
    if (lower.isBlank() || lower == "localhost" || lower.endsWith(".localhost")
        || lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".lan")
        || lower.endsWith(".test") || lower.endsWith(".invalid") || lower.endsWith(".example")
        || lower.contains(":") || Regex("^(\\d{1,3}\\.){3}\\d{1,3}$").matches(lower)) return false
    return lower.contains(".")
}

private fun isAllowedShareOrPageHost(host: String): Boolean = isPublicResolverHost(host)

private fun isAllowedVideoHost(host: String): Boolean = isPublicResolverHost(host)

private fun isSupportedShareUrl(rawUrl: String): Boolean {
    val url = rawUrl.trim().toHttpUrlOrNull() ?: return false
    if (url.scheme != "http" && url.scheme != "https" || url.username.isNotEmpty() || url.password.isNotEmpty()) return false
    return isPublicResolverHost(url.host)
}

private fun isTrustedShellOrigin(rawUrl: String?): Boolean {
    if (rawUrl.isNullOrBlank()) return false
    val configured = Uri.parse(SITE_URL)
    val current = Uri.parse(rawUrl)
    val configuredScheme = configured.scheme ?: return false
    val currentScheme = current.scheme ?: return false
    val configuredHost = configured.host ?: return false
    val currentHost = current.host ?: return false
    fun normalizedPort(uri: Uri): Int = when {
        uri.port >= 0 -> uri.port
        uri.scheme.equals("https", ignoreCase = true) -> 443
        uri.scheme.equals("http", ignoreCase = true) -> 80
        else -> -1
    }
    return currentScheme.equals(configuredScheme, ignoreCase = true)
        && currentHost.equals(configuredHost, ignoreCase = true)
        && normalizedPort(current) == normalizedPort(configured)
}

private fun isTrustedShellPage(): Boolean = isTrustedShellOrigin(trustedShellUrl)

private fun shellOriginRule(): String? {
    val uri = Uri.parse(SITE_URL)
    val scheme = uri.scheme ?: return null
    val host = uri.host ?: return null
    val defaultPort = if (scheme.equals("https", true)) 443 else if (scheme.equals("http", true)) 80 else -1
    val port = if (uri.port >= 0 && uri.port != defaultPort) ":${uri.port}" else ""
    return "$scheme://$host$port"
}
private fun secureBridgeBootstrapScript(): String {
    val nonceJson = org.json.JSONObject.quote(bridgeNonce)
    return """
        (function () {
          if (window !== window.top) return;
          const nonce = $nonceJson;
          const attach = (publicName, privateName) => {
            if (Object.prototype.hasOwnProperty.call(window, publicName)) return;
            const nativeApi = window[privateName];
            if (!nativeApi || typeof nativeApi.getMethodNames !== "function") return;
            let names;
            try { names = JSON.parse(nativeApi.getMethodNames()); } catch (_) { return; }
            const wrapper = Object.create(null);
            for (const methodName of names) {
              wrapper[methodName] = (...args) => {
                const raw = nativeApi.invoke(nonce, methodName, JSON.stringify(args));
                let result;
                try { result = JSON.parse(raw); } catch (_) { throw new Error("Invalid native bridge response"); }
                if (!result || result.ok !== true) throw new Error(result && result.error ? result.error : "Native bridge call rejected");
                return result.value;
              };
            }
            Object.freeze(wrapper);
            Object.defineProperty(window, publicName, { value: wrapper, configurable: false, writable: false });
          };
          attach("AndroidShell", "AndroidShellSecure");
          attach("PhoneWidget", "PhoneWidgetSecure");
          window.dispatchEvent(new Event("floatshell-bridge-ready"));
        })();
    """.trimIndent()
}

private fun isLikelyPublicHls(rawUrl: String): Boolean {
    val url = rawUrl.toHttpUrlOrNull() ?: return false
    if (!isAllowedVideoHost(url.host)) return false
    return url.encodedPath.lowercase().endsWith(".m3u8")
}

private fun isLikelyPublicMp4(rawUrl: String): Boolean {
    val url = rawUrl.toHttpUrlOrNull() ?: return false
    if (!isAllowedVideoHost(url.host)) return false
    val path = url.encodedPath.lowercase()
    if (path.endsWith(".m3u8") || path.endsWith(".jpg") || path.endsWith(".jpeg")
        || path.endsWith(".png") || path.endsWith(".webp") || path.endsWith(".gif")) return false
    return path.endsWith(".mp4")
        || isHostUnder(url.host, "douyinvod.com")
        || isHostUnder(url.host, "kwaicdn.com")
        || isHostUnder(url.host, "kwimgs.com")
        || isHostUnder(url.host, "yximgs.com")
        || isHostUnder(url.host, "kspkg.com")
        || isHostUnder(url.host, "ks-cdn.com")
        // Douyin's SSR parser exposes signed playback URLs on aweme.snssdk.com.
        || (isHostUnder(url.host, "snssdk.com") && path.contains("/aweme/v1/play"))
        || (isHostUnder(url.host, "xhscdn.com") && (path.contains("video") || path.contains("stream") || path.contains("media") || url.queryParameter("type") == "video"))
}

private fun readBoundedText(input: java.io.InputStream, maxBytes: Int): String {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    var total = 0
    while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        total += count
        if (total > maxBytes) throw IllegalStateException("分享页面过大，已停止解析")
        output.write(buffer, 0, count)
    }
    return output.toString(Charsets.UTF_8.name())
}

private fun fetchSharedVideoPage(startUrl: String): SharedVideoPage {
    var currentUrl = startUrl
    for (attempt in 0..6) {
        val current = currentUrl.toHttpUrlOrNull()
            ?: throw IllegalArgumentException("分享链接格式不正确")
        if (!isPublicResolverHost(current.host)) {
            throw IllegalArgumentException("跳转到了不支持的平台域名，已停止解析")
        }

        val requestBuilder = Request.Builder()
            .url(current)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36")
            .header("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
        runCatching { CookieManager.getInstance().getCookie(current.toString()) }
            .getOrNull()?.takeIf { it.isNotBlank() }?.let { requestBuilder.header("Cookie", it) }
        val request = requestBuilder.build()
        val response = sharedVideoClient.newCall(request).execute()
        if (response.code in 300..399) {
            val location = response.header("Location")
            val next = if (location.isNullOrBlank()) null else response.request.url.resolve(location)
            response.close()
            if (next == null) throw IllegalStateException("分享页面返回了无效跳转")
            val nextUrl = next.toString()
            if (isLikelyPublicMp4(nextUrl) || isLikelyPublicHls(nextUrl)) return SharedVideoPage(currentUrl, null, nextUrl)
            if (!isPublicResolverHost(next.host)) {
                throw IllegalStateException("分享页面跳转到受限或不支持的地址，已停止解析")
            }
            currentUrl = nextUrl
            continue
        }

        response.use {
            if (!it.isSuccessful) throw IllegalStateException("平台页面返回 HTTP " + it.code)
            val contentType = (it.header("Content-Type") ?: "").lowercase()
            if ((contentType.startsWith("video/") && isLikelyPublicMp4(current.toString()))
                || (contentType.contains("mpegurl") && isAllowedVideoHost(current.host))) {
                return SharedVideoPage(current.toString(), null, current.toString())
            }
            val body = it.body ?: throw IllegalStateException("平台页面没有可读取的内容")
            val length = body.contentLength()
            if (length > 4L * 1024L * 1024L) throw IllegalStateException("分享页面过大，已停止解析")
            val html = body.byteStream().use { stream -> readBoundedText(stream, 4 * 1024 * 1024) }
            return SharedVideoPage(current.toString(), html, null)
        }
    }
    throw IllegalStateException("分享链接跳转次数过多")
}

/**
 * Parse Douyin's server-rendered window._ROUTER_DATA payload before falling back to URL scanning.
 * This follows the established open-source parser strategy: loaderData -> video/note page ->
 * videoInfoRes.item_list[0].video.play_addr.url_list. No signature or login bypass is attempted.
 */
private fun extractDouyinRouterPlayUrl(html: String): String? {
    if (!html.contains("douyin.com", ignoreCase = true) && !html.contains("iesdouyin.com", ignoreCase = true)) return null
    val match = Regex("""window\._ROUTER_DATA\s*=\s*(.*?)</script>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)).find(html)
        ?: return null
    var raw = match.groupValues[1].trim()
    // Find the matching JSON object end, ignoring braces inside quoted strings.
    var depth = 0
    var quoted = false
    var escaped = false
    var end = -1
    for (i in raw.indices) {
        val c = raw[i]
        if (quoted) {
            if (escaped) escaped = false
            else if (c == '\\') escaped = true
            else if (c == '"') quoted = false
        } else {
            when (c) {
                '"' -> quoted = true
                '{' -> depth++
                '}' -> { depth--; if (depth == 0) { end = i + 1; break } }
            }
        }
    }
    if (end <= 0) return null
    raw = raw.substring(0, end).replace(Regex(""":\s*undefined(?=[,\s}\]])"""), ": null")
    return runCatching {
        val root = org.json.JSONObject(raw)
        val loader = root.optJSONObject("loaderData") ?: return@runCatching null
        val page = loader.keys().asSequence()
            .filter { it.contains("video_(id)/page") || it.contains("note_(id)/page") }
            .mapNotNull { loader.optJSONObject(it) }
            .firstOrNull() ?: return@runCatching null
        val items = page.optJSONObject("videoInfoRes")?.optJSONArray("item_list")
            ?: return@runCatching null
        val item = items.optJSONObject(0) ?: return@runCatching null
        val urls = item.optJSONObject("video")?.optJSONObject("play_addr")?.optJSONArray("url_list")
            ?: return@runCatching null
        (0 until urls.length()).asSequence()
            .mapNotNull { urls.optString(it).takeIf(String::isNotBlank) }
            .map { it.replace("playwm", "play") }
            .firstOrNull { isLikelyPublicMp4(it) }
    }.getOrNull()
}

private fun extractPublicMp4Url(html: String): String? {
    // Platforms commonly serialize media URLs in escaped JSON, meta tags, or source elements.
    val normalized = html
        .replace("\\/", "/")
        .replace("\\u002F", "/", ignoreCase = true)
        .replace("\\u0026", "&", ignoreCase = true)
        .replace("\\u003A", ":", ignoreCase = true)
        .replace("\\u003D", "=", ignoreCase = true)
        .replace("\\u003F", "?", ignoreCase = true)
        .replace("&amp;", "&", ignoreCase = true)
        .replace("&quot;", "\"")
        .replace("&#x2F;", "/", ignoreCase = true)
        .replace("&#47;", "/")
    val urlRegex = Regex("""https?://[^\s"'<>\\]+""", RegexOption.IGNORE_CASE)
    val markerNames = listOf(
        "playAddr", "play_addr", "playUrl", "play_url", "downloadAddr",
        "download_addr", "srcNoMark", "src_no_mark", "play_url_h264",
        "video_url", "videoUrl", "video_src", "videoSrc", "contentUrl",
        "og:video:secure_url", "og:video", "twitter:player:stream",
        "<video", "<source", "currentSrc", "master_url", "originVideoKey"
    )
    val preferred = mutableListOf<String>()
    for (marker in markerNames) {
        var from = 0
        while (true) {
            val index = normalized.indexOf(marker, from, ignoreCase = true)
            if (index < 0) break
            val end = minOf(normalized.length, index + 12000)
            preferred.addAll(urlRegex.findAll(normalized.substring(index, end)).map { it.value })
            from = index + marker.length
        }
    }
    val decoded = normalized
        .replace("%3A", ":", ignoreCase = true)
        .replace("%2F", "/", ignoreCase = true)
        .replace("%3F", "?", ignoreCase = true)
        .replace("%26", "&", ignoreCase = true)
        .replace("%3D", "=", ignoreCase = true)
    val candidates = preferred + urlRegex.findAll(decoded).map { it.value }.toList() +
        urlRegex.findAll(normalized).map { it.value }.toList()
    return candidates.asSequence()
        .map { it.trim().trimEnd(',', ';', ')', ']', '}', '\\', '.', '"') }
        .distinct()
        .firstOrNull { candidate ->
            val path = candidate.substringBefore('?').substringBefore('#').lowercase()
            isLikelyPublicMp4(candidate) &&
                !path.endsWith(".jpg") && !path.endsWith(".jpeg") &&
                !path.endsWith(".png") && !path.endsWith(".webp") &&
                !path.endsWith(".gif") && !path.endsWith(".avif")
        }
}

private fun extractPublicHlsUrl(html: String): String? {
    val normalized = html.replace("\\/", "/")
        .replace("\\u002F", "/", ignoreCase = true)
        .replace("&amp;", "&", ignoreCase = true)
    return Regex("""https?://[^\s"'<>\\]+""", RegexOption.IGNORE_CASE)
        .findAll(normalized)
        .map { it.value.trim().trimEnd(',', ';', ')', ']', '}', '\\', '.', '"') }
        .firstOrNull(::isLikelyPublicHls)
}
private fun downloadPublicMp4(mediaUrl: String, pageUrl: String): CachedSharedVideo {
    var currentUrl = mediaUrl
    for (attempt in 0..5) {
        val current = currentUrl.toHttpUrlOrNull()
            ?: throw IllegalArgumentException("视频地址格式不正确")
        if (!isLikelyPublicMp4(current.toString())) {
            throw IllegalStateException("只允许从支持的平台公开视频 CDN 获取 MP4")
        }
        val requestBuilder = Request.Builder()
            .url(current)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36")
            .header("Accept", "video/mp4,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5")
            .header("Referer", pageUrl)
        runCatching { CookieManager.getInstance().getCookie(current.toString()) }
            .getOrNull()?.takeIf { it.isNotBlank() }?.let { requestBuilder.header("Cookie", it) }
        val request = requestBuilder.build()
        val response = sharedVideoClient.newCall(request).execute()
        if (response.code in 300..399) {
            val location = response.header("Location")
            val next = if (location.isNullOrBlank()) null else response.request.url.resolve(location)
            response.close()
            if (next == null || !isLikelyPublicMp4(next.toString())) {
                throw IllegalStateException("视频流跳转到了不支持的地址，已停止下载")
            }
            currentUrl = next.toString()
            continue
        }

        response.use {
            if (!it.isSuccessful) throw IllegalStateException("视频流返回 HTTP " + it.code)
            val contentType = (it.header("Content-Type") ?: "").lowercase()
            if (contentType.contains("mpegurl") || current.encodedPath.endsWith(".m3u8", ignoreCase = true)) {
                throw IllegalStateException("此链接返回的是 HLS 流，不是可直接嵌入的 MP4")
            }
            if (contentType.startsWith("image/")) throw IllegalStateException("平台返回了图片而不是视频")
            if (!contentType.startsWith("video/") && !contentType.contains("octet-stream")
                && !isLikelyPublicMp4(current.toString())) {
                throw IllegalStateException("平台没有返回可播放的视频流")
            }
            val body = it.body ?: throw IllegalStateException("视频流为空")
            if (body.contentLength() > 100L * 1024L * 1024L) throw IllegalStateException("视频超过 100 MB 缓存上限")
            val directory = sharedVideoCacheDir()
            if (!directory.exists() && !directory.mkdirs()) throw IllegalStateException("无法创建临时视频缓存目录")
            val cacheId = UUID.randomUUID().toString()
            val file = File(directory, cacheId + ".mp4")
            try {
                body.byteStream().use { input ->
                    FileOutputStream(file).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            if (total > 100L * 1024L * 1024L) throw IllegalStateException("视频超过 100 MB 缓存上限")
                            output.write(buffer, 0, count)
                        }
                    }
                }
                val contentUri = FileProvider.getUriForFile(
                    this,
                    packageName + ".sharedvideos",
                    file
                ).toString()
                return CachedSharedVideo(cacheId, contentUri)
            } catch (error: Throwable) {
                file.delete()
                throw error
            }
        }
    }
    throw IllegalStateException("视频流跳转次数过多")
}

private fun resolveAndCacheSharedVideo(rawUrl: String): CachedSharedVideo {
    val trimmed = rawUrl.trim()
    if (!isSupportedShareUrl(trimmed)) throw IllegalArgumentException("仅支持公开 HTTP(S) 网页链接；本机、内网和非公开地址不支持")
    pruneCachedSharedVideos()
    val firstPage = fetchSharedVideoPage(trimmed)
    val pages = mutableListOf(firstPage)

    // Mature Douyin parsers request the mobile SSR share route directly after resolving a
    // short link. Try those canonical routes too; the original URL often renders a shell page.
    val resolvedUrl = firstPage.pageUrl
    val douyinId = Regex("""(?:douyin\.com/(?:video|note|share/video|share/note)/|iesdouyin\.com/share/(?:video|note)/)(\d+)""", RegexOption.IGNORE_CASE)
        .find(resolvedUrl)?.groupValues?.getOrNull(1)
    if (douyinId != null) {
        listOf(
            "https://m.douyin.com/share/video/$douyinId",
            "https://www.iesdouyin.com/share/video/$douyinId"
        ).forEach { candidate ->
            if (pages.none { it.pageUrl == candidate }) {
                runCatching { fetchSharedVideoPage(candidate) }.getOrNull()?.let(pages::add)
            }
        }
    }

    var lastError: Throwable? = null
    for (page in pages) {
        val mediaUrl = page.directVideoUrl
            ?: page.html?.let { extractDouyinRouterPlayUrl(it) }
            ?: page.html?.let { extractPublicMp4Url(it) }
            ?: page.html?.let { extractPublicHlsUrl(it) }
        if (mediaUrl != null) {
            return try {
                if (isLikelyPublicHls(mediaUrl)) return CachedSharedVideo("", "", mediaUrl)
                downloadPublicMp4(mediaUrl, page.pageUrl)
            } catch (error: Throwable) {
                lastError = error
                continue
            }
        }
    }
    throw IllegalStateException(
        lastError?.message
            ?: "页面中没有找到可直接播放的公开 MP4；可能需要登录、由 JavaScript 加载或使用了平台专有签名"
    )
}

/**
 * Bilibili short links (b23.tv) often expose only the official player page, not a public
 * MP4 stream. If stream extraction fails, resolve the canonical BV/av identifier and keep
 * playback inside the app with Bilibili's official embedded player instead of a dead panel.
 */
private fun resolveBilibiliEmbedFallback(rawUrl: String): CachedSharedVideo? {
    val input = rawUrl.toHttpUrlOrNull() ?: return null
    if (!isHostUnder(input.host, "bilibili.com") && !input.host.equals("b23.tv", ignoreCase = true)) return null
    val page = fetchSharedVideoPage(rawUrl)
    val combined = page.pageUrl + "\n" + (page.html ?: "")
    val bvid = Regex("""(?:/video/|bvid[=:])\s*(BV[0-9A-Za-z]{10})""", RegexOption.IGNORE_CASE)
        .find(combined)?.groupValues?.getOrNull(1)
    val aid = Regex("""(?:/av|aid[=:])\s*(\d+)""", RegexOption.IGNORE_CASE)
        .find(combined)?.groupValues?.getOrNull(1)
    val base = "https://player.bilibili.com/player.html"
    val query = when {
        !bvid.isNullOrBlank() -> "bvid=" + Uri.encode(bvid)
        !aid.isNullOrBlank() -> "aid=" + Uri.encode(aid)
        else -> return null
    }
    return CachedSharedVideo("", "", null, "$base?$query&autoplay=0&danmaku=0&high_quality=1")
}

/** Dispatch a resolver result back into the trusted app page. Must be called on the UI thread. */
private fun emitSharedVideoResult(requestId: String, result: Result<CachedSharedVideo>) {
    if (!::webView.isInitialized || isFinishing || !isTrustedShellPage()) {
        result.getOrNull()?.let { deleteCachedSharedVideoInternal(it.cacheId) }
        return
    }
    val payload = org.json.JSONObject().put("requestId", requestId)
    result.onSuccess {
        payload.put("ok", true)
        if (it.cacheId.isNotBlank()) payload.put("cacheId", it.cacheId)
        if (it.contentUri.isNotBlank()) payload.put("contentUri", it.contentUri)
        if (!it.mediaUrl.isNullOrBlank()) payload.put("mediaUrl", it.mediaUrl)
        if (!it.embedUrl.isNullOrBlank()) payload.put("embedUrl", it.embedUrl)
    }.onFailure { error ->
        payload.put("ok", false).put("message", (error.message ?: "公开视频解析失败").take(240))
    }
    val script = "window.dispatchEvent(new CustomEvent('floatshell-shared-video-ready',{detail:" + payload.toString() + "}));"
    webView.evaluateJavascript(script, null)
}

/**
 * Some platforms create the video URL only after JavaScript executes. Load the share page in
 * an isolated WebView (no JavaScript bridge is installed), inspect video/source elements and
 * performance resource URLs, then cache only a validated public MP4. The hidden view is always
 * removed and destroyed after success or timeout.
 */
@SuppressLint("SetJavaScriptEnabled")
private fun resolveSharedVideoWithWebView(rawUrl: String, callback: (Result<CachedSharedVideo>) -> Unit) {
    if (!isSupportedShareUrl(rawUrl) || !::rootContainer.isInitialized) {
        callback(Result.failure(IllegalArgumentException("分享链接无效")))
        return
    }
    val resolverView = WebView(this)
    val handler = android.os.Handler(android.os.Looper.getMainLooper())
    var finished = false
    var mediaDownloadStarted = false
    var attempts = 0
    val startedAt = System.currentTimeMillis()
    fun finish(result: Result<CachedSharedVideo>) {
        if (finished) {
            result.getOrNull()?.let { deleteCachedSharedVideoInternal(it.cacheId) }
            return
        }
        finished = true
        handler.removeCallbacksAndMessages(resolverView)
        runCatching { resolverView.stopLoading() }
        runCatching { (resolverView.parent as? android.view.ViewGroup)?.removeView(resolverView) }
        runCatching { resolverView.destroy() }
        callback(result)
    }
    fun inspectPage() {
        if (finished) return
        attempts++
        val script = """
            (function() {
              const out = [];
              const add = v => { if (typeof v === 'string' && (v.startsWith('https://') || v.startsWith('http://'))) out.push(v); };
              document.querySelectorAll('video').forEach(v => { add(v.currentSrc); add(v.src); });
              document.querySelectorAll('video source, source').forEach(v => add(v.src));
              document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[name="twitter:player:stream"],meta[itemprop="contentUrl"]')
                .forEach(v => add(v.content));
              try {
                performance.getEntriesByType('resource').forEach(e => {
                  if (/.mp4(?:[?#]|$)|.m3u8(?:[?#]|$)|video|playaddr|play_url/i.test(e.name)) add(e.name);
                });
              } catch (_) {}
              return JSON.stringify(Array.from(new Set(out)).slice(0, 80));
            })();
        """.trimIndent()
        resolverView.evaluateJavascript(script) { encoded ->
            if (finished) return@evaluateJavascript
            val candidates = runCatching {
                val decoded = org.json.JSONTokener(encoded ?: "null").nextValue() as? String ?: "[]"
                org.json.JSONArray(decoded)
            }.getOrNull()
            val mediaUrl = candidates?.let { array ->
                (0 until array.length()).asSequence()
                    .mapNotNull { index -> array.optString(index).takeIf { it.startsWith("http://") || it.startsWith("https://") } }
                    .firstOrNull { isLikelyPublicMp4(it) || isLikelyPublicHls(it) }
            }
            if (mediaUrl != null && !mediaDownloadStarted) {
                mediaDownloadStarted = true
                sharedVideoExecutor.execute {
                    val result = runCatching {
                        if (isLikelyPublicHls(mediaUrl)) CachedSharedVideo("", "", mediaUrl)
                        else downloadPublicMp4(mediaUrl, rawUrl)
                    }
                    runOnUiThread { finish(result) }
                }
            } else if (mediaUrl == null && (attempts >= 14 || System.currentTimeMillis() - startedAt > 18000L)) {
                finish(Result.failure(IllegalStateException("动态页面加载后仍未发现可直接播放的 MP4；可能需要平台签名、登录或 HLS 播放支持")))
            } else {
                handler.postAtTime({ inspectPage() }, resolverView, android.os.SystemClock.uptimeMillis() + 1000L)
            }
        }
    }
    resolverView.settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        mediaPlaybackRequiresUserGesture = false
        allowFileAccess = false
        allowContentAccess = false
        userAgentString = "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
    }
    CookieManager.getInstance().setAcceptCookie(true)
    CookieManager.getInstance().setAcceptThirdPartyCookies(resolverView, true)
    resolverView.alpha = 0.01f
    resolverView.isFocusable = false
    resolverView.isFocusableInTouchMode = false
    rootContainer.addView(resolverView, FrameLayout.LayoutParams(1, 1))
    resolverView.webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String?) {
            inspectPage()
        }
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
            if (request.isForMainFrame && !finished) {
                finish(Result.failure(IllegalStateException("平台网页加载失败：" + error.description)))
            }
        }
    }
    handler.postAtTime({
        if (!finished && !mediaDownloadStarted) finish(Result.failure(IllegalStateException("动态解析超时（18 秒）")))
    }, resolverView, android.os.SystemClock.uptimeMillis() + 19000L)
    resolverView.loadUrl(rawUrl)
}

private fun pruneCachedSharedVideos() {
    val directory = sharedVideoCacheDir()
    if (!directory.exists()) return
    val cutoff = System.currentTimeMillis() - 24L * 60L * 60L * 1000L
    directory.listFiles()?.filter { it.isFile && it.name.endsWith(".mp4") }?.forEach { file ->
        if (file.lastModified() < cutoff) file.delete()
    }
}

private fun deleteCachedSharedVideoInternal(cacheId: String): Boolean {
    if (!cacheId.matches(Regex("[a-fA-F0-9-]{36}"))) return false
    val directory = sharedVideoCacheDir().canonicalFile
    val file = File(directory, cacheId + ".mp4").canonicalFile
    if (file.parentFile != directory) return false
    return file.delete() || !file.exists()
}

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pruneCachedSharedVideos()
        installNativeCrashRecorder()

        // If the previous launch never reached a successful main-page load, start in
        // a native-only recovery screen. This avoids repeatedly initializing a crashing
        // WebView/bridge stack and lets users copy diagnostics without opening the website.
        val startupPrefs = getSharedPreferences("float_startup_diagnostics", Context.MODE_PRIVATE)
        val crashFile = File(filesDir, "last-native-crash.txt")
        val lastSuccessAt = startupPrefs.getLong("last_successful_page_at", 0L)
        val recordedCrashAt = if (crashFile.isFile) {
            runCatching { crashFile.useLines { it.firstOrNull()?.removePrefix("time=")?.toLongOrNull() ?: 0L } }.getOrDefault(0L)
        } else 0L
        // A newly recorded native crash also triggers safe mode, even if the page had
        // loaded successfully earlier in the same process lifecycle.
        recoveryBoot = startupPrefs.getBoolean("launch_in_progress", false) || recordedCrashAt > lastSuccessAt
        startupPrefs.edit()
            .putBoolean("launch_in_progress", true)
            .putLong("launch_started_at", System.currentTimeMillis())
            .commit()
        if (recoveryBoot) {
            rootContainer = FrameLayout(this)
            setContentView(rootContainer)
            val lastCrash = if (crashFile.exists()) crashFile.readText().takeLast(6000) else "没有捕获到未捕获异常堆栈；也可能是系统强制结束、ANR 或崩溃发生在记录器安装前。"
            val webCrashFile = File(filesDir, "last-webview-crash.txt")
            val lastWebCrash = if (webCrashFile.isFile) webCrashFile.readText().takeLast(6000) else ""
            showNativeRecoveryScreen(
                "检测到上次启动未完成",
                "已进入原生恢复模式，暂不启动网页和原生桥，避免反复闪退。请先复制诊断摘要；确认后再点“退出恢复模式并重试”。\n\n上次异常摘要：\n" + lastCrash + (if (lastWebCrash.isNotBlank()) "\n\n上次 WebView 崩溃：\n" + lastWebCrash else "")
            )
            return
        }

        WindowCompat.setDecorFitsSystemWindows(window, false)
        enableDisplayCutoutCover()
        hideSystemStatusBar()
        // 音量键默认调媒体流：WebView 里的语音条/TTS 都走媒体流播放，
        // 不设的话短音频没在播时按键调的是铃声，用户感觉"音量键无效、声音巨大"
        volumeControlStream = AudioManager.STREAM_MUSIC

        // 外层容器：decorFits=false 后系统不再替 App 避让键盘，由容器底部内边距
        // 把键盘高度让出来（WebView 随之变矮），网页收到 resize 后输入栏自动上移。
        webView = WebView(this)
        // 打开 WebView 远程调试通道。Android 默认是关闭的，导致在电脑上
        // chrome://inspect 根本看不到这台设备——排查推送/后台任务时没有任何日志可看。
        // 打开后仅在「USB 调试 + chrome://inspect」时可见，不影响正常使用。
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        rootContainer = FrameLayout(this).apply {
            addView(
                webView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        setContentView(rootContainer)
        // 挂上 insets 监听：状态栏高度注入 + 键盘避让都靠它。必须在 setContentView 之后，
        // 此时 rootContainer 已初始化，监听回调里才能安全地给它设内边距。
        observeWindowInsets()
        // 首帧主动请求一次 insets，确保启动即拿到状态栏高度（部分机型不会自动派发首次回调）。
        ViewCompat.requestApplyInsets(rootContainer)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            // 一起看本地解析服务通常是 http://127.0.0.1:8765；页面是 https，
            // WebView 默认会把这种混合内容拦掉，导致本地解析永远走不到。
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            allowFileAccess = false
            userAgentString = "$userAgentString FloatShell/$VERSION"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        // The app embeds cross-site video players (notably Bilibili's official iframe).
        // Third-party cookies must be permitted for those embeds to retain supported session state.
        // This does not bypass platform login/permission checks; it only removes our WebView-level block.
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        // The raw Android interfaces are never exposed under the app-facing names.
        // Cross-origin frames can see JavascriptInterface objects, so they receive only a nonce-gated RPC endpoint.
        webView.addJavascriptInterface(SecureJavascriptBridge(ShellBridge()), "AndroidShellSecure")
        webView.addJavascriptInterface(SecureJavascriptBridge(PhoneWidgetBridge()), "PhoneWidgetSecure")
        val originRule = shellOriginRule()
        if (originRule != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            secureBridgeDocumentStartInstalled = runCatching {
                WebViewCompat.addDocumentStartJavaScript(webView, secureBridgeBootstrapScript(), setOf(originRule))
                true
            }.getOrDefault(false)
        }
        // 桌面小组件桥：独立命名空间，跟通话/截屏那套分开，
        // 免得以後加方法时和 AndroidShell 里几十个方法混在一起。
        // PhoneWidgetSecure is registered above through the same nonce-gated wrapper.
        // 步数传感器是异步的（没有同步取值接口），必须提前挂上才有值可读。
        // 这里只是「挂监听」，不申请权限；没授权时 attachStepSensor 内部会直接返回。
        PerceptionBridge.attachStepSensor(this)
        // 登记给 ShellBus：浮窗服务/无障碍服务要把事件投回页面，需要这个引用。
        // WebView 只能在主线程访问，投递时由 ShellBus 统一 post 到主线程。
        ShellBus.webView = webView

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                trustedShellUrl = url ?: trustedShellUrl
                if (!secureBridgeDocumentStartInstalled && isTrustedShellPage()) {
                    view.evaluateJavascript(secureBridgeBootstrapScript(), null)
                }
                recoveryOverlay?.let { rootContainer.removeView(it) }
                recoveryOverlay = null
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, url, isReload)
                if (isTrustedShellOrigin(url)) trustedShellUrl = url
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                if (isTrustedShellOrigin(url)) {
                    trustedShellUrl = url
                    getSharedPreferences("float_startup_diagnostics", Context.MODE_PRIVATE)
                        .edit()
                        .putBoolean("launch_in_progress", false)
                        .putLong("last_successful_page_at", System.currentTimeMillis())
                        .apply()
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                super.onReceivedError(view, request, error)
                if (request.isForMainFrame) {
                    val description = "网页主文档加载失败：${error.description}（错误码 ${error.errorCode}）"
                    showNativeRecoveryScreen("网页没有加载成功", description)
                }
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: android.webkit.WebResourceResponse) {
                super.onReceivedHttpError(view, request, response)
                if (request.isForMainFrame && response.statusCode >= 400) {
                    showNativeRecoveryScreen("站点返回错误", "HTTP ${response.statusCode} ${response.reasonPhrase ?: ""}\n地址：${request.url.host ?: "未知"}")
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                val reason = if (detail.didCrash()) "WebView 渲染进程崩溃" else "WebView 渲染进程被系统回收"
                val detailText = "$reason；系统优先级：${detail.rendererPriorityAtExit()}"
                recordWebViewCrash(reason, detailText)
                showNativeRecoveryScreen("网页进程异常退出", detailText)
                return true
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                // Subframe navigations must never replace the trusted top-level URL snapshot.
                // Otherwise a cross-origin video iframe would revoke the bridge for the real app page.
                if (!request.isForMainFrame) return false
                trustedShellUrl = url.toString()
                val scheme = url.scheme ?: return false
                // 站内导航留在壳里；顶层 http(s) 外链和自定义协议交给系统
                if (scheme == "http" || scheme == "https") {
                    if (url.host == Uri.parse(SITE_URL).host) return false
                    return runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, url)); true
                    }.getOrDefault(true)
                }
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url)); true
                }.getOrDefault(true)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // Required by HTML5 video players inside cross-origin platform iframes.
            override fun onShowCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
                if (webVideoCustomView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                webVideoCustomView = view
                webVideoCustomViewCallback = callback
                webView.visibility = View.INVISIBLE
                rootContainer.setPadding(0, 0, 0, 0)
                rootContainer.addView(view, FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    Gravity.CENTER,
                ))
                view.requestFocus()
                hideSystemStatusBar()
            }

            override fun onHideCustomView() {
                hideWebVideoCustomView(notifyPage = false)
            }

            // Capture WebView JavaScript warnings/errors locally for the diagnostics panel.
            override fun onConsoleMessage(consoleMessage: android.webkit.ConsoleMessage): Boolean {
                val level = when (consoleMessage.messageLevel()) {
                    android.webkit.ConsoleMessage.MessageLevel.ERROR -> "ERROR"
                    android.webkit.ConsoleMessage.MessageLevel.WARNING -> "WARN"
                    else -> return true
                }
                recordWebConsoleMessage(level + " " + consoleMessage.sourceId().orEmpty() + ":" +
                    consoleMessage.lineNumber() + " " + consoleMessage.message().orEmpty())
                return true
            }
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                val supported = request.resources.filter { webResourcePermissions(it).isNotEmpty() }
                if (supported.isEmpty()) { request.deny(); return }
                val missing = supported.flatMap { webResourcePermissions(it) }
                    .distinct()
                    .filter { ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) { request.grant(supported.toTypedArray()); return }
                if (pendingWebPermissionRequest != null) { request.deny(); return }
                pendingWebPermissionRequest = request
                webPermissionLauncher.launch(missing.toTypedArray())
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                filePathCallback?.onReceiveValue(emptyArray())
                filePathCallback = callback
                return runCatching {
                    val intent = params.createIntent()
                    // createIntent() 一般已按 params.mode 带上 EXTRA_ALLOW_MULTIPLE；个别 WebView
                    // 版本拿不到 multiple 模式，网页多选会退化成单选，这里显式兜一次。
                    if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    fileChooserLauncher.launch(intent); true
                }.getOrElse {
                    filePathCallback = null; false
                }
            }
        }

        // 备份导出等下载：交给系统下载管理器，落到公共下载目录
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            runCatching {
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    // blob/data 由页面内 JS 触发的 a[download] 处理；提示用户等待
                    Toast.makeText(this, "正在导出…", Toast.LENGTH_SHORT).show()
                    return@DownloadListener
                }
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    addRequestHeader("User-Agent", userAgent)
                    addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        safeDownloadName(android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)),
                    )
                }
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "已开始下载到「下载」目录", Toast.LENGTH_SHORT).show()
            }
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webVideoCustomView != null) {
                    hideWebVideoCustomView(notifyPage = true)
                    return
                }
                if (!::webView.isInitialized) {
                    moveTaskToBack(true)
                    return
                }
                webView.evaluateJavascript("(function(){var d={handled:false};window.dispatchEvent(new CustomEvent('floatphone-native-back',{detail:d}));return d.handled?'yes':'no';})()") { result ->
                    if (result?.contains("yes") == true) return@evaluateJavascript
                    if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
                }
            }
        })

        // 冷启动带深链（如来电接听）直接加载目标；否则加载首页
        webView.loadUrl(consumeOpenUrl(intent) ?: SITE_URL)
        ensurePushService()
    }

    /** singleTask：App 已在运行时（如全屏来电页接听）通过 onNewIntent 送达深链 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val target = consumeOpenUrl(intent) ?: return
        if (!::webView.isInitialized) {
            showNativeRecoveryScreen("当前处于安全恢复模式", "收到站内跳转请求，但网页尚未启动。请先复制诊断摘要，确认后退出恢复模式重试。")
            return
        }
        // SPA 已加载：loadUrl 到同页 hash 只触发 hashchange，不会整页重载
        webView.loadUrl(target)
    }

    /**
     * 取出本次要加载的站内地址。两个来源：
     * 1. 内部深链（来电接听）走 EXTRA_OPEN_URL；
     * 2. 外部 App 走 floatshell://open?url=… 的 Intent.data。
     * 无论哪个来源都必须以 SITE_URL 开头，防止被外部应用指到任意网址。
     * 取走后清空，避免配置变更重建时重复加载。
     */
    private fun consumeOpenUrl(intent: Intent?): String? {
        if (intent == null) return null
        val extra = intent.getStringExtra(EXTRA_OPEN_URL)
        intent.removeExtra(EXTRA_OPEN_URL)
        if (extra != null) return extra.takeIf { it.startsWith(SITE_URL) }
        val data = intent.data
        if (data != null && data.scheme == DEEP_LINK_SCHEME) {
            intent.data = null
            return data.getQueryParameter("url").orEmpty().takeIf { it.startsWith(SITE_URL) }
        }
        return null
    }

    /**
     * 隐藏系统状态栏（沉浸式）：页面自带虚拟状态栏，系统那条纯属多余。
     * decorFitsSystemWindows=false 时 WebView 本就铺满全屏，这里只负责隐掉系统状态栏那一条；
     * 键盘避让改由 observeWindowInsets() 里的 IME 内边距接管。
     * 从屏幕顶部下滑可临时唤出系统状态栏，松手自动再隐藏。
     */
    /**
     * 允许窗口画进刘海/挖孔区域。
     *
     * 隐藏状态栏后，LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT 只允许内容进入「仍被系统栏盖住」
     * 的挖孔区；状态栏一藏，挖孔区就不再算系统栏范围，窗口被整块下移留黑——页面 top:0 因此
     * 落在挖孔下方，表现为顶部一条黑边（截图里红条诊断条下面那截就是它）。
     * shortEdges 让窗口在竖屏短边（顶部/底部）无条件铺进挖孔区，WebView 才能盖满整块屏幕。
     */
    private fun enableDisplayCutoutCover() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
    }

    private fun hideWebVideoCustomView(notifyPage: Boolean) {
        val view = webVideoCustomView ?: return
        rootContainer.removeView(view)
        webVideoCustomView = null
        if (::webView.isInitialized) webView.visibility = View.VISIBLE
        rootContainer.setPadding(0, 0, 0, imeInsetPx)
        val callback = webVideoCustomViewCallback
        webVideoCustomViewCallback = null
        if (notifyPage) callback?.onCustomViewHidden()
        hideSystemStatusBar()
    }

    private fun hideSystemStatusBar() {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.statusBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    /**
     * 监听真实状态栏高度（物理像素，经 WindowInsets 实测，隐藏状态栏后依然能拿到原始尺寸）。
     * 不同机型/异形屏/系统字体缩放都会让这个值跟 CSS 的 env(safe-area-inset-top) 估算不一致，
     * 页面自己猜不准——所以由壳实测后用 JS 注入，页面只管用，不用再猜。
     */
    private fun observeWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            // 必须用 getInsetsIgnoringVisibility：状态栏已被 hideSystemStatusBar() 隐藏，
            // getInsets() 只返回"当前可见"的栏尺寸，隐藏后恒为 0——这正是此前注入链路
            // 失效（诊断条上 bridge 值 0、CSS/行内值皆空）、页面顶部露出黑块的根因。
            val statusBarPx = insets
                .getInsetsIgnoringVisibility(WindowInsetsCompat.Type.statusBars()).top
            val density = resources.displayMetrics.density
            val cssPx = (statusBarPx / density).toInt()
            if (cssPx > 0 && cssPx != statusBarHeightCssPx) {
                statusBarHeightCssPx = cssPx
                injectStatusBarHeight()
            }

            // 键盘避让：setDecorFitsSystemWindows(false) 后 adjustResize 不再由系统代劳，
            // 网页侧 interactiveWidget("resizes-content") 在 WebView 里同样不生效，
            // 于是输入框被键盘盖住。这里把 IME 高度写成容器底部内边距，WebView 变矮，
            // 网页 resize 后输入栏自然贴在键盘上方。
            val imePx = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            if (imePx != imeInsetPx) {
                imeInsetPx = imePx
                if (::rootContainer.isInitialized) rootContainer.setPadding(0, 0, 0, imePx)
            }
            insets
        }
    }

    /** 把实测状态栏高度（CSS px）写入页面根元素的 CSS 变量，供 phone-shell.css 的 --status-bar-drop 消费。 */
    private fun injectStatusBarHeight() {
        if (!::webView.isInitialized || statusBarHeightCssPx <= 0) return
        val js = "document.documentElement.style.setProperty('--android-shell-status-bar-height', '${statusBarHeightCssPx}px');" +
            "window.dispatchEvent(new CustomEvent('floatshell-statusbarheight', { detail: $statusBarHeightCssPx }));"
        webView.evaluateJavascript(js, null)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // 临时唤出状态栏后、或从锁屏/多任务回来时焦点变化，需要重新隐藏一次
        if (hasFocus) hideSystemStatusBar()
    }

    /**
     * 点通知的落点。带 sessionId 时通过深链直达对应会话（复用 consumeOpenUrl 的
     * EXTRA_OPEN_URL 通道，来电接听走的就是它）；不带则回首页。
     *
     * 用 hash（#open_session=）而不是 query：SPA 已在运行时 loadUrl 到同页 hash
     * 只触发 hashchange，不会整页重载；query 变化会触发一次完整重新加载。
     */
    private fun contentIntent(sessionId: String? = null): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val id = sessionId?.trim().orEmpty()
        if (id.isNotEmpty()) {
            intent.putExtra(EXTRA_OPEN_URL, "${SITE_URL.trimEnd('/')}/#open-chat=${Uri.encode(id)}")
        }
        return PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun ensurePushService() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            PushService.start(this)
        }
    }

    /**
     * App 退到后台／回到前台：直接驱动浮窗显隐。
     *
     * 这是浮窗可见性的主路径，不再只依赖网页 visibilitychange + 桥调用。
     * 原因：App 一退到后台，WebView 的 JS 会被系统冻结或节流，那条
     * 「网页通知原生显示」的链路本身就会断——表现正是「退出去后浮窗不弹，
     * 但声音照旧」（放音走媒体通道，不依赖网页）。Activity 的生命周期回调
     * 由系统直接给，不受 JS 是否还在跑影响。
     */
    override fun onStop() {
        super.onStop()
        if (!recoveryBoot) {
            runCatching { CallOverlayService.onHostBackground() }
            runCatching { CheckInService.onHostBackground() }
        }
    }

    override fun onStart() {
        super.onStart()
        if (!recoveryBoot) {
            runCatching { CallOverlayService.onHostForeground() }
            runCatching { CheckInService.onHostForeground() }
        }
    }

    override fun onDestroy() {
        // Recovery mode intentionally returns before creating a WebView. Keep its
        // lifecycle safe: touching a lateinit WebView here would crash the recovery UI.
        if (::webView.isInitialized) {
            if (ShellBus.webView === webView) ShellBus.webView = null
            runCatching { CookieManager.getInstance().flush() }
            runCatching { webView.stopLoading() }
            runCatching { webView.destroy() }
        }
        runCatching { sharedVideoExecutor.shutdownNow() }
        super.onDestroy()
    }

    /** 暴露给网页的原生桥（网页侧可用 window.AndroidShell 特性检测壳环境）。 */
    inner class ShellBridge {
        @JavascriptInterface
        fun getVersion(): String = VERSION

        /** Allow the trusted in-app player to request landscape, then restore normal sensor rotation. */
        @JavascriptInterface
        fun setScreenOrientation(mode: String): Boolean {
            if (!isTrustedShellPage()) return false
            val orientation = when (mode.trim().lowercase()) {
                "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
                else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
            runOnUiThread { requestedOrientation = orientation }
            return true
        }

        /** Resolve public short-video share links to a bounded, app-private MP4 cache. */
        @JavascriptInterface
        fun resolveShortVideoShareUrl(url: String, requestId: String): Boolean {
            val cleanUrl = url.trim()
            val cleanRequestId = requestId.trim()
            if (!isTrustedShellPage() || cleanRequestId.isBlank() || cleanRequestId.length > 120 || !isSupportedShareUrl(cleanUrl)) return false
            return runCatching {
                sharedVideoExecutor.execute {
                    val staticResult = runCatching { resolveAndCacheSharedVideo(cleanUrl) }
                    if (staticResult.isSuccess) {
                        runOnUiThread { emitSharedVideoResult(cleanRequestId, staticResult) }
                    } else {
                        // Static HTML extraction misses videos injected by page JavaScript.
                        // Retry in a separate, unprivileged WebView and inspect only public media URLs.
                        runOnUiThread {
                            if (!::webView.isInitialized || isFinishing || !isTrustedShellPage()) return@runOnUiThread
                            resolveSharedVideoWithWebView(cleanUrl) { dynamicResult ->
                                val finalResult = dynamicResult.recoverCatching { error ->
                                    resolveBilibiliEmbedFallback(cleanUrl) ?: throw IllegalStateException(
                                        (staticResult.exceptionOrNull()?.message ?: "静态网页解析失败") +
                                            "；动态页面解析也失败：" + (error.message ?: "未发现可直接播放的 MP4")
                                    )
                                }
                                emitSharedVideoResult(cleanRequestId, finalResult)
                            }
                        }
                    }
                }
                true
            }.getOrDefault(false)
        }

        /** Deletes only a UUID-named MP4 from the dedicated private cache directory. */
        @JavascriptInterface
        fun deleteCachedShortVideo(cacheId: String): Boolean {
            if (!isTrustedShellPage()) return false
            return runCatching { deleteCachedSharedVideoInternal(cacheId) }.getOrDefault(false)
        }

        /**
         * 本机运行诊断快照。只读取系统状态，不读取聊天、角色、截图或账号数据。
         * 诊断页通过此方法区分「旧 APK / 权限未开 / 系统环境差异」。
         */
        @JavascriptInterface
        fun getLastNativeCrashLog(): String = try {
            val native = File(filesDir, "last-native-crash.txt")
            val web = File(filesDir, "last-webview-crash.txt")
            listOfNotNull(
                native.takeIf { it.isFile }?.readText(),
                web.takeIf { it.isFile }?.readText()?.let { "\n[WebView 渲染进程]\n$it" },
            ).joinToString("\n").takeLast(30000)
        } catch (_: Throwable) {
            ""
        }

        @JavascriptInterface
        fun clearLastNativeCrashLog(): Boolean = try {
            File(filesDir, "last-native-crash.txt").delete()
            File(filesDir, "last-webview-crash.txt").delete()
            true
        } catch (_: Throwable) {
            false
        }

        @JavascriptInterface
        fun getWebConsoleLogs(): String = webConsoleLogsJson()

        @JavascriptInterface
        fun clearWebConsoleLogs(): Boolean = try {
            synchronized(webConsoleLogs) { webConsoleLogs.clear() }
            true
        } catch (_: Throwable) { false }

        @JavascriptInterface
        fun getDiagnosticsSnapshot(): String = try {
            val appOps = getSystemService(Context.APP_OPS_SERVICE) as android.app.AppOpsManager
            val usageMode = appOps.checkOpNoThrow(
                android.app.AppOpsManager.OPSTR_GET_USAGE_STATS,
                android.os.Process.myUid(),
                packageName
            )
            val accessibilityServices = Settings.Secure.getString(
                contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ).orEmpty()
            val expectedAccessibility = android.content.ComponentName(
                this@MainActivity,
                CallControlService::class.java
            ).flattenToString()
            val webViewPackage = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                WebView.getCurrentWebViewPackage()
            } else null
            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                packageManager.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                packageManager.getPackageInfo(packageName, 0)
            }
            org.json.JSONObject()
                .put("appId", packageName)
                .put("appVersion", BuildConfig.VERSION_NAME)
                .put("versionCode", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) packageInfo.longVersionCode else packageInfo.versionCode.toLong())
                .put("androidVersion", Build.VERSION.RELEASE ?: "unknown")
                .put("sdkInt", Build.VERSION.SDK_INT)
                .put("manufacturer", Build.MANUFACTURER ?: "unknown")
                .put("model", Build.MODEL ?: "unknown")
                .put("webViewPackage", webViewPackage?.packageName ?: "unknown")
                .put("webViewVersion", webViewPackage?.versionName ?: "unknown")
                .put("permissions", org.json.JSONObject()
                    .put("notifications", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED &&
                            notificationManager.areNotificationsEnabled()
                    } else notificationManager.areNotificationsEnabled())
                    .put("overlay", Settings.canDrawOverlays(this@MainActivity))
                    .put("usageAccess", usageMode == android.app.AppOpsManager.MODE_ALLOWED)
                    .put("accessibility", accessibilityServices.split(':').any {
                        it.equals(expectedAccessibility, ignoreCase = true)
                    })
                )
                .toString()
        } catch (error: Throwable) {
            org.json.JSONObject()
                .put("diagnosticsError", error.javaClass.simpleName + ": " + (error.message ?: "unknown"))
                .put("appVersion", BuildConfig.VERSION_NAME)
                .toString()
        }

        /** 实测系统状态栏高度（CSS px）。页面侧兜底轮询用；主要注入路径见 injectStatusBarHeight。 */
        @JavascriptInterface
        fun getStatusBarHeightPx(): Int = statusBarHeightCssPx

        // ── 感知桥（电量 / 网络 / 应用名）────────────────
        // 只读、零判断、不抛异常。所有「要不要上报」的逻辑在网页侧，
        // 这样阈值与开关随网页部署即时生效，不必重编 APK。

        /** 设备状态快照 JSON：{ battery:{percent,charging}, network:{type,metered} }。 */
        @JavascriptInterface
        fun getPerceptionSnapshot(): String = perception.snapshotJson()

        /** 包名 → 应用显示名；取不到返回空串。 */
        @JavascriptInterface
        fun getAppLabel(packageName: String): String = perception.appLabel(packageName)

        /** 本机支持哪些感知能力，给「感知 → 诊断」面板用。 */
        @JavascriptInterface
        fun getPerceptionCapabilities(): String = perception.capabilitiesJson()

        /**
         * 读今天各应用的使用时长（JSON 数组，按时长降序）。
         * 未授权或读不到都返回空数组——调用方据此说「读不到」，不编造。
         *
         * 授权状态复用上面 deviceAction.hasUsageStatsAccess() 那一个方法，
         * 这里刻意不再加第二个同名方法：同一个 ShellBridge 里两个同名同参方法
         * 会构成 JVM 平台声明冲突（之前 openUrl 就这么炸过一次）。
         */
        @JavascriptInterface
        fun readUsageStats(maxEntries: Int): String {
            if (!isTrustedShellPage()) return "[]"
            return perception.usageStatsJson(maxEntries)
        }

        /**
         * 把网页端感知开关/连续使用阈值持久化给原生无障碍服务。
         * 这里只同步最小配置，不上传任何数据；后台事件仍经登录态站点 API 发送。
         */
        @JavascriptInterface
        fun configureBackgroundPerception(json: String): Boolean = try {
            val config = org.json.JSONObject(json)
            val threshold = config.optInt("thresholdMinutes", 20).coerceIn(2, 180)
            getSharedPreferences("native_background_perception", Context.MODE_PRIVATE)
                .edit()
                .putBoolean("enabled", config.optBoolean("enabled", false))
                .putBoolean("foregroundAppEnabled", config.optBoolean("foregroundAppEnabled", false))
                .putBoolean("usageStatsEnabled", config.optBoolean("usageStatsEnabled", false))
                .putInt("thresholdMinutes", threshold)
                .putInt("usageSignalMinutes", config.optInt("usageSignalMinutes", 60).coerceIn(0, 720))
                .putString("usageOverrides", config.optJSONArray("usageOverrides")?.toString() ?: "[]")
                .putString("ruleFilters", config.optJSONArray("ruleFilters")?.toString() ?: "[]")
                .putString("targetPackage", config.optString("targetPackage", "").take(160))
                .putString("targetFilter", config.optString("targetFilter", "").take(160))
                .putLong("updatedAt", System.currentTimeMillis())
                .apply()
            true
        } catch (_: Throwable) {
            false
        }

        /** 将现实桥规则同步到本机执行器；规则和事件保存在应用私有存储。 */
        @JavascriptInterface
        fun configureNativeRealityBridge(json: String): Boolean =
            NativeRealityBridge.configure(this@MainActivity, json)

        /** 读取本机现实桥执行流水，供网页诊断面板显示。 */
        @JavascriptInterface
        fun getNativeRealityBridgeLog(): String =
            NativeRealityBridge.recentLog(this@MainActivity)

        /** 原生无障碍服务是否支持独立后台停留计时（供网页避免重复触发）。 */
        @JavascriptInterface
        fun supportsBackgroundDwellTracking(): Boolean = true

        /** 活动识别权限是否已授予（步数感知的前提）。 */
        @JavascriptInterface
        fun hasStepPermission(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(
                this@MainActivity,
                Manifest.permission.ACTIVITY_RECOGNITION,
            ) == PackageManager.PERMISSION_GRANTED

        /**
         * 申请活动识别权限（步数感知）。
         *
         * 由网页在用户明确打开「步数」时调用，不在 App 启动时一股脑申请——
         * 那时用户还不知道这个权限是干什么用的，拒绝率会很高。
         * 已经授予或系统版本不需要时直接返回 true。
         */
        @JavascriptInterface
        fun requestStepPermission(): Boolean {
            if (hasStepPermission()) {
                PerceptionBridge.attachStepSensor(this@MainActivity)
                return true
            }
            runCatching { stepPermissionLauncher.launch(Manifest.permission.ACTIVITY_RECOGNITION) }
            return false
        }

        // ── 设备动作桥（手电筒 / 音量 / 亮度 / 勿扰 / 打开应用）────
        // 全部返回 JSON 字符串（{"ok":true,...} 或 {"ok":false,"reason":"..."}）：
        // @JavascriptInterface 对复杂返回类型的支持有限，返回字符串最稳，
        // 也让网页侧能拿到「为什么失败」而不是一个光秃秃的 false。
        //
        // 每个动作都是一次性、立即可见、可撤销的；不做任何持续/隐蔽行为。

        /** 手电筒：开关。 */
        @JavascriptInterface
        fun setTorch(on: Boolean): String = deviceAction.setTorch(on).toString()

        /** 手电筒当前状态（本进程内的记忆，见 DeviceActionBridge）。 */
        @JavascriptInterface
        fun isTorchOn(): Boolean = deviceAction.isTorchOn()

        /** 音量：stream=media/ring/alarm/notification，action=up/down/set/mute，level=0-100。 */
        @JavascriptInterface
        fun setVolume(stream: String, action: String, level: Int): String =
            deviceAction.setVolume(stream, action, level).toString()

        /** 屏幕亮度：level=0-100（需要「修改系统设置」权限）。 */
        @JavascriptInterface
        fun setBrightness(level: Int): String = deviceAction.setBrightness(level).toString()

        /** 勿扰模式开关（需要勿扰访问权限）。 */
        @JavascriptInterface
        fun setDnd(on: Boolean): String = deviceAction.setDnd(on).toString()

        /** 按包名打开另一个应用。 */
        @JavascriptInterface
        fun openApp(packageName: String): String {
            if (!isTrustedShellPage()) return "{\"ok\":false,\"reason\":\"blocked\"}"
            return deviceAction.openApp(packageName).toString()
        }

        /** 按应用显示名找包名（找不到返回空串）。 */
        @JavascriptInterface
        fun findPackageByLabel(label: String): String = deviceAction.findPackageByLabel(label)

        /** 设闹钟（会打开系统时钟 App 让用户确认）。 */
        @JavascriptInterface
        fun setAlarm(hour: Int, minute: Int, message: String): String =
            deviceAction.setAlarm(hour, minute, message).toString()

        /** 设倒计时（直接启动，秒为单位）。 */
        @JavascriptInterface
        fun setTimer(seconds: Int, message: String): String =
            deviceAction.setTimer(seconds, message).toString()

        /** 媒体播放控制：action=play/pause/toggle/next/prev/stop。 */
        @JavascriptInterface
        fun mediaControl(action: String): String = deviceAction.mediaControl(action).toString()

        /**
         * 用系统浏览器打开链接（只放行 http/https）。
         *
         * 方法名刻意不叫 openUrl：下方跨 App 跳转的 openUrl(url): Boolean 是既有接口。
         * 同一个 ShellBridge 里两个 openUrl 方法名与参数类型相同、仅返回类型不同，
         * 会构成 JVM 平台声明冲突，导致整包编译失败——这里用独立名字把两者分开。
         */
        @JavascriptInterface
        fun openWebUrl(url: String): String = deviceAction.openUrl(url).toString()

        /** 是否已授予「使用情况访问」权限（屏幕使用时间的前提）。 */
        @JavascriptInterface
        fun hasUsageStatsAccess(): Boolean = deviceAction.hasUsageStatsAccess()

        // ── 日历桥（读系统日程 / 写角色纪念日）────
        // 读和写分开报状态：用户可能只想让角色「知道我的安排」，
        // 但不接受「往我日历里写东西」。两个权限独立授予，所以状态也独立。

        /** 是否已授予读日历权限。 */
        @JavascriptInterface
        fun hasCalendarReadPermission(): Boolean = calendar.hasReadPermission()

        /** 是否已授予写日历权限。 */
        @JavascriptInterface
        fun hasCalendarWritePermission(): Boolean = calendar.hasWritePermission()

        /**
         * 申请日历权限。read=true 时申请读，write=true 时申请写。
         *
         * 返回 true 表示「现在就已授权」，false 表示弹出了系统对话框、
         * 结果要稍后由 hasCalendarReadPermission() 等轮询确认。
         */
        @JavascriptInterface
        fun requestCalendarPermission(read: Boolean, write: Boolean): Boolean {
            val needed = mutableListOf<String>()
            if (read && !calendar.hasReadPermission()) needed.add(Manifest.permission.READ_CALENDAR)
            if (write && !calendar.hasWritePermission()) needed.add(Manifest.permission.WRITE_CALENDAR)
            if (needed.isEmpty()) return true
            runCatching { calendarPermissionLauncher.launch(needed.toTypedArray()) }
            return false
        }

        /** 读未来 daysAhead 天（可含过去 daysBack 天）的系统日程，返回 JSON 数组。 */
        @JavascriptInterface
        fun readCalendarEvents(daysAhead: Int, daysBack: Int): String {
            if (!isTrustedShellPage()) return "[]"
            return calendar.readEventsJson(daysAhead, daysBack)
        }

        /**
         * 往系统日历新增一条日程。只新增，不修改不删除用户已有安排。
         * allDay=true 时用 year/month/day（month 为 1-12）；否则用 startMillis/endMillis。
         */
        @JavascriptInterface
        fun insertCalendarEvent(
            title: String,
            allDay: Boolean,
            year: Int,
            month: Int,
            day: Int,
            startMillis: Long,
            endMillis: Long,
            description: String,
        ): String = calendar.insertEvent(
            title, allDay, year, month, day, startMillis, endMillis, description,
        ).toString()

        /** 删除一条由角色写入的日程（用户后悔时的清理路径）。 */
        @JavascriptInterface
        fun deleteCalendarEvent(eventId: Long): String = calendar.deleteOwnEvent(eventId).toString()

        /** 日历能力与授权状态。 */
        @JavascriptInterface
        fun getCalendarCapabilities(): String = calendar.capabilitiesJson()

        // ── 位置桥（角色知道你在哪儿）────
        // 只前台取点、坐标降精度到约 110 米、地名只到区/街道级。
        // 刻意不申请后台定位权限——采样本来就只在 App 活着时发生。

        /** 定位能力与授权状态（含「系统定位开关有没有开」）。 */
        @JavascriptInterface
        fun getLocationCapabilities(): String = locationBridge.capabilitiesJson()

        /** 是否已授予定位权限（粗略或精确任一即可）。 */
        @JavascriptInterface
        fun hasLocationPermission(): Boolean = locationBridge.hasAny()

        /**
         * 申请定位权限。
         *
         * 返回 true 表示「现在就已授权」，false 表示弹出了系统对话框、
         * 结果要稍后由 hasLocationPermission() 轮询确认——申请是异步的，
         * 不能同步拿到结果。
         */
        @JavascriptInterface
        fun requestLocationPermission(): Boolean {
            if (locationBridge.hasAny()) return true
            val needed = mutableListOf<String>()
            if (!locationBridge.hasFine()) needed.add(Manifest.permission.ACCESS_FINE_LOCATION)
            if (!locationBridge.hasCoarse()) needed.add(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (needed.isEmpty()) return true
            runCatching { locationPermissionLauncher.launch(needed.toTypedArray()) }
            return false
        }

        /**
         * 读当前大概位置（JSON；读不到返回空对象）。
         *
         * 同步返回缓存值：定位本身是异步的，网页按采样周期先 refresh 再读。
         */
        @JavascriptInterface
        fun readLocation(): String {
            if (!isTrustedShellPage()) return "{}"
            return locationBridge.readJson().toString()
        }

        /**
         * 主动取一次实时位置（一次性，不是持续追踪）。
         *
         * 网页在采样时调：光靠「最后已知位置」可能拿到几小时前的坐标，
         * 说「到了公司」就错了。结果落进缓存，随后的 readLocation 能读到。
         */
        @JavascriptInterface
        fun refreshLocation() {
            locationBridge.refresh()
        }

        /** 位置桥内部状态（诊断面板用，不含具体坐标）。 */
        @JavascriptInterface
        fun getLocationDiagnostics(): String = locationBridge.diagnosticsJson()

        // ── 健康桥（角色知道昨晚睡得怎么样）────
        // 经 Health Connect 读，只申请睡眠读取、只回时长与起止，不读分期、
        // 不读心率血氧、不写任何健康数据。

        /** 健康能力与授权状态（含「Health Connect 装没装」）。 */
        @JavascriptInterface
        fun getHealthCapabilities(): String = healthBridge.capabilitiesJson()

        /** 睡眠读取权限是否已授予。 */
        @JavascriptInterface
        fun hasHealthPermission(): Boolean = healthBridge.hasSleepPermission() || healthPermissionGranted

        /**
         * 申请睡眠读取权限。
         *
         * 返回 true 表示「现在已经可以读」，false 表示弹出了 Health Connect
         * 的授权页、结果要稍后由 hasHealthPermission() 轮询确认——
         * 申请是异步的，不能同步拿到结果。
         */
        @JavascriptInterface
        fun requestHealthPermission(): Boolean {
            if (healthBridge.hasSleepPermission()) return true
            if (!healthBridge.isAvailable()) return false
            return runCatching {
                healthPermissionLauncher.launch(setOf(HealthBridge.PERM_SLEEP))
                false
            }.getOrDefault(false)
        }

        /** 读缓存的最近一觉（JSON；读不到返回空对象）。 */
        @JavascriptInterface
        fun readSleep(): String {
            if (!isTrustedShellPage()) return "{}"
            return healthBridge.readJson().toString()
        }

        /** 请健康桥在后台取一次睡眠数据（结果落缓存，随后的 readSleep 能读到）。 */
        @JavascriptInterface
        fun refreshHealth() {
            healthBridge.refresh()
        }

        /** 跳 Health Connect 设置页（用户在那里看数据来源、撤销授权）。 */
        @JavascriptInterface
        fun openHealthSettings(): Boolean = healthBridge.openHealthSettings()

        /** 健康桥内部状态（诊断面板用，不含睡眠内容）。 */
        @JavascriptInterface
        fun getHealthDiagnostics(): String = healthBridge.diagnosticsJson()

        /** 本机支持哪些设备动作（含授权状态）。 */
        @JavascriptInterface
        fun getDeviceActionCapabilities(): String = deviceAction.capabilitiesJson()

        /**
         * 跳系统授权页。which = write_settings / dnd / accessibility / battery / app_details。
         * 由网页在用户点「去授权」时调用，壳不主动跳。
         */
        @JavascriptInterface
        fun openSystemSettings(which: String): Boolean = deviceAction.openSystemSettings(which)

        /**
         * 让网页直接发一条真正的系统通知（网页侧封装在 lib/shell-notify.ts）。
         *
         * 为什么必须由壳来做：Android WebView 里 Notification API 与 PushManager 都
         * 不存在，网页再怎么请求权限也弹不出通知，过去壳内只有覆盖在手机界面上的
         * 站内横幅。这里用 NotificationManager 发到「角色消息」渠道，与离线推送同一个
         * 渠道，锁屏/通知栏/后台都能看到。
         *
         * @param avatarUrl 角色头像：data:image/... 内联，或 http(s) 直链；空则用应用图标。
         * @return 是否已发出（JS 端据此决定要不要退回浏览器通知路径）。
         */
        @JavascriptInterface
        fun notify(title: String, body: String, avatarUrl: String, sessionId: String?): Boolean {
            if (!isTrustedShellPage()) return false
            return runCatching {
            ensureMessageChannel()
            val manager = getSystemService(NotificationManager::class.java)
            val icon = loadAvatarBitmap(avatarUrl)
            val builder = NotificationCompat.Builder(this@MainActivity, CH_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title.ifBlank { "小手机" })
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(contentIntent(sessionId))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
            if (icon != null) builder.setLargeIcon(icon)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                builder.setColor(0xFF5B7CFA.toInt())
            }
            // 带「回复」按钮：用户可以直接在横幅上回一句。这条路径是**页面活着时**
            // 角色消息的主要通道（含查岗后角色的反馈），与 PushService 的离线推送
            // 是两个入口，两边都得挂上，否则「有时能回、有时回不了」。
            // 没有 sessionId 的通用提醒（如截屏提示）挂了也没处送，故只在有时加。
            val sid = sessionId?.trim().orEmpty()
            if (sid.isNotEmpty()) {
                // androidx 版（NotificationCompat.Action.addRemoteInput 只认它）：
                // 用 android.app.RemoteInput 会因类型不匹配而编译失败。
                val remoteInput = androidx.core.app.RemoteInput.Builder(NotificationReplyReceiver.KEY_REPLY_TEXT)
                    .setLabel("回复")
                    .build()
                val replyIntent = Intent(this@MainActivity, NotificationReplyReceiver::class.java).apply {
                    action = NotificationReplyReceiver.ACTION_REPLY
                    putExtra(NotificationReplyReceiver.EXTRA_SESSION_ID, sid)
                }
                // MUTABLE 是必需的：用户输入要由系统填进 RemoteInput，
                // 不可变的 PendingIntent 装不下结果，回复框会打不开。
                val replyPending = PendingIntent.getBroadcast(
                    this@MainActivity,
                    sid.hashCode(),
                    replyIntent,
                    PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                builder.addAction(
                    NotificationCompat.Action.Builder(R.drawable.ic_stat, "回复", replyPending)
                        .addRemoteInput(remoteInput)
                        .setAllowGeneratedReplies(true)
                        .build(),
                )
            }
            manager.notify(webNotifId++, builder.build())
            if (webNotifId > 900) webNotifId = 500
            true
            }.getOrDefault(false)
        }

        /**
         * 按直链交给系统下载管理器下载（真·后台）。
         *
         * 页面里 fetch → blob → base64 → saveBase64File 这条路虽然能落盘，但读取与编码
         * 全在网页里跑：App 一进后台 WebView 就暂停 JS，下载随之卡住。有直链的资源
         * （图片、音乐、安装包等）走这里，交给系统托管——切后台、锁屏、退出 App 都会继续，
         * 完成后通知栏提示。返回是否成功入队。
         */
        @JavascriptInterface
        fun downloadUrl(url: String, fileName: String): Boolean {
            if (!isTrustedShellPage()) return false
            return runCatching {
            if (!url.startsWith("http://") && !url.startsWith("https://")) return@runCatching false
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeDownloadName(fileName))
            }
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            true
            }.getOrDefault(false)
        }

        // ── 通话浮窗 ──────────────────────────────

        /**
         * 开一个原生通话浮窗（浮在其他 App 上层）。
         *
         * 网页侧在通话开始/缩小时调用；参数是渲染所需的全部信息：
         * @param name   角色名
         * @param avatar 头像：data:image/... 内联或 http(s) 直链，空则纯色底
         * @param meta   底部信息（如「语音通话 · 00:12」，换行分段）
         * @param callId 本次通话 id，随事件回传，供网页校验是不是同一通电话
         * @return 是否已具备浮窗权限；false 时网页应引导用户去授权
         */
        @JavascriptInterface
        fun startCallOverlay(name: String, avatar: String, meta: String, callId: String, elapsedSeconds: Int): Boolean {
            // 通话接通时（App 一定在前台）就把服务暖好：窗口建出来但先藏着。
            // 切到后台只是把已有窗口显示出来（showCallOverlay），不再从后台启动
            // 前台服务——Android 12+ 会拒绝，浮窗于是「有时不弹」。
            if (!CallOverlayService.canDraw(this@MainActivity)) return false
            // 头像落成缓存文件再传：内联 data URL 可能有几 MB，塞进 Intent 会抛
            // TransactionTooLargeException，服务根本起不来（浮窗不出现的真凶）。
            val avatarRef = CallOverlayService.prepareAvatarRef(this@MainActivity, avatar)
            // 交给 start 判断成败：它会把失败原因记进诊断，网页侧据此提示而不是静默
            return CallOverlayService.start(this@MainActivity, name, avatarRef, meta, callId, elapsedSeconds)
        }

        /** 浮窗内部状态快照（JSON），网页诊断面板直接展示。 */
        @JavascriptInterface
        fun getOverlayDebugInfo(): String = CallOverlayService.debugInfo(this@MainActivity)

        /** 切到后台：把预热好的浮窗显示出来。 */
        @JavascriptInterface
        fun showCallOverlay() {
            runCatching { CallOverlayService.show(this@MainActivity) }
        }

        /** 回到前台：把浮窗藏起来（服务继续活着，下次切出去秒显）。 */
        @JavascriptInterface
        fun hideCallOverlay() {
            runCatching { CallOverlayService.hide(this@MainActivity) }
        }

        /** 更新浮窗显示（改名/换头像/刷新时长），不重建窗口。 */
        @JavascriptInterface
        fun updateCallOverlay(name: String, avatar: String, meta: String, elapsedSeconds: Int) {
            // 同样走缓存文件：update 也是 Intent，一样受 Binder 事务上限约束
            val avatarRef = CallOverlayService.prepareAvatarRef(this@MainActivity, avatar)
            runCatching { CallOverlayService.update(this@MainActivity, name, avatarRef, meta, elapsedSeconds) }
        }

        /**
         * 更新浮窗左上角的「待发 N」角标（0 = 隐藏）。
         *
         * 网页小窗一直有这个角标，原生浮窗此前没有：通话忙碌时从浮窗回复条
         * 发的消息会排队等角色说完，没有角标用户完全不知道话还排着，只当是丢了。
         * 走同进程实例直改（不走 Intent）：角标是高频小改动，没必要排队等一次
         * Service 投递。
         */
        @JavascriptInterface
        fun updateCallOverlayPending(count: Int) {
            runCatching { CallOverlayService.updatePending(this@MainActivity, count) }
        }

        /** 收掉浮窗（挂断或退回全屏时调用）。 */
        @JavascriptInterface
        fun stopCallOverlay() {
            runCatching { CallOverlayService.stop(this@MainActivity) }
        }

        /** 读当前快捷回复条配色（网页侧「通话浮窗外观」用它回显预设与自定义项）。 */
        @JavascriptInterface
        fun getOverlayThemeJson(): String = CallOverlayService.currentThemeJson(this@MainActivity)

        /** 下发完整配色（预设键 + 逐项自定义）；已弹出的回复条会即时换色。 */
        @JavascriptInterface
        fun setOverlayThemeJson(json: String) {
            runCatching { CallOverlayService.setThemeJson(this@MainActivity, json) }
        }

        /** 浮窗权限是否已授予。 */
        @JavascriptInterface
        fun canDrawOverlay(): Boolean = CallOverlayService.canDraw(this@MainActivity)

        /** 跳到系统的「显示在其他应用上层」授权页。 */
        @JavascriptInterface
        fun requestOverlayPermission() {
            if (Build.VERSION.SDK_INT < 23) return
            runCatching {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:$packageName"),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /** 无障碍服务是否已开启。 */
        @JavascriptInterface
        fun isAccessibilityConnected(): Boolean = CallControlService.connected

        /** 跳到系统「无障碍」设置页，引导用户开启通话控制服务。 */
        @JavascriptInterface
        fun openAccessibilitySettings() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /**
         * 截屏能力与状态（系统是否支持、无障碍是否已开启）。
         * 设置面板据此显示三态：不支持 / 要开无障碍 / 可用。
         */
        @JavascriptInterface
        fun getScreenshotCapabilities(): String = ScreenshotBridge.capabilitiesJson()

        /**
         * 让原生截一张当前屏幕。
         *
         * 返回是否**受理**（拿不到无障碍实例或版本过低时直接给失败原因）——
         * 画面本身是异步的，稍后经 window 的 'shell-call-overlay' 事件
         * （action='screenshot'）推回网页。之所以不在这里同步返回图片：
         * takeScreenshot 是回调式 API，且编码几 MB 的 PNG 不能阻塞主线程。
         */
        @JavascriptInterface
        fun captureScreenshot(): String {
            if (!isTrustedShellPage()) return "{\"ok\":false,\"error\":\"blocked\"}"
            return ScreenshotBridge.capture().toString()
        }

        // ── 查岗预览浮层（截屏先给用户过目，同意才发给角色）────

        /** 查岗服务能力与状态（系统支持 / 无障碍 / 浮窗权限）。 */
        @JavascriptInterface
        fun getCheckInCapabilities(): String = CheckInService.capabilitiesJson(this@MainActivity)

        /** 截屏桥的内部状态快照（诊断面板用，不含任何画面内容）。 */
        @JavascriptInterface
        fun getScreenshotDiagnostics(): String = ScreenshotBridge.diagnosticsJson()

        /** 查岗浮层的内部状态快照（诊断面板用）。 */
        @JavascriptInterface
        fun getCheckInDiagnostics(): String = CheckInService.diagnosticsJson(this@MainActivity)

        /**
         * 读走「用户主动截屏（悬浮球）」的结果（JSON 字符串，空串 = 没有）。
         *
         * 网页在页面挂载时、以及收到 checkIn 事件时各拉一次：前者补
         * 「点球时页面已被回收」的那次，后者处理当场送达的。拉到即清空，
         * 所以同一张图不会被发两遍。
         */
        @JavascriptInterface
        fun consumePendingUserShot(): String = CheckInService.consumePendingUserShot()

        // ── 截屏悬浮球（你自己点一下截屏）────

        /** 悬浮球能力与状态。 */
        @JavascriptInterface
        fun getScreenshotBallCapabilities(): String = ScreenshotBallService.capabilitiesJson()

        /**
         * 下发悬浮球外观（文字 / 颜色 / 大小），球正显示着会当场重画。
         * 参数形如 {"text":"截","color":"#5B7CFA","diameter":50}。
         */
        @JavascriptInterface
        fun setScreenshotBallStyle(json: String): Boolean =
            ScreenshotBallService.setStyle(this@MainActivity, json)

        /** 读悬浮球当前外观（设置页回显用）。 */
        @JavascriptInterface
        fun getScreenshotBallStyle(): String =
            ScreenshotBallService.styleJson(this@MainActivity)

        /**
         * 网页把「用户主动截屏时发给谁」的候选清单交过来保管。
         *
         * 必须提前给：点球那一刻网页可能已被系统回收，浮层回网页取清单
         * 只会拿到空的。清单只含角色 id 与名字，不含聊天内容或屏幕信息。
         * 参数形如 {"targets":[{"id":"...","name":"..."}],"defaultId":"..."}。
         */
        @JavascriptInterface
        fun setScreenshotShareTargets(json: String): Boolean =
            CheckInService.setShareTargets(this@MainActivity, json)

        /** 读分享目标状态（诊断面板用：手上几个角色、默认发给谁、上次发给了谁）。 */
        @JavascriptInterface
        fun getScreenshotShareTargets(): String =
            CheckInService.shareTargetsJson(this@MainActivity)

        /**
         * 拉起截屏悬浮球。用户打开开关时（App 在前台）调用——
         * Android 12+ 禁止后台启动前台服务，必须先暖好。
         */
        @JavascriptInterface
        fun prepareScreenshotBall(): Boolean = ScreenshotBallService.prepare(this@MainActivity)

        /** 收掉截屏悬浮球（用户关掉开关时调用）。 */
        @JavascriptInterface
        fun stopScreenshotBall() {
            ScreenshotBallService.stop(this@MainActivity)
        }

        /**
         * 预热查岗服务。用户开启查岗时（App 在前台）调用，让服务常驻待命——
         * Android 12+ 禁止后台启动前台服务，而查岗正是后台触发，必须先暖好。
         * 返回是否成功发起；false 多半是没给浮窗权限。
         */
        @JavascriptInterface
        fun prepareCheckIn(): Boolean = CheckInService.prepare(this@MainActivity)

        /** 收掉查岗服务（用户关闭全部查岗时调用）。 */
        @JavascriptInterface
        fun stopCheckIn() {
            CheckInService.stop(this@MainActivity)
        }

        /** Read pending notification replies without deleting them; JS acknowledges after persistence. */
        @JavascriptInterface
        fun peekPendingReplies(): String = NotificationReplyReceiver.peekPendingReplies(this@MainActivity)

        /** Acknowledge only successfully persisted reply IDs (JSON string array). */
        @JavascriptInterface
        fun acknowledgePendingReplies(idsJson: String): Boolean =
            NotificationReplyReceiver.acknowledgePendingReplies(this@MainActivity, idsJson)

        /** Legacy read-and-clear bridge retained for older web builds. */
        @JavascriptInterface
        fun consumePendingReplies(): String = NotificationReplyReceiver.consumePendingReplies(this@MainActivity)

        /**
         * 弹一次查岗预览：截当前屏 → 浮层给用户过目 → 结果经 'checkIn' 事件回推。
         * 只表示「已请求」，用户是否同意要等事件。
         */
        @JavascriptInterface
        fun requestCheckIn(characterId: String, name: String, avatar: String) {
            CheckInService.show(this@MainActivity, characterId, name, avatar)
        }

        /**
         * 读查岗 / 截屏确认浮层的配色（JSON 原文）。
         *
         * 与通话浮窗的 getOverlayThemeJson 分开走：两者配色互不影响，
         * 设置页各自回显自己那份。
         */
        @JavascriptInterface
        fun getCheckInTheme(): String = CheckInOverlayTheme.themeJson(this@MainActivity)

        /**
         * 下发查岗浮层配色（`{key, custom}`）。浮层正开着且在等用户决定时
         * 不会重建窗口——见 CheckInOverlayTheme.setTheme 的注释。
         */
        @JavascriptInterface
        fun setCheckInTheme(json: String): Boolean =
            CheckInOverlayTheme.setTheme(this@MainActivity, json)

        /** 打开本应用的系统设置页（引导用户关电池限制、开自启动）。 */
        @JavascriptInterface
        fun openAppSettings() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /** 请求忽略电池优化（保活关键一步）。 */
        @SuppressLint("BatteryLife")
        @JavascriptInterface
        fun requestIgnoreBatteryOptimization() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /**
         * 把 base64 内容写入公共「下载」目录（导出备份、导出数据用）。
         *
         * 为什么必须走这里：网页导出走的是 blob: + a[download]，而 WebView 的
         * DownloadListener 拿到 blob: 时 DownloadManager 取不到内存地址，
         * 页面上既没落盘也没有任何提示。所以页面把内容 base64 交给壳来落盘。
         * Android 10+ 走 MediaStore 不需要任何权限；8/9 需要 WRITE_EXTERNAL_STORAGE
         * （Manifest 里已用 maxSdkVersion=28 限定）。
         * 返回是否写入成功；文件名里的非法字符会被替换，避免路径穿越。
         */
        @JavascriptInterface
        fun saveBase64File(fileName: String, base64: String): Boolean {
            // 保存到公共下载目录是用户主动动作；不再被“可信页面”门禁挡住，
            // 否则保存图片会只返回 false，而网页只能看到“原生保存接口失败”。
            return runCatching {
            val safeName = fileName
                .replace(Regex("[\\\\/:*?\"<>|]"), "_")
                .trim()
                .ifBlank { "download" }
                .take(120)
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                    put(MediaStore.Downloads.MIME_TYPE, guessMimeType(safeName))
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return@runCatching false
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: return@runCatching false
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)
            } else {
                @Suppress("DEPRECATION")
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                if (!dir.exists()) dir.mkdirs()
                FileOutputStream(File(dir, safeName)).use { it.write(bytes) }
            }
            true
            }.onFailure { error ->
                synchronized(webConsoleLogs) {
                    webConsoleLogs.add("saveBase64File failed: " + (error.message ?: error.javaClass.simpleName))
                }
            }.getOrDefault(false)
        }

        /** 原生剪贴板兜底：WebView 的 navigator.clipboard 在部分机型会静默失败。 */
        @JavascriptInterface
        fun copyText(text: String): Boolean = runCatching {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("小手机", text))
            true
        }.getOrDefault(false)

        /**
         * 大文件分块写入：网页先 begin，拿 token 后逐块 append，最后 finish。
         * 这样不用把整个备份文件序列化成一个巨大的 Base64 字符串，避免 WebView OOM。
         */
        @JavascriptInterface
        fun beginChunkedFile(fileName: String): String {
            val safeName = fileName
                .replace(Regex("[\\/:*?\"<>|]"), "_")
                .trim()
                .ifBlank { "download" }
                .take(120)
            return runCatching {
                val token = UUID.randomUUID().toString()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                        put(MediaStore.Downloads.MIME_TYPE, guessMimeType(safeName))
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: return@runCatching ""
                    val stream = contentResolver.openOutputStream(uri)
                        ?: run { contentResolver.delete(uri, null, null); return@runCatching "" }
                    chunkedFileWrites[token] = ChunkedFileWrite(uri, null, stream)
                } else {
                    @Suppress("DEPRECATION")
                    val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    if (!dir.exists()) dir.mkdirs()
                    val file = File(dir, safeName)
                    chunkedFileWrites[token] = ChunkedFileWrite(null, file, FileOutputStream(file))
                }
                token
            }.getOrDefault("")
        }

        @JavascriptInterface
        fun appendChunkedFile(token: String, base64: String): Boolean {
            val session = chunkedFileWrites[token] ?: return false
            return runCatching {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                synchronized(session) {
                    session.stream.write(bytes)
                    session.bytes += bytes.size
                }
                true
            }.getOrDefault(false)
        }

        @JavascriptInterface
        fun finishChunkedFile(token: String): Boolean {
            val session = chunkedFileWrites.remove(token) ?: return false
            return runCatching {
                synchronized(session) { session.stream.flush(); session.stream.close() }
                if (session.bytes <= 0L) throw IllegalStateException("没有写入任何字节")
                val uri = session.uri
                if (uri != null) {
                    val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
                    contentResolver.update(uri, values, null, null)
                }
                true
            }.onFailure {
                session.uri?.let { uri -> runCatching { contentResolver.delete(uri, null, null) } }
                session.file?.delete()
            }.getOrDefault(false)
        }

        @JavascriptInterface
        fun abortChunkedFile(token: String) {
            val session = chunkedFileWrites.remove(token) ?: return
            runCatching { synchronized(session) { session.stream.close() } }
            session.uri?.let { uri -> runCatching { contentResolver.delete(uri, null, null) } }
            session.file?.delete()
        }

        /**
         * 打开另一个 App（桌宠联动用）。给出目标包名；可选的 dataUrl 会作为
         * Intent.data 带上（对方 Activity 的 intent-filter 能收到）。
         * 返回是否成功发起跳转——目标未安装时返回 false，页面据此提示。
         */
        @JavascriptInterface
        fun launchExternalApp(packageName: String, dataUrl: String): Boolean {
            if (!isTrustedShellPage()) return false
            return runCatching {
            val intent = packageManager.getLaunchIntentForPackage(packageName)
                ?: return@runCatching false
            if (dataUrl.isNotBlank()) intent.data = Uri.parse(dataUrl)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            true
            }.getOrDefault(false)
        }

        /**
         * 用 ACTION_VIEW 打开任意 URL / 自定义 scheme（如桌宠的 deskpet://xxx）。
         * 与 launchExternalApp 的区别：这条路不绑定包名，由系统按 scheme 匹配目标，
         * 对方只需在 Manifest 里声明对应的 intent-filter——是跨 App 联动的推荐方式，
         * 而且对方没在运行时也能把它的入口 Activity 拉起来。
         */
        @JavascriptInterface
        fun openUrl(url: String): Boolean {
            if (!isTrustedShellPage()) return false
            return runCatching {
            startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            true
            }.getOrDefault(false)
        }
    }

    /**
     * 兜底创建「角色消息」渠道。
     *
     * PushService 也会建同名渠道，但两者时机不定：网页可能在推送服务起来前就
     * 发第一条消息通知，那时渠道还不存在——Android 8+ 上往未创建的渠道发通知
     * 会被静默丢弃（通知栏什么都不出现，且没有任何报错）。这里补一次幂等创建。
     * 渠道已存在时 createNotificationChannel 只更新名称与描述，不会重置用户的
     * 重要性/声音选择。
     */
    private fun ensureMessageChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        runCatching {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CH_MESSAGES, "角色消息", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "角色发来的消息"
                },
            )
        }
    }

    /**
     * 把网页传来的头像变成通知大图标。支持 data:image/... 内联与 http(s) 直链。
     * 解析失败或超时一律返回 null，调用方退回应用图标——头像只是锦上添花，
     * 绝不能因为一张图让通知迟到或丢失。
     */
    private fun loadAvatarBitmap(avatarUrl: String): Bitmap? {
        val value = avatarUrl.trim()
        if (value.isEmpty()) return null
        return runCatching {
            if (value.startsWith("data:image/")) decodeDataUrlBitmap(value) else fetchRemoteAvatar(value)
        }.getOrNull()
    }

    /** 解 data:image/png;base64,xxxx 形式的头像。 */
    private fun decodeDataUrlBitmap(dataUrl: String): Bitmap? = runCatching {
        val comma = dataUrl.indexOf(',')
        if (comma < 0) return@runCatching null
        val header = dataUrl.substring(0, comma)
        if (!header.contains("base64", ignoreCase = true)) return@runCatching null
        val bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }.getOrNull()

    /** 拉取远程头像。站点可能要求登录 Cookie，这里带上；失败返回 null。 */
    private fun fetchRemoteAvatar(url: String): Bitmap? = runCatching {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return@runCatching null
        val builder = Request.Builder().url(url)
        val cookie = CookieManager.getInstance().getCookie(url)
        if (!cookie.isNullOrEmpty()) builder.header("Cookie", cookie)
        avatarClient.newCall(builder.build()).execute().use { response ->
            if (!response.isSuccessful) return@runCatching null
            val bytes = response.body?.bytes() ?: return@runCatching null
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }
    }.getOrNull()

    /** 按扩展名猜 MIME，MediaStore 用；猜不中给通用二进制。 */
    private fun guessMimeType(fileName: String): String = when (fileName.substringAfterLast('.', "").lowercase()) {
        "json" -> "application/json"
        "zip" -> "application/zip"
        "txt" -> "text/plain"
        "md" -> "text/markdown"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "mp3" -> "audio/mpeg"
        "wav" -> "audio/wav"
        "mp4" -> "video/mp4"
        else -> "application/octet-stream"
    }

    /**
     * 桌面小组件桥。
     *
     * 与方法庞杂的 ShellBridge 分开命名空间（网页侧挂在 window.PhoneWidget），
     * 避免以后继续往那个类里堆不相干的能力。
     *
     * 所有方法都只做转发，不持有状态——渲染与桌面刷新分别由
     * PhoneWidgetRenderer / PhoneWidgetProvider 负责，网页侧对应 lib/widget/。
     */
    private inner class PhoneWidgetBridge {

        /** 壳是否支持小组件。老壳没有这个对象，网页据此降级。 */
        @JavascriptInterface
        fun isSupported(): Boolean = true

        /**
         * 提交一份渲染好的 HTML。
         *
         * 返回 true 只表示「已受理」——真正的渲染是异步的（要等离屏 WebView 加载完），
         * 网页不该把返回值当作「已经显示出来了」。
         */
        @JavascriptInterface
        fun update(html: String, widthDp: Int, heightDp: Int, scale: Int): Boolean {
            if (!isTrustedShellPage()) return false
            return runCatching {
            // 尺寸记一份：系统定时刷新（onUpdate）时网页不在场，只能靠这里存的值。
            PhoneWidgetProvider.saveSize(this@MainActivity, widthDp, heightDp, scale)
            PhoneWidgetRenderer.renderAndPush(this@MainActivity, html, widthDp, heightDp, scale)
            true
            }.getOrDefault(false)
        }

        /** Update an independent profile without overwriting the legacy single-widget cache. */
        @JavascriptInterface
        fun updateProfile(profileId: String, html: String, widthDp: Int, heightDp: Int, scale: Int): Boolean {
            if (!isTrustedShellPage()) return false
            return runCatching {
            if (profileId.isBlank() || profileId == "default") return false
            PhoneWidgetRenderer.renderAndPush(this@MainActivity, profileId, html, widthDp, heightDp, scale)
            true
            }.getOrDefault(false)
        }

        @JavascriptInterface
        fun deleteProfile(profileId: String): Boolean = PhoneWidgetProvider.deleteProfile(this@MainActivity, profileId)

        @JavascriptInterface
        fun requestPinProfile(profileId: String): Boolean = PhoneWidgetProvider.requestPinProfile(this@MainActivity, profileId)

        /** 用上次缓存的 HTML 重画一次（用户改完尺寸/主题时调用）。 */
        @JavascriptInterface
        fun refresh(): Boolean = runCatching {
            val (w, h, scale) = PhoneWidgetProvider.loadSize(this@MainActivity)
            PhoneWidgetRenderer.renderCached(this@MainActivity, w, h, scale)
            true
        }.getOrDefault(false)

        /** 桌面上是否已经放了小组件（没放时设置页给「添加到桌面」引导）。 */
        @JavascriptInterface
        fun isPlaced(): Boolean = PhoneWidgetProvider.isPlaced(this@MainActivity)

        /**
         * 小组件的当前状态（诊断用，只读，不触发任何渲染）。
         *
         * 为什么需要：渲染失败原来一律静默，桌面只会退回应用图标，
         * 用户在设置页看到的预览又是正常的（那是 iframe 渲染的，走不到原生）。
         * 有了它，设置页能如实列出「HTML 推到了没 / PNG 落盘了没 / 最后一次渲染成败」。
         */
        /** 保存网页侧的小组件 profile 列表，供系统配置 Activity 选择。 */
        @JavascriptInterface
        fun setProfiles(json: String): Boolean = runCatching {
            getSharedPreferences("shell_phone_widget", Context.MODE_PRIVATE).edit()
                .putString("profiles_json", json.take(30000)).apply()
            true
        }.getOrDefault(false)

        @JavascriptInterface
        fun diagnostics(): String = PhoneWidgetRenderer.diagnosticsJson(this@MainActivity)

        /** 拉起系统的「添加到桌面」引导。Android 8+ 有效，更低版本静默失败。 */
        @JavascriptInterface
        fun requestPin(): Boolean = runCatching {
            PhoneWidgetProvider.requestPin(this@MainActivity)
            true
        }.getOrDefault(false)
    }
    /**
     * The only object exposed to every WebView frame. It reveals method names, but every
     * invocation requires a nonce that is injected into the trusted top-level document only.
     */
    private inner class SecureJavascriptBridge(private val target: Any) {
        @JavascriptInterface
        fun getMethodNames(): String = org.json.JSONArray(
            target.javaClass.methods
                .filter { it.isAnnotationPresent(JavascriptInterface::class.java) }
                .map { it.name }
                .distinct()
                .sorted(),
        ).toString()

        @JavascriptInterface
        fun invoke(nonce: String, methodName: String, argsJson: String): String {
            if (!isTrustedShellPage() || !java.security.MessageDigest.isEqual(nonce.toByteArray(Charsets.UTF_8), bridgeNonce.toByteArray(Charsets.UTF_8))) {
                return org.json.JSONObject().put("ok", false).put("error", "Untrusted native bridge caller").toString()
            }
            if (argsJson.length > 8_000_000) {
                return org.json.JSONObject().put("ok", false).put("error", "Native bridge payload too large").toString()
            }
            return try {
                val args = org.json.JSONArray(argsJson)
                val candidates = target.javaClass.methods.filter {
                    it.name == methodName && it.isAnnotationPresent(JavascriptInterface::class.java) && it.parameterCount == args.length()
                }
                val methodAndArgs = candidates.firstNotNullOfOrNull { method ->
                    runCatching { method to convertBridgeArguments(method.parameterTypes, args) }.getOrNull()
                } ?: throw IllegalArgumentException("Unsupported native bridge method or arguments")
                methodAndArgs.first.isAccessible = true
                val result = methodAndArgs.first.invoke(target, *methodAndArgs.second)
                val value = if (result == Unit || result == null) org.json.JSONObject.NULL else result
                org.json.JSONObject().put("ok", true).put("value", value).toString()
            } catch (error: Throwable) {
                val cause = (error as? java.lang.reflect.InvocationTargetException)?.targetException ?: error
                org.json.JSONObject().put("ok", false).put("error", (cause.message ?: cause.javaClass.simpleName).take(500)).toString()
            }
        }

        private fun convertBridgeArguments(types: Array<Class<*>>, args: org.json.JSONArray): Array<Any?> {
            return Array(types.size) { index ->
                val raw = args.opt(index)
                val type = types[index]
                when {
                    type == String::class.java -> if (raw == org.json.JSONObject.NULL) null else raw.toString()
                    type == java.lang.Boolean.TYPE || type == java.lang.Boolean::class.java -> raw as? Boolean ?: throw IllegalArgumentException("Expected boolean argument")
                    type == java.lang.Integer.TYPE || type == java.lang.Integer::class.java -> (raw as? Number)?.toInt() ?: throw IllegalArgumentException("Expected integer argument")
                    type == java.lang.Long.TYPE || type == java.lang.Long::class.java -> (raw as? Number)?.toLong() ?: throw IllegalArgumentException("Expected long argument")
                    type == java.lang.Double.TYPE || type == java.lang.Double::class.java -> (raw as? Number)?.toDouble() ?: throw IllegalArgumentException("Expected number argument")
                    type == java.lang.Float.TYPE || type == java.lang.Float::class.java -> (raw as? Number)?.toFloat() ?: throw IllegalArgumentException("Expected number argument")
                    else -> throw IllegalArgumentException("Unsupported native bridge argument type: ${type.simpleName}")
                }
            }
        }
    }
}
