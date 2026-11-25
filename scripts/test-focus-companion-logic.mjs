#!/usr/bin/env node
/* doris.focus.companion 新功能链路 · 逻辑层冒烟测试
 * 从 index.html 主脚本按名抽取函数，在 vm 沙箱里配桩跑断言矩阵。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// 用法: node scripts/test-focus-companion-logic.mjs [repoRoot=过程根目录]
// 验证内置「角色陪伴专注」新功能链路的纯逻辑：壁纸闸门/审批解析/通行证回收/查岗调度/闹钟兜底/催促节奏。
import { fileURLToPath } from 'node:url';
const ROOT = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'custom-apps/focus-companion/index.html'), 'utf8');
const main = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g).map(s => s.replace(/<\/?script[^>]*>/g, '')).sort((a, b) => b.length - a.length)[0];

function extractFn(name) {
  const key = name.includes('(') ? name : ('function ' + name + '(');
  let i = main.indexOf(key);
  if (i < 0) {
    const ck = 'const ' + name + ' = ';
    const ci = main.indexOf(ck);
    if (ci < 0) throw new Error('找不到函数: ' + name);
    const semi = main.indexOf(';', ci);
    return main.slice(ci, semi + 1);
  }
  if (i >= 6 && main.slice(i - 6, i) === 'async ') i -= 6;
  let d = main.indexOf('{', i), depth = 0, j = d;
  for (; j < main.length; j++) {
    if (main[j] === '{') depth++;
    else if (main[j] === '}') { depth--; if (!depth) break; }
  }
  return main.slice(i, j + 1);
}

const FN = ['cfg', 'sdk', 'pad2', 'fmtDur', 'canGenWall', 'wallMode', 'wlParseVerdict',
  'activeWlPasses', 'wlTrust', 'wlTrustAdd', 'scheduleWlCheckin', 'cancelWlCheckinNative',
  'scheduleAlarm', 'scheduleMorning', 'bookSystemAlarm', 'bookSystemAlarmForAppt',
  'apptTimesOf', 'apptAdvance', 'apptGap', 'apptMaxNudge', 'sessionEndAt'];
const src = FN.map(extractFn).join('\n\n');

const TASKS = [], ALARMS = [], DBU = [], TL = [], TOASTS = [];
let SETTINGS_SAVED = 0;
const sandbox = {
  T: { WLP: 'wl_passes', ALARM: 'alarms', SESSION: 'sessions' },
  clamp: (n, a, b) => Math.max(a, Math.min(b, n)),
  S: { settings: {}, wlPasses: [], session: null, chars: [{ id: 'c1', name: '小满' }] },
  API: {
    tasks: { schedule: async o => { TASKS.push(o); return { ok: true }; } },
    device: { alarmSet: async o => { ALARMS.push(o); return { ok: true }; }, dndSet: async o => ({ ok: true, on: o.on }), notify: async o => ({ ok: true }) }
  },
  DB: { update: async (t, id, d) => { DBU.push([t, id, d]); return { id }; }, list: async () => [], create: async () => ({ id: 'new1' }) },
  saveSettings: async () => { SETTINGS_SAVED++; return true; },
  syncTimeline: async (cid, txt, kind) => { TL.push([cid, String(txt).slice(0, 60), kind]); },
  charById: id => sandbox.S.chars.find(c => c.id === id) || null,
  anyCharId: () => 'c1',
  charName: id => { const c = sandbox.S.chars.find(x => x.id === id); return c ? c.name : '角色'; },
  pickOneChar: ids => (ids && ids[0]) || 'c1',
  toast: t => TOASTS.push(String(t)),
  render: () => {}, openSheet: () => {}, closeSheet: () => {}, notify: () => {},
  console, Date, JSON, Math, Promise, setTimeout, clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'extracted.js' });

let pass = 0, fail = 0;
function T(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  → ' + detail : '')); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
const run = code => vm.runInContext(code, sandbox);

console.log('== 1. 壁纸生图闸门 canGenWall / wallMode ==');
run(`S.settings = { wallGenOff: false, customWallUse: false, wallGenWithCustom: false }`);
T('无自定义壁纸 + 生成开 → 允许生图', run(`canGenWall()`) === true);
run(`S.settings.wallGenOff = true`);
T('总开关关 → 不生图', run(`canGenWall()`) === false, 'wallMode=' + run(`wallMode()`));
run(`S.settings = { wallGenOff: false, customWallUse: true, wallGenWithCustom: false }`);
T('用自定义壁纸（默认） → 暂停生图', run(`canGenWall()`) === false, 'wallMode=' + run(`wallMode()`));
run(`S.settings.wallGenWithCustom = true`);
T('AI+我的壁纸 → 允许生图', run(`canGenWall()`) === true, 'wallMode=' + run(`wallMode()`));

console.log('== 2. 白名单审批解析 wlParseVerdict ==');
T('纯 JSON', (() => { const v = run(`wlParseVerdict(JSON.stringify({decision:'approve',grantedMinutes:15,conditions:'',reply:'准了'}))`); return v && v.decision === 'approve' && v.grantedMinutes === 15; })());
T('带 ```json 围栏', (() => { const v = run("wlParseVerdict('```json\\n{\"decision\":\"counter\",\"grantedMinutes\":10}\\n```')"); return v && v.decision === 'counter'; })());
T('带前缀废话', (() => { const v = run(`wlParseVerdict('我的批复如下：{"decision":"reject","grantedMinutes":0,"reply":"不行"}')`); return v && v.decision === 'reject'; })());
T('无效输出 → null', run(`wlParseVerdict('我觉得可以吧')`) === null);

console.log('== 3. 通行证到期回收 activeWlPasses ==');
run(`S.settings.wlTrust = 0; S.wlPasses = [
  { id:'p1', dbId:'db_p1', app:'欧路词典', status:'active', expireAt: Date.now() - 1000, uses: 0 },
  { id:'p2', dbId:'db_p2', app:'地图', status:'active', expireAt: Date.now() + 600000, uses: 1 }
]`);
(async () => {
const act = run(`activeWlPasses()`);
await new Promise(r => setTimeout(r, 40));
T('过期通行证被回收', act.length === 1 && act[0].id === 'p2');
T('到期状态写库', DBU.length === 1 && DBU[0][1] === 'db_p1', DBU.length ? ('DB.update → ' + DBU[0][1]) : 'DBU空');
T('按时回收信任分 +5', sandbox.S.settings.wlTrust === 5);
T('回收留痕进时间线', TL.some(x => x[2] === 'wl_trust' && /欧路词典/.test(x[1])));

console.log('== 4. 查岗随机调度 scheduleWlCheckin ==');
TASKS.length = 0;
await run(`S.settings.wlCheckin = null; scheduleWlCheckin(S.wlPasses[1])`);
await new Promise(r => setTimeout(r, 40));
const chk = sandbox.S.settings.wlCheckin;
T('生成查岗计划（10 分钟时限）', chk && chk.passId === 'p2' && chk.deadlineAt - chk.at === 10 * 60000 && chk.deadlineAt - chk.at === 10 * 60000);
T('宿主任务已排（focus_wlchk_*）', TASKS.some(t => String(t.id).startsWith('focus_wlchk_')));
const chkTask = TASKS.find(t => String(t.id).startsWith('focus_wlchk_'));
T('查岗通知走系统通知栏（shell.notify）', chkTask && chkTask.actions.some(a => a.type === 'shell.notify'));
T('查岗时刻落在通行证窗口内', chkTask && chkTask.delayMs >= 60000 && (Date.now() + chkTask.delayMs) <= sandbox.S.wlPasses[1].expireAt);
run(`S.settings.wlCheckin = null; scheduleWlCheckin({ id:'x', status:'rejected' })`);
T('非 active 通行证不排查岗', !sandbox.S.settings.wlCheckin);

console.log('== 5. 系统闹钟兜底 scheduleAlarm / scheduleMorning ==');
ALARMS.length = 0; TASKS.length = 0;
run(`scheduleAlarm({ time: '07:30', charId: 'c1' })`).then(() => {}).catch(() => {});

  TASKS.length = 0; ALARMS.length = 0;
  await run(`scheduleAlarm({ time: '07:30', charId: 'c1' })`);
  await new Promise(r => setTimeout(r, 30));
  T('语音闹钟保存 → 立系统时钟闹钟 07:30', ALARMS.some(a => a.hour === 7 && a.minute === 30 && /叫你起床/.test(a.message)), JSON.stringify(ALARMS));
  const at = TASKS.find(t => String(t.id).startsWith('focus_alarm_'));
  T('叫早任务带 shell.notify（页面死了也能收）', at && at.actions.some(a => a.type === 'shell.notify'));
  TASKS.length = 0; ALARMS.length = 0;
  await run(`scheduleAlarm({ time: '08:00' }, true)`);
  T('boot 重排静默 → 不重复立系统闹钟', ALARMS.length === 0, 'ALARMS=' + JSON.stringify(ALARMS));
  ALARMS.length = 0; TASKS.length = 0;
  await run(`scheduleMorning({ time: '06:50', charId: 'c1', enabled: true })`);
  await new Promise(r => setTimeout(r, 30));
  T('晨间闭环 → 立系统闹钟 06:50', ALARMS.some(a => a.hour === 6 && a.minute === 50 && /晨间/.test(a.message)), JSON.stringify(ALARMS));
  const mt = TASKS.find(t => String(t.id) === 'focus_morning');
  T('晨间任务带 shell.notify', mt && mt.actions.some(a => a.type === 'shell.notify'));
  TASKS.length = 0; ALARMS.length = 0;
  await run(`scheduleMorning({ time: '06:50' }, true)`);
  T('晨间 boot 重排静默', ALARMS.length === 0);

  console.log('== 6. 预约催促节奏 apptTimesOf ==');
  run(`S.settings.apptAdvanceMin = 10; S.settings.apptGapMin = 5; S.settings.apptMaxNudge = 3;`);
  const times = run(`apptTimesOf({ startAt: 1000000 })`);
  T('默认 T-10 / T-5 / T-0 三次催促', times.length === 3 && times[2] === 1000000 && times[1] === 1000000 - 5 * 60000 && times[0] === 1000000 - 10 * 60000, JSON.stringify(times.map(t => (1000000 - t) / 60000)));

  console.log('== 7. 通行证签发 → 查岗联动（bookSystemAlarmForAppt 回归） ==');
  ALARMS.length = 0;
  await run(`bookSystemAlarmForAppt({ startAt: new Date('2026-11-21T07:30:00').getTime(), task: '背单词' })`);
  T('预约仍保留系统闹钟兜底（M2a 回归）', ALARMS.length === 1 && ALARMS[0].hour === 7 && /TA约你/.test(ALARMS[0].message), JSON.stringify(ALARMS[0]));

  console.log('== 8. 看守锁截止时间 ==');
  const lockEnd = run(`sessionEndAt({ startAt: 1000000, cycles: 2, focusMin: 25, breakMin: 5, phaseEndsAt: 1000000 + 25 * 60000, cycle: 1 })`);
  T('2 轮专注的截止 = 开始 + 2×25 分钟 + 1×5 分钟休息', lockEnd === 1000000 + 55 * 60000, String(lockEnd));
  const pausedEnd = run(`sessionEndAt({ startAt: 1000000, cycles: 2, focusMin: 25, breakMin: 5, phaseEndsAt: 1000000 + 40 * 60000, cycle: 2 })`);
  T('暂停顺延后至少覆盖当前阶段', pausedEnd >= 1000000 + 40 * 60000, String(pausedEnd));

  console.log('\\n结果: PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})();
