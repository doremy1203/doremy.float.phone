package app.floatphone.shell

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.database.sqlite.SQLiteDatabase
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Release-safe harness bridge.
 *
 * The app reads command JSON files from its external files dir and executes
 * them in its own WebView. Shizuku/shell only needs /sdcard access; it never
 * needs /data/user/0 or a debuggable WebView.
 *
 * Path (actual package id may end with .dev):
 *   /sdcard/Android/data/<package>/files/harness/config.json
 *   /sdcard/Android/data/<package>/files/harness/inbox/<id>.json
 *   /sdcard/Android/data/<package>/files/harness/outbox/<id>.json
 *
 * config.json: {"enabled":true,"token":"..."}
 * command:     {"id":"...","token":"...","op":"eval","expression":"..."}
 *
 * Supported ops: ping, info, eval, reload, fs, prefs, sqlite.
 * `eval` runs in the page origin and can read/write IndexedDB, KV and DOM.
 * `fs` / `prefs` / `sqlite` read and write the app's private data dirs.
 */
object HarnessAgent {
    private const val TAG = "FloatHarness"
    private const val VERSION = "0.3.0"
    private const val MAX_COMMAND_BYTES = 8 * 1024 * 1024
    private const val MAX_RESULT_CHARS = 6 * 1024 * 1024
    private const val MAX_FILE_BYTES = 2 * 1024 * 1024

    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val pending = ConcurrentHashMap<String, (String) -> Unit>()
    @Volatile private var running = false
    @Volatile private var pollFuture: ScheduledFuture<*>? = null
    @Volatile private var activity: Activity? = null
    @Volatile private var webView: WebView? = null
    @Volatile private var currentUrl: String = ""

    private fun harnessDir(context: Context): File {
        val base = context.getExternalFilesDir("harness") ?: File(context.filesDir, "harness")
        return base.also { it.mkdirs() }
    }

    private fun inbox(context: Context): File = File(harnessDir(context), "inbox").also { it.mkdirs() }
    private fun outbox(context: Context): File = File(harnessDir(context), "outbox").also { it.mkdirs() }
    private fun configFile(context: Context): File = File(harnessDir(context), "config.json")

    @JavascriptInterface
    fun resolve(id: String, payload: String) {
        val callback = pending.remove(id) ?: return
        callback(payload)
    }

    /** Must be called before webView.loadUrl(). */
    fun attach(activity: Activity, webView: WebView) {
        this.activity = activity
        this.webView = webView
        runCatching { webView.addJavascriptInterface(this, "AndroidHarness") }
        ensureConfig(activity)
    }

    /** Called from the WebView callback on the UI thread. */
    fun updateUrl(url: String?) {
        if (!url.isNullOrBlank()) currentUrl = url
    }

    /** Call on page finished; idempotent. */
    fun start(activity: Activity, webView: WebView) {
        if (running) return
        this.activity = activity
        this.webView = webView
        ensureConfig(activity)
        running = true
        // Keep polling even while disabled: writing enabled=true can then take
        // effect without restarting Float. pollOnce() still enforces the token
        // and enabled flag before touching any command.
        pollFuture?.cancel(false)
        pollFuture = executor.scheduleWithFixedDelay({
            try { pollOnce(activity) } catch (error: Throwable) {
                Log.w(TAG, "poll failed: ${error.message}")
            }
        }, 250, 700, TimeUnit.MILLISECONDS)
        Log.i(TAG, "harness polling; dir=${harnessDir(activity).absolutePath}")
    }

    fun stop() {
        running = false
        pollFuture?.cancel(false)
        pollFuture = null
        pending.clear()
        activity = null
        webView = null
    }

    private fun ensureConfig(context: Context) {
        val file = configFile(context)
        if (file.exists()) return
        runCatching {
            file.writeText(
                JSONObject()
                    .put("enabled", false)
                    .put("token", UUID.randomUUID().toString().replace("-", ""))
                    .put("note", "Set enabled=true to enable; polling picks it up without restart.")
                    .toString(2)
            )
        }
    }

    private fun readConfig(context: Context): JSONObject? {
        return runCatching { JSONObject(configFile(context).readText()) }.getOrNull()
    }

