# 自定义 APP 文件下载接口

自定义 APP 运行在隔离 iframe 中，不应直接访问 `window.AndroidShell`，也不需要放宽 iframe 沙盒权限。下载由宿主代理到统一的 `download-utils`，APK 环境自动复用 Android 原生文件保存与分块写入能力。

## SDK

在 `manifest.json` 的 `permissions` 中声明：

```json
{
  "permissions": ["media.download"]
}
```

调用方式：

```js
// 推荐：先存入宿主媒体库，再用引用下载（避免重复传输大段 base64）
const stored = await AiPhone.media.put({ dataUrl });
await AiPhone.media.download({
  ref: stored.ref,
  filename: "我的图片.png"
});

// 推荐大文件：直接传 Blob，postMessage 使用结构化克隆，不膨胀成 base64
await AiPhone.media.download({
  blob,
  filename: "导出文件.zip"
});

// 也可直接传 data URL / base64
await AiPhone.media.download({
  dataUrl,
  filename: "我的图片.png"
});

// base64 不带 data: 前缀时需显式给 MIME
await AiPhone.media.download({
  base64,
  mime: "application/pdf",
  filename: "导出.pdf"
});
```

## 行为

- Android APK：宿主调用原生保存接口，优先分块写入，保存到系统 Download 目录；原生失败会返回错误，不会假报成功。
- 兼容旧自定义 APP：运行器会自动拦截 APK iframe 内带 `download` 属性的 `blob:` / `data:` 链接，并转交宿主保存。常见的 `a.href = URL.createObjectURL(blob); a.download = ...; a.click()` 不必逐个改造即可获得 APK 下载能力；新代码仍推荐显式调用 `AiPhone.media.download()`。
- 普通浏览器：通过浏览器下载机制触发下载；浏览器无法确认最终落盘，因此只提示已触发。
- iOS：遵循统一下载工具的系统分享/浏览器能力策略。
- 通过 `ref` 下载时，只能下载当前 APP 自己通过 `media.put` 写入并登记的媒体。
- 单次 data URL/base64 输入沿用自定义 APP 媒体上限（约 25MB）；较大的媒体建议直接传 `blob`，由宿主原生分块写入；也可以先用 `media.put`，再通过 `ref` 下载。
- 文件名会过滤路径分隔符及系统不允许的字符。

## 兼容性

为兼容已经声明 `media.save` 的旧 APP，运行器暂时也允许拥有 `media.save` 权限的 APP 调用 `media.download`。新 APP 应改为声明更精确的 `media.download` 权限。`media.save` 仍表示写入宿主主题资产库，不等同于下载到公共目录。

## 为什么不直接把原生桥开放给 iframe？

Android 的 `addJavascriptInterface` 会把对象暴露给 WebView 的所有 frame，无法仅凭调用判断来源 frame。当前方案保留原生桥只在可信顶层页面可用的边界；iframe 通过自定义 APP SDK 请求宿主，宿主验证 APP 权限和媒体归属后再调用原生下载工具。
