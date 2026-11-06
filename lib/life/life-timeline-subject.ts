import { USER_NAME_MACRO } from "../user-macro";

/**
 * 玩家自己的生活记录会作为“已发生事实”进入同场景角色的提示词。记录写入时主语用的是
 * 玩家显示名（默认“我”）或第二人称“你”，角色读到会把第一人称误当成自己的记忆。
 * 这里只替换记录的主语，正文（对白、地点、细节）保持原样，绝不做全文替换。
 */
export function asPlayerRecordSubject(
  entry: { title: string; actorName?: string; actorId?: string },
  playerDisplayName?: string,
): { title: string; actorName?: string } {
  const storedName = (entry.actorName || "").trim();
  const displayName = (playerDisplayName || "").trim();
  const isPlayer = entry.actorId
    ? entry.actorId === "player"
    : Boolean(storedName) && (storedName === displayName || storedName === "我");
  if (!isPlayer) return { title: entry.title, actorName: entry.actorName };

  // actorName 是写入当时的玩家显示名才算主语；像“场景旁白”这类署名要保留。
  const nameIsPlayer = Boolean(storedName) && (storedName === displayName || storedName === "我");
  let title = entry.title;
  if (nameIsPlayer && title.startsWith(storedName)) {
    title = USER_NAME_MACRO + title.slice(storedName.length);
  } else if (title.startsWith("你")) {
    title = USER_NAME_MACRO + title.slice(1);
  }
  return { title, actorName: nameIsPlayer ? USER_NAME_MACRO : entry.actorName };
}