    private fun pollOnce(context: Context) {
        if (!running) return
        val config = readConfig(context) ?: return
        if (!config.optBoolean("enabled", false)) return
        val token = config.optString("token").trim()
        if (token.isEmpty()) return
        val files = inbox(context).listFiles()
            ?.filter { it.isFile && it.name.endsWith(".json") }
            ?.sortedBy { it.name }
            ?: return
        for (file in files.take(4)) {
            if (!running) return
            val working = File(file.parentFile, file.name + ".processing")
            if (!file.renameTo(working)) continue
            val id = working.nameWithoutExtension.removeSuffix(".json")
            var commandId = id
            try {
                if (working.length() > MAX_COMMAND_BYTES) throw IllegalArgumentException("command too large")
                val command = JSONObject(working.readText())
                if (command.optString("token") != token) throw SecurityException("invalid harness token")
                commandId = command.optString("id", id).ifBlank { id }
                when (command.optString("op")) {
                    "ping" -> writeResult(context, commandId, nativeResult(commandId, ok = true, context = context))
                    "info" -> writeResult(context, commandId, nativeResult(commandId, ok = true, context = context))
                    "reload" -> {
                        activity?.runOnUiThread { webView?.reload() }
                        writeResult(context, commandId, nativeResult(commandId, ok = true, context = context))
                    }
                    "fs" -> writeResult(context, commandId, fsResult(context, commandId, command))
                    "prefs" -> writeResult(context, commandId, prefsResult(context, commandId, command))
                    "sqlite" -> writeResult(context, commandId, sqliteResult(context, commandId, command))
                    "eval" -> {
                        val expression = command.optString("expression")
                        if (expression.isBlank()) throw IllegalArgumentException("eval 需要 expression")
                        evalInPage(activity, expression, commandId) { payload ->
                            writeResult(context, commandId, payload)
                        }
                    }
                    else -> throw IllegalArgumentException("unsupported op: ${command.optString("op")}")
                }
            } catch (error: Throwable) {
                writeResult(context, commandId, errorResult(commandId, error))
            } finally {
                runCatching { working.delete() }
            }
        }
    }

    private fun fsRoots(context: Context): Map<String, File> {
        val data = File(context.applicationInfo.dataDir)
        return mapOf(
            "files" to context.filesDir,
            "cache" to context.cacheDir,
            "no_backup" to context.noBackupFilesDir,
            "external" to (context.getExternalFilesDir(null) ?: File(context.filesDir, "external")),
            "external_cache" to (context.externalCacheDir ?: context.cacheDir),
            "shared_prefs" to File(data, "shared_prefs"),
            "databases" to File(data, "databases"),
            "data" to data,
        )
    }

    private fun fsTarget(context: Context, rootName: String, relativePath: String): Pair<File, File> {
        val root = (fsRoots(context)[rootName] ?: throw IllegalArgumentException("fs root 不支持：$rootName")).canonicalFile
        val target = File(root, relativePath.ifBlank { "." }).canonicalFile
        if (target != root && !target.path.startsWith(root.path + File.separator)) {
            throw SecurityException("路径越界")
        }
        return root to target
    }

