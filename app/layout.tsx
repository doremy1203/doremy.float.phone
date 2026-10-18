import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ChatPluginBootstrap } from "@/components/chat-plugin-bootstrap";
import { ChatReasoningVisibilityController } from "@/components/chat-reasoning-visibility-controller";
import { CSSImportEnhancer } from "@/components/css-import-enhancer";
import { PWAManifestInjector } from "@/components/pwa-manifest-injector";
import { PWARegistrar } from "@/components/pwa-registrar";
import "../styles/fonts.css";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  // Android 键盘弹出时让浏览器原生压缩布局视口（而非只压缩 visualViewport）。
  // 配合 desktop-shell 的 --phone-screen-height 同步：输入栏天然贴在键盘上方，
  // 点击命中区域由原生布局保证，彻底避免手动抬升带来的视觉/hit-test 错位。
  interactiveWidget: "resizes-content",
};

export const metadata: Metadata = {
  title: "float",
  description: "float",
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <meta name="theme-color" content="#f8f7f2" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <link rel="icon" href="/icon-192.png" type="image/png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="float" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="mobile-web-app-capable" content="yes" />
        {/* 原生安卓壳（android-shell/MainActivity.kt）的 WebView 环境探测。
            部分设备（如部分华为/鸿蒙 WebView 内核）对 `(hover: none) and (pointer: coarse)`
            媒体特性判断不稳定，导致 phone-shell.css 的移动端铺满样式不生效，表现为
            桌面态的手机外壳卡片居中显示、四周留白不对称（见与用户的排障记录）。
            window.AndroidShell 是壳注入的原生桥对象（唯一在普通移动浏览器里不存在、
            只在这个壳里一定存在的信号），比 UA 字符串嗅探更可靠。
            同步执行的首次判断覆盖大多数机型；但部分机型（反馈来自华为 nova13pro）
            的 WebView 内核把 addJavascriptInterface 注入的对象挂上 window 的时机
            晚于这段 <head> 内联脚本的执行——同步判断那一刻 window.AndroidShell
            还不存在，一次性检测失败后就再也不会重试，标记永远挂不上、移动端铺满
            样式永远不生效（与构建产物、CSS 代码本身无关，纯粹是时序竞态）。
            这里补一层短时轮询兜底：挂标记这个动作本身是幂等的，重复判断/重复
            setAttribute 不会产生副作用，只在"目前还没挂上"时持续尝试，挂上后
            立即停止，不常驻定时器。 */}
        <script
          dangerouslySetInnerHTML={{
            // 壳识别用两路信号：window.AndroidShell（注入时机因内核而异）+
            // UA 里的 "FloatShell/" 标记（MainActivity 设置，首个脚本执行时就一定在）。
            // 挂上标记后用 MutationObserver 守住：React 客户端重渲染 <html> 时
            // 可能清掉根元素上的非 React 属性，被清掉就立刻补回。
            __html: `(function(){var d=document.documentElement;function isShell(){try{if(window.AndroidShell)return true}catch(e){}return (navigator.userAgent||'').indexOf('FloatShell/')!==-1}function mark(){if(d.getAttribute('data-shell-env')!=='android')d.setAttribute('data-shell-env','android')}function keep(){try{new MutationObserver(mark).observe(d,{attributes:true,attributeFilter:['data-shell-env']})}catch(e){}}if(isShell()){mark();keep();return}var n=0;var t=setInterval(function(){n++;if(isShell()){clearInterval(t);mark();keep()}else if(n>50){clearInterval(t)}},100)})();`,
          }}
        />
      </head>
      <body>
        <PWAManifestInjector />
        <PWARegistrar />
        <CSSImportEnhancer />
        <ChatPluginBootstrap />
        <ChatReasoningVisibilityController />
        {children}
      </body>
    </html>
  );
}
