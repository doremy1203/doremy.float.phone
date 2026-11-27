#!/usr/bin/env node
/**
 * Float Harness Bridge — MCP server over stdio.
 * Developer/debug tool; connects to Float's WebView through CDP and exposes
 * broad local operations. Not bundled into the production app.
 *
 *   node tools/float-harness/server.mjs
 *
 * Env: FLOAT_HARNESS_MODE=app|cdp|auto, FLOAT_CDP_URL, FLOAT_CDP_TARGET_ID,
 *      FLOAT_ADB_SERIAL, FLOAT_APP_PACKAGE, FLOAT_HARNESS_DENY_RAW_EVAL=1
 */
import readline from "node:readline";
import { connectToFloat, CdpClient } from "./cdp.mjs";
import { AppBridge, PACKAGE } from "./app-bridge.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "float-harness", version: "0.2.0" };
const MODE = (process.env.FLOAT_HARNESS_MODE || "auto").toLowerCase();
const appBridge = new AppBridge();
let connection = null;

async function getConnection(force = false) {
  if (!force && connection?.client?.ws?.readyState === WebSocket.OPEN) return connection;
  connection?.client?.close();
  const found = await connectToFloat();
  const client = new CdpClient(found.target.webSocketDebuggerUrl);
  await client.connect();
  connection = { ...found, client };
  return connection;
}
async function cdpEvaluate(expression) {
  const { client } = await getConnection();
  return client.evaluate(expression);
}
const preferApp = MODE === "app" || (MODE === "auto" && !process.env.FLOAT_CDP_URL);

async function withBackend(appFn, cdpFn) {
  if (MODE === "app") return appFn();
  if (MODE === "cdp") return cdpFn();
  if (preferApp) {
    try { return await appFn(); } catch (appError) {
      try { return await cdpFn(); } catch (cdpError) {
        throw new Error(`App harness: ${appError.message}; CDP: ${cdpError.message}`);
      }
    }
  }
  try { return await cdpFn(); } catch (cdpError) {
    try { return await appFn(); } catch (appError) {
      throw new Error(`CDP: ${cdpError.message}; App harness: ${appError.message}`);
    }
  }
}

async function evaluate(expression) {
  return withBackend(() => appBridge.evaluate(expression), () => cdpEvaluate(expression));
}
const text = (value, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});
const schema = (properties = {}, required = []) => ({
  type: "object", properties, ...(required.length ? { required } : {}),
});

