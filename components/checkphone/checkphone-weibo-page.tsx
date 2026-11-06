"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bell,
  ChevronLeft,
  House,
  RotateCcw,
  Eraser,
  UserRound,
  Plus,
  Search,
  MessageSquare,
  Mic,
  Smile,
  Star,
  ThumbsUp,
  MoreHorizontal,
  ChevronDown,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { CheckPhoneBilingualText, normalizeCheckPhoneText } from "@/components/checkphone/checkphone-bilingual-text";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import { ConfirmDialog } from "@/components/ui";
import type { Character } from "@/lib/character-types";
import type {
  CheckPhoneSnapshot,
  CheckPhoneWeiboPayload,
  CheckPhoneWeiboPost,
  CheckPhoneWeiboThread,
  CheckPhoneWeiboTone,
  CheckPhoneWeiboTopic,
} from "@/lib/checkphone-config";
import { generateCheckPhoneWeibo } from "@/lib/checkphone-engine";
import {
  clearPhoneSnapshot,
  loadPhoneSnapshot,
  savePhoneSnapshot,
} from "@/lib/checkphone-storage";
import {
  beginCheckPhoneRefresh,
  endCheckPhoneRefresh,
  isCheckPhoneRefreshing,
  subscribeCheckPhoneRefresh,
} from "@/lib/checkphone-refresh-tracker";
import { splitBilingualText } from "@/lib/bilingual-text";

type CheckPhoneWeiboPageProps = {
  character: Character;
  onBack: () => void;
};

type WeiboTabId = "home" | "trending" | "messages" | "profile";

const WEIBO_TABS: Array<{ id: WeiboTabId; label: string; icon: LucideIcon }> = [
  { id: "home", label: "微博", icon: House },
  { id: "trending", label: "发现", icon: Search },
  { id: "messages", label: "消息", icon: MessageSquare },
  { id: "profile", label: "我", icon: UserRound },
];

function formatCount(count: number): string {
  if (count >= 10000)
    return `${(count / 10000).toFixed(count >= 100000 ? 0 : 1).replace(/\.0$/, "")}万`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
}

function getThreadPreview(thread: CheckPhoneWeiboThread): string {
  const last = thread.messages[thread.messages.length - 1];
  return last?.text?.trim() || "";
}

function getWeiboListPlainText(text: string): string {
  const normalized = normalizeCheckPhoneText(text);
  return splitBilingualText(normalized)?.original ?? normalized;
}

function getThreadTime(thread: CheckPhoneWeiboThread): string {
  const last = thread.messages[thread.messages.length - 1];
  return last?.timeLabel || "";
}

function orderWeiboCommentsForDisplay(
  comments: CheckPhoneWeiboPost["comments"],
): CheckPhoneWeiboPost["comments"] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const indexById = new Map(comments.map((comment, index) => [comment.id, index]));
  const childrenByParent = new Map<string, CheckPhoneWeiboPost["comments"]>();
  const childIds = new Set<string>();

  function wouldCreateCycle(commentId: string, parentId: string) {
    const seen = new Set<string>([commentId]);
    let currentId = parentId;
    while (currentId) {
      if (seen.has(currentId)) return true;
      seen.add(currentId);
      currentId = byId.get(currentId)?.replyToCommentId || "";
    }
    return false;
  }

  comments.forEach((comment) => {
    const parentId = comment.replyToCommentId;
    if (!parentId || !byId.has(parentId) || wouldCreateCycle(comment.id, parentId)) return;
    childIds.add(comment.id);
    const children = childrenByParent.get(parentId) ?? [];
    children.push(comment);
    childrenByParent.set(parentId, children);
  });

  childrenByParent.forEach((children) => {
    children.sort((a, b) => (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0));
  });

  const ordered: CheckPhoneWeiboPost["comments"] = [];
  const visited = new Set<string>();
  function visit(comment: CheckPhoneWeiboPost["comments"][number]) {
    if (visited.has(comment.id)) return;
    visited.add(comment.id);
    ordered.push(comment);
    (childrenByParent.get(comment.id) ?? []).forEach(visit);
  }

  comments.filter((comment) => !childIds.has(comment.id)).forEach(visit);
  comments.forEach(visit);
  return ordered;
}

function WeiboMedia({
  icon,
  tone,
}: {
  icon: string;
  tone: CheckPhoneWeiboTone;
}) {
  return (
    <div className={`cp-weibo-media cp-weibo-media--${tone}`}>
      <span className="cp-weibo-media-icon">{icon}</span>
    </div>
  );
}

function WeiboRepostIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.5 5.8h7.8" />
      <path d="M4.5 5.8v13.7h13.7V11.7" />
      <path d="M10.8 13.2 18.2 5.8" />
      <path d="M15.7 5.8h2.5v2.5" />
    </svg>
  );
}

