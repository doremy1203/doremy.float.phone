#!/usr/bin/env node
/**
 * App-internal harness client.
 *
 * The release Float shell can run a file-queue agent inside its own WebView.
 * This module drives that agent through adb / Shizuku shell, with no CDP and
 * no debuggable WebView required.
 *
 * Env:
 *   FLOAT_APP_PACKAGE   default app.floatphone.shell
 *   FLOAT_ADB_SERIAL    optional adb serial
 *   FLOAT_HARNESS_TOKEN optional token when creating config.json
 *   ADB                 optional adb executable
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);
const ADB = process.env.ADB || "adb";
const SERIAL = process.env.FLOAT_ADB_SERIAL || "";
export const PACKAGE = process.env.FLOAT_APP_PACKAGE || "app.floatphone.shell";
export const BASE_DIR = `/sdcard/Android/data/${PACKAGE}/files/harness`;
const INBOX = `${BASE_DIR}/inbox`;
const OUTBOX = `${BASE_DIR}/outbox`;
const CONFIG = `${BASE_DIR}/config.json`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function onlineSerial(stdout) {
  const devices = String(stdout)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("List of devices"))
    .map(line => line.split(/\s+/))
    .filter(parts => parts[1] === "device")
    .map(parts => parts[0]);
  return devices.length === 1 ? devices[0] : "";
}

async function adb(args, options = {}) {
  let serial = SERIAL;
  if (!serial) {
    try {
      const { stdout } = await execFileAsync(ADB, ["devices"], { maxBuffer: 1024 * 1024 });
      serial = onlineSerial(stdout);
    } catch {
      serial = "";
    }
  }
  const full = serial ? ["-s", serial, ...args] : args;
  return execFileAsync(ADB, full, { maxBuffer: 32 * 1024 * 1024, ...options });
}

async function shell(command, options = {}) {
  return adb(["shell", command], options);
}

async function pushText(remotePath, value) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "float-harness-"));
  const localPath = path.join(dir, "payload.json");
  try {
    await fs.writeFile(localPath, value, "utf8");
    await adb(["push", localPath, remotePath]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readRemote(remotePath) {
  const { stdout } = await shell(`cat '${remotePath.replace(/'/g, "'\\''")}'`);
  return String(stdout).trim();
}

async function removeRemote(remotePath) {
  await shell(`rm -f '${remotePath.replace(/'/g, "'\\''")}'`).catch(() => undefined);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} 不是合法 JSON：${String(value).slice(0, 200)}`);
  }
}

export class AppBridge {
  constructor() {
    this.token = null;
  }

  async ensureSetup({ enable = false } = {}) {
    await shell(`mkdir -p '${INBOX}' '${OUTBOX}'`);
    let config = null;
    let raw = "";
    try {
      raw = await readRemote(CONFIG);
      if (raw) config = parseJson(raw, CONFIG);
    } catch {
      config = null;
    }
    if (!config) {
      const token = process.env.FLOAT_HARNESS_TOKEN || crypto.randomBytes(24).toString("hex");
      config = {
        enabled: enable === true,
        token,
        note: "Float app-internal harness. Set enabled=true to enable.",
      };
      await pushText(CONFIG, JSON.stringify(config, null, 2));
      this.token = token;
      if (!config.enabled) {
        throw new Error(`App harness 配置已创建但未启用：${CONFIG}；调用 float_app_setup 或把 enabled 改为 true`);
      }
      return { created: true, enabled: true, token, baseDir: BASE_DIR };
    }
    if (enable && config.enabled !== true) {
      config.enabled = true;
      if (!config.token) config.token = process.env.FLOAT_HARNESS_TOKEN || crypto.randomBytes(24).toString("hex");
      await pushText(CONFIG, JSON.stringify(config, null, 2));
      this.token = config.token;
      return { created: false, enabled: true, token: config.token, baseDir: BASE_DIR };
    }
    if (config.enabled !== true) {
      throw new Error(`App harness 未启用：${CONFIG} 设置 enabled=true 后重启 Float`);
    }
    if (!config.token) throw new Error(`App harness 缺少 token：${CONFIG}`);
    this.token = config.token;
    return { created: false, enabled: true, token: config.token, baseDir: BASE_DIR };
  }

  async command(op, args = {}, { timeoutMs = 60000 } = {}) {
    const setup = await this.ensureSetup();
    const id = `h-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const payload = { id, token: setup.token, op, ...args };
    await pushText(`${INBOX}/${id}.json`, JSON.stringify(payload));
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        let raw = "";
        try {
          raw = await readRemote(`${OUTBOX}/${id}.json`);
        } catch {
          raw = "";
        }
        if (raw) {
          const result = parseJson(raw, "harness result");
          await removeRemote(`${OUTBOX}/${id}.json`);
          return result;
        }
        await sleep(300);
      }
      throw new Error(`等待 App harness 超时（${timeoutMs}ms）。请确认 Float 正在前台运行，且 config.json 已启用。`);
    } finally {
      await removeRemote(`${INBOX}/${id}.json`);
    }
  }

  async ping() {
    return this.command("ping", {}, { timeoutMs: 20000 });
  }

  async evaluate(expression) {
    const result = await this.command("eval", { expression: String(expression) });
    if (result.ok !== true) throw new Error(result.error || "eval failed");
    return result.value;
  }

  async reload() {
    return this.command("reload");
  }

  async fs(args = {}) {
    return this.command("fs", args);
  }

  async prefs(args = {}) {
    return this.command("prefs", args);
  }

  async sqlite(args = {}) {
    return this.command("sqlite", args);
  }

  async info() {
    return this.command("info");
  }

  async screenshot() {
    const { stdout } = await adb(["exec-out", "screencap", "-p"], { encoding: null });
    if (!Buffer.isBuffer(stdout) || stdout.length === 0) throw new Error("adb screencap 没有返回图像");
    return stdout.toString("base64");
  }

  async status() {
    const info = await this.ping();
    return { ok: true, mode: "app", baseDir: BASE_DIR, info };
  }
}
