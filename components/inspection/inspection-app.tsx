"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  MessageSquare,
  Pencil,
  RefreshCw,
  Send,
  StickyNote,
  X,
} from "lucide-react";

import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import { loadChatMessages, loadChatSessions, resolveSessionCharacterId } from "@/lib/chat-storage";
import { getVisibleComments, getVisiblePosts } from "@/lib/moments-storage";
import type { MomentPost } from "@/lib/moments-types";
import {
  appendInspectionChatMessage,
  applyInspectionGeneratedContent,
  createEmptyInspectionPhone,
  formatClock,
  loadInspectionPhone,
  updateInspectionRemark,
  type InspectionChatMessage,
  type InspectionMemo,
  type InspectionPhoneState,
} from "@/lib/inspection-storage";
import {
  buildFallbackBundle,
  buildFallbackComment,
  decideInspectionPermission,
  generateFriendReply,
  generateInspectionBundle,
  generateInspectionComment,
  saveInspectionMemory,
} from "@/lib/inspection-engine";

type TabKey = "chat" | "moments" | "memos" | "photos";
type EntryPhase = "permission" | "asking" | "phone";

const TAB_LABELS: Record<TabKey, string> = {
  chat: "聊天",
  moments: "动态",
  memos: "备忘录",
  photos: "相册",
};

const USER_THREAD_ID = "__user__";

function formatShortTime(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return formatClock(date);
  } catch {
    return "";
  }
}

