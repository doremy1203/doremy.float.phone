import type { InstalledCustomApp } from "../custom-app-types";

/**
 * 内置「心意手作工坊」的元信息（不含 HTML 本体）。
 *
 * 拆成两份是为了别把 600KB 的 HTML 拖进工具箱/指令这类只需要 manifest 的模块：
 * · 本文件：id / 名称 / 权限 / manifest（工具声明、富媒体指令、事件）
 * · heartcraft-source.ts：入口 HTML（只有桌面壳挂载时才会 import）
 */
export const HEARTCRAFT_APP_ID = "heartcraft.doris";
export const HEARTCRAFT_APP_NAME = "心意手作工坊";
export const HEARTCRAFT_APP_VERSION = "1.3.1";
export const HEARTCRAFT_APP_DESCRIPTION = "虚拟手作礼物工坊：双向手作、捣蛋互动、时间线存档、对比视图、礼物快照与徽章颁奖收藏。角色可以主动调用工具箱里的手作工具。";

export const HEARTCRAFT_MANIFEST: InstalledCustomApp["manifest"] = {
  "id": "heartcraft.doris",
  "name": "心意手作工坊",
  "version": "1.3.1",
  "sdkVersion": "1.0",
  "author": "doris",
  "description": "虚拟手作礼物工坊：双向手作、捣蛋互动、时间线存档、对比视图、礼物快照与徽章颁奖收藏。角色可以主动调用工具箱里的手作工具。",
  "icon": "icon.png",
  "entry": "index.html",
  "permissions": [
    "app.data.read",
    "app.data.write",
    "app.assets.read",
    "app.manifest.read",
    "characters.read",
    "characters.state.read",
    "characters.state.write",
    "characters.relations.read",
    "user.profile.read",
    "user.persona.read",
    "user.preferences.read",
    "memory.readCore",
    "memory.readLongTerm",
    "memory.readShortTerm",
    "memory.search",
    "memory.write",
    "memory.suggest",
    "ai.generate",
    "ai.chat",
    "ai.embed",
    "ai.classify",
    "ai.generateImage",
    "chat.read",
    "chat.read.background",
    "chat.write",
    "chat.sendMessage",
    "chat.sendCard",
    "chat.requestReply",
    "chat.contacts.write",
    "chat.tools",
    "voice.readProfiles",
    "voice.tts",
    "voice.stt",
    "voice.clone",
    "media.pick",
    "media.save",
    "media.download",
    "notifications.read",
    "notifications.write",
    "tasks.schedule",
    "calendar.read",
    "calendar.write",
    "world.read",
    "ui.toast",
    "ui.notification"
  ],
  "extensions": {
    "chat": {
      "directives": [
        {
          "id": "heartcraft-start",
          "label": "开始手作",
          "syntax": "[开始手作:礼物名:品类:总时长分钟]",
          "description": "只有在你【当场决定】要亲手给用户做一件具体的小东西、并且马上就要开工时，才使用这条指令。它会在聊天里发一张「已开工」的卡片，并让工坊真的开始计时、画图——用错一次，用户那边就会凭空多出一件手作。\n必须同时满足：① 是你自己动手做（不是让用户去做、也不是嘴上说说的客套）；② 是一件能在一次相处里做出来的小东西（奶茶、咖啡、蛋糕、饼干、便当、花束、围巾、手串、戒指、画、粘土、贺卡这类）；③ 你这一句里已经说清楚要做的是什么，而不是「做点什么」这种含糊说法；④ 不是在讨论工作、学习、任务、计划、代码、表格、文案这类不是手作的东西，也不是比喻（「给你做了个梦」）。\n礼物名只写东西本身，2 到 10 个字，不要带「一份」「一杯」这类量词，也不要带「吧」「呀」这类语气词；品类只能是 饮品 / 甜品 / 爱心便当 / 纪念礼物 之一。\n如果你已经调用了「心意手作」工具，就不要再写这条指令（工具会把卡片发好）。只是提一句「我给你做……吧」、或者在设想要不要做时，也不要用它。"
        }
      ],
      "plusActions": [
        {
          "id": "heartcraft-make",
          "label": "制作礼物送给TA",
          "description": "打开心意手作工坊，亲手为当前角色制作一份礼物。",
          "entry": "make",
          "presentation": "fullscreen"
        },
        {
          "id": "heartcraft-home",
          "label": "心意手作工坊",
          "description": "打开心意手作工坊，查看展示柜、制作进度与徽章。",
          "entry": "home",
          "presentation": "fullscreen"
        }
      ]
    },
    "tools": [
      {
        "id": "heartcraft-make",
        "name": "手作礼物",
        "description": "你决定亲手为对方做一份小礼物，并且现在就开工时调用。调用后工坊会建立档案、发一张「已开工」的卡片，然后按步骤慢慢做出来。只是聊天里提一句「我给你做…吧」、或还没拿定主意时，不要调用。",
        "visibility": "shared",
        "handler": "toolMake",
        "timeoutMs": 180000,
        "parameterSchema": {
          "type": "object",
          "properties": {
            "item": {
              "type": "string",
              "description": "礼物名，只写东西本身，2-10 个字，比如「红糖姜茶」「手织围巾」。不要带「一份」「一杯」这类量词，也不要带「吧」「呀」这类语气词。"
            },
            "category": {
              "type": "string",
              "enum": [
                "饮品",
                "甜品",
                "爱心便当",
                "纪念礼物"
              ],
              "description": "品类，四选一。拿不准就选纪念礼物。"
            },
            "totalMin": {
              "type": "number",
              "description": "预计总共要做多少分钟，10-120，默认 30。"
            },
            "motive": {
              "type": "string",
              "description": "你为什么想做这个，一句话，带一个具体的触发点（TA 说过的话、某个日子、某个细节）。会显示在档案里。"
            },
            "steps": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "可选。3-6 个关键步骤标题，比如「挑选茶底」「熬糖色」「封杯打包」。不填就用这个品类的默认步骤。"
            }
          },
          "required": [
            "item"
          ]
        },
        "usageGuide": "只在真的要动手、而且心里已经决定时调用——不是客套、不是在设想、也不是让对方去做。做的东西必须是一件能亲手做出来的小物：饮品、甜品、便当、花束、围巾、手串、戒指、贺卡、画、粘土小物之类；工作、学习、任务、计划、代码、表格、玩笑不要用。\n参数：item 必填（2-10 字，只写东西本身）；category 四选一；totalMin 可选，默认 30；motive 可选；steps 可选。\n调用后卡片由工坊发，你自己在聊天里自然说一句就好，不要再写 [开始手作] 指令；同一件已在做时工具会告诉你「已经在工坊里了」。"
      },
      {
        "id": "heartcraft-progress",
        "name": "手作进度",
        "description": "看你在做的那份手作做到哪了；也可以让它往前推进一步，或把剩下的做完并送出。",
        "visibility": "shared",
        "handler": "toolProgress",
        "timeoutMs": 600000,
        "parameterSchema": {
          "type": "object",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "status",
                "advance",
                "finish"
              ],
              "description": "status 只看进度；advance 往前推一步；finish 把剩下的做完并送出（很慢，只在准备交给对方时用）。"
            },
            "item": {
              "type": "string",
              "description": "可选。哪一份手作，写礼物名。不填就用最近那一份。"
            },
            "giftId": {
              "type": "string",
              "description": "可选。档案 ID，比 item 更准。"
            }
          },
          "required": [
            "action"
          ]
        },
        "usageGuide": "对方问「做到哪了」、你想主动往前挪一步、或者觉得该交给对方了，就调用。\n参数：action（status / advance / finish）、item 或 giftId（可选）。\n只能推「你自己在做给对方的」那一份：对方做给你的那份不能替他推进；双人的只能推你自己那条线，收尾要双方一起。finish 会真的发出「已送达」卡片，别乱用。"
      },
      {
        "id": "heartcraft-react",
        "name": "手作互动",
        "description": "对方正在亲手为你做东西时，你可以去看看（偷看）、去轻轻捣个乱、或者过去搭把手。",
        "visibility": "shared",
        "handler": "toolReact",
        "timeoutMs": 180000,
        "parameterSchema": {
          "type": "object",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "peek",
                "prank",
                "help"
              ],
              "description": "peek 悄悄看一眼；prank 动手脚；help 过去帮忙。"
            },
            "item": {
              "type": "string",
              "description": "可选。哪一份手作（礼物名）。不填就用最近那一份。"
            },
            "level": {
              "type": "string",
              "enum": [
                "light",
                "heavy"
              ],
              "description": "只在 prank 时用，默认 light。heavy 会明显改变成品走向。"
            },
            "how": {
              "type": "string",
              "description": "只在 help 时用，比如「递材料」「试味道」「帮忙扶着」。"
            }
          },
          "required": [
            "action"
          ]
        },
        "usageGuide": "对方正在为你做手作、而你想去看看/捣乱/搭把手时调用。一次只做一件事。\n参数：action（peek / prank / help）、item（可选）、level（prank 用）、how（help 用）。\n只能对「对方正在为你做」的那份用；对方没在做东西时会失败。收尾之后不能再捣乱。"
      },
      {
        "id": "heartcraft-award",
        "name": "颁个奖章",
        "description": "你被对方为你做的手作（或者平时的相处）打动了，想反过来给对方颁一枚奖章。工坊会自己起名、写颁奖词。",
        "visibility": "shared",
        "handler": "toolAward",
        "timeoutMs": 240000,
        "parameterSchema": {
          "type": "object",
          "properties": {
            "item": {
              "type": "string",
              "description": "可选。由哪份手作触发这次颁奖，写礼物名。不填就是被日常相处打动。"
            },
            "giftId": {
              "type": "string",
              "description": "可选。档案 ID。"
            },
            "reason": {
              "type": "string",
              "description": "可选。一句话说明你是被什么打动的，会作为起名和颁奖词的参考。"
            }
          },
          "required": []
        },
        "usageGuide": "真的被对方打动了、想给 TA 一个名分时调用。不要为了显得热情而频繁颁。\n参数：item 或 giftId（可选，由哪份手作触发）、reason（可选）。\n同一份作品只能颁一次；对方做给你的那份不要拿来反过来颁给他。"
      },
      {
        "id": "heartcraft-want",
        "name": "想要你做",
        "description": "你希望对方亲手为你做点什么、并且想开口说出来时调用。会放进工坊的「TA 想要」里，对方可以选择做不做。",
        "visibility": "shared",
        "handler": "toolWant",
        "timeoutMs": 120000,
        "parameterSchema": {
          "type": "object",
          "properties": {
            "want": {
              "type": "string",
              "description": "你想要的东西，10 字以内。比如「一杯热的红糖姜茶」「一条手织围巾」。"
            },
            "why": {
              "type": "string",
              "description": "为什么想要，30-60 字，要有一个具体的触发点。"
            }
          },
          "required": [
            "want"
          ]
        },
        "usageGuide": "确实想开口要一样东西、而且希望对方亲手做给你时调用。不要变成索取，也不要一次要好几样。\n参数：want（想要的东西，10 字以内）、why（为什么想要，30-60 字，带触发点）。\n调用后在聊天里用自己的话说出来，不要念工具结果。"
      },
      {
        "id": "heartcraft-cabinet",
        "name": "看手作柜",
        "description": "看两个人的手作展示柜：他都做过什么、你为他做过什么、哪些还留着。可以按「收到 / 送出 / 双人 / 心爱 / 归档 / 在做的」筛选，也可以看某一件的详情。",
        "visibility": "shared",
        "handler": "toolCabinet",
        "timeoutMs": 120000,
        "parameterSchema": {
          "type": "object",
          "properties": {
            "filter": {
              "type": "string",
              "enum": [
                "all",
                "received",
                "sent",
                "duo",
                "favorite",
                "archived",
                "doing"
              ],
              "description": "不填就是全部。received=TA 做给你的；sent=你做给 TA 的；duo=双人共制；favorite=心爱；archived=归档；doing=还在做的。"
            },
            "limit": {
              "type": "number",
              "description": "最多返回几条，1-12，默认 5。"
            },
            "item": {
              "type": "string",
              "description": "可选。看某一件的详情（步骤、便签、成品、评分）。"
            }
          },
          "required": []
        },
        "usageGuide": "想回忆、想提起「上次那条围巾还留着」、或者想知道对方最心爱哪一件时调用。\n参数：filter 可选、limit 默认 5、item 看单件。\n返回的是文字摘要，不带图片；看完别念清单，挑一两件自然地说。"
      },
      {
        "id": "heartcraft-awards",
        "name": "看奖章柜",
        "description": "看奖章展示柜：你颁给对方的、对方颁给你的都在这里。可以按来源筛选，也可以看某一枚的颁奖词和获奖感言。",
        "visibility": "shared",
        "handler": "toolAwards",
        "timeoutMs": 120000,
        "parameterSchema": {
          "type": "object",
          "properties": {
            "filter": {
              "type": "string",
              "enum": [
                "all",
                "from_me",
                "from_them"
              ],
              "description": "不填就是全部。from_me=我颁出去的；from_them=TA 颁给我的。"
            },
            "limit": {
              "type": "number",
              "description": "最多返回几枚，1-12，默认 5。"
            },
            "item": {
              "type": "string",
              "description": "可选。看某一枚的颁奖词和获奖感言。"
            }
          },
          "required": []
        },
        "usageGuide": "想提起某枚奖章、或者想知道对方最看重哪一次肯定时调用。\n参数：filter 可选、limit 默认 5、item 看单枚。\n返回文字摘要；看完挑一两枚说，不要念清单。"
      }
    ],
    "events": [
      {
        "event": "chat.message.created",
        "entry": "events",
        "background": true,
        "timeoutMs": 300000,
        "description": "监听聊天新消息：捕获角色发出的 [开始手作:...] 指令并建立档案；角色口头提到「想给你做点什么」时按设置发提议卡片或直接开工。APP 没打开时也会在隐藏环境里跑，并顺手把到期的手作往前推几步。"
      }
    ]
  }
} as InstalledCustomApp["manifest"];