const TOOLS = [
  {
    name: "float_status",
    description: "检查 Float 连接状态与当前页面（CDP 或 App 内文件队列）。",
    inputSchema: schema(),
  },
  {
    name: "float_app_setup",
    description: "启用 release 包内的文件队列 Harness（写入 /sdcard/Android/data/<包>/files/harness/config.json）。会影响本机调试配置，必须 confirm=true。",
    inputSchema: schema({ confirm: { type: "boolean" } }, ["confirm"]),
  },
  {
    name: "float_app_info",
    description: "查看 App 内部 Harness 的包、版本、WebView 地址和本地数据目录。",
    inputSchema: schema(),
  },
  {
    name: "float_fs",
    description: "读写 App 私有目录（files/cache/shared_prefs/databases/data）和外部沙盒。写/删必须 confirm=true；路径限制在所选 root 内。",
    inputSchema: schema({
      action: { type: "string", enum: ["list", "read", "stat", "write", "mkdir", "delete"] },
      root: { type: "string", enum: ["files", "cache", "no_backup", "external", "external_cache", "shared_prefs", "databases", "data"], default: "files" },
      path: { type: "string" },
      content: { type: "string" },
      encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      recursive: { type: "boolean", default: false },
      maxBytes: { type: "integer", minimum: 1, maximum: 2097152 },
      confirm: { type: "boolean" },
    }, ["action"]),
  },
  {
    name: "float_prefs",
    description: "读写 App 的 SharedPreferences。set/delete 必须 confirm=true。",
    inputSchema: schema({
      action: { type: "string", enum: ["list", "get", "set", "delete"] },
      name: { type: "string" },
      key: { type: "string" },
      value: {},
      confirm: { type: "boolean" },
    }, ["action"]),
  },
  {
    name: "float_sqlite",
    description: "查看/查询/执行 App 私有 SQLite 数据库。exec 必须 confirm=true。",
    inputSchema: schema({
      action: { type: "string", enum: ["list", "query", "exec"] },
      database: { type: "string" },
      sql: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 2000, default: 500 },
      confirm: { type: "boolean" },
    }, ["action"]),
  },
  {
    name: "float_eval",
    description: "在 Float 页面上下文执行任意 JS（最高权限，能读写全部页面数据）。仅限开发/调试。",
    inputSchema: schema({ expression: { type: "string" } }, ["expression"]),
  },
  {
    name: "float_list_databases",
    description: "列出 IndexedDB 数据库、版本和 object store。",
    inputSchema: schema(),
  },
  {
    name: "float_read_kv",
    description: "读取 AiPhoneKvDB 的 key/prefix；KV 中存在生活状态、配置和多数应用数据。",
    inputSchema: schema({
      key: { type: "string" },
      prefix: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 2000, default: 100 },
    }),
  },
  {
    name: "float_write_kv",
    description: "写入/删除 AiPhoneKvDB 键；必须 confirm=true。写后调用 float_reload 重新水合。",
    inputSchema: schema({
      key: { type: "string" },
      value: { type: "string" },
      remove: { type: "boolean", default: false },
      confirm: { type: "boolean" },
    }, ["key", "confirm"]),
  },
  {
    name: "float_life_locations",
    description: "直接读取/追加/更新/删除生活系统地点。写操作必须 confirm=true；默认延迟刷新页面。",
    inputSchema: schema({
      action: { type: "string", enum: ["list", "add", "update", "delete"] },
      id: { type: "string" },
      name: { type: "string" },
      aliases: { type: "array", items: { type: "string" } },
      description: { type: "string" },
      atmosphere: { type: "string" },
      layout: { type: "string" },
      props: { type: "array", items: { type: "string" } },
      relation: { type: "string", enum: ["own-home", "shared-home", "workplace", "frequent", "mentioned", "unknown"] },
      category: { type: "string", enum: ["住宅", "商业", "公共", "自然", "其他"] },
      visibility: { type: "string", enum: ["public", "private"] },
      confirm: { type: "boolean" },
      reload: { type: "boolean", default: true },
    }, ["action"]),
  },
  {
    name: "float_life_diagnose",
    description: "诊断生活地点：地点、别名、日程中未匹配的地点名。",
    inputSchema: schema(),
  },
  {
    name: "float_memory_entries",
    description: "读取长期/核心记忆，可按角色、类型、关键词过滤。",
    inputSchema: schema({
      characterId: { type: "string" },
      type: { type: "string", enum: ["long_term", "core", "all"], default: "all" },
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    }),
  },
  {
    name: "float_snapshot",
    description: "导出数据库/store 元信息、KV 键和 localStorage 摘要。",
    inputSchema: schema({
      includeKvValues: { type: "boolean", default: false },
      includeLocalStorage: { type: "boolean", default: true },
      maxKvValueChars: { type: "integer", default: 300 },
    }),
  },
  {
    name: "float_screenshot",
    description: "截取 Float 当前页面。",
    inputSchema: schema(),
  },
  {
    name: "float_reload",
    description: "刷新 Float 页面，使直接写入的 KV/IndexedDB 重新水合。",
    inputSchema: schema(),
  },
  {
    name: "float_click",
    description: "按 CSS selector 点击页面元素。",
    inputSchema: schema({ selector: { type: "string" } }, ["selector"]),
  },
  {
    name: "float_type",
    description: "向 input/textarea 写入文本并触发 input/change。",
    inputSchema: schema({
      selector: { type: "string" },
      text: { type: "string" },
      submit: { type: "boolean", default: false },
    }, ["selector", "text"]),
  },
];

const LIFE_KEY = "ai_phone_virtual_life_state_v1";
const LIFE_STATE_EXPR = full => `(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open("AiPhoneKvDB");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const tx=db.transaction("entries","readonly");const r=tx.objectStore("entries").get(${JSON.stringify(LIFE_KEY)});const row=await new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});db.close();if(!row)return {exists:false};const s=JSON.parse(row.value);const summary={exists:true,updatedAt:s.updatedAt,locations:(s.locations||[]).length,schedules:(s.schedules||[]).length,scenes:(s.scenes||[]).length,sceneMessages:(s.sceneMessages||[]).length,events:(s.events||[]).length,memories:(s.memories||[]).length,timeline:(s.timeline||[]).length};return ${full ? "Object.assign(summary,{state:s})" : "summary"}})()`;

