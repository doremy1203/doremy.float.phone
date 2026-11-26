/** 角色查岗（查看用户手机）的事件总线 */

export const USER_PHONE_CHECK_REQUEST_EVENT = "ai-user-phone-check-request";

export type UserPhoneCheckSource = "button" | "keyword";

export type UserPhoneCheckRequestDetail = {
  characterId: string;
  source: UserPhoneCheckSource;
};

/** 请求某个角色发起一次查岗；是否放行由用户在权限弹窗里决定 */
export function requestUserPhoneCheck(characterId: string, source: UserPhoneCheckSource = "button"): void {
  if (typeof window === "undefined" || !characterId) return;
  const detail: UserPhoneCheckRequestDetail = { characterId, source };
  window.dispatchEvent(new CustomEvent(USER_PHONE_CHECK_REQUEST_EVENT, { detail }));
}

/** 用户消息里是否在让角色看自己的手机 */
export function isUserPhoneCheckIntent(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/查岗/.test(value)) return true;
  if (/查(看|查|一下)?我[^。！？\n]{0,3}手机/.test(value)) return true;
  if (/看看我(的)?手机/.test(value)) return true;
  return false;
}
