# Float Harness Bridge

给外部 harness（Claude Code / Codex / OpenClaw / 任意 MCP 客户端）用的本地调试桥。

它**不修改网页或 APK 代码**，而是连接到正在运行的 Float，直接读写应用数据、查看生活系统、检查记忆、截图和操作页面。

## 两种后端

| 后端 | 适用包 | 原理 | 需要 |
|---|---|---|---|
| `app` | release / DEV | App 内 `HarnessAgent` 轮询 `/sdcard/Android/data/<包>/files/harness/`，把命令交给自己的 WebView 执行 | APK 包含 `HarnessAgent`，Shizuku/adb 有 `/sdcard` 访问权限 |
| `cdp` | 仅 DEV | Chrome DevTools Protocol 连接 WebView | WebView 调试开启，电脑能 `adb forward` |
| `auto` | 两者 | 默认优先 App 队列；有 `FLOAT_CDP_URL` 时优先 CDP，失败再回退 | 至少一个可用 |

release 包没有 `webview_devtools_remote_*`，只能用 `app`。网页层/数据层改动不需要重新发 APK；原生 Kotlin 改动仍然要重装。

## 安装 App 内 Harness

1. 安装包含 `HarnessAgent` 的同签名 APK（不要卸载旧版，否则 WebView 数据会丢）。
2. 启动一次 Float。App 会创建：

```text
/sdcard/Android/data/app.floatphone.shell/files/harness/
  config.json
  inbox/
  outbox/
```

`.dev` 包的路径是 `app.floatphone.shell.dev`。

3. 用 MCP 工具或手工写入配置，启用 Harness：

```json
{
  "enabled": true,
  "token": "换成一串随机字符串"
}
```

`config.json` 初始为 `enabled:false`，并自带随机 token。改完后不需要重启 Float：Harness 会持续轮询配置，下一次轮询即生效。

4. 配 MCP：

```json
{
  "mcpServers": {
    "float-harness": {
      "command": "node",
      "args": [
        "C:\\path\\to\\doremy.float.phone\\tools\\float-harness\\server.mjs"
      ],
      "env": {
        "FLOAT_HARNESS_MODE": "app",
        "FLOAT_APP_PACKAGE": "app.floatphone.shell",
        "FLOAT_ADB_SERIAL": "可选，多设备时填",
        "ADB": "C:\\Users\\你\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe"
      }
    }
  }
}
```

也可以先让 MCP 写配置：

```text
float_app_setup({ confirm: true })
float_status()
```

`float_app_setup` 会保留/生成 token，并把 `config.json` 写成 `enabled:true`。

5. Float 必须正在运行（前台或后台存活）。命令会一直排队，直到 App 处理；客户端默认 60 秒超时。App 被系统杀掉时请重新打开 Float。

### 本地 debug 包

debug 包名是 `app.floatphone.shell.dev`，和正式包并排安装。页面指向本机 dev server 时，推荐：

```bash
# 编译时指定本机地址
SHELL_SITE_URL=http://127.0.0.1:3001 ./gradlew :app:assembleDebug

# 让手机上的 127.0.0.1:3001 反代到电脑
adb reverse tcp:3001 tcp:3001
```

`adb reverse` 会随 adb 重连/无线调试端口变化而失效；页面报 `ERR_CONNECTION_REFUSED` 时重新执行一次即可。

debug 源集里有一份仅 debug 生效的 `network_security_config.xml`，允许局域网明文，所以调试包也可以直接指向 `http://<电脑局域网IP>:3001`。release 仍沿用主配置的明文禁令；release 测试请用 HTTPS 或 `adb reverse`。

## 手工命令格式

```text
/sdcard/Android/data/<包>/files/harness/inbox/<id>.json
```

```json
{
  "id": "my-command-1",
  "token": "config.json 里的 token",
  "op": "eval",
  "expression": "document.title"
}
```

结果写到：

```text
/sdcard/Android/data/<包>/files/harness/outbox/my-command-1.json
```

支持的 `op`：

- `ping` / `info`：版本、包名、WebView URL、数据目录
- `eval`：在页面上下文执行 JS，自动 await Promise
- `reload`：刷新页面
- `fs`：读写 App 私有目录与外部沙盒
- `prefs`：读写 SharedPreferences
- `sqlite`：查询/执行 App 私有 SQLite

写操作必须带 `"confirm": true`。文件队列只在本机使用；token 在 App 外沙盒里，能读 `/sdcard` 的进程都读得到。

## CDP 模式（仅 DEV）

前提：Float DEV 壳、`http://localhost:3001`、USB 调试、电脑有 `adb`、Node.js 22+。

```bash
node tools/float-harness/server.mjs
```

