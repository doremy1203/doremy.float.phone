/**
 * WeChat iLink Bot protocol version. This is the version declared to WeChat
 * when minting the login QR and when polling/sending messages.
 *
 * "OpenClaw" in WeChat's upgrade prompt is only the name of Tencent's reference
 * client; this project talks to iLink directly and does not depend on OpenClaw.
 */
export const WEIXIN_ILINK_PROTOCOL_VERSION = "2.4.11";

/** iLink-App-ClientVersion is 0x00MMNNPP (major/minor/patch). */
export const WEIXIN_ILINK_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 11;

export const WEIXIN_ILINK_BASE_INFO = {
  channel_version: WEIXIN_ILINK_PROTOCOL_VERSION,
} as const;