    private fun fsResult(context: Context, id: String, command: JSONObject): String {
        val action = command.optString("action", "list")
        val rootName = command.optString("root", "files")
        val relative = command.optString("path", "")
        val (root, target) = fsTarget(context, rootName, relative)
        val result = JSONObject().put("id", id).put("ok", true).put("action", action)
            .put("root", rootName).put("path", target.relativeTo(root).path.replace(File.separatorChar, '/'))
        when (action) {
            "list" -> {
                if (target.isFile) throw IllegalArgumentException("目标不是目录")
                val entries = JSONArray()
                var count = 0
                fun walk(dir: File, depth: Int) {
                    if (count >= 1000 || depth > 8) return
                    val children = dir.listFiles()?.sortedBy { it.name } ?: return
                    for (child in children) {
                        if (count >= 1000) break
                        count++
                        entries.put(
                            JSONObject()
                                .put("name", child.name)
                                .put("path", child.relativeTo(root).path.replace(File.separatorChar, '/'))
                                .put("dir", child.isDirectory)
                                .put("size", if (child.isFile) child.length() else 0)
                                .put("modified", child.lastModified())
                        )
                        if (child.isDirectory && command.optBoolean("recursive", false)) walk(child, depth + 1)
                    }
                }
                walk(target, 0)
                result.put("count", count).put("entries", entries)
            }
            "read" -> {
                if (!target.isFile) throw IllegalArgumentException("文件不存在")
                val limit = command.optInt("maxBytes", MAX_FILE_BYTES).coerceIn(1, MAX_FILE_BYTES)
                if (target.length() > limit) throw IllegalArgumentException("文件过大：${target.length()} > $limit")
                val bytes = target.readBytes()
                val encoding = command.optString("encoding", "")
                val isText = bytes.take(4096).none { it == 0.toByte() }
                if (encoding == "base64" || !isText) {
                    result.put("encoding", "base64").put("content", Base64.encodeToString(bytes, Base64.NO_WRAP))
                } else {
                    result.put("encoding", "utf8").put("content", String(bytes, Charsets.UTF_8))
                }
                result.put("size", bytes.size)
            }
            "stat" -> {
                if (!target.exists()) throw IllegalArgumentException("路径不存在")
                result.put("exists", true).put("dir", target.isDirectory)
                    .put("size", if (target.isFile) target.length() else 0)
                    .put("modified", target.lastModified())
            }
            "write" -> {
                if (command.optBoolean("confirm", false) != true) throw SecurityException("写文件必须 confirm=true")
                if (target == root) throw IllegalArgumentException("不能写根目录")
                val content = command.optString("content", "")
                if (content.length > 4 * 1024 * 1024) throw IllegalArgumentException("内容过大")
                val bytes = if (command.optString("encoding", "") == "base64") {
                    Base64.decode(content, Base64.DEFAULT)
                } else {
                    content.toByteArray(Charsets.UTF_8)
                }
                target.parentFile?.mkdirs()
                target.writeBytes(bytes)
                result.put("size", bytes.size)
            }
            "mkdir" -> {
                if (command.optBoolean("confirm", false) != true) throw SecurityException("mkdir 必须 confirm=true")
                if (target == root) throw IllegalArgumentException("不能重建根目录")
                if (!target.mkdirs() && !target.isDirectory) throw IllegalStateException("创建目录失败")
            }
            "delete" -> {
                if (command.optBoolean("confirm", false) != true) throw SecurityException("删除必须 confirm=true")
                if (target == root) throw IllegalArgumentException("不能删除根目录")
                if (!target.exists()) throw IllegalArgumentException("路径不存在")
                if (target.isDirectory && !command.optBoolean("recursive", false)) {
                    throw IllegalArgumentException("删除目录需要 recursive=true")
                }
                if (!target.deleteRecursively()) throw IllegalStateException("删除失败")
            }
            else -> throw IllegalArgumentException("未知 fs action：$action")
        }
        return result.toString()
    }

    private fun jsonValue(value: Any?): Any? {
        return when (value) {
            null -> JSONObject.NULL
            is Set<*> -> JSONArray(value.toList())
            else -> value
        }
    }

