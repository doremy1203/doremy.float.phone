"use client";

import { useEffect, useMemo, useState } from "react";
import { useCheckPhoneRefresh } from "@/lib/checkphone-refresh-tracker";
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, PhoneCall, RefreshCw, Search, Trash2, UserRound, Voicemail } from "lucide-react";
import { CheckPhoneBilingualText } from "@/components/checkphone/checkphone-bilingual-text";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import { ConfirmDialog } from "@/components/ui";
import type { Character } from "@/lib/character-types";
import type {
  CheckPhoneCallDirection,
  CheckPhoneContactCard,
  CheckPhonePhonePayload,
  CheckPhoneSnapshot,
  CheckPhoneVoicemail,
} from "@/lib/checkphone-config";
import { formatChatUiTime } from "@/lib/chat-time";
import { generateCheckPhonePhone } from "@/lib/checkphone-engine";
import { clearPhoneSnapshot, loadPhoneSnapshot, savePhoneSnapshot } from "@/lib/checkphone-storage";
import { normalizeBilingualTextInput, splitBilingualText } from "@/lib/bilingual-text";

type CheckPhonePhonePageProps = {
  character: Character;
  onBack: () => void;
};

type PhoneTabId = "recents" | "contacts" | "voicemail";

const PHONE_TABS: Array<{ id: PhoneTabId; label: string; icon: typeof PhoneCall }> = [
  { id: "recents", label: "最近", icon: PhoneCall },
  { id: "contacts", label: "联系人", icon: UserRound },
  { id: "voicemail", label: "语音信箱", icon: Voicemail },
];

function getDirectionLabel(direction: CheckPhoneCallDirection): string {
  switch (direction) {
    case "incoming":
      return "来电";
    case "outgoing":
      return "去电";
    case "missed":
      return "未接";
    default:
      return "";
  }
}

function getDirectionClass(direction: CheckPhoneCallDirection): string {
  return direction === "missed" ? "is-missed" : "";
}

function getDirectionIcon(direction: CheckPhoneCallDirection) {
  switch (direction) {
    case "incoming":
      return <ArrowDownLeft size={12} strokeWidth={3} className="cp-call-flow-icon" />;
    case "outgoing":
      return <ArrowUpRight size={12} strokeWidth={3} className="cp-call-flow-icon" />;
    case "missed":
      return <ArrowDownLeft size={12} strokeWidth={3} className="cp-call-flow-icon cp-call-flow-icon--missed" />;
    default:
      return null;
  }
}

function getContactInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

function getPhoneListPlainText(text: string): string {
  const normalized = normalizeBilingualTextInput(text);
  return splitBilingualText(normalized)?.original ?? normalized;
}

function buildVoicemailPreview(transcript: string): string {
  const lines = getPhoneListPlainText(transcript)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const preview = (lines[0] ?? transcript.trim()).replace(/\s+/g, " ");
  return preview.length > 60 ? `${preview.slice(0, 57).trimEnd()}...` : preview;
}