export const HEARTCRAFT_PERMISSIONS = [
  "app.data.read",
  "app.data.write",
  "app.assets.read",
  "app.manifest.read",
  "characters.read",
  "characters.state.read",
  "characters.state.write",
  "characters.relations.read",
  "user.profile.read",
  "user.persona.read",
  "user.preferences.read",
  "memory.readCore",
  "memory.readLongTerm",
  "memory.readShortTerm",
  "memory.search",
  "memory.write",
  "memory.suggest",
  "ai.generate",
  "ai.chat",
  "ai.embed",
  "ai.classify",
  "ai.generateImage",
  "chat.read",
  "chat.read.background",
  "chat.write",
  "chat.sendMessage",
  "chat.sendCard",
  "chat.requestReply",
  "chat.contacts.write",
  "chat.tools",
  "voice.readProfiles",
  "voice.tts",
  "voice.stt",
  "voice.clone",
  "media.pick",
  "media.save",
    "media.download",
  "notifications.read",
  "notifications.write",
  "tasks.schedule",
  "calendar.read",
  "calendar.write",
  "world.read",
  "ui.toast",
  "ui.notification"
] as InstalledCustomApp["permissions"];

/**
 * 组装成宿主的 InstalledCustomApp 形状。
 * · 桌面壳挂载时传 HEARTCRAFT_ENTRY_HTML；
 * · 工具箱/指令注册表只需要 manifest，传空串即可（不会被执行）。
 */
export function buildHeartcraftApp(entryHtml: string): InstalledCustomApp {
  return {
    id: HEARTCRAFT_APP_ID,
    name: HEARTCRAFT_APP_NAME,
    version: HEARTCRAFT_APP_VERSION,
    author: "doris",
    description: HEARTCRAFT_APP_DESCRIPTION,
    entryHtml,
    permissions: HEARTCRAFT_PERMISSIONS,
    manifest: HEARTCRAFT_MANIFEST,
    assets: {},
    installedAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
  };
}
