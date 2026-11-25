/** 内置「角色陪伴专注」的元信息（不含 HTML 本体）。
 *
 * 拆成两份是为了别把 ~1MB 的 HTML 拖进工具箱/指令这类只需要 manifest 的模块：
 * · 本文件：id / 名称 / 权限 / manifest（5 个角色工具、2 条富媒体指令、2 个 plusActions、1 个后台事件）
 * · focus-companion-source.ts：入口 HTML（只有桌面壳挂载时才会 import）
 *
 * manifest 与权限 1:1 来自市场 zip v1.9.4（custom-apps/focus-companion/manifest.json），
 * app id 保持不变——老用户装过市场版的话，数据（ai_phone_custom_app_data_v1:<id>/*）无缝延续。
 * 本文件由 scripts/build-focus-companion-dist.mjs 生成，不要手改 manifest 部分。
 */
import type { InstalledCustomApp } from "../custom-app-types";

export const FOCUS_COMPANION_APP_ID = "doris.focus.companion";
export const FOCUS_COMPANION_APP_NAME = "角色陪伴专注";
export const FOCUS_COMPANION_APP_VERSION = "1.10.1";
export const FOCUS_COMPANION_APP_DESCRIPTION = "带虚拟角色陪伴监督的专注工具：番茄专注 + 角色陪伴对话与壁纸 + AI 出题校验与错题本 + 可自定义惩罚锁定 + 睡眠计时与报告 + 心愿与连坐 + 奖励、账本与收藏夹。v1.9.3 把同类功能收成六个入口（计划与邀请 / 学习档案 / 激励中心 / 报告与趋势 / 奖励与账本 / 内容库），页顶标签切换，首页以「现在能做的那件事」开头。聊天室 + 号面板可发「专注邀约」（可预订时间段，到点前角色来催）与「睡眠陪伴」；角色也能主动调用工具或直接发卡约你。";