function lifeLocationsExpr(a) {
  return `(async()=>{const open=n=>new Promise((res,rej)=>{const r=indexedDB.open(n);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const db=await open("AiPhoneKvDB");const tx=db.transaction("entries","readonly");const r=tx.objectStore("entries").get(${JSON.stringify(LIFE_KEY)});const row=await new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});db.close();if(!row)throw new Error("生活状态还不存在");
    const s=JSON.parse(row.value),action=${JSON.stringify(String(a.action))},name=${JSON.stringify(String(a.name||""))},id=${JSON.stringify(String(a.id||""))},confirm=${a.confirm===true},p=${JSON.stringify({aliases:a.aliases,description:a.description,atmosphere:a.atmosphere,layout:a.layout,props:a.props,relation:a.relation,category:a.category,visibility:a.visibility})};
    const norm=v=>String(v||"").trim().normalize("NFKC").replace(/[\\s\\u3000·•/\\\\|｜、，,。.!！?？:：;；()（）\\[\\]【】_-]+/g,"").toLocaleLowerCase();const locs=Array.isArray(s.locations)?s.locations:[];const find=()=>locs.find(x=>String(x.id)===id)||locs.find(x=>norm(x.name)===norm(name))||locs.find(x=>(x.aliases||[]).some(v=>norm(v)===norm(name)));
    if(action==="list")return {count:locs.length,locations:locs};
    if(!confirm)throw new Error("写操作必须 confirm=true");
    const save=async()=>{const d=await open("AiPhoneKvDB");const w=d.transaction("entries","readwrite");w.objectStore("entries").put({key:${JSON.stringify(LIFE_KEY)},value:JSON.stringify(s)});await new Promise((res,rej)=>{w.oncomplete=()=>res();w.onerror=()=>rej(w.error)});d.close()};
    if(action==="add"){if(!name.trim())throw new Error("add 需要 name");if(find())throw new Error("同名或同别名地点已存在");const slug=name.trim().toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu,"-").replace(/^-|-$/g,"").slice(0,42)||"place";let lid="imported-place-"+slug;const ids=new Set(locs.map(x=>x.id));let n=2;while(ids.has(lid))lid="imported-place-"+slug+"-"+(n++);const loc={id:lid,name:name.trim(),aliases:(p.aliases||[]).map(String).filter(Boolean),description:p.description||"",atmosphere:p.atmosphere||"",layout:p.layout||"",props:(p.props||[]).map(String).filter(Boolean),visibility:p.visibility||"public",sourceRefs:[{sourceKey:"harness:"+lid,kind:"manual",importedAt:new Date().toISOString()}],fieldOrigins:{description:"ai",atmosphere:"ai",layout:"ai",props:"ai",aliases:"ai"}};if(p.category)loc.category=p.category;if(p.relation==="own-home"||p.relation==="shared-home")loc.visibility="private";locs.push(loc);s.locations=locs;s.updatedAt=new Date().toISOString();await save();return {ok:true,action,location:loc,requiresReload:${a.reload!==false}}}
    const loc=find();if(!loc)throw new Error("找不到地点");if(action==="delete"){s.locations=locs.filter(x=>x!==loc);s.updatedAt=new Date().toISOString();await save();return {ok:true,action,deleted:loc.id,requiresReload:${a.reload!==false}}}if(action==="update"){for(const k of ["aliases","description","atmosphere","layout","props","category","visibility"])if(p[k]!==undefined)loc[k]=p[k];s.updatedAt=new Date().toISOString();await save();return {ok:true,action,location:loc,requiresReload:${a.reload!==false}}}throw new Error("未知 action")})()`;
}

