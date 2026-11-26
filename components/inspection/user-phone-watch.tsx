"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Lock } from "lucide-react";

import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import { loadChatMessages, loadChatSessions, resolveSessionCharacterId, type ChatMessage } from "@/lib/chat-storage";
import type { MomentComment, MomentPost } from "@/lib/moments-types";
import { getAllPosts, loadAllMomentComments } from "@/lib/moments-storage";
import {
  applyUserPhoneAlias,
  commentAsUser,
  generateUserPhoneWatchScript,
  pickFriendSession,
  postMomentAsUser,
  saveUserPhoneWatchMemory,
  sendFriendReply,
  sendUserMessage,
  type UserPhoneWatchScript,
} from "@/lib/user-phone-watch-engine";

type UserPhoneWatchProps = {
  characterId: string;
  onDone: () => void;
};

type WatchView = "home" | "chat" | "moments";

const VIEW_LABELS: Record<WatchView, string> = {
  home: "聊天",
  chat: "聊天",
  moments: "动态",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function postAuthorName(post: MomentPost, characters: Character[]): string {
  if (post.authorType === "user") return "我";
  return characters.find(item => item.id === post.authorId)?.name ?? "好友";
}

export function UserPhoneWatch({ characterId, onDone }: UserPhoneWatchProps) {
  const [characters] = useState<Character[]>(() => loadCharacters());
  const checker = useMemo<Character>(
    () =>
      characters.find(item => item.id === characterId) ?? {
        id: characterId,
        name: "ta",
        avatar: null,
        persona: "",
        createdAt: "",
        updatedAt: "",
      },
    [characters, characterId],
  );

  const sessionsRef = useRef(loadChatSessions());
  const [, bump] = useState(0);
  /** 备注/发消息都会落库，重新读一次会话保证列表展示同步 */
  const reloadSessions = () => {
    sessionsRef.current = loadChatSessions();
    bump(value => value + 1);
  };

  const [script, setScript] = useState<UserPhoneWatchScript | null>(null);
  const [view, setView] = useState<WatchView>("home");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [bubble, setBubble] = useState("");
  const [remarkFlash, setRemarkFlash] = useState<string | null>(null);
  const [commentFlash, setCommentFlash] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const sessions = sessionsRef.current;
  const privateSessions = sessions.filter(session => !session.isGroup && resolveSessionCharacterId(session));
  const friendSession = pickFriendSession(sessions, characterId);
  const friendCharacter = friendSession
    ? characters.find(item => item.id === resolveSessionCharacterId(friendSession)) ?? null
    : null;
  const ownSession = privateSessions.find(session => resolveSessionCharacterId(session) === characterId) ?? null;
  const messages: ChatMessage[] = activeSessionId ? loadChatMessages(activeSessionId) : [];
  const posts: MomentPost[] = getAllPosts()
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8);
  const allComments: MomentComment[] = loadAllMomentComments();

  // 生成一次操作台词（角色人设驱动）
  useEffect(() => {
    let cancelled = false;
    const friendName = friendCharacter?.name ?? "好友";
    void generateUserPhoneWatchScript(checker, friendName).then(next => {
      if (!cancelled) setScript(next);
    });
    return () => {
      cancelled = true;
    };
    // 只在进入查岗时生成一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 按脚本自动操作，用户全程只读
  useEffect(() => {
    if (!script) return;
    let cancelled = false;
    const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    const alive = () => !cancelled;
    const friendName = friendCharacter?.name ?? "好友";
    const targetPostId = (() => {
      const target = getAllPosts()
        .filter(post => post.authorType === "character" && post.authorId !== characterId)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      return target?.id ?? null;
    })();

    (async () => {
      setBubble(`${checker.name}：我看看你的手机……`);
      await wait(1400);
      if (!alive()) return;

      setView("home");
      setBubble(script.bubbles[0] ?? "……");
      await wait(2100);
      if (!alive()) return;

      if (friendSession) {
        setActiveSessionId(friendSession.id);
        setView("chat");
        setBubble(script.bubbles[1] ?? "……");
        await wait(1800);
        if (!alive()) return;

        setDraft(script.friendMessage);
        await wait(1100);
        if (!alive()) return;

        setDraft("");
        sendUserMessage(friendSession.id, script.friendMessage);
        reloadSessions();
        await wait(900);
        if (!alive()) return;

        sendFriendReply(friendSession.id, script.friendReply);
        reloadSessions();
        void saveUserPhoneWatchMemory(
          characterId,
          `查岗时，我翻看他与「${friendName}」的聊天，并以他的身份发了消息：「${script.friendMessage}」。`,
          0.5,
        );
        await wait(2300);
        if (!alive()) return;
      }

      setActiveSessionId(null);
      setView("home");
      setBubble(script.bubbles[2] ?? "……");
      if (ownSession) {
        applyUserPhoneAlias(ownSession.id, script.remark);
        setRemarkFlash(ownSession.id);
        reloadSessions();
        window.setTimeout(() => {
          if (!cancelled) setRemarkFlash(null);
        }, 2600);
      }
      await wait(2400);
      if (!alive()) return;

      setView("moments");
      setBubble(script.bubbles[3] ?? "……");
      await wait(1500);
      if (!alive()) return;

      postMomentAsUser(script.momentText, characters.map(item => item.id));
      reloadSessions();
      await wait(1700);
      if (!alive()) return;

      if (targetPostId) {
        commentAsUser(targetPostId, script.comment);
        setCommentFlash(targetPostId);
        reloadSessions();
      }
      await wait(2300);
      if (!alive()) return;

      setBubble(script.bubbles[4] ?? "看完了。");
      void saveUserPhoneWatchMemory(
        characterId,
        `我看完了他的手机：聊天、备注和动态都翻了一遍，还以他的身份发了动态「${script.momentText}」。`,
        0.5,
      );
      await wait(3200);
      if (!alive()) return;
      onDoneRef.current();
    })();

    return () => {
      cancelled = true;
    };
    // 脚本只在生成后变化一次；其余数据通过 ref/存储实时读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script]);

  useEffect(() => {
    const box = messagesRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages.length, draft, view]);

  const activeSession = activeSessionId ? sessions.find(session => session.id === activeSessionId) : null;
  const activeCharacter = activeSession
    ? characters.find(item => item.id === resolveSessionCharacterId(activeSession)) ?? null
    : null;

  return (
    <div className="upw-shell" role="dialog" aria-label={`${checker.name} 正在查看你的手机`}>
      <header className="upw-header">
        <span
          className="upw-header-avatar"
          style={checker.avatar ? { backgroundImage: `url("${checker.avatar}")` } : undefined}
          aria-hidden
        />
        <div className="upw-header-text">
          <div className="upw-header-title">{checker.name} 正在查看你的手机</div>
          <div className="upw-header-sub">
            <Lock size={11} strokeWidth={2} />
            你正在旁观，暂时无法操作手机
          </div>
        </div>
        <button type="button" className="upw-end-btn" onClick={() => onDoneRef.current()}>
          结束旁观
        </button>
      </header>

      <div className="upw-tabs" aria-hidden>
        <span className={view === "moments" ? "upw-tab" : "upw-tab is-active"}>{VIEW_LABELS.home}</span>
        <span className={view === "moments" ? "upw-tab is-active" : "upw-tab"}>动态</span>
      </div>

      {view === "home" && (
        <div className="upw-list">
          {privateSessions.length === 0 && <div className="upw-empty">手机里还没有私聊。</div>}
          {privateSessions.map(session => {
            const character = characters.find(item => item.id === resolveSessionCharacterId(session)) ?? null;
            const name = session.alias || character?.name || "对方";
            return (
              <div key={session.id} className="upw-row">
                <span
                  className="upw-avatar"
                  style={character?.avatar ? { backgroundImage: `url("${character.avatar}")` } : undefined}
                  aria-hidden
                >
                  {character?.avatar ? null : name.slice(0, 1)}
                </span>
                <div className="upw-row-main">
                  <div className="upw-row-name">
                    {name}
                    {remarkFlash === session.id && <span className="upw-row-flash">备注已改</span>}
                  </div>
                  <div className="upw-row-preview">{session.lastMessagePreview || "暂无消息"}</div>
                </div>
                <span className="upw-row-time">{formatTime(session.updatedAt)}</span>
              </div>
            );
          })}
        </div>
      )}

      {view === "chat" && activeSession && (
        <div className="upw-chat">
          <div className="upw-chat-title">
            {activeSession.alias || activeCharacter?.name || "对方"}
            {remarkFlash === activeSession.id && <span className="upw-row-flash">备注已改</span>}
          </div>
          <div className="upw-messages" ref={messagesRef}>
            {messages.slice(-40).map(message => (
              <div
                key={message.id}
                className={message.role === "user" ? "upw-msg upw-msg-user" : "upw-msg upw-msg-other"}
              >
                {message.content}
              </div>
            ))}
            {draft && <div className="upw-msg upw-msg-user upw-msg-typing">{draft}</div>}
          </div>
        </div>
      )}

      {view === "moments" && (
        <div className="upw-feed">
          {posts.length === 0 && <div className="upw-empty">还没有动态。</div>}
          {posts.map(post => {
            const comments = allComments.filter(comment => comment.postId === post.id).slice(-3);
            return (
              <div key={post.id} className={commentFlash === post.id ? "upw-post is-flash" : "upw-post"}>
                <div className="upw-post-author">
                  {postAuthorName(post, characters)}
                  <span className="upw-post-time">{formatTime(post.createdAt)}</span>
                </div>
                <div className="upw-post-content">{post.content}</div>
                {comments.length > 0 && (
                  <div className="upw-post-comments">
                    {comments.map(comment => (
                      <div key={comment.id} className="upw-post-comment">
                        <b>{comment.authorType === "user" ? "我" : comment.authorName || "好友"}</b>
                        ：{comment.content}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="upw-bubble" role="status">
        <span className="upw-bubble-name">{checker.name}</span>
        <span className="upw-bubble-text">{bubble || "……"}</span>
      </div>
    </div>
  );
}