export const FOCUS_COMPANION_MANIFEST: InstalledCustomApp["manifest"] =
  {
  "id": "doris.focus.companion",
  "name": "角色陪伴专注",
  "version": "1.10.1",
  "sdkVersion": "1.0",
  "author": "doris",
  "description": "带虚拟角色陪伴监督的专注工具：番茄专注 + 角色陪伴对话与壁纸 + AI 出题校验与错题本 + 可自定义惩罚锁定 + 睡眠计时与报告 + 心愿与连坐 + 奖励、账本与收藏夹。v1.9.3 把同类功能收成六个入口（计划与邀请 / 学习档案 / 激励中心 / 报告与趋势 / 奖励与账本 / 内容库），页顶标签切换，首页以「现在能做的那件事」开头。聊天室 + 号面板可发「专注邀约」（可预订时间段，到点前角色来催）与「睡眠陪伴」；角色也能主动调用工具或直接发卡约你。",
  "icon": "icon.png",
  "entry": "index.html",
  "permissions": [
    "app.data.read",
    "app.data.write",
    "characters.read",
    "characters.state.read",
    "characters.state.write",
    "ai.generate",
    "ai.chat",
    "ai.generateImage",
    "voice.readProfiles",
    "voice.tts",
    "memory.write",
    "chat.read",
    "chat.read.background",
    "chat.write",
    "chat.sendCard",
    "chat.requestReply",
    "chat.tools",
    "notifications.read",
    "notifications.write",
    "tasks.schedule",
    "device.alarm.set",
    "wallet.read",
    "wallet.pay",
    "media.pick",
    "media.save",
    "calendar.read",
    "calendar.write",
    "user.profile.read",
    "ui.toast",
    "ui.notification",
    "device.assist",
    "device.dnd.set",
    "device.screenshot",
    "device.apps.list"
  ],
  "resources": {
    "presets": [
      "presets.json"
    ],
    "regexes": [],
    "worldBooks": [],
    "bindings": [],
    "tools": [],
    "voices": [],
    "assets": []
  },
  "primaryTags": [],
  "extensions": {
    "chat": {
      "directives": [
        {
          "id": "focus-sleep-invite",
          "label": "邀我一起睡",
          "syntax": "[陪睡:模式:分钟:想说的话]",
          "description": "当你想主动邀用户一起睡觉、午睡或小憩、陪他入睡时使用。模式填「小憩」「午睡」「长睡眠」之一；分钟填 0 表示不定时；最后一格写你想对他说的一句话。一次回复最多写一个。",
          "card": {
            "appLabel": "角色陪伴专注",
            "title": "想让你陪我一起睡",
            "subtitle": "一起睡 · {{模式}}",
            "status": "等你躺下",
            "accentColor": "#a58bff",
            "sections": [
              {
                "title": "邀请",
                "rows": [
                  {
                    "label": "一起",
                    "value": "{{模式}} · {{分钟}} 分钟"
                  },
                  {
                    "label": "想对你说",
                    "value": "{{想说的话}}"
                  }
                ]
              }
            ],
            "actions": [
              {
                "label": "去陪他"
              }
            ]
          },
          "tags": []
        },
        {
          "id": "focus-appt-invite",
          "label": "跟我约一段专注",
          "syntax": "[约专注:时间:事项:分钟]",
          "description": "当你想跟用户约一个具体的专注时间、到点督促他开始学习时使用。时间填 HH:MM（例如 21:00）；事项写这次要做什么；分钟填这段专注的时长。一次回复最多写一个。",
          "card": {
            "appLabel": "角色陪伴专注",
            "title": "约一个专注时间",
            "subtitle": "约专注 · {{时间}}",
            "status": "等你答应",
            "accentColor": "#7c8cff",
            "sections": [
              {
                "title": "约定",
                "rows": [
                  {
                    "label": "时间",
                    "value": "{{时间}}"
                  },
                  {
                    "label": "做什么",
                    "value": "{{事项}}"
                  },
                  {
                    "label": "多久",
                    "value": "{{分钟}} 分钟"
                  }
                ]
              }
            ],
            "actions": [
              {
                "label": "答应他"
              }
            ]
          },
          "tags": []
        }
      ],
      "plusActions": [
        {
          "id": "focus-invite",
          "label": "专注邀约",
          "description": "打开专注邀约页：可以请角色现在陪你专注，也可以预订一个时间段（到点前角色会来催你准备，连着催 3 次还没点开始就按惩罚库开罚）。会带上当前对话的角色。",
          "entry": "focus-invite",
          "presentation": "app",
          "tags": []
        },
        {
          "id": "sleep-companion",
          "label": "睡眠陪伴",
          "description": "打开睡眠陪伴页：邀请当前对话的角色陪你一起睡（小憩 / 午睡 / 长睡眠），邀请会写进聊天室并由他应你一声。",
          "entry": "sleep-companion",
          "presentation": "app",
          "tags": []
        }
      ],
      "tools": [
        {
          "id": "focus-stats",
          "name": "查我的专注情况",
          "description": "查询用户最近的专注记录：今日/本周专注分钟数、次数、考核通过率、最有效率的时段、违规次数、连续打卡与当前专注币。用户问你「我这两天学得怎么样」「我最近专注多少」时调用。",
          "parameterSchema": {
            "type": "object",
            "properties": {
              "range": {
                "type": "string",
                "description": "统计范围：today（今天）/ week（本周，默认）/ all（全部）"
              }
            }
          },
          "visibility": "shared",
          "handler": "focusStats"
        },
        {
          "id": "sleep-last",
          "name": "看昨晚睡得怎么样",
          "description": "读取用户最近一次睡眠记录：总时长、酝酿睡意、实际入睡、中途醒来次数与质量结论。用户问「我昨晚睡得怎么样」「睡够了没」时调用。",
          "parameterSchema": {
            "type": "object",
            "properties": {
              "count": {
                "type": "number",
                "description": "要读几条最近记录，默认 1，最多 7"
              }
            }
          },
          "visibility": "shared",
          "handler": "sleepLast"
        },
        {
          "id": "add-todo",
          "name": "帮我记一条待办",
          "description": "把一件事记进用户的专注待办清单（会显示在 APP 首页，开始专注时可以直接选用）。用户说「帮我记一下」「明天要做…」时调用。",
          "parameterSchema": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string",
                "description": "待办内容，尽量具体"
              },
              "note": {
                "type": "string",
                "description": "可选备注，例如什么时候做、为什么"
              },
              "minutes": {
                "type": "number",
                "description": "可选，预估需要多少分钟"
              }
            },
            "required": [
              "text"
            ]
          },
          "visibility": "shared",
          "handler": "addTodo"
        },
        {
          "id": "make-appt",
          "name": "跟我约一段专注",
          "description": "和用户约定一个具体的专注时间（日期+时间+事项+时长）。到点前会提前提醒他准备开始，每 5 分钟催一次、共 3 次，连着催三次他还没开始就按规矩处罚。用户说「你盯我学习」「几点陪我学」时调用。",
          "parameterSchema": {
            "type": "object",
            "properties": {
              "date": {
                "type": "string",
                "description": "日期 YYYY-MM-DD，不填按今天"
              },
              "time": {
                "type": "string",
                "description": "开始时间 HH:MM，必填"
              },
              "task": {
                "type": "string",
                "description": "这段专注要做什么"
              },
              "minutes": {
                "type": "number",
                "description": "专注时长（分钟），默认 25"
              }
            },
            "required": [
              "time",
              "task"
            ]
          },
          "visibility": "shared",
          "handler": "makeAppt"
        },
        {
          "id": "invite-sleep",
          "name": "邀我一起睡",
          "description": "主动邀请用户一起睡（小憩/午睡/长睡眠）。会写进 APP 的邀请记录并给他发一条通知；他打开 APP 就能一键躺下，你会说一句哄他入睡的话。",
          "parameterSchema": {
            "type": "object",
            "properties": {
              "mode": {
                "type": "string",
                "description": "小憩 / 午睡 / 长睡眠，默认午睡"
              },
              "minutes": {
                "type": "number",
                "description": "计划睡多久（分钟），0 表示不定时"
              },
              "note": {
                "type": "string",
                "description": "你想对他说的一句话"
              }
            }
          },
          "visibility": "shared",
          "handler": "inviteSleep"
        },
        {
          "id": "focus-unlock",
          "name": "解除看守锁",
          "description": "当用户明确要求关掉专注/看守锁、他被锁得没法用手机，或继续锁下去会伤害他时调用。会结束当前专注并立即解除看守锁、恢复勿扰，历史记录保留；不要因为用户只是抱怨累就擅自解锁。",
          "parameterSchema": {
            "type": "object",
            "properties": {
              "reason": {
                "type": "string",
                "description": "为什么现在要解除，例如身体不舒服、紧急用机"
              }
            }
          },
          "visibility": "shared",
          "handler": "focusUnlock"
        },
        {
          "id": "pass-verdict",
          "name": "判定通行证查岗",
          "description": "当角色收到白名单通行证查岗的屏幕截图后调用：判断用户是在学习/查资料还是在玩。合规传 verdict=pass；违规、用户拒绝给看或超时未交传 verdict=violation。app 传通行证对应的应用名（如 DeepSeek）。会立即更新通行证状态和信任分：pass +2，violation 收回通行证并 -10。",
          "parameterSchema": {
            "type": "object",
            "properties": {
              "app": {
                "type": "string",
                "description": "通行证对应的应用名，例如 DeepSeek"
              },
              "verdict": {
                "type": "string",
                "enum": [
                  "pass",
                  "violation"
                ],
                "description": "pass=合规；violation=违规或没交自证"
              },
              "reason": {
                "type": "string",
                "description": "一句判断理由，会写进 timeline"
              }
            },
            "required": [
              "verdict"
            ]
          },
          "visibility": "shared",
          "handler": "passVerdict"
        }
      ]
    },
    "tools": [
      {
        "id": "focus-stats",
        "name": "查我的专注情况",
        "description": "查询用户最近的专注记录：今日/本周专注分钟数、次数、考核通过率、最有效率的时段、违规次数、连续打卡与当前专注币。用户问你「我这两天学得怎么样」「我最近专注多少」时调用。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "range": {
              "type": "string",
              "description": "统计范围：today（今天）/ week（本周，默认）/ all（全部）"
            }
          }
        },
        "visibility": "shared",
        "handler": "focusStats"
      },
      {
        "id": "sleep-last",
        "name": "看昨晚睡得怎么样",
        "description": "读取用户最近一次睡眠记录：总时长、酝酿睡意、实际入睡、中途醒来次数与质量结论。用户问「我昨晚睡得怎么样」「睡够了没」时调用。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "count": {
              "type": "number",
              "description": "要读几条最近记录，默认 1，最多 7"
            }
          }
        },
        "visibility": "shared",
        "handler": "sleepLast"
      },
      {
        "id": "add-todo",
        "name": "帮我记一条待办",
        "description": "把一件事记进用户的专注待办清单（会显示在 APP 首页，开始专注时可以直接选用）。用户说「帮我记一下」「明天要做…」时调用。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string",
              "description": "待办内容，尽量具体"
            },
            "note": {
              "type": "string",
              "description": "可选备注，例如什么时候做、为什么"
            },
            "minutes": {
              "type": "number",
              "description": "可选，预估需要多少分钟"
            }
          },
          "required": [
            "text"
          ]
        },
        "visibility": "shared",
        "handler": "addTodo"
      },
      {
        "id": "make-appt",
        "name": "跟我约一段专注",
        "description": "和用户约定一个具体的专注时间（日期+时间+事项+时长）。到点前会提前提醒他准备开始，每 5 分钟催一次、共 3 次，连着催三次他还没开始就按规矩处罚。用户说「你盯我学习」「几点陪我学」时调用。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "date": {
              "type": "string",
              "description": "日期 YYYY-MM-DD，不填按今天"
            },
            "time": {
              "type": "string",
              "description": "开始时间 HH:MM，必填"
            },
            "task": {
              "type": "string",
              "description": "这段专注要做什么"
            },
            "minutes": {
              "type": "number",
              "description": "专注时长（分钟），默认 25"
            }
          },
          "required": [
            "time",
            "task"
          ]
        },
        "visibility": "shared",
        "handler": "makeAppt"
      },
      {
        "id": "invite-sleep",
        "name": "邀我一起睡",
        "description": "主动邀请用户一起睡（小憩/午睡/长睡眠）。会写进 APP 的邀请记录并给他发一条通知；他打开 APP 就能一键躺下，你会说一句哄他入睡的话。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "description": "小憩 / 午睡 / 长睡眠，默认午睡"
            },
            "minutes": {
              "type": "number",
              "description": "计划睡多久（分钟），0 表示不定时"
            },
            "note": {
              "type": "string",
              "description": "你想对他说的一句话"
            }
          }
        },
        "visibility": "shared",
        "handler": "inviteSleep"
      },
      {
        "id": "focus-unlock",
        "name": "解除看守锁",
        "description": "当用户明确要求关掉专注/看守锁、他被锁得没法用手机，或继续锁下去会伤害他时调用。会结束当前专注并立即解除看守锁、恢复勿扰，历史记录保留；不要因为用户只是抱怨累就擅自解锁。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "reason": {
              "type": "string",
              "description": "为什么现在要解除，例如身体不舒服、紧急用机"
            }
          }
        },
        "visibility": "shared",
        "handler": "focusUnlock"
      },
      {
        "id": "pass-verdict",
        "name": "判定通行证查岗",
        "description": "当角色收到白名单通行证查岗的屏幕截图后调用：判断用户是在学习/查资料还是在玩。合规传 verdict=pass；违规、用户拒绝给看或超时未交传 verdict=violation。app 传通行证对应的应用名（如 DeepSeek）。会立即更新通行证状态和信任分：pass +2，violation 收回通行证并 -10。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "app": {
              "type": "string",
              "description": "通行证对应的应用名，例如 DeepSeek"
            },
            "verdict": {
              "type": "string",
              "enum": [
                "pass",
                "violation"
              ],
              "description": "pass=合规；violation=违规或没交自证"
            },
            "reason": {
              "type": "string",
              "description": "一句判断理由，会写进 timeline"
            }
          },
          "required": [
            "verdict"
          ]
        },
        "visibility": "shared",
        "handler": "passVerdict"
      }
    ],
    "events": [
      {
        "event": "chat.message.created",
        "entry": "chat-directives",
        "background": true,
        "description": "监听聊天新消息：解析角色主动发出的 [陪睡:…] / [约专注:…]，写进 APP 的邀请记录并发通知。"
      }
    ]
  },
  "events": [
    {
      "event": "chat.message.created",
      "entry": "chat-directives",
      "background": true,
      "description": "监听聊天新消息：解析角色主动发出的 [陪睡:…] / [约专注:…]，写进 APP 的邀请记录并发通知。"
    }
  ],
  "chatDirectives": [
    {
      "id": "focus-sleep-invite",
      "label": "邀我一起睡",
      "syntax": "[陪睡:模式:分钟:想说的话]",
      "description": "当你想主动邀用户一起睡觉、午睡或小憩、陪他入睡时使用。模式填「小憩」「午睡」「长睡眠」之一；分钟填 0 表示不定时；最后一格写你想对他说的一句话。一次回复最多写一个。",
      "card": {
        "appLabel": "角色陪伴专注",
        "title": "想让你陪我一起睡",
        "subtitle": "一起睡 · {{模式}}",
        "status": "等你躺下",
        "accentColor": "#a58bff",
        "sections": [
          {
            "title": "邀请",
            "rows": [
              {
                "label": "一起",
                "value": "{{模式}} · {{分钟}} 分钟"
              },
              {
                "label": "想对你说",
                "value": "{{想说的话}}"
              }
            ]
          }
        ],
        "actions": [
          {
            "label": "去陪他"
          }
        ]
      },
      "tags": []
    },
    {
      "id": "focus-appt-invite",
      "label": "跟我约一段专注",
      "syntax": "[约专注:时间:事项:分钟]",
      "description": "当你想跟用户约一个具体的专注时间、到点督促他开始学习时使用。时间填 HH:MM（例如 21:00）；事项写这次要做什么；分钟填这段专注的时长。一次回复最多写一个。",
      "card": {
        "appLabel": "角色陪伴专注",
        "title": "约一个专注时间",
        "subtitle": "约专注 · {{时间}}",
        "status": "等你答应",
        "accentColor": "#7c8cff",
        "sections": [
          {
            "title": "约定",
            "rows": [
              {
                "label": "时间",
                "value": "{{时间}}"
              },
              {
                "label": "做什么",
                "value": "{{事项}}"
              },
              {
                "label": "多久",
                "value": "{{分钟}} 分钟"
              }
            ]
          }
        ],
        "actions": [
          {
            "label": "答应他"
          }
        ]
      },
      "tags": []
    }
  ],
  "chatPlusActions": [
    {
      "id": "focus-invite",
      "label": "专注邀约",
      "description": "打开专注邀约页：可以请角色现在陪你专注，也可以预订一个时间段（到点前角色会来催你准备，连着催 3 次还没点开始就按惩罚库开罚）。会带上当前对话的角色。",
      "entry": "focus-invite",
      "presentation": "app",
      "tags": []
    },
    {
      "id": "sleep-companion",
      "label": "睡眠陪伴",
      "description": "打开睡眠陪伴页：邀请当前对话的角色陪你一起睡（小憩 / 午睡 / 长睡眠），邀请会写进聊天室并由他应你一声。",
      "entry": "sleep-companion",
      "presentation": "app",
      "tags": []
    }
  ],
  "chatExtensions": {
    "directives": [
      {
        "id": "focus-sleep-invite",
        "label": "邀我一起睡",
        "syntax": "[陪睡:模式:分钟:想说的话]",
        "description": "当你想主动邀用户一起睡觉、午睡或小憩、陪他入睡时使用。模式填「小憩」「午睡」「长睡眠」之一；分钟填 0 表示不定时；最后一格写你想对他说的一句话。一次回复最多写一个。",
        "card": {
          "appLabel": "角色陪伴专注",
          "title": "想让你陪我一起睡",
          "subtitle": "一起睡 · {{模式}}",
          "status": "等你躺下",
          "accentColor": "#a58bff",
          "sections": [
            {
              "title": "邀请",
              "rows": [
                {
                  "label": "一起",
                  "value": "{{模式}} · {{分钟}} 分钟"
                },
                {
                  "label": "想对你说",
                  "value": "{{想说的话}}"
                }
              ]
            }
          ],
          "actions": [
            {
              "label": "去陪他"
            }
          ]
        },
        "tags": []
      },
      {
        "id": "focus-appt-invite",
        "label": "跟我约一段专注",
        "syntax": "[约专注:时间:事项:分钟]",
        "description": "当你想跟用户约一个具体的专注时间、到点督促他开始学习时使用。时间填 HH:MM（例如 21:00）；事项写这次要做什么；分钟填这段专注的时长。一次回复最多写一个。",
        "card": {
          "appLabel": "角色陪伴专注",
          "title": "约一个专注时间",
          "subtitle": "约专注 · {{时间}}",
          "status": "等你答应",
          "accentColor": "#7c8cff",
          "sections": [
            {
              "title": "约定",
              "rows": [
                {
                  "label": "时间",
                  "value": "{{时间}}"
                },
                {
                  "label": "做什么",
                  "value": "{{事项}}"
                },
                {
                  "label": "多久",
                  "value": "{{分钟}} 分钟"
                }
              ]
            }
          ],
          "actions": [
            {
              "label": "答应他"
            }
          ]
        },
        "tags": []
      }
    ],
    "plusActions": [
      {
        "id": "focus-invite",
        "label": "专注邀约",
        "description": "打开专注邀约页：可以请角色现在陪你专注，也可以预订一个时间段（到点前角色会来催你准备，连着催 3 次还没点开始就按惩罚库开罚）。会带上当前对话的角色。",
        "entry": "focus-invite",
        "presentation": "app",
        "tags": []
      },
      {
        "id": "sleep-companion",
        "label": "睡眠陪伴",
        "description": "打开睡眠陪伴页：邀请当前对话的角色陪你一起睡（小憩 / 午睡 / 长睡眠），邀请会写进聊天室并由他应你一声。",
        "entry": "sleep-companion",
        "presentation": "app",
        "tags": []
      }
    ],
    "tools": [
      {
        "id": "focus-stats",
        "name": "查我的专注情况",
        "description": "查询用户最近的专注记录：今日/本周专注分钟数、次数、考核通过率、最有效率的时段、违规次数、连续打卡与当前专注币。用户问你「我这两天学得怎么样」「我最近专注多少」时调用。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "range": {
              "type": "string",
              "description": "统计范围：today（今天）/ week（本周，默认）/ all（全部）"
            }
          }
        },
        "visibility": "shared",
        "handler": "focusStats"
      },
      {
        "id": "sleep-last",
        "name": "看昨晚睡得怎么样",
        "description": "读取用户最近一次睡眠记录：总时长、酝酿睡意、实际入睡、中途醒来次数与质量结论。用户问「我昨晚睡得怎么样」「睡够了没」时调用。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "count": {
              "type": "number",
              "description": "要读几条最近记录，默认 1，最多 7"
            }
          }
        },
        "visibility": "shared",
        "handler": "sleepLast"
      },
      {
        "id": "add-todo",
        "name": "帮我记一条待办",
        "description": "把一件事记进用户的专注待办清单（会显示在 APP 首页，开始专注时可以直接选用）。用户说「帮我记一下」「明天要做…」时调用。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string",
              "description": "待办内容，尽量具体"
            },
            "note": {
              "type": "string",
              "description": "可选备注，例如什么时候做、为什么"
            },
            "minutes": {
              "type": "number",
              "description": "可选，预估需要多少分钟"
            }
          },
          "required": [
            "text"
          ]
        },
        "visibility": "shared",
        "handler": "addTodo"
      },
      {
        "id": "make-appt",
        "name": "跟我约一段专注",
        "description": "和用户约定一个具体的专注时间（日期+时间+事项+时长）。到点前会提前提醒他准备开始，每 5 分钟催一次、共 3 次，连着催三次他还没开始就按规矩处罚。用户说「你盯我学习」「几点陪我学」时调用。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "date": {
              "type": "string",
              "description": "日期 YYYY-MM-DD，不填按今天"
            },
            "time": {
              "type": "string",
              "description": "开始时间 HH:MM，必填"
            },
            "task": {
              "type": "string",
              "description": "这段专注要做什么"
            },
            "minutes": {
              "type": "number",
              "description": "专注时长（分钟），默认 25"
            }
          },
          "required": [
            "time",
            "task"
          ]
        },
        "visibility": "shared",
        "handler": "makeAppt"
      },
      {
        "id": "invite-sleep",
        "name": "邀我一起睡",
        "description": "主动邀请用户一起睡（小憩/午睡/长睡眠）。会写进 APP 的邀请记录并给他发一条通知；他打开 APP 就能一键躺下，你会说一句哄他入睡的话。",
        "parameterSchema": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "description": "小憩 / 午睡 / 长睡眠，默认午睡"
            },
            "minutes": {
              "type": "number",
              "description": "计划睡多久（分钟），0 表示不定时"
            },
            "note": {
              "type": "string",
              "description": "你想对他说的一句话"
            }
          }
        },
        "visibility": "shared",
        "handler": "inviteSleep"
      }
    ]
  }
} as InstalledCustomApp["manifest"];

/** zip 包里声明了 icon.png 但没随包提供，桌面图标走 desktop-config 的内置图标。 */
export function buildFocusCompanionApp(entryHtml: string): InstalledCustomApp {
  return {
    id: FOCUS_COMPANION_APP_ID,
    name: FOCUS_COMPANION_APP_NAME,
    version: FOCUS_COMPANION_APP_VERSION,
    author: "doris",
    description: FOCUS_COMPANION_APP_DESCRIPTION,
    entryHtml,
    permissions: (FOCUS_COMPANION_MANIFEST.permissions ?? []) as InstalledCustomApp["permissions"],
    manifest: FOCUS_COMPANION_MANIFEST,
    assets: {},
    installedAt: "2026-11-21T00:00:00.000Z",
    updatedAt: "2026-11-21T00:00:00.000Z",
  };
}
