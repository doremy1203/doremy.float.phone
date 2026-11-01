/**
 * 截屏：让角色能看见用户此刻真实屏幕上的画面。
 *
 * 与其它能力的最大不同：**它读的是用户全部屏幕内容**——银行余额、私聊、
 * 密码框都可能在画面里。所以这里的默认值比设备动作还保守，
 * 而且从设计上就要求「用户点一下才截一张」，不做任何自动、定时、监听。
 *
 * 产品边界（改代码前先读）：
 *  - 默认全部关闭（缺失 = 关）。
 *  - 只做「调一次截一张」，没有任何持续/后台/定时的截屏路径。
 *  - 截屏需要无障碍服务（Android 11+ 的 AccessibilityService.takeScreenshot），
 *    所以状态要分三层报：系统支不支持 / 无障碍开没开 / 现在能不能截。
 *  - 失败必须如实说原因，绝不返回一张空白图冒充成功。
 */

/** 壳如实上报的截屏状态。 */
export type ScreenshotCapabilities = {
  /** 系统版本够不够（Android 11+） */
  supported?: boolean;
  /** 无障碍服务是否已开启（截屏的前提） */
  accessibilityOn?: boolean;
  /** 现在是否真的可以截（supported && accessibilityOn） */
  ready?: boolean;
};

/** 原生推回的一张截屏。成功时带 PNG base64 与尺寸。 */
export type ScreenshotCaptureResult =
  | {
      ok: true;
      /** 缩放后的宽度（原生上限 720） */
      width: number;
      height: number;
      /** PNG 字节数，用于展示与排查 */
      bytes: number;
      /** PNG base64（不含 data: 前缀） */
      base64: string;
    }
  | { ok: false; reason: string };

/** 截屏桥的内部状态快照（诊断用，不含任何画面内容）。 */
export type ScreenshotDiagnostics = {
  supported?: boolean;
  accessibilityOn?: boolean;
  ready?: boolean;
  capturing?: boolean;
  /** 最近一次失败描述（空串 = 没记到失败） */
  lastError?: string;
  /** 最近一次截屏时刻；0 = 从未截过 */
  lastCaptureAt?: number;
  lastCaptureOk?: boolean;
  /** 最近一次截屏的补充说明（尺寸体积或失败原因） */
  lastCaptureNote?: string;
  captureCount?: number;
};

/** 查岗浮层的内部状态快照（诊断用）。 */
export type CheckInDiagnostics = {
  /** 浮窗权限是否已授予 */
  canDraw?: boolean;
  /** 服务是否在运行 */
  running?: boolean;
  /** 壳自己认知的前后台 */
  hostInForeground?: boolean;
  /** 是否有活动实例 */
  hasInstance?: boolean;
  /** 窗口是否真的挂上了 */
  windowAdded?: boolean;
  /** 窗口是否可见 */
  windowVisible?: boolean;
  /** 是否正有一张图等着用户决定 */
  awaitingDecision?: boolean;
  /** 最近一次失败描述 */
  lastError?: string;
  lastShowAt?: number;
  showCount?: number;
  /** 原生手上的可分享角色数量（用户主动截屏时浮层里供选择） */
  shareTargetCount?: number;
  /** 默认接收角色名（空 = 每次都要在浮层里选） */
  shareDefaultName?: string;
  /** 最近一次主动截屏实际发给了谁（空 = 没记到） */
  lastShareTarget?: string;
  /** 嵌一层截屏桥的状态 */
  screenshot?: ScreenshotDiagnostics;
};

/** 原生上报的截屏悬浮球能力与状态。 */
export type ScreenshotBallCapabilities = {
  /** 系统版本够不够（Android 11+） */
  supported?: boolean;
  /** 无障碍服务是否已开启（截屏的前提） */
  accessibilityOn?: boolean;
  /** 悬浮球是否正在显示 */
  running?: boolean;
};

/** 原生上报的查岗能力与状态。 */
export type CheckInCapabilities = {
  /** 系统版本够不够（Android 11+） */
  supported?: boolean;
  /** 无障碍服务是否已开启 */
  accessibilityOn?: boolean;
  /** 浮窗权限与常驻服务是否就绪（查岗浮层的前提） */
  canDraw?: boolean;
};

/**
 * 一次查岗等待的结果：用户同意给图，或拒绝/超时/失败。
 *
 * reply 是用户在浮层回复框里顺手说的话（可选）。它和屏幕内容无关，
 * 所以无论同意还是拒绝都会带回来——用户主动打的字不该被吞掉。
 */
export type CheckInOutcome =
  | { accepted: true; base64: string; width: number; height: number; bytes?: number; reply?: string; characterId?: string }
  | { accepted: false; reason: string; reply?: string; characterId?: string };

/**
 * 一个可选的分享接收角色（用户主动截屏时浮层里选「发给谁」）。
 *
 * 只带 id 与名字，不带头像：清单要经 @JavascriptInterface 同步传给原生，
 * 头像 base64 动辄几百 KB 起，塞进去有撑爆桥的风险，浮层里用名字足够认人。
 */
export type ScreenshotShareTarget = {
  id: string;
  name: string;
};

/** 原生当前持有的分享目标状态（诊断面板展示用）。 */
export type ScreenshotShareTargetState = {
  /** 原生手上有几个可选角色（0 = 网页还没推送过，或一个角色都没有） */
  count: number;
  /** 默认接收角色 id（空 = 每次都在浮层里选） */
  defaultId: string;
  /** 默认接收角色名（给人看的） */
  defaultName: string;
  /** 最近一次实际发给了谁（空 = 还没发过） */
  lastTargetName: string;
  /** 上次没能定下目标的原因（空 = 没有） */
  lastTargetReason: string;
};

/** 检索一条截屏记录：图片本体存在媒体库，这里只留引用与元信息。 */
export type ScreenshotRecord = {
  id: string;
  /** media-store:// 引用，可直接给 <img src> */
  ref: string;
  width: number;
  height: number;
  bytes: number;
  /** 截取时间戳 */
  at: number;
};