    private fun prefsResult(context: Context, id: String, command: JSONObject): String {
        val action = command.optString("action", "list")
        val data = File(context.applicationInfo.dataDir)
        val prefsDir = File(data, "shared_prefs")
        val result = JSONObject().put("id", id).put("ok", true).put("action", action)
        if (action == "list") {
            val names = JSONArray()
            prefsDir.listFiles()
                ?.filter { it.isFile && it.name.endsWith(".xml") }
                ?.sortedBy { it.name }
                ?.forEach { names.put(it.name.removeSuffix(".xml")) }
            return result.put("count", names.length()).put("names", names).toString()
        }
        val name = command.optString("name").removeSuffix(".xml").trim()
        if (name.isEmpty()) throw IllegalArgumentException("prefs 需要 name")
        if (name.contains('/') || name.contains('\\') || name == "." || name == "..") {
            throw IllegalArgumentException("prefs name 非法")
        }
        val prefs: SharedPreferences = context.getSharedPreferences(name, Context.MODE_PRIVATE)
        result.put("name", name)
        when (action) {
            "get" -> {
                val key = command.optString("key")
                if (key.isBlank()) {
                    val all = JSONObject()
                    for ((k, v) in prefs.all) all.put(k, jsonValue(v))
                    result.put("values", all)
                } else if (!prefs.contains(key)) {
                    result.put("exists", false).put("key", key)
                } else {
                    result.put("exists", true).put("key", key).put("value", jsonValue(prefs.all[key]))
                }
            }
            "set" -> {
                if (command.optBoolean("confirm", false) != true) throw SecurityException("写 prefs 必须 confirm=true")
                val key = command.optString("key").trim()
                if (key.isEmpty()) throw IllegalArgumentException("set 需要 key")
                val editor = prefs.edit()
                when (val value = command.opt("value")) {
                    null, JSONObject.NULL -> editor.remove(key)
                    is Boolean -> editor.putBoolean(key, value)
                    is Int -> editor.putInt(key, value)
                    is Long -> editor.putLong(key, value)
                    is Double -> editor.putFloat(key, value.toFloat())
                    is JSONArray -> {
                        val values = mutableSetOf<String>()
                        for (i in 0 until value.length()) values.add(value.optString(i))
                        editor.putStringSet(key, values)
                    }
                    else -> editor.putString(key, value.toString())
                }
                if (!editor.commit()) throw IllegalStateException("prefs 写入失败")
                result.put("key", key).put("saved", true)
            }
            "delete" -> {
                if (command.optBoolean("confirm", false) != true) throw SecurityException("删除 prefs 必须 confirm=true")
                val key = command.optString("key").trim()
                val editor = prefs.edit()
                if (key.isEmpty()) editor.clear() else editor.remove(key)
                if (!editor.commit()) throw IllegalStateException("prefs 删除失败")
                result.put("key", key).put("deleted", true)
            }
            else -> throw IllegalArgumentException("未知 prefs action：$action")
        }
        return result.toString()
    }

