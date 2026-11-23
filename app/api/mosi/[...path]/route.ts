// ============================================
// Moss / mosi 语音接口 · 跨域中转（内嵌在同源下）
// Base URL 填：https://khaki-one-11.vercel.app/api/mosi/v1
// 健康检查：   https://khaki-one-11.vercel.app/api/mosi/ping
// ============================================

import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const UPSTREAM = 'https://api.mosi.cn';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

// 这些请求头不能转发，否则会出错
const DROP_REQ_HEADERS = [
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'keep-alive',
  'transfer-encoding',
];

// 这些响应头不能透传，否则浏览器解不开
const DROP_RES_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
];

async function proxy(req: NextRequest, segs: string[]) {
  const path = '/' + segs.join('/');

  // 健康检查
  if (path === '/ping' || path === '/') {
    return new Response(
      JSON.stringify({
        ok: true,
        service: 'moss-tts-proxy-next',
        hint: '中转站已上线，Base URL 填 https://khaki-one-11.vercel.app/api/mosi/v1',
        gotPath: path,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
      }
    );
  }

  const url = new URL(req.url);
  const target = UPSTREAM + path + (url.search || '');

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (DROP_REQ_HEADERS.includes(key.toLowerCase())) return;
    headers.set(key, value);
  });

  let body: ArrayBuffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'follow',
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'upstream_unreachable', detail: String(e), target }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
      }
    );
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (DROP_RES_HEADERS.includes(key.toLowerCase())) return;
    outHeaders.set(key, value);
  });
  for (const [k, v] of Object.entries(CORS)) outHeaders.set(k, v);
  outHeaders.set('X-Proxy-Upstream-Status', String(upstream.status));
  outHeaders.set('X-Proxy-Target', target);

  // 直接用流返回，音频边下边到，不占内存、不超时
  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

type Ctx = { params: Promise<{ path?: string[] }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  return proxy(req, params?.path ?? []);
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  return proxy(req, params?.path ?? []);
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  return proxy(req, params?.path ?? []);
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  return proxy(req, params?.path ?? []);
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