export function CheckPhonePhonePage({ character, onBack }: CheckPhonePhonePageProps) {
  const [snapshot, setSnapshot] = useState<CheckPhoneSnapshot<CheckPhonePhonePayload> | null>(null);
  const [selectedTab, setSelectedTab] = useState<PhoneTabId>("recents");
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [selectedVoicemailId, setSelectedVoicemailId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useCheckPhoneRefresh(character.id, "phone", setSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [debugRawOutput, setDebugRawOutput] = useState<string | null>(null);
  const [debugSanitizedOutput, setDebugSanitizedOutput] = useState<string | null>(null);
  const [debugParseMode, setDebugParseMode] = useState<"raw" | "sanitized" | "failed" | null>(null);
  const [debugParseError, setDebugParseError] = useState<string | null>(null);
  const [debugNormalizeError, setDebugNormalizeError] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    setSnapshot(null);
    setSelectedTab("recents");
    setSelectedCallId(null);
    setSelectedContactId(null);
    setSelectedVoicemailId(null);
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    (async () => {
      const cached = await loadPhoneSnapshot<CheckPhonePhonePayload>(character.id, "phone");
      if (cancelled) return;
      setSnapshot(cached);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [character.id]);

  async function handleRefresh() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    const {
      payload,
      summary,
      error: nextError,
      debugRawOutput: nextDebugRawOutput,
      debugSanitizedOutput: nextDebugSanitizedOutput,
      debugParseMode: nextDebugParseMode,
      debugParseError: nextDebugParseError,
      debugNormalizeError: nextDebugNormalizeError,
    } = await generateCheckPhonePhone(
      character.id,
      snapshot?.payload ?? null,
      snapshot?.updatedAt,
    );
    if (payload) {
      const now = new Date().toISOString();
      const nextSnapshot: CheckPhoneSnapshot<CheckPhonePhonePayload> = {
        id: `${character.id}:phone`,
        characterId: character.id,
        appId: "phone",
        generatedAt: snapshot?.generatedAt ?? now,
        updatedAt: now,
        summary,
        payload,
      };
      await savePhoneSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
      setSelectedCallId(null);
      setSelectedContactId(null);
      setSelectedVoicemailId(null);
    }
    setError(nextError ?? null);
    setDebugRawOutput(nextDebugRawOutput ?? null);
    setDebugSanitizedOutput(nextDebugSanitizedOutput ?? null);
    setDebugParseMode(nextDebugParseMode ?? null);
    setDebugParseError(nextDebugParseError ?? null);
    setDebugNormalizeError(nextDebugNormalizeError ?? null);
    setLoading(false);
    setLoaded(true);
  }

  async function handleClear() {
    if (loading) return;
    await clearPhoneSnapshot(character.id, "phone");
    setSnapshot(null);
    setSelectedTab("recents");
    setSelectedCallId(null);
    setSelectedContactId(null);
    setSelectedVoicemailId(null);
    setError(null);
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    setLoaded(true);
    setConfirmClearOpen(false);
  }

  const payload = snapshot?.payload ?? null;
  const sq = searchQuery.trim().toLowerCase();

  const filteredRecents = useMemo(() => {
    const list = payload?.recents ?? [];
    if (!sq) return list;
    return list.filter((r) => r.name.toLowerCase().includes(sq));
  }, [payload, sq]);

  const filteredContacts = useMemo(() => {
    const list = payload?.contacts ?? [];
    if (!sq) return list;
    return list.filter((c) => c.name.toLowerCase().includes(sq) || c.tagLabel.toLowerCase().includes(sq) || c.note.toLowerCase().includes(sq));
  }, [payload, sq]);

  const filteredVoicemails = useMemo(() => {
    const list = payload?.voicemails ?? [];
    if (!sq) return list;
    return list.filter((v) => v.name.toLowerCase().includes(sq) || v.transcript.toLowerCase().includes(sq));
  }, [payload, sq]);

  const latestCallByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of payload?.recents ?? []) {
      if (!map.has(item.name)) map.set(item.name, item.createdAt);
    }
    return map;
  }, [payload]);

  const subtitle = selectedTab === "recents" 
    ? "最近联络与未接来电" 
    : selectedTab === "contacts" 
      ? "通讯录与特工档案" 
      : "语音留言归档";

  const backAction = onBack;

  return (
    <div className="cp-phone-module">
      <header className="cp-phone-cyber-header">
        <div className="cp-phone-cyber-header--compact">
          <div className="cp-cyber-header-left">
            <button type="button" className="cp-cyber-btn" onClick={backAction} aria-label="Back">
              <ChevronLeft size={20} strokeWidth={2.5} />
            </button>
          </div>

          <div className="cp-cyber-title-stack">
            <div className="cp-cyber-title-row">
              <i className="cp-cyber-blink"></i>
              <span className="cp-cyber-title">{payload?.headerTitle || "COMM_LINK"}</span>
            </div>
            <div className="cp-cyber-subtitle">{subtitle}</div>
          </div>

          <div className="cp-cyber-header-right">
            <div className="cp-cyber-actions">
              <button type="button" className="cp-cyber-btn" onClick={handleRefresh} disabled={loading} aria-label="Refresh">
                <RefreshCw size={16} strokeWidth={2.5} className={loading ? "cp-spin" : ""} />
              </button>
              <button
                type="button"
                className="cp-cyber-btn cp-cyber-btn--danger"
                onClick={() => setConfirmClearOpen(true)}
                disabled={loading || !snapshot}
                aria-label="Clear phone snapshot"
              >
                <Trash2 size={16} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
        
        <div className="cp-cyber-status-bar">
          <span className="cp-cyber-mini-text">[ SYS.OP : 0xFV ]</span>
          <span className="cp-cyber-mini-text">LAT 35.41°N // LON 139.46°E</span>
        </div>
      </header>

      {loading && (
        <div className="cp-refresh-indicator cp-refresh-indicator--floating" aria-live="polite">
          <span className="cp-refresh-indicator-text">正在刷新电话</span>
          <span className="cp-refresh-indicator-dots" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
        </div>
      )}

      <div className="cp-phone-body">
        {!loaded && <div className="cp-phone-status">Syncing call logs...</div>}

        {loaded && !payload && !loading && (
          <div className="cp-phone-status cp-empty-copy">
            <p>暂无电话内容</p>
            <span className="cp-phone-hint">点刷新同步最近通话联系人和语音留言</span>
          </div>
        )}

        {error ? (
          <CheckPhoneDebugErrorCard
            title="暂时无法解析电话内容。"
            error={error}
            debugParseMode={debugParseMode}
            debugParseError={debugParseError}
            debugNormalizeError={debugNormalizeError}
            debugRawOutput={debugRawOutput}
            debugSanitizedOutput={debugSanitizedOutput}
          />
        ) : null}

        {payload && (
          <>
            <div className="cp-phone-scroll">
              <div className="cp-app-searchbar">
                <Search size={14} strokeWidth={2.2} />
                <input
                  className="cp-app-searchbar-input"
                  type="text"
                  placeholder="搜索联系人或电话号码"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              {selectedTab === "recents" && (
                <div className="cp-phone-list">
                  {filteredRecents.map((item) => {
                    const isExpanded = selectedCallId === item.id;
                    return (
                    <div key={item.id} className={`cp-accordion-wrapper ${isExpanded ? "is-expanded" : ""}`}>
                      <button
                        type="button"
                        className={`cp-phone-call-card cp-phone-call-card--${item.direction} ${isExpanded ? "is-active" : ""}`}
                        onClick={() => setSelectedCallId(isExpanded ? null : item.id)}
                      >
                        <div className="cp-phone-avatar">{getContactInitial(item.name)}</div>
                        <div className="cp-phone-call-meta">
                          <div className="cp-phone-call-top">
                            <strong>{item.name}</strong>
                            <time><span className="cp-cyber-deco">[T]</span> {formatChatUiTime(item.createdAt)}</time>
                          </div>
                          <div className={`cp-phone-call-mid ${getDirectionClass(item.direction)}`}>
                            {getDirectionIcon(item.direction)}
                            <span className="cp-cyber-deco">{item.direction === "incoming" ? "IN //" : item.direction === "outgoing" ? "OUT //" : "MISS //"}</span>
                            <span>{getDirectionLabel(item.direction)}</span>
                            {item.durationLabel !== getDirectionLabel(item.direction) && (
                              <em>{item.durationLabel}</em>
                            )}
                          </div>
                          <p><span className="cp-cyber-deco">LOG:</span> {getPhoneListPlainText(item.summary)}</p>
                        </div>
                      </button>

                      <div className="cp-accordion-content">
                        <div className="cp-accordion-inner">
                          <div className="cp-phone-memo">
                            <span className="cp-memo-tape"></span>
                            <span className="cp-memo-title">{"// TRANSCRIPT_LOG"}</span>
                            <p className="cp-memo-body"><CheckPhoneBilingualText text={item.summary} tone="phone" /></p>
                          </div>
                          <div className="cp-phone-memo cp-phone-memo--thought">
                            <span className="cp-memo-tape cp-memo-tape--thought"></span>
                            <span className="cp-memo-title">{"// INNER_RESONANCE"}</span>
                            <p className="cp-memo-body cp-memo-body--italic"><CheckPhoneBilingualText text={item.innerThought} tone="phone" /></p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )})}
                </div>
              )}

              {selectedTab === "contacts" && (
                <div className="cp-phone-list">
                  {filteredContacts.map((item) => {
                    const isExpanded = selectedContactId === item.id;
                    return (
                    <div key={item.id} className={`cp-accordion-wrapper ${isExpanded ? "is-expanded" : ""}`}>
                      <button
                        type="button"
                        className={`cp-phone-contact-card ${isExpanded ? "is-active" : ""}`}
                        onClick={() => setSelectedContactId(isExpanded ? null : item.id)}
                      >
                        <div className="cp-phone-avatar">{getContactInitial(item.name)}</div>
                        <div className="cp-phone-contact-meta">
                          <div className="cp-phone-call-top">
                            <strong>{item.name}</strong>
                            <time>{latestCallByName.has(item.name) ? <><span className="cp-cyber-deco">[T]</span> {formatChatUiTime(latestCallByName.get(item.name) || "")}</> : ""}</time>
                          </div>
                          <div className="cp-phone-contact-tags">
                            <span className="cp-cyber-deco">TAG //</span>
                            <span>{item.tagLabel}</span>
                            <em>{item.accentLabel}</em>
                          </div>
                          <p><span className="cp-cyber-deco">MEMO:</span> {getPhoneListPlainText(item.note)}</p>
                        </div>
                      </button>
                      
                      <div className="cp-accordion-content">
                        <div className="cp-accordion-inner">
                          <div className="cp-phone-memo cp-phone-memo--contact">
                            <span className="cp-memo-tape"></span>
                            <span className="cp-memo-title">{"// DIRECTIVE_NOTE"}</span>
                            <p className="cp-memo-body cp-memo-body--italic"><CheckPhoneBilingualText text={item.note} tone="phone" /></p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )})}
                </div>
              )}

              {selectedTab === "voicemail" && (
                <div className="cp-phone-list">
                  {filteredVoicemails.map((item) => {
                    const isExpanded = selectedVoicemailId === item.id;
                    return (
                    <div key={item.id} className={`cp-accordion-wrapper ${isExpanded ? "is-expanded" : ""}`}>
                      <button
                        type="button"
                        className={`cp-phone-voicemail-card ${isExpanded ? "is-active" : ""}`}
                        onClick={() => setSelectedVoicemailId(isExpanded ? null : item.id)}
                      >
                        <div className="cp-phone-call-top">
                          <strong>{item.name}</strong>
                          <time><span className="cp-cyber-deco">[T]</span> {formatChatUiTime(item.createdAt)}</time>
                        </div>
                        <div className="cp-phone-call-mid">
                          <span className="cp-cyber-deco">V-MAIL //</span>
                          <span>留存</span>
                          <em>{item.durationLabel}</em>
                        </div>
                        <p><span className="cp-cyber-deco">SCRIPT:</span> {buildVoicemailPreview(item.transcript)}</p>
                      </button>

                      <div className="cp-accordion-content">
                        <div className="cp-accordion-inner">
                          <div className="cp-phone-memo">
                            <span className="cp-memo-tape"></span>
                            <span className="cp-memo-title">{"// VOICEMAIL_TRANSCRIPT"}</span>
                            <p className="cp-memo-body"><CheckPhoneBilingualText text={item.transcript} tone="phone" /></p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )})}
                </div>
              )}
            </div>
          </>
        )}

        <nav className="cp-phone-tabbar" aria-label="电话导航">
          {PHONE_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = selectedTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                className={`cp-phone-tab ${active ? "is-active" : ""}`}
                onClick={() => {
                  setSelectedTab(tab.id);
                  setSelectedCallId(null);
                  setSelectedContactId(null);
                  setSelectedVoicemailId(null);
                }}
              >
                <Icon size={16} strokeWidth={2.1} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
      {confirmClearOpen && (
        <ConfirmDialog
          title="清空电话内容？"
          message="确认后会清空当前电话缓存。之后重新刷新时，不会再带入旧电话内容。"
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