function WeiboPostCard({
  post,
  onOpen,
}: {
  post: CheckPhoneWeiboPost;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="cp-weibo-post-card"
      onClick={onOpen}
      style={{
        display: "block",
        width: "calc(100% + 32px)",
        background: "#fff",
        border: "none",
        borderRadius: 0,
        boxShadow: "none",
        textAlign: "left",
        padding: 0,
        margin: "0 -16px",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "12px 16px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            marginBottom: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "40px",
                height: "40px",
                borderRadius: "50%",
                background: "#f0f0f0",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "calc(16px*var(--app-text-scale,1))",
                color: "#666",
                position: "relative",
              }}
            >
              {post.authorName.slice(0, 1)}
              <div
                style={{
                  position: "absolute",
                  bottom: 0,
                  right: 0,
                  width: "14px",
                  height: "14px",
                  background: "#f46200",
                  borderRadius: "50%",
                  border: "1px solid #fff",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "calc(9px*var(--app-text-scale,1))",
                  fontWeight: "bold",
                }}
              >
                v
              </div>
            </div>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "2px" }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "6px" }}
              >
                <strong
                  style={{
                    fontSize: "calc(15px*var(--app-text-scale,1))",
                    color: "#f46200",
                    fontWeight: 500,
                  }}
                >
                  {post.authorName}
                </strong>
                {post.authorBadge && post.authorBadge !== "本人" && (
                  <span
                    style={{
                      fontSize: "calc(10px*var(--app-text-scale,1))",
                      background: "#fff6f0",
                      color: "#f46200",
                      padding: "1px 4px",
                      borderRadius: "2px",
                      border: "1px solid #f46200",
                    }}
                  >
                    {post.authorBadge}
                  </span>
                )}
              </div>
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#999" }}>来自 {post.tone === "graphite" ? "iPhone客户端" : "微博"}</div>
            </div>
          </div>
          <ChevronDown size={16} color="#ccc" />
        </div>

        <p
          style={{
            margin: "0 0 8px 0",
            fontSize: "calc(15px*var(--app-text-scale,1))",
            color: "#333",
            lineHeight: 1.5,
            wordBreak: "break-word",
          }}
        >
          <CheckPhoneBilingualText text={post.body} tone="weibo" />
        </p>

        {post.mediaIcon && (
          <div style={{ marginBottom: "12px" }}>
            <WeiboMedia icon={post.mediaIcon} tone={post.tone} />
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          borderTop: "1px solid #f5f5f5",
          padding: "10px 0",
        }}
      >
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
            color: "#666",
            fontSize: "calc(13px*var(--app-text-scale,1))",
          }}
        >
          <WeiboRepostIcon />
          <span>
            {post.repostCount > 0 ? formatCount(post.repostCount) : "转发"}
          </span>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
            color: "#666",
            fontSize: "calc(13px*var(--app-text-scale,1))",
            borderLeft: "1px solid #f5f5f5",
            borderRight: "1px solid #f5f5f5",
          }}
        >
          <MessageSquare size={16} />
          <span>
            {post.commentCount > 0 ? formatCount(post.commentCount) : "评论"}
          </span>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
            color: "#666",
            fontSize: "calc(13px*var(--app-text-scale,1))",
          }}
        >
          <ThumbsUp size={16} />
          <span>{post.likeCount > 0 ? formatCount(post.likeCount) : "赞"}</span>
        </div>
      </div>
    </button>
  );
}

