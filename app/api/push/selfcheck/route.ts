import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { decryptPushJobPayload, type EncryptedPayload } from "@/lib/server/push-job-crypto";
import { broadcastShellNotify } from "@/lib/server/push-service";
import { encodeSupabaseFilter, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

/**
 * 离线推送全链路自检。
 *
 * 为什么需要这个：离线推送是一条很长的链（站点配置 → 账号 → 订阅 → 建任务 →
 * 服务端扫描 → 调模型 → 写回传箱 → 广播 → 壳长连接 → 系统通知），任何一段断了
 * 的现象都一样：收不到消息。过去链上没有观测点，只能猜。
 *
 * 这里把链拆成若干可独立判定的段，逐段给出「通过 / 未通过 / 需注意」和下一步该
 * 做什么。默认还会真发一条广播到壳通道，把「服务端能不能推到这台设备」这件事
 * 直接变成可观测的结果。
 *
 * 只读查询 + 一条测试广播，不会改动任何业务数据。
 */

type StepStatus = "ok" | "warn" | "fail";

type Step = {
  key: string;
  label: string;
  status: StepStatus;
  detail: string;
  hint?: string;
};

const SHELL_PREFIX = "shell:";

export async function GET(request: Request) {
  const url = new URL(request.url);
  // 探测广播会真的弹一条通知，允许用 ?probe=0 关掉。
  const probe = url.searchParams.get("probe") !== "0";
  const steps: Step[] = [];

  // ── ① 站点配置 ──
  const supabase = getSupabaseServerConfig();
  if (!supabase) {
    steps.push({
      key: "site",
      label: "站点 Supabase 配置",
      status: "fail",
      detail: "缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY。",
      hint: "在部署平台环境变量里补齐后重新部署。",
    });
    return NextResponse.json({ ok: false, steps, summary: "站点未配置 Supabase，后续步骤无法进行。" });
  }
  steps.push({ key: "site", label: "站点 Supabase 配置", status: "ok", detail: `已配置：${supabase.url}` });

  // NEXT_PUBLIC_SELF_HOSTED_MODE 是构建期注入，服务端读到的就是打包时的值。
  const selfHosted = process.env.NEXT_PUBLIC_SELF_HOSTED_MODE === "true";
  steps.push({
    key: "mode",
    label: "单机模式开关",
    status: selfHosted ? "ok" : "fail",
    detail: selfHosted
      ? "NEXT_PUBLIC_SELF_HOSTED_MODE=true，离线任务接口已开放。"
      : "/api/push/jobs 与 /api/push/outbox 会直接返回 503，任务永远建不起来。",
    hint: selfHosted ? undefined : "设为 true 后必须重新部署（该变量是构建期注入，改完不部署不生效）。",
  });

  // ── ② 账号身份 ──
  const account = await getCurrentAccount(request).catch(() => null);
  if (!account) {
    steps.push({
      key: "account",
      label: "账号身份",
      status: "fail",
      detail: "未取得当前账号。",
      hint: "确认已登录。壳的订阅与任务是挂在站点账号 id 下的，身份拿不到后面全断。",
    });
    return NextResponse.json({ ok: false, steps, summary: "没有账号身份，无法继续。" });
  }
  steps.push({ key: "account", label: "账号身份", status: "ok", detail: account.id });

  // ── ③ 推送订阅 ──
  const subs = await supabaseRestFetch<{ endpoint: string }[]>(
    `push_subscriptions?user_id=eq.${encodeSupabaseFilter(account.id)}&select=endpoint&limit=50`,
  );
  if (!subs.ok) {
    steps.push({ key: "subs", label: "推送订阅", status: "fail", detail: `查询失败：${subs.error}` });
  } else {
    // 壳订阅的 endpoint 是合成的 shell:<账号id>，服务端凭前缀分流，不走 Web Push。
    const shellCount = subs.data.filter(row => row.endpoint.startsWith(SHELL_PREFIX)).length;
    const webCount = subs.data.length - shellCount;
    if (subs.data.length === 0) {
      steps.push({
        key: "subs",
        label: "推送订阅",
        status: "fail",
        detail: "该账号名下没有任何订阅——这是「收不到任何消息」最常见的原因。",
        hint: "壳需要成功连过一次长连接才会注册。通知栏常驻通知显示「已连接，等待角色消息」即已注册；显示「未登录或站点不可达」则还没注册成功。",
      });
    } else {
      steps.push({
        key: "subs",
        label: "推送订阅",
        status: shellCount > 0 ? "ok" : "warn",
        detail: `共 ${subs.data.length} 条：壳通道 ${shellCount} 条，Web Push ${webCount} 条。`,
        hint: shellCount === 0 ? "没有 shell: 订阅，离线消息不会被广播到壳的长连接。" : undefined,
      });
    }
  }

  const pushConfig = await supabaseRestFetch<{
    payload_key?: string | null;
    vapid_public_key?: string | null;
    vapid_private_key?: string | null;
  }[]>("push_server_config?id=eq.main&select=payload_key,vapid_public_key,vapid_private_key&limit=1");

  // ── ④ 现实桥云端收件箱 ──
  const bridgeConfig = await supabaseRestFetch<{ cloud_config?: EncryptedPayload | null }[]>(
    `push_bridge_config?user_id=eq.${encodeSupabaseFilter(account.id)}&select=cloud_config&limit=1`,
  );
  if (!bridgeConfig.ok) {
    steps.push({ key: "bridge-config", label: "现实桥云端配置", status: "fail", detail: `读取失败：${bridgeConfig.error}` });
  } else if (!bridgeConfig.data[0]?.cloud_config) {
    steps.push({
      key: "bridge-config",
      label: "现实桥云端配置",
      status: "fail",
      detail: "当前账号没有已同步的个人云配置，原生事件无法进入现实桥。",
      hint: "打开现实桥设置，确认个人云配置已保存并同步。",
    });
  } else {
    try {
      const payloadKey = pushConfig.ok ? String(pushConfig.data[0]?.payload_key ?? "") : "";
      if (!payloadKey) throw new Error("push_server_config.payload_key 尚未配置。");
      const cloud = JSON.parse(decryptPushJobPayload(bridgeConfig.data[0].cloud_config!, payloadKey)) as { url?: string; key?: string };
      const cloudUrl = String(cloud.url ?? "").replace(/\/+$/, "");
      const cloudKey = String(cloud.key ?? "").trim();
      if (!/^https:\/\//i.test(cloudUrl) || !cloudKey) throw new Error("个人云 URL 或访问密钥无效。");
      const sameProject = new URL(cloudUrl).origin.toLowerCase() === new URL(supabase.url).origin.toLowerCase();
      steps.push({
        key: "bridge-config",
        label: "现实桥云端配置",
        status: sameProject ? "ok" : "warn",
        detail: sameProject ? "个人云配置有效，且与站点环境变量指向同一个 Supabase 项目。" : "个人云配置可解密，但 Supabase 项目地址与站点环境变量不一致。",
        hint: sameProject ? undefined : "当前部署约定使用同一个 Supabase 项目，请核对现实桥个人云 URL 与站点 SUPABASE_URL。",
      });
      const inboxResponse = await fetch(`${cloudUrl}/storage/v1/object/list/ai-phone-backup`, {
        method: "POST",
        headers: { apikey: cloudKey, Authorization: `Bearer ${cloudKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "bridge-inbox/", limit: 5, offset: 0, sortBy: { column: "name", order: "asc" } }),
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (!inboxResponse.ok) {
        const detail = (await inboxResponse.text().catch(() => "")).slice(0, 180);
        steps.push({ key: "bridge-inbox", label: "现实桥收件箱", status: "fail", detail: `个人云 Storage 返回 HTTP ${inboxResponse.status}：${detail}`, hint: "检查 ai-phone-backup 存储桶、对象读写策略和个人云密钥。" });
      } else {
        const objects = await inboxResponse.json().catch(() => []) as Array<{ name?: string }>;
        steps.push({ key: "bridge-inbox", label: "现实桥收件箱", status: "ok", detail: `Storage 可访问；当前待处理对象约 ${Array.isArray(objects) ? objects.length : 0} 条（最多抽查 5 条）。` });
      }
    } catch (error) {
      steps.push({ key: "bridge-config", label: "现实桥云端配置", status: "fail", detail: error instanceof Error ? error.message : String(error), hint: "重新保存现实桥个人云配置，并检查 push_server_config.payload_key 是否可用。" });
    }
  }

  // ── ⑥ 离线任务表 ──
  const jobs = await supabaseRestFetch<{ trigger_key: string; kind: string; status: string; execute_at: string }[]>(
    `push_jobs?user_id=eq.${encodeSupabaseFilter(account.id)}&select=trigger_key,kind,status,execute_at&order=execute_at.desc&limit=20`,
  );
  if (!jobs.ok) {
    steps.push({ key: "jobs", label: "离线任务表 push_jobs", status: "fail", detail: `查询失败：${jobs.error}` });
  } else {
    const pending = jobs.data.filter(row => row.status === "pending");
    steps.push({
      key: "jobs",
      label: "离线任务表 push_jobs",
      status: jobs.data.length > 0 ? "ok" : "warn",
      detail: jobs.data.length === 0
        ? "一条记录都没有——说明预约根本没建起来，不是投递失败。"
        : `最近 ${jobs.data.length} 条，其中待执行 ${pending.length} 条：${jobs.data.slice(0, 5).map(row => row.kind).join("、")}`,
      hint: jobs.data.length === 0
        ? "依次查：主动消息规则建了吗？订阅门控过了吗？触发时刻是否落在安静时段？"
        : undefined,
    });
    const bridgeScans = jobs.data.filter(row => row.kind === "bridge_scan");
    const latestBridgeScan = bridgeScans[0];
    const bridgeScanStatus: StepStatus = !latestBridgeScan
      ? "warn"
      : latestBridgeScan.status === "failed"
        ? "fail"
        : latestBridgeScan.status === "running"
          ? "warn"
          : "ok";
    steps.push({
      key: "bridge-scan",
      label: "现实桥云端扫描任务",
      status: bridgeScanStatus,
      detail: latestBridgeScan
        ? `最近任务状态：${latestBridgeScan.status}；触发键：${latestBridgeScan.trigger_key}。`
        : "最近 20 条任务中没有 bridge_scan 记录，尚不能确认云端扫描已被唤醒。",
      hint: !latestBridgeScan
        ? "触发一条现实桥事件后重新诊断；如果仍没有任务，检查原生事件上传接口与 push_jobs 写入。"
        : latestBridgeScan.status === "failed"
          ? "检查 push-bridge Edge Function 执行日志与任务 result_note。"
          : latestBridgeScan.status === "running"
            ? "任务仍在执行；若持续不结束，检查 push-bridge Worker 日志和模型请求超时。"
            : undefined,
    });
  }

  // ── ⑦ 回传箱积压 ──
  const outbox = await supabaseRestFetch<{ id: string }[]>(
    `push_outbox?user_id=eq.${encodeSupabaseFilter(account.id)}&consumed_at=is.null&select=id&limit=50`,
  );
  if (outbox.ok) {
    steps.push({
      key: "outbox",
      label: "回传箱 push_outbox",
      status: "ok",
      detail: outbox.data.length === 0
        ? "没有积压。"
        : `有 ${outbox.data.length} 条已生成但还没合并进聊天（打开 App 应会自动取回）。`,
    });
  }

  // ── ⑧ Web Push 密钥自举（仅浏览器订阅依赖；Shell Realtime 不依赖 VAPID）──
  const hasWebSubscriptions = subs.ok && subs.data.some(row => !row.endpoint.startsWith(SHELL_PREFIX));
  const hasShellSubscriptions = subs.ok && subs.data.some(row => row.endpoint.startsWith(SHELL_PREFIX));
  if (!hasWebSubscriptions) {
    steps.push({
      key: "vapid",
      label: "Web Push 密钥",
      status: hasShellSubscriptions ? "ok" : "warn",
      detail: hasShellSubscriptions
        ? "当前使用 Android Shell Realtime 通道，无浏览器 Web Push 订阅；该通道不依赖 VAPID。"
        : "没有浏览器 Web Push 订阅；Shell 订阅也未确认，VAPID 检查跳过。",
    });
  } else {
    const vapidReady = pushConfig.ok
      && Boolean(pushConfig.data[0]?.vapid_public_key && pushConfig.data[0]?.vapid_private_key);
    steps.push({
      key: "vapid",
      label: "Web Push 密钥",
      status: vapidReady ? "ok" : "fail",
      detail: vapidReady ? "push_server_config 中的 VAPID 公私钥已配置。" : "未读取到完整 VAPID 公私钥。",
      hint: vapidReady ? undefined : "检查 push_server_config 表及 VAPID 密钥配置。",
    });
  }

  // ── ⑨ 真发一条广播：服务端 → 壳长连接 ──
  if (probe) {
    const sent = await broadcastShellNotify(account.id, {
      title: "链路自检",
      body: "自检广播：看到这条说明服务端→壳长连接是通的。",
      url: "/",
    });
    steps.push({
      key: "broadcast",
      label: "服务端 → 壳长连接广播",
      status: sent ? "ok" : "fail",
      detail: sent ? "已向 shellpush:<账号id> 频发送出一条广播。" : "广播请求失败。",
      hint: sent
        ? "若此刻没收到系统通知，问题在壳侧：长连接是否活着、系统通知权限是否给了。"
        : "检查 Supabase Realtime 是否可用（项目是否被暂停、Realtime 是否被关）。",
    });
  }

  const failed = steps.filter(step => step.status === "fail");
  return NextResponse.json({
    ok: failed.length === 0,
    steps,
    summary: failed.length === 0
      ? "各段均通过。若仍收不到消息，问题在客户端触发或系统通知权限。"
      : `有 ${failed.length} 段未通过：${failed.map(step => step.label).join("、")}。`,
  });
}