function formatDateLabel(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getMonth() + 1}/${date.getDate()} ${formatClock(date)}`;
  } catch {
    return "";
  }
}

type InspectionAppProps = {
  characterId: string;
  onClose: () => void;
};

export function InspectionApp({ characterId, onClose }: InspectionAppProps) {
  const characters = useMemo<Character[]>(() => loadCharacters(), []);
  const owner = useMemo(
    () => characters.find(character => character.id === characterId) ?? null,
    [characters, characterId],
  );
  const friends = useMemo(
    () => characters.filter(character => character.id !== characterId),
    [characters, characterId],
  );

  const [phase, setPhase] = useState<EntryPhase>("permission");
  const [askBusy, setAskBusy] = useState(false);
  const [askResult, setAskResult] = useState<{ allow: boolean; reason: string } | null>(null);
  const [phone, setPhone] = useState<InspectionPhoneState | null>(() => loadInspectionPhone(characterId));

  // 人设 / 记忆衍生出的手机好友，和真实角色一起出现在聊天列表里
  const allFriends = useMemo<Character[]>(() => {
    const npcFriends: Character[] = (phone?.npcs ?? []).map(npc => ({
      id: npc.id,
      name: npc.name,
      avatar: null,
      persona: npc.relation,
      createdAt: "",
      updatedAt: "",
    }));
    return [...friends, ...npcFriends];
  }, [friends, phone?.npcs]);
  const [tab, setTab] = useState<TabKey>("chat");
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [remarkEditing, setRemarkEditing] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState("");
  const [bubble, setBubble] = useState<string | null>(null);
  const [bubbleOpen, setBubbleOpen] = useState(true);
  const [bubbleLoading, setBubbleLoading] = useState(false);
  const commentSeq = useRef(0);

  const remarkForUser = phone?.remarkForUser || "我";

  // 与该角色的真实聊天（只读，来自聊天 App）
  const realThread = useMemo<InspectionChatMessage[]>(() => {
    if (!owner) return [];
    try {
      const session = loadChatSessions()
        .filter(item => !item.isGroup && resolveSessionCharacterId(item) === owner.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!session) return [];
      return loadChatMessages(session.id)
        .filter(message => message.role === "user" || message.role === "assistant")
        .map(message => ({
          id: message.id,
          direction: message.role === "user" ? "incoming" as const : "outgoing" as const,
          text: message.content.replace(/\s+/g, " ").trim().slice(0, 300),
          timeLabel: formatShortTime(message.createdAt),
        }))
        .filter(message => message.text.length > 0)
        .slice(-80);
    } catch {
      return [];
    }
  }, [owner]);

  const momentCards = useMemo(() => {
    if (!owner) return [] as { post: MomentPost; comments: ReturnType<typeof getVisibleComments> }[];
    try {
      return getVisiblePosts(owner.id)
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(post => ({ post, comments: getVisibleComments(post.id, owner.id) }));
    } catch {
      return [] as { post: MomentPost; comments: ReturnType<typeof getVisibleComments> }[];
    }
  }, [owner]);

  const nameOf = useCallback((authorType: string, authorId: string, authorName?: string): string => {
    if (authorType === "user") return "我";
    if (authorName) return authorName;
    return characters.find(character => character.id === authorId)?.name ?? "未知";
  }, [characters]);

  const requestComment = useCallback(async (page: TabKey, context: string) => {
    if (!owner) return;
    const seq = ++commentSeq.current;
    setBubbleLoading(true);
    try {
      const text = await generateInspectionComment(owner, TAB_LABELS[page], context);
      if (seq !== commentSeq.current) return;
      const finalText = text || buildFallbackComment(page);
      setBubble(finalText);
      setBubbleOpen(true);
      void saveInspectionMemory(
        owner.id,
        `对方在翻我的手机（${TAB_LABELS[page]}），我说：「${finalText}」`,
        0.5,
      );
    } finally {
      if (seq === commentSeq.current) setBubbleLoading(false);
    }
  }, [owner]);

  const runGenerate = useCallback(async (): Promise<InspectionPhoneState | null> => {
    if (!owner) return null;
    setGenerating(true);
    const startedAt = Date.now();
    try {
      const bundle = await generateInspectionBundle(owner, allFriends) ?? buildFallbackBundle(owner, allFriends);
      // 兜底内容几乎是瞬时返回的，保留一点最短加载时间，避免点击后毫无反馈
      const elapsed = Date.now() - startedAt;
      if (elapsed < 600) await new Promise(resolve => window.setTimeout(resolve, 600 - elapsed));
      const next = applyInspectionGeneratedContent(owner.id, bundle);
      setPhone(next);
      return next;
    } catch {
      return null;
    } finally {
      setGenerating(false);
    }
  }, [owner, allFriends]);

  const enterPhone = useCallback(async () => {
    setPhase("phone");
    const existing = loadInspectionPhone(characterId) ?? createEmptyInspectionPhone(characterId);
    setPhone(existing);
    const empty = existing.memos.length === 0
      && existing.photos.length === 0
      && Object.keys(existing.conversations).length === 0;
    if (empty) void runGenerate();
    void requestComment("chat", "");
  }, [characterId, runGenerate, requestComment]);

  const handleAsk = useCallback(async () => {
    if (!owner || askBusy) return;
    setAskBusy(true);
    setPhase("asking");
    try {
      setAskResult(await decideInspectionPermission(owner));
    } finally {
      setAskBusy(false);
    }
  }, [owner, askBusy]);

  const handleRefresh = useCallback(async () => {
    if (generating) return;
    const next = await runGenerate();
    if (!next) {
      setBubble("……刷新失败了，等一下再试。");
      setBubbleOpen(true);
      return;
    }
    setJustRefreshed(true);
    window.setTimeout(() => setJustRefreshed(false), 1800);
    void requestComment(tab, "刚刚刷新了整部手机的内容");
  }, [generating, runGenerate, requestComment, tab]);

  const handleTabChange = (next: TabKey) => {
    setTab(next);
    setActiveChat(null);
    void requestComment(next, "");
  };

  const openChat = (id: string) => {
    setActiveChat(id);
    const friend = allFriends.find(item => item.id === id);
    void requestComment("chat", friend ? `正在看我和${friend.name}的聊天记录` : "正在看我们俩的真实聊天记录");
  };

  const handleSend = async () => {
    if (!owner || !activeChat || activeChat === USER_THREAD_ID || sending) return;
    const text = draft.trim();
    if (!text) return;
    const friend = allFriends.find(item => item.id === activeChat);
    setSending(true);
    setDraft("");
    let next = appendInspectionChatMessage(characterId, activeChat, { direction: "outgoing", text });
    setPhone(next);
    const thread = next.conversations[activeChat] ?? [];
    try {
      const reply = friend ? await generateFriendReply(owner, friend, thread, text) : null;
      const finalReply = reply || "……";
      next = appendInspectionChatMessage(characterId, activeChat, { direction: "incoming", text: finalReply });
      setPhone(next);
      if (friend) {
        void saveInspectionMemory(friend.id, `我在${owner.name}的手机上收到用户的消息：「${text}」`, 0.6);
      }
      void saveInspectionMemory(
        owner.id,
        `用户在我的手机上给${friend?.name ?? "好友"}发消息：「${text}」，对方回：「${finalReply}」`,
        0.55,
      );
      void requestComment("chat", `用户正在用我的手机给${friend?.name ?? "好友"}发消息`);
    } finally {
      setSending(false);
    }
  };

  const startRemarkEdit = () => {
    setRemarkDraft(phone?.remarkForUser ?? "");
    setRemarkEditing(true);
  };

  const saveRemark = () => {
    if (!owner) return;
    const next = updateInspectionRemark(characterId, remarkDraft);
    setPhone(next);
    setRemarkEditing(false);
    void saveInspectionMemory(owner.id, `用户把我手机里 TA 的备注改成了「${next.remarkForUser || "我"}」`, 0.45);
    void requestComment("chat", "用户刚改了我手机里 TA 的备注");
  };

  if (!owner) {
    return (
      <div className="inspection-shell inspection-empty">
        <p>找不到这个角色。</p>
        <button type="button" className="inspection-btn inspection-btn-primary" onClick={onClose}>返回</button>
      </div>
    );
  }

  // ---- 权限阶段 ----
  if (phase !== "phone") {
    return (
      <div className="inspection-shell">
        <div className="inspection-permission">
          <div className="inspection-permission-card">
            <div className="inspection-permission-title">
              查看 {owner.name} 的手机
            </div>
            <p className="inspection-permission-desc">
              你可以先问问 ta 的意见，也可以强行查看。被拒绝后本次将无法进入。
            </p>

            {!askResult && (
              <div className="inspection-permission-actions">
                <button
                  type="button"
                  className="inspection-btn inspection-btn-primary"
                  disabled={askBusy}
                  onClick={() => void handleAsk()}
                >
                  {askBusy ? "ta 正在考虑…" : `询问 ${owner.name} 的意见`}
                </button>
                <button
                  type="button"
                  className="inspection-btn inspection-btn-danger"
                  onClick={() => void enterPhone()}
                >
                  强制查看
                </button>
                <button type="button" className="inspection-btn" onClick={onClose}>
                  取消
                </button>
              </div>
            )}

            {askResult && (
              <div className={`inspection-decision ${askResult.allow ? "is-allow" : "is-deny"}`}>
                <div className="inspection-decision-reason">「{askResult.reason}」</div>
                {askResult.allow ? (
                  <button type="button" className="inspection-btn inspection-btn-primary" onClick={() => void enterPhone()}>
                    进入 ta 的手机
                  </button>
                ) : (
                  <button type="button" className="inspection-btn" onClick={onClose}>
                    好，不看了
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const state = phone ?? createEmptyInspectionPhone(characterId);
  const activeFriend = activeChat ? allFriends.find(item => item.id === activeChat) ?? null : null;
  const activeMessages: InspectionChatMessage[] = activeChat === USER_THREAD_ID
    ? realThread
    : (activeChat ? state.conversations[activeChat] ?? [] : []);
  const lastRealMessage = realThread[realThread.length - 1]?.text ?? "";

  return (
    <div className="inspection-shell">
      <header className="inspection-header">
        <button type="button" className="inspection-icon-btn" onClick={onClose} aria-label="关闭查岗">
          <ArrowLeft size={18} strokeWidth={1.8} />
        </button>
        <div className="inspection-title-group">
          <div className="inspection-title">{owner.name} 的手机</div>
          <div className="inspection-updated">
            {state.generatedAt ? `更新于 ${formatShortTime(state.generatedAt)}` : "尚未生成"}
            {justRefreshed ? " · 已刷新" : ""}
          </div>
        </div>
        <button
          type="button"
          className="inspection-refresh-btn"
          onClick={() => void handleRefresh()}
          onPointerDown={event => event.stopPropagation()}
          disabled={generating}
          aria-label="刷新手机内容"
        >
          <RefreshCw size={15} strokeWidth={1.8} className={generating ? "spin" : ""} />
          {generating ? "刷新中" : justRefreshed ? "已刷新" : "刷新"}
        </button>
      </header>

      {!activeChat && (
        <nav className="inspection-tabs">
          {(Object.keys(TAB_LABELS) as TabKey[]).map(key => (
            <button
              key={key}
              type="button"
              className={`inspection-tab${tab === key ? " is-active" : ""}`}
              onClick={() => handleTabChange(key)}
            >
              {TAB_LABELS[key]}
            </button>
          ))}
        </nav>
      )}

      <div className="inspection-body">
        {generating && (
          <div className="inspection-refreshing" role="status">
            <RefreshCw size={13} strokeWidth={2} className="spin" />
            正在刷新手机内容…
          </div>
        )}
        {tab === "chat" && !activeChat && (
          <div className="inspection-chat-list">
            <div className="inspection-chat-row">
              <div className="inspection-avatar">
                <span>{remarkForUser.slice(0, 1) || "我"}</span>
              </div>
              <button type="button" className="inspection-chat-main" onClick={() => openChat(USER_THREAD_ID)}>
                <div className="inspection-chat-name">
                  {remarkForUser}
                  <span className="inspection-chat-badge">本人</span>
                </div>
                <div className="inspection-chat-preview">{lastRealMessage || "还没有聊过"}</div>
              </button>
              <button type="button" className="inspection-icon-btn" onClick={startRemarkEdit} aria-label="修改我的备注">
                <Pencil size={15} strokeWidth={1.8} />
              </button>
            </div>

            {allFriends.length === 0 && (
              <div className="inspection-empty-hint">ta 的手机里还没有其他好友。</div>
            )}
            {allFriends.map(friend => {
              const thread = state.conversations[friend.id] ?? [];
              const last = thread[thread.length - 1];
              return (
                <button
                  key={friend.id}
                  type="button"
                  className="inspection-chat-row is-clickable"
                  onClick={() => openChat(friend.id)}
                >
                  <div
                    className="inspection-avatar"
                    style={friend.avatar ? { backgroundImage: `url("${friend.avatar}")` } : undefined}
                  >
                    {!friend.avatar && <span>{friend.name.slice(0, 1)}</span>}
                  </div>
                  <div className="inspection-chat-main">
                    <div className="inspection-chat-name">{friend.name}</div>
                    <div className="inspection-chat-preview">
                      {last ? last.text : "暂无聊天记录"}
                    </div>
                  </div>
                  {last && <span className="inspection-chat-time">{last.timeLabel}</span>}
                </button>
              );
            })}
          </div>
        )}

        {tab === "chat" && activeChat && (
          <div className="inspection-thread">
            <div className="inspection-thread-head">
              <button type="button" className="inspection-icon-btn" onClick={() => setActiveChat(null)} aria-label="返回聊天列表">
                <ArrowLeft size={16} strokeWidth={1.8} />
              </button>
              <span>
                {activeChat === USER_THREAD_ID ? remarkForUser : activeFriend?.name ?? "聊天"}
                {activeChat === USER_THREAD_ID && <em className="inspection-thread-note">真实记录 · 只读</em>}
              </span>
            </div>
            <div className="inspection-thread-body">
              {activeMessages.length === 0 && (
                <div className="inspection-empty-hint">没有聊天记录。</div>
              )}
              {activeMessages.map(message => (
                <div
                  key={message.id}
                  className={`inspection-bubble-row ${message.direction === "outgoing" ? "is-out" : "is-in"}`}
                >
                  <div className="inspection-bubble">{message.text}</div>
                  <span className="inspection-bubble-time">{message.timeLabel}</span>
                </div>
              ))}
            </div>
            {activeChat !== USER_THREAD_ID && (
              <div className="inspection-composer">
                <input
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) void handleSend();
                  }}
                  placeholder={`以 ${owner.name} 的身份发消息…`}
                  disabled={sending}
                />
                <button
                  type="button"
                  className="inspection-send-btn"
                  onClick={() => void handleSend()}
                  disabled={sending || !draft.trim()}
                  aria-label="发送"
                >
                  {sending ? <RefreshCw size={15} className="spin" /> : <Send size={15} strokeWidth={1.8} />}
                </button>
              </div>
            )}
          </div>
        )}

        {tab === "moments" && (
          <div className="inspection-moments">
            {momentCards.length === 0 && (
              <div className="inspection-empty-hint">还没有动态。</div>
            )}
            {momentCards.map(({ post, comments }) => (
              <article key={post.id} className="inspection-moment-card">
                <div className="inspection-moment-head">
                  <span className="inspection-moment-author">{nameOf(post.authorType, post.authorId)}</span>
                  <span className="inspection-moment-time">{formatDateLabel(post.createdAt)}</span>
                </div>
                {post.content && <p className="inspection-moment-text">{post.content}</p>}
                {post.photoUrl ? (
                  <div
                    className="inspection-moment-photo"
                    style={{ backgroundImage: `url("${post.photoUrl}")` }}
                  />
                ) : post.photoDescription ? (
                  <div className="inspection-moment-photo is-placeholder">{post.photoDescription}</div>
                ) : null}
                <div className="inspection-moment-meta">
                  <span>{post.likes.length} 赞</span>
                  <span>{comments.length} 评论</span>
                </div>
                {comments.length > 0 && (
                  <div className="inspection-moment-comments">
                    {comments.slice(0, 6).map(comment => (
                      <div key={comment.id} className="inspection-moment-comment">
                        <b>{nameOf(comment.authorType, comment.authorId, comment.authorName)}</b>：{comment.content}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

        {tab === "memos" && (
          <div className="inspection-memos">
            <MemoSection
              title="计划"
              icon={<StickyNote size={14} strokeWidth={1.8} />}
              items={state.memos.filter(memo => memo.category === "plan")}
              empty="没有写下来的计划。"
            />
            <MemoSection
              title="说不出口的话"
              icon={<MessageSquare size={14} strokeWidth={1.8} />}
              items={state.memos.filter(memo => memo.category === "unsaid")}
              empty="这里空空的。"
            />
          </div>
        )}

        {tab === "photos" && (
          <div className="inspection-photos">
            {state.photos.length === 0 && (
              <div className="inspection-empty-hint">相册是空的。</div>
            )}
            <div className="inspection-photo-grid">
              {state.photos.map(photo => (
                <figure key={photo.id} className={`inspection-photo tone-${photo.tone}`}>
                  <div className="inspection-photo-art">
                    <ImageIcon size={22} strokeWidth={1.4} />
                  </div>
                  <figcaption>
                    <div className="inspection-photo-title">{photo.title}</div>
                    {photo.caption && <div className="inspection-photo-caption">{photo.caption}</div>}
                    <div className="inspection-photo-meta">
                      {[photo.location, photo.timeLabel].filter(Boolean).join(" · ")}
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 悬浮发言气泡 */}
      <div className={`inspection-comment-bar${bubbleOpen ? " is-open" : ""}`}>
        {bubbleOpen ? (
          <div className="inspection-comment-card">
            <div className="inspection-comment-text">
              {bubbleLoading ? "…" : bubble || `${owner.name} 暂时没说话。`}
            </div>
            <button
              type="button"
              className="inspection-icon-btn"
              onClick={() => setBubbleOpen(false)}
              aria-label="收起发言"
            >
              <ChevronDown size={15} strokeWidth={1.8} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="inspection-comment-collapsed"
            onClick={() => setBubbleOpen(true)}
          >
            <MessageSquare size={14} strokeWidth={1.8} />
            {owner.name} 的发言
            <ChevronUp size={14} strokeWidth={1.8} />
          </button>
        )}
      </div>

      {/* 修改备注 */}
      {remarkEditing && (
        <div className="inspection-modal-mask" role="dialog" aria-label="修改备注">
          <div className="inspection-modal">
            <div className="inspection-modal-title">修改我在 ta 通讯录里的备注</div>
            <input
              className="inspection-modal-input"
              value={remarkDraft}
              maxLength={20}
              onChange={event => setRemarkDraft(event.target.value)}
              placeholder="留空则显示「我」"
              autoFocus
            />
            <div className="inspection-modal-actions">
              <button type="button" className="inspection-btn" onClick={() => setRemarkEditing(false)}>
                取消
              </button>
              <button type="button" className="inspection-btn inspection-btn-primary" onClick={saveRemark}>
                保存
              </button>
            </div>
            <button
              type="button"
              className="inspection-modal-close"
              onClick={() => setRemarkEditing(false)}
              aria-label="关闭"
            >
              <X size={16} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MemoSection({
  title,
  icon,
  items,
  empty,
}: {
  title: string;
  icon: ReactNode;
  items: InspectionMemo[];
  empty: string;
}) {
  return (
    <section className="inspection-memo-section">
      <div className="inspection-memo-title">
        {icon}
        {title}
        <span>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="inspection-empty-hint">{empty}</div>
      ) : (
        items.map(memo => (
          <div key={memo.id} className="inspection-memo-card">
            <div className="inspection-memo-card-title">{memo.title}</div>
            {memo.body && <div className="inspection-memo-card-body">{memo.body}</div>}
          </div>
        ))
      )}
    </section>
  );
}