async function handleTool(name, args = {}) {
  if (name === "float_status") {
    return withBackend(
      async () => text(await appBridge.status()),
      async () => {
        const { target, httpUrl } = await getConnection();
        return text({ ok: true, mode: "cdp", httpUrl, target: { id: target.id, title: target.title, url: target.url } });
      },
    );
  }
  if (name === "float_app_setup") {
    if (args.confirm !== true) return text("启用 App harness 必须 confirm=true", true);
    return text(await appBridge.ensureSetup({ enable: true }));
  }
  if (name === "float_app_info") {
    return withBackend(
      async () => text(await appBridge.info()),
      async () => {
        const { target, httpUrl } = await getConnection();
        return text({ ok: true, mode: "cdp", httpUrl, target: { id: target.id, title: target.title, url: target.url } });
      },
    );
  }
  if (name === "float_fs") {
    if (["write", "mkdir", "delete"].includes(String(args.action)) && args.confirm !== true) {
      return text("写/删/建目录必须 confirm=true", true);
    }
    return text(await appBridge.fs(args));
  }
  if (name === "float_prefs") {
    if (["set", "delete"].includes(String(args.action)) && args.confirm !== true) {
      return text("写/删 SharedPreferences 必须 confirm=true", true);
    }
    return text(await appBridge.prefs(args));
  }
  if (name === "float_sqlite") {
    if (String(args.action) === "exec" && args.confirm !== true) {
      return text("sqlite exec 必须 confirm=true", true);
    }
    return text(await appBridge.sqlite(args));
  }
  if (name === "float_eval") {
    if (process.env.FLOAT_HARNESS_DENY_RAW_EVAL === "1") return text("raw eval 已禁用", true);
    return text(await evaluate(String(args.expression || "")));
  }
  if (name === "float_list_databases") {
    return text(await evaluate(`(async()=>{const out=[];for(const info of await indexedDB.databases()){if(!info.name)continue;const db=await new Promise((res,rej)=>{const r=indexedDB.open(info.name);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});out.push({name:info.name,version:db.version,stores:Array.from(db.objectStoreNames)});db.close()}return out})()`));
  }
  if (name === "float_read_kv") {
    return text(await evaluate(`(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open("AiPhoneKvDB");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const tx=db.transaction("entries","readonly");const os=tx.objectStore("entries");const key=${args.key===undefined?"undefined":JSON.stringify(String(args.key))};const prefix=${args.prefix===undefined?"undefined":JSON.stringify(String(args.prefix))};let rows;if(key!==undefined){const r=os.get(key);const v=await new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});rows=v?[v]:[]}else{const r=os.getAll();rows=await new Promise((res,rej)=>{r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)});if(prefix!==undefined)rows=rows.filter(x=>String(x.key).startsWith(prefix))}db.close();return {count:rows.length,rows:rows.slice(0,${Math.max(1,Math.min(2000,Number(args.limit)||100))})}})()`));
  }
  if (name === "float_write_kv") {
    if (args.confirm !== true) return text("写 KV 必须 confirm=true", true);
    const value = args.value === undefined ? "undefined" : JSON.stringify(String(args.value));
    return text(await evaluate(`(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open("AiPhoneKvDB");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const tx=db.transaction("entries","readwrite");const os=tx.objectStore("entries");const key=${JSON.stringify(String(args.key))};if(${args.remove===true})os.delete(key);else{const value=${value};if(value===undefined)throw new Error("write 需要 value");os.put({key,value})}await new Promise((res,rej)=>{tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);tx.onabort=()=>rej(tx.error)});db.close();return {ok:true,key,removed:${args.remove===true}}})()`));
  }
  if (name === "float_life_locations") {
    const write = args.action !== "list";
    if (write && args.confirm !== true) return text("写生活地点必须 confirm=true", true);
    const value = await evaluate(lifeLocationsExpr(args));
    if (write && args.reload !== false) setTimeout(() => { void getConnection().then(({ client }) => client.reload()).catch(() => undefined); }, 250);
    return text(value);
  }
  if (name === "float_life_diagnose") {
    return text(await evaluate(`(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open("AiPhoneKvDB");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const tx=db.transaction("entries","readonly");const r=tx.objectStore("entries").get(${JSON.stringify(LIFE_KEY)});const row=await new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});db.close();if(!row)return {exists:false};const s=JSON.parse(row.value);const locs=s.locations||[];const names=new Set(locs.flatMap(l=>[l.name,...(l.aliases||[])].map(x=>String(x||"").trim()).filter(Boolean)));const unmatched=[...new Set((s.schedules||[]).map(x=>x.plannedLocationName||x.locationName).filter(Boolean).filter(n=>!names.has(String(n).trim())))];return {locations:locs.length,aliases:locs.reduce((n,l)=>n+(l.aliases||[]).length,0),schedules:(s.schedules||[]).length,unmatchedLocationNames:unmatched,locationSamples:locs.slice(0,20).map(l=>({id:l.id,name:l.name,aliases:l.aliases||[],visibility:l.visibility}))}})()`));
  }
  if (name === "float_memory_entries") {
    const cid = JSON.stringify(String(args.characterId || ""));
    const type = JSON.stringify(String(args.type || "all"));
    const query = JSON.stringify(String(args.query || "").toLowerCase());
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
    return text(await evaluate(`(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open("ai_phone_memory_db_v1");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const rows=[];for(const name of Array.from(db.objectStoreNames)){if(!/memory|entry|entries/i.test(name))continue;const tx=db.transaction(name,"readonly");const r=tx.objectStore(name).getAll();const list=await new Promise((res,rej)=>{r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)});for(const v of list){if(!v||typeof v!=="object")continue;if(${cid}&&v.characterId!==${cid})continue;if(${type}!=="all"&&v.type!==${type})continue;if(${query}&&!String(v.content||"").toLowerCase().includes(${query}))continue;rows.push(v)}}db.close();return {count:rows.length,entries:rows.slice(-${limit}).map(v=>({id:v.id,characterId:v.characterId,type:v.type,sourceApp:v.sourceApp,content:String(v.content||"").slice(0,500),metadata:v.metadata}))}})()`));
  }
  if (name === "float_snapshot") {
    const include = args.includeKvValues === true;
    const max = Math.max(0, Number(args.maxKvValueChars) || 300);
    return text(await evaluate(`(async()=>{const dbs=[];for(const info of await indexedDB.databases()){if(!info.name)continue;const db=await new Promise((res,rej)=>{const r=indexedDB.open(info.name);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});dbs.push({name:info.name,version:db.version,stores:Array.from(db.objectStoreNames)});db.close()}const db=await new Promise((res,rej)=>{const r=indexedDB.open("AiPhoneKvDB");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const tx=db.transaction("entries","readonly");const r=tx.objectStore("entries").getAll();const rows=await new Promise((res,rej)=>{r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)});db.close();return {databases:dbs,kvCount:rows.length,kvKeys:rows.map(x=>x.key).sort(),kv:${include ? `rows.map(x=>({key:x.key,value:String(x.value).slice(0,${max})}))` : "undefined"},localStorage:${args.includeLocalStorage === false ? "undefined" : "Object.fromEntries(Object.entries(localStorage).map(([k,v])=>[k,String(v).slice(0,300)]))"}}})()`));
  }
  if (name === "float_screenshot") {
    return withBackend(
      async () => ({ content: [{ type: "image", data: await appBridge.screenshot(), mimeType: "image/png" }] }),
      async () => {
        const { client } = await getConnection();
        return { content: [{ type: "image", data: await client.screenshot(), mimeType: "image/png" }] };
      },
    );
  }
  if (name === "float_reload") {
    return text(await withBackend(
      async () => ({ ok: true, backend: "app", result: await appBridge.reload() }),
      async () => { const { client } = await getConnection(); await client.reload(); return { ok: true, backend: "cdp" }; },
    ));
  }
  if (name === "float_click") {
    const selector = JSON.stringify(String(args.selector || ""));
    return text(await evaluate(`(()=>{const el=document.querySelector(${selector});if(!el)throw new Error("找不到元素");el.click();return {ok:true,tag:el.tagName,text:(el.innerText||"").slice(0,120)}})()`));
  }
  if (name === "float_type") {
    const selector = JSON.stringify(String(args.selector || ""));
    const value = JSON.stringify(String(args.text || ""));
    return text(await evaluate(`(()=>{const el=document.querySelector(${selector});if(!el)throw new Error("找不到元素");const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,"value")?.set;if(setter)setter.call(el,${value});else el.value=${value};el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));${args.submit === true ? 'el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true}));' : ""}return {ok:true,tag:el.tagName,value:el.value.slice(0,120)}})()`));
  }
  return text(`未知工具：${name}`, true);
}

function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
const success = (id, result) => send({ jsonrpc: "2.0", id, result });
const failure = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async line => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!request || request.jsonrpc !== "2.0") return;
  const { id, method, params } = request;
  try {
    if (method === "initialize") return success(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "ping") return success(id, {});
    if (method === "tools/list") return success(id, { tools: TOOLS });
    if (method === "resources/list") return success(id, { resources: [] });
    if (method === "prompts/list") return success(id, { prompts: [] });
    if (method === "tools/call") {
      if (!params?.name) return failure(id, -32602, "缺少 tools/call name");
      try { return success(id, await handleTool(params.name, params.arguments || {})); }
      catch (error) { return success(id, text(error instanceof Error ? error.message : String(error), true)); }
    }
    return failure(id, -32601, `未实现的方法：${method}`);
  } catch (error) {
    return failure(id, -32603, error instanceof Error ? error.message : String(error));
  }
});
console.error(`[float-harness] ready; ${TOOLS.length} tools; mode=${MODE}; app=${PACKAGE}`);
