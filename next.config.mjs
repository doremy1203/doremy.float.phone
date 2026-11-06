import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const isWslUncPath = projectRoot.startsWith("\\\\wsl$\\");

function resolveDistDir() {
  // 本地验证构建可用 NEXT_DIST_DIR 指到独立目录,避免覆写正在跑的 dev server 的 .next
  if (process.env.NEXT_DIST_DIR) {
    return process.env.NEXT_DIST_DIR;
  }
  if (!isWindows || !isWslUncPath) {
    return ".next";
  }

  const safeProjectName = path.basename(projectRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.tmpdir(), `next-dist-${safeProjectName}`);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  outputFileTracingRoot: projectRoot,
  distDir: resolveDistDir(),
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    // 历史注释里的 TS 错误均已修复（2026-10 全仓 tsc --noEmit 零错误），构建期类型检查重新打开，
    // 防止类型回归悄悄溜进 main。若个别文件需要豁免，用 // @ts-expect-error 精确标注，不要整体关闭。
    ignoreBuildErrors: false,
  },
  outputFileTracingIncludes: {
    "/api/**": ["./data/**"],
  },
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      // @gltf-transform/core 的 dist 引用 node:fs / node:path(带 node: 前缀),
      // 它的 browser 字段只映射了裸 fs/path,webpack 对 node: 前缀报 UnhandledSchemeError。
      // 客户端包里剥掉前缀,再用 fallback 置空(浏览器路径实际只用 WebIO,不会真调 fs)。
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, "");
        }),
      );
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        module: false,
      };
    }
    return config;
  },
};

export default nextConfig;