它会尝试连接 `http://127.0.0.1:9222`；找不到时自动执行：

```bash
adb shell pidof app.floatphone.shell.dev
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
```

手动配置：

```json
"env": {
  "FLOAT_HARNESS_MODE": "cdp",
  "FLOAT_CDP_URL": "http://127.0.0.1:9222"
}
```

## 工具

| 工具 | 作用 |
|---|---|
| `float_status` | 查看连接状态、后端、包版本和当前页面 |
| `float_app_setup` | 启用 App 内文件队列 Harness（需 `confirm=true`） |
| `float_app_info` | 包、版本、数据目录、SharedPreferences/数据库列表 |
| `float_fs` | 读写 App 私有目录和外部沙盒（写/删需 `confirm=true`） |
| `float_prefs` | 读写 SharedPreferences（写/删需 `confirm=true`） |
| `float_sqlite` | 查询/执行 App 私有 SQLite（exec 需 `confirm=true`） |
| `float_eval` | 在页面上下文执行任意 JS（最高权限） |
| `float_list_databases` | 列出全部 IndexedDB |
| `float_read_kv` | 读取 AiPhoneKvDB |
| `float_write_kv` | 写/删 KV（需 `confirm=true`） |
| `float_life_locations` | 生活地点 list/add/update/delete |
| `float_life_diagnose` | 检查未匹配的日程地点 |
| `float_memory_entries` | 检查长期/核心记忆 |
| `float_snapshot` | 存储结构/KV 键/localStorage 摘要 |
| `float_screenshot` | 截当前页面；app 后端截整屏 |
| `float_reload` | 重新加载页面 |
| `float_click` | 点击 CSS selector |
| `float_type` | 输入文本 |

`float_eval` 是万能入口，例如：

```js
// 读生活状态
(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('AiPhoneKvDB');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = db.transaction('entries', 'readonly');
  const r = tx.objectStore('entries').get('ai_phone_virtual_life_state_v1');
  const row = await new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  db.close();
  return JSON.parse(row.value);
})()
```

注意：`eval` 的参数是一个**表达式**，不是任意语句块。多步操作请像上面一样包成 async IIFE。

## 原生数据示例

```text
float_app_info()
float_fs({ action: "list", root: "data", path: "", recursive: true })
float_fs({ action: "read", root: "shared_prefs", path: "float_startup_diagnostics.xml" })
float_prefs({ action: "get", name: "float_startup_diagnostics" })
float_sqlite({ action: "list" })
float_sqlite({ action: "query", database: "xxx.db", sql: "select * from table limit 20" })
```

`root` 可选：`files`、`cache`、`no_backup`、`external`、`external_cache`、`shared_prefs`、`databases`、`data`。路径不能越出 root。

## 安全边界

- **仅开发/本机使用**。`float_eval` 可以读取页面里的 API Key、Token、全部角色数据；`float_fs`/`float_prefs`/`float_sqlite` 可以读取 App 私有数据。
- 不要把 MCP/CDP 端口暴露到公网。
- 写操作先备份；重要数据先 `float_snapshot` 或 `float_fs` 导出。
- `float_life_locations` 写入后默认刷新页面，让 KV 缓存重新水合。
- 直接改 IndexedDB/KV 可能与页面内存状态竞争；写完尽快 `float_reload`。
- 原生 Kotlin/APK 代码不能通过这个桥热更新；网页层和数据层可以。
- 不需要时把 `config.json` 改回 `enabled:false`。

## 为什么需要刷新

Float 的 KV 有内存缓存。直接写 `AiPhoneKvDB` 后，页面内存里的旧状态可能还在；刷新会让应用重新水合。

## 生活地点示例

```text
float_life_diagnose()
float_life_locations({
  action: "add",
  name: "旧城图书馆",
  aliases: ["市图"],
  atmosphere: "安静",
  layout: "三楼有自习室",
  relation: "frequent",
  confirm: true
})
```

新增地点使用 `imported-place-*` ID，来源标记为 `harness`，不会覆盖用户手改的字段。

## 排错

- `App harness 未启用`：把 `config.json` 的 `enabled` 改成 `true`，或调用 `float_app_setup`。
- `等待 App harness 超时`：Float 没在前台/进程被杀；先打开 Float。也可能是路径写到了错误的包（`.dev` vs release）。
- `invalid harness token`：客户端读到的 config 和命令里的 token 不一致；重新跑 `float_app_setup`。
- `adb: no devices`：先 `adb devices`，或填 `FLOAT_ADB_SERIAL`。
- `cat: ... Permission denied`：当前 shell 没有 `/sdcard/Android/data` 访问权限；确认 Shizuku 授权给的是 shell uid，或改用有权限的 adb。