export function CheckPhoneWeiboPage({
  character,
  onBack,
}: CheckPhoneWeiboPageProps) {
  const [snapshot, setSnapshot] =
    useState<CheckPhoneSnapshot<CheckPhoneWeiboPayload> | null>(null);
  const [selectedTab, setSelectedTab] = useState<WeiboTabId>("home");
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugRawOutput, setDebugRawOutput] = useState<string | null>(null);
  const [debugParseMode, setDebugParseMode] = useState<
    "raw" | "sanitized" | "failed" | null
  >(null);
  const [debugParseError, setDebugParseError] = useState<string | null>(null);
  const [debugNormalizeError, setDebugNormalizeError] = useState<string | null>(
    null,
  );
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refreshKey = `${character.id}:weibo`;
    setLoaded(false);
    setError(null);
    setSnapshot(null);
    setDebugRawOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    setSelectedTab("home");
    setSelectedPostId(null);
    setSelectedThreadId(null);
    // Reflect a refresh that's still running in the background (started before we
    // navigated away and came back), so the spinner keeps turning.
    setLoading(isCheckPhoneRefreshing(refreshKey));
    (async () => {
      const cached = await loadPhoneSnapshot<CheckPhoneWeiboPayload>(
        character.id,
        "weibo",
      );
      if (cancelled) return;
      setSnapshot(cached);
      setLoaded(true);
    })();
    // When the background refresh ends (possibly started by a previous mount),
    // stop the spinner and pull in the freshly-saved snapshot.
    const unsubscribe = subscribeCheckPhoneRefresh(() => {
      if (cancelled) return;
      const refreshing = isCheckPhoneRefreshing(refreshKey);
      setLoading(refreshing);
      if (!refreshing) {
        void loadPhoneSnapshot<CheckPhoneWeiboPayload>(character.id, "weibo").then((latest) => {
          if (!cancelled) setSnapshot(latest);
        });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [character.id]);

  async function handleRefresh() {
    const refreshKey = `${character.id}:weibo`;
    if (loading || isCheckPhoneRefreshing(refreshKey)) return;
    beginCheckPhoneRefresh(refreshKey);
    setLoading(true);
    setError(null);
    setDebugRawOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    try {
      const {
        payload,
        summary,
        error: nextError,
        debugRawOutput: nextDebugRawOutput,
        debugParseMode: nextDebugParseMode,
        debugParseError: nextDebugParseError,
        debugNormalizeError: nextDebugNormalizeError,
      } = await generateCheckPhoneWeibo(
        character.id,
        snapshot?.payload ?? null,
        snapshot?.updatedAt,
      );
      if (payload) {
        const now = new Date().toISOString();
        const nextSnapshot: CheckPhoneSnapshot<CheckPhoneWeiboPayload> = {
          id: `${character.id}:weibo`,
          characterId: character.id,
          appId: "weibo",
          generatedAt: snapshot?.generatedAt ?? now,
          updatedAt: now,
          summary,
          payload,
        };
        await savePhoneSnapshot(nextSnapshot);
        setSnapshot(nextSnapshot);
        setSelectedPostId(null);
        setSelectedThreadId(null);
      }
      setError(nextError ?? null);
      setDebugRawOutput(nextDebugRawOutput ?? null);
      setDebugParseMode(nextDebugParseMode ?? null);
      setDebugParseError(nextDebugParseError ?? null);
      setDebugNormalizeError(nextDebugNormalizeError ?? null);
      setLoaded(true);
    } finally {
      // Runs even if the page was unmounted mid-refresh; clears the global
      // in-flight flag so any (re)mounted page instance stops its spinner.
      endCheckPhoneRefresh(refreshKey);
      setLoading(false);
    }
  }

  async function handleClear() {
    if (loading) return;
    await clearPhoneSnapshot(character.id, "weibo");
    setSnapshot(null);
    setSelectedTab("home");
    setSelectedPostId(null);
    setSelectedThreadId(null);
    setError(null);
    setDebugRawOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    setLoaded(true);
    setConfirmClearOpen(false);
  }

  const payload = snapshot?.payload ?? null;
  const allPosts = useMemo(
    () => (payload ? [...payload.homePosts, ...payload.myPosts] : []),
    [payload],
  );
  const activePost = useMemo(
    () => allPosts.find((post) => post.id === selectedPostId) ?? null,
    [allPosts, selectedPostId],
  );
  const activePostComments = useMemo(
    () => (activePost ? orderWeiboCommentsForDisplay(activePost.comments) : []),
    [activePost],
  );
  const activeThread = useMemo(
    () =>
      payload?.messageThreads.find(
        (thread) => thread.id === selectedThreadId,
      ) ?? null,
    [payload, selectedThreadId],
  );

  const subtitle = activePost
    ? activePost.authorName
    : activeThread
      ? activeThread.tagLabel
      : selectedTab === "trending"
        ? "今天值得停留的话题"
        : selectedTab === "messages"
          ? "评论、@与站内私信"
          : selectedTab === "profile"
            ? payload?.profile.handle || "个人主页"
            : payload?.headerSubtitle || "正在刷新的话题";

  const backAction = activePost
    ? () => setSelectedPostId(null)
    : activeThread
      ? () => setSelectedThreadId(null)
      : onBack;

  function renderRootBackButton(color = "#333") {
    return (
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        style={{
          border: "none",
          background: "transparent",
          color,
          padding: 0,
          boxShadow: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ChevronLeft size={26} strokeWidth={2} />
      </button>
    );
  }

  function renderRootActions(color = "#333") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "16px",
        }}
      >
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading}
          aria-label="Refresh"
          style={{
            border: "none",
            background: "transparent",
            color,
            padding: 0,
            boxShadow: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <RotateCcw size={20} strokeWidth={2} className={loading ? "cp-spin" : ""} />
        </button>
        <button
          type="button"
          onClick={() => setConfirmClearOpen(true)}
          disabled={loading || !snapshot}
          aria-label="Clear"
          style={{
            border: "none",
            background: "transparent",
            color,
            padding: 0,
            boxShadow: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: loading || !snapshot ? 0.45 : 1,
          }}
        >
          <Eraser size={20} strokeWidth={2} />
        </button>
      </div>
    );
  }

  return (
    <div className="cp-weibo-module">
      <header
        className={`cp-weibo-appbar${!activePost && !activeThread && selectedTab === "trending" ? " cp-weibo-appbar--hero" : ""}`}
        style={{
          background:
            !activePost && !activeThread && selectedTab === "trending"
              ? "radial-gradient(circle at 18% 26%, rgba(255, 218, 105, 0.95) 0%, rgba(255, 178, 59, 0.64) 34%, transparent 66%), radial-gradient(circle at 76% 18%, rgba(255, 220, 92, 0.86) 0%, rgba(255, 151, 34, 0.48) 38%, transparent 72%), linear-gradient(150deg, #ffc94d 0%, #ff9829 45%, #f36522 100%)"
              : "#fff",
          borderBottom:
            (!activePost && !activeThread && selectedTab === "trending") ||
            (!activePost && !activeThread && selectedTab === "profile")
              ? "none"
              : "1px solid #f0f0f0",
          padding:
            !activePost && !activeThread && selectedTab === "trending"
              ? "calc(var(--cp-appbar-safe-top) + 10px) 16px 16px"
              : "var(--cp-appbar-safe-top) 16px 10px",
          minHeight:
            !activePost && !activeThread && selectedTab === "trending"
              ? "144px"
              : undefined,
          overflow: "hidden",
        }}
      >
        {activePost || activeThread ? (
          <>
            <button
              type="button"
              className="cp-float-back"
              onClick={backAction}
              aria-label="Back"
              style={{
                color: "#333",
                background: "transparent",
                boxShadow: "none",
                padding: 0,
              }}
            >
              <ChevronLeft size={26} strokeWidth={2} />
            </button>
            <div
              className="cp-weibo-header-stack"
              style={{ maxWidth: "calc(100% - 120px)" }}
            >
              <div
                className="cp-weibo-header-title"
                style={{
                  fontSize: "calc(16px*var(--app-text-scale,1))",
                  color: "#333",
                  fontWeight: 500,
                  maxWidth: "100%",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {activePost
                  ? "微博正文"
                  : activeThread
                    ? activeThread.name
                    : "微博"}
              </div>
            </div>
            <div
              className="cp-appbar-actions"
              style={{
                position: "static",
                gap: "12px",
                minWidth: "48px",
                justifyContent: "flex-end",
              }}
            >
              {activeThread ? (
                <button
                  type="button"
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    color: "#555",
                    fontSize: "calc(14px*var(--app-text-scale,1))",
                    lineHeight: 1,
                  }}
                >
                  设置
                </button>
              ) : (
                <MoreHorizontal size={24} color="#666" />
              )}
            </div>
          </>
        ) : selectedTab === "home" ? (
          <div
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              position: "relative",
            }}
          >
            {renderRootBackButton()}
            <div className="cp-dead-tab" style={{ display: "flex", gap: "24px", position: "absolute", left: "50%", transform: "translateX(-50%)" }}>
              <span
                style={{
                  fontSize: "calc(16px*var(--app-text-scale,1))",
                  color: "#333",
                  fontWeight: 600,
                  position: "relative",
                }}
              >
                推荐
                <div
                  style={{
                    position: "absolute",
                    bottom: "-6px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    width: "12px",
                    height: "3px",
                    background: "#f46200",
                    borderRadius: "2px",
                  }}
                />
              </span>
            </div>
            {renderRootActions()}
          </div>
        ) : selectedTab === "trending" ? (
          <div
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
              alignSelf: "stretch",
              alignItems: "center",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: "calc(var(--cp-appbar-safe-top) + 10px)",
                left: "16px",
              }}
            >
              {renderRootBackButton("#fff")}
            </div>
            <div
              style={{
                position: "absolute",
                top: "calc(var(--cp-appbar-safe-top) + 10px)",
                right: "16px",
              }}
            >
              {renderRootActions("#fff")}
            </div>
            <div
              style={{
                color: "#fff",
                fontSize: "calc(30px*var(--app-text-scale,1))",
                fontWeight: 800,
                fontStyle: "italic",
                lineHeight: 1,
                textShadow: "0 3px 12px rgba(189, 73, 0, 0.28)",
                letterSpacing: "0",
                paddingTop: "20px",
              }}
            >
              话题热搜
            </div>
          </div>
        ) : selectedTab === "messages" ? (
          <div
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              position: "relative",
            }}
          >
            {renderRootBackButton()}
            <div className="cp-dead-tab" style={{ display: "flex", gap: "24px", position: "absolute", left: "50%", transform: "translateX(-50%)" }}>
              <span
                style={{ fontSize: "calc(16px*var(--app-text-scale,1))", color: "#666", fontWeight: 400 }}
              >
                动态
              </span>
              <span
                style={{
                  fontSize: "calc(16px*var(--app-text-scale,1))",
                  color: "#333",
                  fontWeight: 600,
                  position: "relative",
                }}
              >
                消息
                <div
                  style={{
                    position: "absolute",
                    bottom: "-6px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    width: "12px",
                    height: "3px",
                    background: "#f46200",
                    borderRadius: "2px",
                  }}
                />
              </span>
            </div>
            {renderRootActions()}
          </div>
        ) : (
          <div
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "18px",
            }}
          >
            {renderRootBackButton()}
            {renderRootActions()}
          </div>
        )}
      </header>

      {loading && (
        <div
          className="cp-refresh-indicator cp-refresh-indicator--floating"
          aria-live="polite"
        >
          <span className="cp-refresh-indicator-text">正在刷新微博</span>
          <span className="cp-refresh-indicator-dots" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
          </span>
        </div>
      )}

      <div className="cp-weibo-body">
        {!loaded && <div className="cp-weibo-status">Syncing feed...</div>}

        {loaded && !payload && !loading && (
          <div className="cp-weibo-status cp-empty-copy">
            <p>暂无微博内容</p>
            <span className="cp-weibo-hint">点刷新同步首页热搜消息和个人主页</span>
          </div>
        )}

        {error ? (
          <CheckPhoneDebugErrorCard
            title="暂时无法解析微博内容。"
            error={error}
            debugParseMode={debugParseMode}
            debugParseError={debugParseError}
            debugNormalizeError={debugNormalizeError}
            debugRawOutput={debugRawOutput}
          />
        ) : null}

        {payload && !activePost && !activeThread && (
          <>
            <div
              className="cp-weibo-scroll"
              style={
                selectedTab === "trending" || selectedTab === "messages"
                  ? { padding: "0 0 96px", gap: 0 }
                  : undefined
              }
            >
              {selectedTab === "home" && (
                <section className="cp-weibo-feed">
                  {payload.homePosts.map((post) => (
                    <WeiboPostCard
                      key={post.id}
                      post={post}
                      onOpen={() => setSelectedPostId(post.id)}
                    />
                  ))}
                </section>
              )}

              {selectedTab === "trending" && (
                <section
                  className="cp-weibo-topic-list"
                  style={{ background: "#fff", gap: 0 }}
                >
                  <div
                    style={{
                      padding: "0 16px",
                      borderBottom: "1px solid #f0f0f0",
                      display: "flex",
                      gap: "24px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "calc(15px*var(--app-text-scale,1))",
                        color: "#333",
                        fontWeight: 600,
                        padding: "12px 0",
                        borderBottom: "2px solid #f46200",
                      }}
                    >
                      我的
                    </span>
                    <span
                      style={{
                        fontSize: "calc(15px*var(--app-text-scale,1))",
                        color: "#666",
                        padding: "12px 0",
                      }}
                    >
                      热搜
                    </span>
                    <span
                      style={{
                        fontSize: "calc(15px*var(--app-text-scale,1))",
                        color: "#666",
                        padding: "12px 0",
                      }}
                    >
                      社会
                    </span>
                    <span
                      style={{
                        fontSize: "calc(15px*var(--app-text-scale,1))",
                        color: "#666",
                        padding: "12px 0",
                      }}
                    >
                      科技
                    </span>
                  </div>
                  <div
                    style={{
                      padding: "8px 16px",
                      fontSize: "calc(12px*var(--app-text-scale,1))",
                      color: "#999",
                      background: "#f9f9f9",
                    }}
                  >
                    热搜雷达，发现你关心的热点
                  </div>
                  {payload.trendingTopics.map((topic, index) => (
                    <article
                      key={topic.id}
                      className="cp-weibo-topic-card"
	                      style={{
	                        display: "flex",
	                        alignItems: "center",
	                        padding: "13px 16px",
	                        borderBottom: "1px solid #f9f9f9",
	                        gap: "10px",
	                        borderRadius: 0,
	                        background: "#fff",
	                      }}
	                    >
                      <div
                        className="cp-weibo-topic-rank"
                        style={{
	                          color: index < 3 ? "#f46200" : "#f46200",
	                          fontSize: "calc(16px*var(--app-text-scale,1))",
	                          fontStyle: "italic",
	                          fontWeight: "bold",
		                          width: "22px",
		                          textAlign: "center",
		                          flex: "0 0 22px",
		                          height: "auto",
		                          borderRadius: 0,
		                          background: "transparent",
		                        }}
		                      >
                        {index + 1}
                      </div>
                      <div
                        className="cp-weibo-topic-body"
                        style={{
	                          flex: 1,
	                          minWidth: 0,
		                          display: "flex",
		                          flexDirection: "row",
		                          alignItems: "center",
		                          gap: "7px",
		                          flexWrap: "nowrap",
	                        }}
	                      >
                        <strong
                          className="cp-weibo-topic-title"
                          style={{
	                            color: "#333",
	                            flex: "1 1 auto",
	                            minWidth: 0,
	                            whiteSpace: "nowrap",
	                            overflow: "hidden",
	                            textOverflow: "ellipsis",
                          }}
                        >
                          <CheckPhoneBilingualText text={topic.title} tone="weibo" variant="inline" />
                        </strong>
	                        <span style={{ flex: "0 0 auto", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#999", whiteSpace: "nowrap" }}>
	                          {topic.heatLabel}
	                        </span>
                        {index % 3 === 0 && (
                          <span
                            style={{
                              background: "#ff4d4f",
	                              color: "#fff",
	                              fontSize: "calc(10px*var(--app-text-scale,1))",
	                              padding: "1px 4px",
	                              borderRadius: "2px",
	                              transform: "scale(0.9)",
	                              flex: "0 0 auto",
	                            }}
                          >
                            新
                          </span>
                        )}
                      </div>
                    </article>
                  ))}
                </section>
              )}

              {selectedTab === "messages" && (
                <section
	                  className="cp-weibo-panel"
	                  style={{ background: "#fff", gap: 0, borderRadius: 0 }}
	                >
	                  <div
	                    className="cp-weibo-message-overview"
	                    style={{
	                      display: "flex",
	                      flexDirection: "column",
	                      padding: 0,
	                      background: "#fff",
	                    }}
	                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
	                        padding: "8px 0",
                        borderBottom: "1px solid #f9f9f9",
                        gap: "12px",
                      }}
                    >
                      <div
                        style={{
                          width: "44px",
                          height: "44px",
                          borderRadius: "50%",
                          background: "#66a7e0",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          fontSize: "calc(24px*var(--app-text-scale,1))",
                          fontWeight: 400,
                        }}
                      >
                        @
                      </div>
                      <span
	                        style={{ fontSize: "calc(15px*var(--app-text-scale,1))", color: "#333", flex: 1 }}
                      >
                        @我的
                      </span>
                      <ChevronLeft
                        size={18}
                        color="#ccc"
                        style={{ transform: "rotate(180deg)" }}
                      />
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
	                        padding: "8px 0",
                        borderBottom: "1px solid #f9f9f9",
                        gap: "12px",
                      }}
                    >
                      <div
                        style={{
                          width: "44px",
                          height: "44px",
                          borderRadius: "50%",
                          background: "#75c789",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                        }}
                      >
                        <MessageSquare
                          size={22}
                          fill="white"
                          color="#75c789"
                          strokeWidth={1}
                        />
                      </div>
                      <span
	                        style={{ fontSize: "calc(15px*var(--app-text-scale,1))", color: "#333", flex: 1 }}
                      >
                        评论
                      </span>
                      <ChevronLeft
                        size={18}
                        color="#ccc"
                        style={{ transform: "rotate(180deg)" }}
                      />
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
	                        padding: "8px 0",
                        borderBottom: "1px solid #f9f9f9",
                        gap: "12px",
                      }}
                    >
                      <div
                        style={{
                          width: "44px",
                          height: "44px",
                          borderRadius: "50%",
                          background: "#ff9c3a",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                        }}
                      >
                        <ThumbsUp size={22} />
                      </div>
                      <span
	                        style={{ fontSize: "calc(15px*var(--app-text-scale,1))", color: "#333", flex: 1 }}
                      >
                        赞
                      </span>
                      <ChevronLeft
                        size={18}
                        color="#ccc"
                        style={{ transform: "rotate(180deg)" }}
                      />
                    </div>
                  </div>
                  <div
	                    className="cp-weibo-thread-list"
	                    style={{ padding: 0, background: "#fff" }}
	                  >
                    {payload.messageThreads.map((thread) => (
                      <button
                        key={thread.id}
                        type="button"
                        className="cp-weibo-thread-card"
                        onClick={() => setSelectedThreadId(thread.id)}
                        style={{
                          display: "flex",
                          alignItems: "center",
	                          padding: "8px 0",
                          borderBottom: "1px solid #f9f9f9",
                          gap: "12px",
                          background: "transparent",
	                          border: "none",
	                          borderRadius: 0,
                          width: "100%",
                          textAlign: "left",
                        }}
                      >
                        <div
                          style={{
                            width: "44px",
                            height: "44px",
                            borderRadius: "50%",
                            background: "#5a97d7",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#fff",
	                          }}
	                        >
	                          {thread.type === "group" ? (
	                            <Bell size={20} />
	                          ) : (
	                            <span style={{ fontSize: "calc(17px*var(--app-text-scale,1))", fontWeight: 500 }}>
	                              {thread.name.slice(0, 1)}
	                            </span>
	                          )}
	                        </div>
                        <div
                          className="cp-weibo-thread-meta"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            flexDirection: "column",
                            gap: "4px",
                          }}
                        >
                          <div
                            className="cp-weibo-thread-top"
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: "10px",
                              minWidth: 0,
                            }}
                          >
                            <strong
                              style={{
	                                fontSize: "calc(15px*var(--app-text-scale,1))",
                                color: "#333",
                                fontWeight: 400,
                                flex: "1 1 auto",
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {getWeiboListPlainText(thread.name)}
                            </strong>
	                            <time style={{ flex: "0 0 auto", fontSize: "calc(11px*var(--app-text-scale,1))", color: "#999" }}>
                              {getThreadTime(thread)}
                            </time>
                          </div>
                          <p
                            style={{
                              margin: 0,
	                              fontSize: "calc(12px*var(--app-text-scale,1))",
                              color: "#999",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {getWeiboListPlainText(getThreadPreview(thread))}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {selectedTab === "profile" && (
                <section
                  className="cp-weibo-profile"
                  style={{ background: "#f5f5f5", gap: 0 }}
                >
                  <div
                    style={{
                      width: "calc(100% + 32px)",
                      margin: "-14px -16px 0",
                      background: "#fff",
                      padding: "22px 0 0",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        padding: "0 14px",
                      }}
                    >
                      <div
                        style={{
                          width: "62px",
                          height: "62px",
                          borderRadius: "50%",
                          background: "#e8e8e8",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "calc(22px*var(--app-text-scale,1))",
                          color: "#555",
                          flex: "0 0 62px",
                        }}
                      >
                        {payload.profile.name.slice(0, 1)}
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            minWidth: 0,
                          }}
                        >
                          <strong
                            style={{
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontSize: "calc(16px*var(--app-text-scale,1))",
                              fontWeight: 700,
                              color: "#262626",
                              lineHeight: 1.16,
                            }}
                          >
                            {payload.profile.name}
                          </strong>
                          <span
                            style={{
                              flex: "0 0 auto",
                              borderRadius: "5px",
                              background:
                                "linear-gradient(90deg, #ffdc74 0%, #ff8f2d 100%)",
                              color: "#fff",
                              fontSize: "calc(9px*var(--app-text-scale,1))",
                              fontWeight: 700,
                              padding: "2px 4px",
                              lineHeight: 1,
                            }}
                          >
                            红包
                          </span>
                        </div>
                        <div
                          style={{
                            marginTop: "6px",
                            fontSize: "calc(12px*var(--app-text-scale,1))",
                            color: "#8b8b8b",
                            lineHeight: 1.2,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          简介：<CheckPhoneBilingualText text={payload.profile.bio || "暂无简介"} tone="weibo" />
                        </div>
                        <div
                          style={{
                            marginTop: "8px",
                            width: "fit-content",
                            borderRadius: "999px",
                            background: "#eef8ef",
                            color: "#63b36b",
                            padding: "4px 10px",
                            fontSize: "calc(12px*var(--app-text-scale,1))",
                            lineHeight: 1,
                            fontWeight: 500,
                          }}
                        >
                          在线 ›
                        </div>
                      </div>
                    </div>

                    <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(4, 1fr)",
                        padding: "22px 0 14px",
                        textAlign: "center",
                      }}
                    >
                      {[
                        ["微博", formatCount(payload.myPosts.length)],
                        ["视频", "0"],
                        ["关注", formatCount(payload.profile.followingCount)],
                        ["粉丝", formatCount(payload.profile.followerCount)],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <div
                            style={{
                              fontSize: "calc(16px*var(--app-text-scale,1))",
                              fontWeight: 700,
                              color: "#242424",
                              lineHeight: 1,
                            }}
                          >
                            {value}
                          </div>
                          <div
                            style={{
                              marginTop: "7px",
                              fontSize: "calc(11px*var(--app-text-scale,1))",
                              color: "#909090",
                              lineHeight: 1,
                            }}
                          >
                            {label}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div
                    style={{
                      width: "calc(100% + 32px)",
                      margin: "0 -16px",
                      background: "#fff",
                      padding: "14px 16px 10px",
                    }}
                  >
                    <div
                      style={{
                        height: "32px",
                        borderRadius: "999px",
                        background: "#f5f5f5",
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "0 12px",
                        color: "#9a9a9a",
                        fontSize: "calc(12px*var(--app-text-scale,1))",
                      }}
                    >
                      <Search size={14} strokeWidth={2} />
                      <span>搜索我的微博</span>
                    </div>
                  </div>
                  <div
                    className="cp-weibo-feed"
                    style={{
                      background: "#f5f5f5",
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    {payload.myPosts.map((post) => (
                      <WeiboPostCard
                        key={post.id}
                        post={post}
                        onOpen={() => setSelectedPostId(post.id)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>

            <nav
              className="cp-weibo-tabbar"
              aria-label="微博导航"
              style={{
                display: "flex",
                justifyContent: "space-around",
                background: "#fdfdfd",
                borderTop: "1px solid #f0f0f0",
                padding: "8px 0 calc(8px + env(safe-area-inset-bottom, 0px))",
              }}
            >
              {WEIBO_TABS.map((tab) => {
                const Icon = tab.icon;
                const active = selectedTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={`cp-weibo-tab ${active ? "is-active" : ""}`}
                    onClick={() => setSelectedTab(tab.id)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: "4px",
                      background: "transparent",
                      border: "none",
                      color: active ? "#333" : "#999",
                      padding: "0 12px",
                      boxShadow: "none",
                    }}
                  >
	                    <div>
	                      <Icon
	                        size={22}
	                        strokeWidth={active ? 2.5 : 2}
	                        color={active ? "#333" : "#666"}
	                      />
	                    </div>
                    <span
                      style={{
                        fontSize: "calc(10px*var(--app-text-scale,1))",
                        fontWeight: active ? 500 : 400,
                      }}
                    >
                      {tab.label}
                    </span>
                  </button>
                );
              })}
            </nav>
          </>
        )}

        {payload && activePost && (
          <div className="cp-weibo-scroll cp-weibo-scroll--detail">
            <article className="cp-weibo-post-detail">
              <WeiboPostCard post={activePost} onOpen={() => {}} />
              <div
                className="cp-weibo-comment-list"
                style={{
                  margin: "0 -16px",
                  background: "#fff",
                  borderTop: "2px solid #f2f2f2",
                  padding: "4px 16px 4px",
                }}
              >
                {activePostComments.length > 0 ? (
                  activePostComments.map((comment, index) => {
                    const isReply = Boolean(comment.replyToCommentId);
                    const previousComment = activePostComments[index - 1];
                    const followsParent =
                      isReply && previousComment?.id === comment.replyToCommentId;
                    const replyTargetName =
                      comment.replyTo ||
                      (comment.replyToCommentId
                        ? activePostComments.find((item) => item.id === comment.replyToCommentId)?.authorName ?? ""
                        : "");
                    return (
                    <div
                      key={comment.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: isReply
                          ? "24px minmax(0, 1fr)"
                          : "32px minmax(0, 1fr)",
                        gap: isReply ? "7px" : "9px",
                        marginLeft: isReply ? "42px" : 0,
                        padding: isReply
                          ? followsParent
                            ? "2px 0 4px"
                            : "7px 0 4px"
                          : "12px 0 6px",
                        borderTop:
                          index === 0 || isReply
                            ? "none"
                            : "1px solid #f2f2f2",
                      }}
                    >
                      <div
                        style={{
                          width: isReply ? "24px" : "32px",
                          height: isReply ? "24px" : "32px",
                          borderRadius: "50%",
                          background: "#f0f0f0",
                          color: "#777",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: isReply ? "11px" : "13px",
                          flexShrink: 0,
                        }}
                      >
                        {comment.authorName.slice(0, 1)}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "10px",
                            marginBottom: "5px",
                          }}
                        >
                          <strong
                            style={{
                              minWidth: 0,
                              overflow: "hidden",
                              color: index === 0 ? "#f46200" : "#5d6470",
                              fontSize: isReply ? "12px" : "13px",
                              fontWeight: 500,
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {comment.authorName}
                          </strong>
                          {index === 0 ? (
                            <span style={{ color: "#ff8a00", fontSize: "calc(11px*var(--app-text-scale,1))", fontWeight: 700 }}>首评</span>
                          ) : null}
                        </div>
                        <p
                          style={{
                            margin: 0,
                            color: "#222",
                            fontSize: isReply ? "13px" : "14px",
                            lineHeight: 1.48,
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {replyTargetName ? `回复 ${replyTargetName}：` : ""}
                          <CheckPhoneBilingualText text={comment.text} tone="weibo" variant="inline" />
                        </p>
                        <div
                          style={{
                            marginTop: isReply ? "6px" : "9px",
                            display: "flex",
                            alignItems: "center",
                            gap: "14px",
                            color: "#9a9a9a",
                            fontSize: "calc(11px*var(--app-text-scale,1))",
                          }}
                        >
                          <span>来自微博</span>
                          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                            <WeiboRepostIcon size={16} />
                          </span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                            <MessageSquare size={14} strokeWidth={1.7} />
                          </span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                            <ThumbsUp size={14} strokeWidth={1.7} />
                          </span>
                        </div>
                      </div>
                    </div>
                    );
                  })
                ) : (
                  <div
                    className="cp-weibo-mini-empty"
                    style={{
                      borderRadius: 0,
                      background: "#fff",
                      border: "none",
                      textAlign: "center",
                      color: "#999",
                    }}
                  >
                    这条微博暂时还没有评论。
                  </div>
                )}
              </div>
            </article>
          </div>
        )}

        {payload && activeThread && (
          <div
            className="cp-weibo-scroll cp-weibo-scroll--detail"
            style={{ padding: 0, gap: 0, background: "#ededee" }}
          >
            <article
              className="cp-weibo-thread-detail"
              style={{
                minHeight: "100%",
                display: "flex",
                flexDirection: "column",
                gap: 0,
                background: "#ededee",
              }}
            >
              <div
                style={{
                  flex: "1 1 auto",
                  padding: "24px 14px 112px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "13px",
                }}
              >
	                {activeThread.messages.map((message, index) => {
	                  const isOutgoing = message.direction === "outgoing";
	                  const showAuthorName = activeThread.type === "group";
	                  const showTime =
                    index === 0 ||
                    message.timeLabel !==
                      activeThread.messages[index - 1]?.timeLabel;
                  const avatarLabel = (
                    isOutgoing ? character.name : message.authorName
                  ).slice(0, 1);

                  return (
                    <div key={message.id} style={{ display: "contents" }}>
                      {showTime && (
                        <div
                          style={{
                            alignSelf: "center",
                            margin: "2px 0 7px",
                            color: "#9a9a9a",
                            fontSize: "calc(12px*var(--app-text-scale,1))",
                            lineHeight: 1,
                          }}
                        >
                          {message.timeLabel}
                        </div>
                      )}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: isOutgoing ? "flex-end" : "flex-start",
                          alignItems: "flex-start",
                          gap: "8px",
                        }}
                      >
                        {!isOutgoing && (
                          <div
                            aria-hidden="true"
                            style={{
                              width: "36px",
                              height: "36px",
                              flex: "0 0 36px",
                              borderRadius: "50%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              background: "#f08a56",
                              color: "#fff",
                              fontSize: "calc(14px*var(--app-text-scale,1))",
                              fontWeight: 600,
                            }}
                          >
                            {avatarLabel}
                          </div>
                        )}
	                        <div
	                          style={{
	                            maxWidth: "72%",
	                            display: "flex",
	                            flexDirection: "column",
	                            alignItems: isOutgoing ? "flex-end" : "flex-start",
	                          }}
	                        >
	                          {showAuthorName && (
	                            <div
	                              style={{
	                                margin: "0 2px 4px",
	                                color: "#8c8c8c",
	                                fontSize: "calc(11px*var(--app-text-scale,1))",
	                                lineHeight: 1,
	                              }}
	                            >
	                              {message.authorName}
	                            </div>
	                          )}
	                          <div
	                            style={{
	                              padding: "9px 12px",
	                              borderRadius: isOutgoing
	                                ? "16px 4px 16px 16px"
	                                : "4px 16px 16px 16px",
	                              background: isOutgoing ? "#3b9cff" : "#fff",
	                              color: isOutgoing ? "#fff" : "#222",
	                              fontSize: "calc(14px*var(--app-text-scale,1))",
	                              lineHeight: 1.45,
	                              whiteSpace: "pre-wrap",
	                              boxShadow: isOutgoing
	                                ? "none"
	                                : "0 1px 1px rgba(0, 0, 0, 0.04)",
	                            }}
	                          >
	                            <CheckPhoneBilingualText text={message.text} tone={isOutgoing ? "light" : "weibo"} variant="inline" />
	                          </div>
	                        </div>
                        {isOutgoing && (
                          <div
                            aria-hidden="true"
                            style={{
                              width: "36px",
                              height: "36px",
                              flex: "0 0 36px",
                              borderRadius: "50%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              background: "#ff6b9a",
                              color: "#fff",
                              fontSize: "calc(14px*var(--app-text-scale,1))",
                              fontWeight: 600,
                            }}
                          >
                            {avatarLabel}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  position: "sticky",
                  bottom: 0,
                  background: "#f7f7f7",
                  borderTop: "1px solid #dedede",
                  padding:
                    "8px 10px calc(10px + env(safe-area-inset-bottom, 0px))",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    overflowX: "auto",
                    paddingBottom: "8px",
                  }}
                >
                  {["星愿展馆", "晚上好", "续火花", "送爱心"].map((label) => (
                    <button
                      key={label}
                      type="button"
                      style={{
                        flex: "0 0 auto",
                        border: "1px solid #e0e0e0",
                        borderRadius: "999px",
                        background: "#fff",
                        padding: "6px 12px",
                        color: "#555",
                        fontSize: "calc(12px*var(--app-text-scale,1))",
                        lineHeight: 1,
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "32px minmax(0, 1fr) 30px 30px 30px",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <button
                    type="button"
                    aria-label="语音"
                    style={{
                      width: "32px",
                      height: "32px",
                      border: "none",
                      borderRadius: "50%",
                      background: "transparent",
                      color: "#222",
                      display: "grid",
                      placeItems: "center",
                      padding: 0,
                    }}
                  >
                    <Mic size={20} strokeWidth={1.9} />
                  </button>
                  <div
                    aria-hidden="true"
                    style={{
                      height: "36px",
                      borderRadius: "999px",
                      background: "#fff",
                      border: "1px solid #ececec",
                    }}
                  />
                  <Smile size={24} color="#222" strokeWidth={1.8} />
                  <span
                    style={{
                      position: "relative",
                      width: "30px",
                      height: "30px",
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    <Star size={24} color="#222" strokeWidth={1.8} />
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        top: "2px",
                        right: "2px",
                        width: "7px",
                        height: "7px",
                        borderRadius: "50%",
                        background: "#f04444",
                      }}
                    />
                  </span>
                  <Plus size={26} color="#222" strokeWidth={1.8} />
                </div>
              </div>
            </article>
          </div>
        )}
      </div>

      {confirmClearOpen && (
        <ConfirmDialog
          title="清空微博内容？"
          message="确认后会清空当前微博缓存。之后重新刷新时，不会再带入旧微博内容。"
          variant="danger"
          confirmLabel="确认清空"
          cancelLabel="取消"
          onConfirm={handleClear}
          onCancel={() => setConfirmClearOpen(false)}
        />
      )}
    </div>
  );
}