    private fun sqliteResult(context: Context, id: String, command: JSONObject): String {
        val action = command.optString("action", "list")
        val dbDir = File(context.applicationInfo.dataDir, "databases")
        val result = JSONObject().put("id", id).put("ok", true).put("action", action)
        if (action == "list") {
            val names = JSONArray()
            dbDir.listFiles()
                ?.filter { it.isFile && (it.name.endsWith(".db") || it.name.endsWith(".sqlite") || it.name.endsWith(".sqlite3")) }
                ?.sortedBy { it.name }
                ?.forEach { names.put(JSONObject().put("name", it.name).put("size", it.length()).put("modified", it.lastModified())) }
            return result.put("count", names.length()).put("databases", names).toString()
        }
        val name = command.optString("database").trim()
        if (name.isEmpty() || name.contains('/') || name.contains('\\') || name == "." || name == "..") {
            throw IllegalArgumentException("database 非法")
        }
        val file = File(dbDir, name)
        if (!file.isFile) throw IllegalArgumentException("数据库不存在：$name")
        val sql = command.optString("sql").trim()
        if (sql.isEmpty()) throw IllegalArgumentException("sql 为空")
        if (action == "query") {
            if (!Regex("^(select|pragma|with|explain)\\b", RegexOption.IGNORE_CASE).containsMatchIn(sql)) {
                throw IllegalArgumentException("query 只接受 SELECT/PRAGMA/WITH/EXPLAIN")
            }
            val limit = command.optInt("limit", 500).coerceIn(1, 2000)
            val db = SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY)
            try {
                val cursor = db.rawQuery(sql, null)
                try {
                    val columns = JSONArray()
                    for (i in 0 until cursor.columnCount) columns.put(cursor.getColumnName(i))
                    val rows = JSONArray()
                    while (cursor.moveToNext() && rows.length() < limit) {
                        val row = JSONArray()
                        for (i in 0 until cursor.columnCount) row.put(cursor.getString(i) ?: JSONObject.NULL)
                        rows.put(row)
                    }
                    result.put("columns", columns).put("rows", rows).put("rowCount", rows.length())
                } finally {
                    cursor.close()
                }
            } finally {
                db.close()
            }
        } else if (action == "exec") {
            if (command.optBoolean("confirm", false) != true) throw SecurityException("sqlite exec 必须 confirm=true")
            val db = SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE)
            try {
                db.execSQL(sql)
                result.put("executed", true)
            } finally {
                db.close()
            }
        } else {
            throw IllegalArgumentException("未知 sqlite action：$action")
        }
        return result.toString()
    }

    private fun nativeResult(id: String, ok: Boolean, context: Context? = null): String {
        val info = JSONObject()
            .put("id", id)
            .put("ok", ok)
            .put("harnessVersion", VERSION)
            .put("package", activity?.packageName ?: "")
            .put("versionName", BuildConfig.VERSION_NAME)
            .put("versionCode", BuildConfig.VERSION_CODE)
            .put("url", currentUrl)
            .put("webView", runCatching { WebView.getCurrentWebViewPackage()?.versionName }.getOrNull() ?: "")
            .put("time", System.currentTimeMillis())
        if (context != null) {
            val data = File(context.applicationInfo.dataDir)
            val prefs = data.resolve("shared_prefs").listFiles()
                ?.filter { it.isFile && it.name.endsWith(".xml") }
                ?.map { it.name.removeSuffix(".xml") }
                ?.sorted()
                ?: emptyList()
            val databases = data.resolve("databases").listFiles()
                ?.filter { it.isFile && (it.name.endsWith(".db") || it.name.endsWith(".sqlite") || it.name.endsWith(".sqlite3")) }
                ?.map { it.name }
                ?.sorted()
                ?: emptyList()
            info.put("dataDir", data.absolutePath)
                .put("externalFilesDir", context.getExternalFilesDir(null)?.absolutePath ?: "")
                .put("harnessDir", harnessDir(context).absolutePath)
                .put("sharedPrefs", JSONArray(prefs))
                .put("databases", JSONArray(databases))
        }
        return info.toString()
    }

    private fun errorResult(id: String, error: Throwable): String {
        return JSONObject()
            .put("id", id)
            .put("ok", false)
            .put("error", error.message ?: error.javaClass.simpleName)
            .put("errorType", error.javaClass.simpleName)
            .put("time", System.currentTimeMillis())
            .toString()
    }

    private fun evalInPage(activity: Activity?, expression: String, id: String, complete: (String) -> Unit) {
        if (activity == null) {
            complete(JSONObject().put("id", id).put("ok", false).put("error", "activity unavailable").toString())
            return
        }
        val wv = webView
        if (wv == null) {
            complete(JSONObject().put("id", id).put("ok", false).put("error", "webview unavailable").toString())
            return
        }
        pending[id] = complete
        val quotedId = JSONObject.quote(id)
        val script = """
            (function(){
              try {
                var __p = (async function(){ return (""" + expression + """); })();
                Promise.resolve(__p).then(function(v){
                  try { AndroidHarness.resolve($quotedId, JSON.stringify({id:$quotedId,ok:true,value:v})); }
                  catch(e){ AndroidHarness.resolve($quotedId, JSON.stringify({id:$quotedId,ok:false,error:String(e)})); }
                }).catch(function(e){
                  AndroidHarness.resolve($quotedId, JSON.stringify({id:$quotedId,ok:false,error:String(e && (e.stack || e.message) || e)}));
                });
              } catch(e) {
                AndroidHarness.resolve($quotedId, JSON.stringify({id:$quotedId,ok:false,error:String(e && (e.stack || e.message) || e)}));
              }
            })();
        """
        activity.runOnUiThread {
            try {
                wv.evaluateJavascript(script, null)
            } catch (error: Throwable) {
                pending.remove(id)?.invoke(
                    JSONObject().put("id", id).put("ok", false).put("error", error.message ?: "evaluateJavascript failed").toString()
                )
            }
        }
        executor.schedule({
            val callback = pending.remove(id) ?: return@schedule
            callback(JSONObject().put("id", id).put("ok", false).put("error", "eval timeout").toString())
        }, 30, TimeUnit.SECONDS)
    }

    private fun writeResult(context: Context, id: String, payload: String) {
        runCatching {
            val safeId = id.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { UUID.randomUUID().toString() }
            val text = if (payload.length > MAX_RESULT_CHARS) {
                JSONObject()
                    .put("id", id)
                    .put("ok", false)
                    .put("error", "result too large: ${payload.length} chars")
                    .toString()
            } else {
                payload
            }
            val directory = outbox(context)
            val temp = File(directory, ".$safeId.tmp")
            val target = File(directory, "$safeId.json")
            temp.writeText(text)
            if (!temp.renameTo(target)) {
                target.writeText(text)
                runCatching { temp.delete() }
            }
        }.onFailure { Log.w(TAG, "write result failed: ${it.message}") }
    }
}
