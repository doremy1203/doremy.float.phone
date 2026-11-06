// lib/music-service.ts — Unified music search service (local + Netease Cloud Music API)

import { loadAllTracks, type MusicTrack } from "./music-storage";
import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";
import {
    DEFAULT_NETEASE_API_BASE,
    isDefaultNeteaseApiBase,
    normalizeMusicApiBaseUrl,
} from "./music-api-defaults";

// ── Netease API Config ──

export type MusicApiConfig = {
    baseUrl: string; // e.g. "https://your-api.vercel.app"
    enabled: boolean;
    version?: number;
};

const MUSIC_API_KEY = "ai_phone_music_api_v1";
const NETEASE_COOKIE_KEY = "ai_phone_netease_cookie_v1";
const MUSIC_API_CONFIG_VERSION = 2;
const NETEASE_REAL_IP = process.env.NEXT_PUBLIC_NETEASE_REAL_IP || "116.25.146.177";

function normalizeStoredMusicApiBaseUrl(baseUrl: string | undefined): string {
    const normalized = normalizeMusicApiBaseUrl(baseUrl || DEFAULT_NETEASE_API_BASE);
    return isDefaultNeteaseApiBase(normalized) ? DEFAULT_NETEASE_API_BASE : normalized;
}

export function loadMusicApiConfig(): MusicApiConfig {
    if (typeof window === "undefined") return { baseUrl: DEFAULT_NETEASE_API_BASE, enabled: true, version: MUSIC_API_CONFIG_VERSION };
    try {
        const raw = kvGet(MUSIC_API_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<MusicApiConfig>;
            return {
                baseUrl: normalizeStoredMusicApiBaseUrl(parsed.baseUrl),
                enabled: true,
                version: MUSIC_API_CONFIG_VERSION,
            };
        }
    } catch { /* ignore */ }
    return { baseUrl: DEFAULT_NETEASE_API_BASE, enabled: true, version: MUSIC_API_CONFIG_VERSION };
}

export function saveMusicApiConfig(config: MusicApiConfig): void {
    try {
        kvSet(MUSIC_API_KEY, JSON.stringify({
            baseUrl: normalizeStoredMusicApiBaseUrl(config.baseUrl),
            enabled: true,
            version: MUSIC_API_CONFIG_VERSION,
        }));
    } catch { /* ignore */ }
}

export function isNeteaseConfigured(): boolean {
    const cfg = loadMusicApiConfig();
    return !!cfg.baseUrl.trim();
}

// ── Cookie persistence for QR login auth ──

export function saveNeteaseCookie(cookie: string): void {
    try { kvSet(NETEASE_COOKIE_KEY, cookie); } catch { /* ignore */ }
}

export function loadNeteaseCookie(): string {
    if (typeof window === "undefined") return "";
    try { return kvGet(NETEASE_COOKIE_KEY) || ""; } catch { return ""; }
}

export function clearNeteaseCookie(): void {
    try { kvRemove(NETEASE_COOKIE_KEY); } catch { /* ignore */ }
}

/** Append saved cookie and mainland realIP to a Netease API URL as query parameters. */
function withNeteaseParams(url: string): string {
    const cookie = loadNeteaseCookie();
    try {
        const parsed = new URL(url);
        if (!parsed.searchParams.has("realIP")) parsed.searchParams.set("realIP", NETEASE_REAL_IP);
        if (cookie && !parsed.searchParams.has("cookie")) parsed.searchParams.set("cookie", cookie);
        return parsed.toString();
    } catch {
        const params: string[] = [];
        if (!/[?&]realIP=/.test(url)) params.push(`realIP=${encodeURIComponent(NETEASE_REAL_IP)}`);
        if (cookie && !/[?&]cookie=/.test(url)) params.push(`cookie=${encodeURIComponent(cookie)}`);
        if (params.length === 0) return url;
        return `${url}${url.includes("?") ? "&" : "?"}${params.join("&")}`;
    }
}

// ── Netease API Types ──

export type NeteaseSearchResult = {
    id: number;
    name: string;
    artists: string;
    album: string;
    duration: number; // ms
    coverUrl?: string;
};

export type NeteasePlaylistDetail = NeteasePlaylist & {
    description?: string;
    tags?: string[];
    playCount?: number;
    subscribedCount?: number;
    commentCount?: number;
    shareCount?: number;
    subscribed?: boolean;
};

export type NeteaseHotSearch = {
    keyword: string;
    score?: number;
    content?: string;
    iconType?: number;
};

export type NeteaseComment = {
    id: number;
    userName: string;
    avatarUrl?: string;
    content: string;
    likedCount: number;
    time: number;
    ipLocation?: string;
    replyCount?: number;
};

export type NeteaseCommentPage = {
    hotComments: NeteaseComment[];
    comments: NeteaseComment[];
    total: number;
    hasMore: boolean;
};

export type NeteaseArtist = {
    id: number;
    name: string;
    cover?: string;
    briefDesc?: string;
    musicSize: number;
    albumSize: number;
    fansCount?: number;
};

export type NeteaseAlbum = {
    id: number;
    name: string;
    coverUrl?: string;
    year?: string;
};

export type NeteaseUserDetail = {
    nickname: string;
    avatarUrl?: string;
    signature?: string;
    level?: number;
    listenSongs?: number;
    createDays?: number;
    follows?: number;
    followeds?: number;
};

export type NeteaseToplist = NeteasePlaylist & {
    updateFrequency?: string;
    tracks?: Array<{ first: string; second: string }>;
};

function mapSongToSearchResult(s: NeteaseApiRecord): NeteaseSearchResult {
    return {
        id: s.id ?? 0,
        name: s.name || "",
        artists: (s.ar || s.artists || []).map((a: NeteaseApiArtist) => a.name).filter(Boolean).join("/"),
        album: s.al?.name || s.album?.name || "",
        duration: s.dt || s.duration || 0,
        coverUrl: secureHttpUrl(s.al?.picUrl || s.album?.picUrl),
    };
}

// Netease returns http:// asset links (covers, audio); on the HTTPS site those
// trigger mixed-content warnings/blocks. Their CDN serves https fine.
function secureHttpUrl(url: string): string;
function secureHttpUrl(url: string | undefined): string | undefined;
function secureHttpUrl(url: string | undefined): string | undefined {
    return typeof url === "string" ? url.replace(/^http:\/\//, "https://") : url;
}

type NeteaseApiArtist = {
    id?: number;
    name?: string;
    nickname?: string;
    avatarUrl?: string;
    picUrl?: string;
};

type NeteaseApiAlbumInfo = { name?: string; picUrl?: string };
type NeteaseApiTrack = { first?: string; second?: string };
type NeteaseApiPicture = { originUrl?: string; pcSquareUrl?: string; squareUrl?: string };

type NeteaseApiRecord = {
    [key: string]: unknown;
    id?: number;
    name?: string;
    ar?: NeteaseApiArtist[];
    artists?: NeteaseApiArtist[];
    al?: NeteaseApiAlbumInfo;
    album?: NeteaseApiAlbumInfo;
    dt?: number;
    duration?: number;
    picUrl?: string;
    coverImgUrl?: string;
    coverUrl?: string;
    trackCount?: number;
    creator?: NeteaseApiArtist;
    subscribed?: boolean;
    playCount?: number;
    playcount?: number;
    specialType?: number;
    searchWord?: string;
    keyword?: string;
    score?: number;
    content?: string;
    iconType?: number;
    tracks?: NeteaseApiTrack[];
    updateFrequency?: string;
    description?: string;
    tags?: string[];
    subscribedCount?: number;
    commentCount?: number;
    shareCount?: number;
    commentId?: number;
    user?: NeteaseApiArtist;
    likedCount?: number;
    time?: number;
    ipLocation?: { location?: string };
    replyCount?: number;
    publishTime?: number;
    dj?: NeteaseApiArtist;
    programCount?: number;
    lastProgramName?: string;
    mainSong?: { id?: number; duration?: number };
    createTime?: number;
    listenerCount?: number;
    size?: number;
    eventTime?: number;
    json?: string;
    pics?: NeteaseApiPicture[];
    song?: NeteaseApiRecord;
    songInfo?: NeteaseApiRecord;
    data?: NeteaseApiRecord;
};

// ── API Calls ──

function neteaseBase(): string {
    const cfg = loadMusicApiConfig();
    const base = normalizeMusicApiBaseUrl(cfg.baseUrl);
    if (!base) return "";
    return base;
}

function resolveNeteaseRequestBase(baseUrl: string): string {
    const base = normalizeMusicApiBaseUrl(baseUrl || DEFAULT_NETEASE_API_BASE);
    return base;
}

/** Search songs via Netease API */
export async function searchNetease(query: string, limit = 20): Promise<NeteaseSearchResult[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/cloudsearch?keywords=${encodeURIComponent(query)}&limit=${limit}`));
        const data = await resp.json();
        const songs = data?.result?.songs;
        if (!Array.isArray(songs)) return [];
        return songs.map(mapSongToSearchResult);
    } catch (e) {
        console.warn("[MusicService] Netease search failed:", e);
        return [];
    }
}

export type NeteasePlayInfo = {
    url: string | null;
    /** true when the returned url is only a free-trial clip (usually 30s) */
    trial: boolean;
    /** human-readable reason when url is null */
    reason: string;
};

/** Get playable URL for a Netease song, with a concrete failure reason. */
export async function getNeteasePlayInfo(songId: number): Promise<NeteasePlayInfo> {
    const base = neteaseBase();
    if (!base) return { url: null, trial: false, reason: "音乐 API 未配置" };
    try {
        const resp = await fetch(withNeteaseParams(`${base}/song/url?id=${songId}`));
        const data = await resp.json();
        const d = data?.data?.[0];
        const url = d?.url;
        if (url && typeof url === "string") {
            // Netease returns http:// CDN links; on an HTTPS page the browser blocks
            // them as mixed content, so the audio never loads. The CDN serves https.
            return { url: url.replace(/^http:\/\//, "https://"), trial: !!d?.freeTrialInfo, reason: "" };
        }
        const fee = d?.fee;
        const loggedIn = !!loadNeteaseCookie();
        if (fee === 1) {
            return { url: null, trial: false, reason: loggedIn ? "VIP 歌曲，当前账号没有黑胶会员" : "VIP 歌曲，请先在设置中登录网易云账号" };
        }
        if (fee === 4) {
            return { url: null, trial: false, reason: "付费专辑歌曲，需购买后才能播放" };
        }
        // Ask check/music for a human-readable reason (e.g. 无版权)
        try {
            const chk = await fetch(withNeteaseParams(`${base}/check/music?id=${songId}&timestamp=${Date.now()}`)).then(r => r.json());
            const msg = chk?.message ? String(chk.message).replace(/^亲爱的[,，]?/, "").trim() : "";
            if (chk?.success === false && msg) return { url: null, trial: false, reason: msg };
        } catch { /* check endpoint unavailable — fall through */ }
        return { url: null, trial: false, reason: "该歌曲暂时无法播放" };
    } catch (e) {
        console.warn("[MusicService] Get play URL failed:", e);
        return { url: null, trial: false, reason: "网络异常，加载失败" };
    }
}

/** Get playable URL for a Netease song */
export async function getNeteasePlayUrl(songId: number): Promise<string | null> {
    const info = await getNeteasePlayInfo(songId);
    return info.url;
}

/** Get lyrics for a Netease song */
export async function getNeteaseLyrics(songId: number): Promise<string> {
    const base = neteaseBase();
    if (!base) return "";
    try {
        const resp = await fetch(withNeteaseParams(`${base}/lyric?id=${songId}`));
        const data = await resp.json();
        return data?.lrc?.lyric || "";
    } catch {
        return "";
    }
}

/** Get song detail (cover, artist ids, etc.) */
export async function getNeteaseSongDetail(songId: number): Promise<{ coverUrl?: string; name?: string; artists?: string; artistList?: { id: number; name: string }[]; album?: string } | null> {
    const base = neteaseBase();
    if (!base) return null;
    try {
        const resp = await fetch(withNeteaseParams(`${base}/song/detail?ids=${songId}`));
        const data = await resp.json();
        const song = data?.songs?.[0];
        if (!song) return null;
        return {
            coverUrl: secureHttpUrl(song.al?.picUrl),
            name: song.name,
            artists: (song.ar || []).map((a: NeteaseApiRecord) => a.name).join("/"),
            artistList: (song.ar || []).filter((a: NeteaseApiRecord) => a?.id && a?.name).map((a: NeteaseApiArtist) => ({ id: a.id, name: a.name })),
            album: song.al?.name || "",
        };
    } catch {
        return null;
    }
}

// ── QR Login ──

export async function getQrKey(baseUrl: string): Promise<string | null> {
    try {
        const url = resolveNeteaseRequestBase(baseUrl);
        const resp = await fetch(withNeteaseParams(`${url}/login/qr/key?timestamp=${Date.now()}`));
        const data = await resp.json();
        return data?.data?.unikey || null;
    } catch { return null; }
}

export async function getQrImage(baseUrl: string, key: string): Promise<string | null> {
    try {
        const url = resolveNeteaseRequestBase(baseUrl);
        const resp = await fetch(withNeteaseParams(`${url}/login/qr/create?key=${key}&qrimg=true&timestamp=${Date.now()}`));
        const data = await resp.json();
        return data?.data?.qrimg || null;
    } catch { return null; }
}

/** Check QR scan status: 800=expired, 801=waiting, 802=scanned, 803=authorized */
export async function checkQrStatus(baseUrl: string, key: string): Promise<{ code: number; message: string; nickname?: string; cookie?: string }> {
    try {
        const url = resolveNeteaseRequestBase(baseUrl);
        const resp = await fetch(withNeteaseParams(`${url}/login/qr/check?key=${key}&timestamp=${Date.now()}`));
        const data = await resp.json();
        return { code: data?.code || 0, message: data?.message || "", nickname: data?.profile?.nickname, cookie: data?.cookie };
    } catch (e) {
        return { code: 0, message: e instanceof Error ? e.message : "检查失败" };
    }
}

/** Check current login status */
export async function checkLoginStatus(baseUrl: string): Promise<{ loggedIn: boolean; nickname?: string }> {
    try {
        const url = resolveNeteaseRequestBase(baseUrl);
        const resp = await fetch(withNeteaseParams(`${url}/login/status?timestamp=${Date.now()}`));
        const data = await resp.json();
        const profile = data?.data?.profile;
        if (profile?.nickname) return { loggedIn: true, nickname: profile.nickname };
        return { loggedIn: false };
    } catch { return { loggedIn: false }; }
}

// ── User Playlists ──

export type NeteasePlaylist = {
    id: number;
    name: string;
    coverUrl: string;
    trackCount: number;
    creator: string;
    playCount?: number;
    subscribed?: boolean;
    specialType?: number;
};

/** Get current logged-in user's uid */
async function getLoginUid(): Promise<number | null> {
    const base = neteaseBase();
    if (!base) return null;
    try {
        const resp = await fetch(withNeteaseParams(`${base}/login/status?timestamp=${Date.now()}`));
        const data = await resp.json();
        return data?.data?.profile?.userId || null;
    } catch { return null; }
}

/** Fetch user's playlists */
export async function getUserPlaylists(): Promise<NeteasePlaylist[]> {
    const base = neteaseBase();
    if (!base) return [];
    const uid = await getLoginUid();
    if (!uid) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/user/playlist?uid=${uid}&timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.playlist || []).map((p: NeteaseApiRecord) => ({
            id: p.id,
            name: p.name,
            coverUrl: secureHttpUrl(p.coverImgUrl),
            trackCount: p.trackCount,
            creator: p.creator?.nickname || "",
            subscribed: !!p.subscribed,
            playCount: p.playCount,
            specialType: p.specialType,
        }));
    } catch { return []; }
}

/** Fetch tracks in a playlist */
export async function getPlaylistTracks(playlistId: number): Promise<NeteaseSearchResult[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/playlist/track/all?id=${playlistId}&timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.songs || []).map(mapSongToSearchResult);
    } catch { return []; }
}

export async function getDailyRecommendSongs(): Promise<NeteaseSearchResult[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/recommend/songs?timestamp=${Date.now()}`));
        const data = await resp.json();
        const songs = data?.data?.dailySongs || data?.recommend || [];
        return Array.isArray(songs) ? songs.map(mapSongToSearchResult) : [];
    } catch { return []; }
}

export async function getPersonalFm(): Promise<NeteaseSearchResult[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/personal_fm?timestamp=${Date.now()}`));
        const data = await resp.json();
        const songs = data?.data || [];
        return Array.isArray(songs) ? songs.map(mapSongToSearchResult) : [];
    } catch { return []; }
}

export async function getPersonalizedPlaylists(limit = 12): Promise<NeteasePlaylist[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/personalized?limit=${limit}&timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.result || []).map((p: NeteaseApiRecord) => ({
            id: p.id,
            name: p.name,
            coverUrl: secureHttpUrl(p.picUrl || p.coverImgUrl),
            trackCount: p.trackCount || 0,
            creator: p.creator?.nickname || "",
            playCount: p.playCount || p.playcount || 0,
        }));
    } catch { return []; }
}

export async function getRecommendResource(): Promise<NeteasePlaylist[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/recommend/resource?timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.recommend || []).map((p: NeteaseApiRecord) => ({
            id: p.id,
            name: p.name,
            coverUrl: secureHttpUrl(p.picUrl || p.coverImgUrl),
            trackCount: p.trackCount || 0,
            creator: p.creator?.nickname || "",
            playCount: p.playcount || p.playCount || 0,
        }));
    } catch { return []; }
}

export async function getHotSearchDetail(): Promise<NeteaseHotSearch[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/search/hot/detail?timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.data || []).map((item: NeteaseApiRecord) => ({
            keyword: item.searchWord || item.keyword || "",
            score: item.score,
            content: item.content,
            iconType: item.iconType,
        })).filter((item: NeteaseHotSearch) => item.keyword);
    } catch { return []; }
}

export async function getToplists(): Promise<NeteaseToplist[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/toplist/detail?timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.list || []).map((p: NeteaseApiRecord) => ({
            id: p.id,
            name: p.name,
            coverUrl: secureHttpUrl(p.coverImgUrl),
            trackCount: p.trackCount || p.tracks?.length || 0,
            creator: "",
            updateFrequency: p.updateFrequency,
            tracks: Array.isArray(p.tracks) ? p.tracks.slice(0, 3).map((t: NeteaseApiTrack) => ({
                first: t.first || "",
                second: t.second || "",
            })) : [],
        }));
    } catch { return []; }
}

export async function getPlaylistDetail(playlistId: number): Promise<NeteasePlaylistDetail | null> {
    const base = neteaseBase();
    if (!base) return null;
    try {
        const resp = await fetch(withNeteaseParams(`${base}/playlist/detail?id=${playlistId}&timestamp=${Date.now()}`));
        const data = await resp.json();
        const p = data?.playlist;
        if (!p) return null;
        return {
            id: p.id,
            name: p.name,
            coverUrl: secureHttpUrl(p.coverImgUrl),
            trackCount: p.trackCount || 0,
            creator: p.creator?.nickname || "",
            description: p.description || "",
            tags: Array.isArray(p.tags) ? p.tags : [],
            playCount: p.playCount,
            subscribedCount: p.subscribedCount,
            commentCount: p.commentCount,
            shareCount: p.shareCount,
            subscribed: !!p.subscribed,
        };
    } catch { return null; }
}

function mapComment(c: NeteaseApiRecord): NeteaseComment {
    return {
        id: c.commentId ?? c.id ?? 0,
        userName: c.user?.nickname || "网易云用户",
        avatarUrl: secureHttpUrl(c.user?.avatarUrl),
        content: c.content || "",
        likedCount: c.likedCount || 0,
        time: c.time || 0,
        ipLocation: c.ipLocation?.location || "",
        replyCount: c.replyCount || 0,
    };
}

/** Netease comment resource type: 0 = song, 2 = playlist */
export type NeteaseCommentResType = 0 | 2;

export async function getSongComments(songId: number, limit = 20): Promise<NeteaseComment[]> {
    const page = await getSongCommentPage(songId, 0, limit);
    return page.hotComments.length ? page.hotComments : page.comments;
}

/** Paged comments (song or playlist): hot comments arrive on the first page only. */
export async function getSongCommentPage(songId: number, offset = 0, limit = 20, resType: NeteaseCommentResType = 0): Promise<NeteaseCommentPage> {
    const base = neteaseBase();
    const empty: NeteaseCommentPage = { hotComments: [], comments: [], total: 0, hasMore: false };
    if (!base) return empty;
    try {
        const endpoint = resType === 2 ? "comment/playlist" : "comment/music";
        const resp = await fetch(withNeteaseParams(`${base}/${endpoint}?id=${songId}&limit=${limit}&offset=${offset}&timestamp=${Date.now()}`));
        const data = await resp.json();
        const mapList = (list: unknown) => (Array.isArray(list) ? list.map((comment: NeteaseApiRecord) => mapComment(comment)).filter(comment => comment.content) : []);
        return {
            hotComments: offset === 0 ? mapList(data?.hotComments) : [],
            comments: mapList(data?.comments),
            total: data?.total || 0,
            hasMore: !!data?.more,
        };
    } catch { return empty; }
}

/** Floor replies of a comment */
export async function getFloorComments(songId: number, parentCommentId: number, limit = 20, resType: NeteaseCommentResType = 0): Promise<NeteaseComment[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/comment/floor?parentCommentId=${parentCommentId}&id=${songId}&type=${resType}&limit=${limit}&timestamp=${Date.now()}`));
        const data = await resp.json();
        const comments = data?.data?.comments || [];
        return Array.isArray(comments) ? comments.map(mapComment).filter((c: NeteaseComment) => c.content) : [];
    } catch { return []; }
}

/** Post a comment on a song or playlist (requires Netease login cookie) */
export async function postSongComment(songId: number, content: string, resType: NeteaseCommentResType = 0): Promise<{ ok: boolean; message: string }> {
    const base = neteaseBase();
    if (!base) return { ok: false, message: "API 未配置" };
    if (!loadNeteaseCookie()) return { ok: false, message: "发送评论需要先登录网易云账号" };
    try {
        const resp = await fetch(withNeteaseParams(`${base}/comment?t=1&type=${resType}&id=${songId}&content=${encodeURIComponent(content)}&timestamp=${Date.now()}`));
        const data = await resp.json();
        if (data?.code === 200) return { ok: true, message: "评论已发送" };
        return { ok: false, message: data?.message || data?.msg || "发送失败" };
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "发送失败" };
    }
}

/** Subscribe / unsubscribe a playlist (requires Netease login cookie) */
export async function subscribePlaylist(playlistId: number, subscribe: boolean): Promise<{ ok: boolean; message: string }> {
    const base = neteaseBase();
    if (!base) return { ok: false, message: "API 未配置" };
    if (!loadNeteaseCookie()) return { ok: false, message: "收藏歌单需要先登录网易云账号" };
    try {
        const resp = await fetch(withNeteaseParams(`${base}/playlist/subscribe?t=${subscribe ? 1 : 2}&id=${playlistId}&timestamp=${Date.now()}`));
        const data = await resp.json();
        if (data?.code === 200) return { ok: true, message: subscribe ? "已收藏歌单" : "已取消收藏" };
        if (data?.code === 501) return { ok: true, message: "已收藏过这个歌单" };
        return { ok: false, message: data?.message || data?.msg || "操作失败" };
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "操作失败" };
    }
}

// ── Artist ──

export async function getArtistDetail(artistId: number): Promise<NeteaseArtist | null> {
    const base = neteaseBase();
    if (!base) return null;
    try {
        const [detailResp, fansResp] = await Promise.all([
            fetch(withNeteaseParams(`${base}/artist/detail?id=${artistId}&timestamp=${Date.now()}`)).then(r => r.json()),
            fetch(withNeteaseParams(`${base}/artist/follow/count?id=${artistId}&timestamp=${Date.now()}`)).then(r => r.json()).catch(() => null),
        ]);
        const artist = detailResp?.data?.artist;
        if (!artist) return null;
        return {
            id: artist.id,
            name: artist.name || "",
            cover: secureHttpUrl(artist.cover || artist.avatar),
            briefDesc: artist.briefDesc || "",
            musicSize: artist.musicSize || 0,
            albumSize: artist.albumSize || 0,
            fansCount: fansResp?.data?.fansCnt ?? fansResp?.fansCnt,
        };
    } catch { return null; }
}

export async function getArtistTopSongs(artistId: number): Promise<NeteaseSearchResult[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/artist/top/song?id=${artistId}&timestamp=${Date.now()}`));
        const data = await resp.json();
        const songs = data?.songs || [];
        return Array.isArray(songs) ? songs.map(mapSongToSearchResult) : [];
    } catch { return []; }
}

export async function getArtistAlbums(artistId: number, limit = 20): Promise<NeteaseAlbum[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/artist/album?id=${artistId}&limit=${limit}&timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.hotAlbums || []).map((a: NeteaseApiRecord) => ({
            id: a.id,
            name: a.name || "",
            coverUrl: secureHttpUrl(a.picUrl),
            year: a.publishTime ? String(new Date(a.publishTime).getFullYear()) : "",
        }));
    } catch { return []; }
}

// ── User detail (level / listen count) ──

export async function getUserDetail(): Promise<NeteaseUserDetail | null> {
    const base = neteaseBase();
    if (!base) return null;
    const uid = await getLoginUid();
    if (!uid) return null;
    try {
        const resp = await fetch(withNeteaseParams(`${base}/user/detail?uid=${uid}&timestamp=${Date.now()}`));
        const data = await resp.json();
        const profile = data?.profile;
        if (!profile) return null;
        return {
            nickname: profile.nickname || "",
            avatarUrl: secureHttpUrl(profile.avatarUrl),
            signature: profile.signature || "",
            level: data?.level,
            listenSongs: data?.listenSongs,
            createDays: data?.createDays,
            follows: profile.follows,
            followeds: profile.followeds,
        };
    } catch { return null; }
}

export async function getUserRecord(type: 0 | 1 = 1): Promise<NeteaseSearchResult[]> {
    const records = await getUserRecordWithCounts(type);
    return records.map(r => r.song);
}

export type NeteasePlayRecord = { song: NeteaseSearchResult; playCount: number };

/** Listening record with per-song play counts (type 1 = this week, 0 = all time) */
export async function getUserRecordWithCounts(type: 0 | 1 = 1): Promise<NeteasePlayRecord[]> {
    const base = neteaseBase();
    if (!base) return [];
    const uid = await getLoginUid();
    if (!uid) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/user/record?uid=${uid}&type=${type}&timestamp=${Date.now()}`));
        const data = await resp.json();
        const records = data?.weekData || data?.allData || [];
        if (!Array.isArray(records)) return [];
        return records
            .map((r: NeteaseApiRecord) => ({ song: mapSongToSearchResult(r.song || {}), playCount: r.playCount || 0 }))
            .filter((r: NeteasePlayRecord) => r.song.id);
    } catch { return []; }
}

// ── Track-to-Playlist mapping (localStorage) ──

const TRACK_PLAYLIST_MAP_KEY = "ai_phone_track_playlist_map_v1";
registerKvMigration(MUSIC_API_KEY);
registerKvMigration(NETEASE_COOKIE_KEY);
registerKvMigration(TRACK_PLAYLIST_MAP_KEY);

/** Load {neteaseTrackId → playlistId} mapping */
export function loadTrackPlaylistMap(): Record<string, number> {
    try {
        const raw = kvGet(TRACK_PLAYLIST_MAP_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

function saveTrackPlaylistMap(map: Record<string, number>): void {
    try { kvSet(TRACK_PLAYLIST_MAP_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

export function recordTrackPlaylist(trackId: number, playlistId: number): void {
    const map = loadTrackPlaylistMap();
    map[String(trackId)] = playlistId;
    saveTrackPlaylistMap(map);
}

export function removeTrackPlaylistRecord(trackId: number): void {
    const map = loadTrackPlaylistMap();
    delete map[String(trackId)];
    saveTrackPlaylistMap(map);
}

export function getTrackPlaylistId(trackId: number): number | null {
    const map = loadTrackPlaylistMap();
    return map[String(trackId)] ?? null;
}

/** Add tracks to a Netease playlist */
export async function addTracksToPlaylist(playlistId: number, trackIds: number[]): Promise<{ ok: boolean; message: string }> {
    const base = neteaseBase();
    if (!base) return { ok: false, message: "API 未配置" };
    try {
        const resp = await fetch(withNeteaseParams(`${base}/playlist/tracks?op=add&pid=${playlistId}&tracks=${trackIds.join(",")}&timestamp=${Date.now()}`));
        const data = await resp.json();
        if (data?.body?.code === 200 || data?.status === 200 || data?.code === 200) {
            return { ok: true, message: "已添加到歌单" };
        }
        if (data?.body?.code === 502) {
            return { ok: false, message: "歌曲已在歌单中" };
        }
        return { ok: false, message: data?.body?.message || data?.message || "添加失败" };
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "添加失败" };
    }
}

/** Remove tracks from a Netease playlist */
export async function removeTracksFromPlaylist(playlistId: number, trackIds: number[]): Promise<{ ok: boolean; message: string }> {
    const base = neteaseBase();
    if (!base) return { ok: false, message: "API 未配置" };
    try {
        const resp = await fetch(withNeteaseParams(`${base}/playlist/tracks?op=del&pid=${playlistId}&tracks=${trackIds.join(",")}&timestamp=${Date.now()}`));
        const data = await resp.json();
        if (data?.body?.code === 200 || data?.status === 200 || data?.code === 200) {
            return { ok: true, message: "已从歌单移除" };
        }
        return { ok: false, message: data?.body?.message || data?.message || "移除失败" };
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "移除失败" };
    }
}

/** Test Netease API connection */
export async function testNeteaseConnection(baseUrl: string): Promise<{ ok: boolean; message: string }> {
    try {
        const url = resolveNeteaseRequestBase(baseUrl);
        const resp = await fetch(withNeteaseParams(`${url}/search?keywords=test&limit=1`), { signal: AbortSignal.timeout(20000) });
        if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}` };
        const data = await resp.json();
        if (data?.result?.songs) return { ok: true, message: "连接成功" };
        return { ok: false, message: "返回格式异常" };
    } catch (e) {
        if (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError")) {
            return { ok: false, message: "连接超时，可能是服务冷启动或网络较慢" };
        }
        return { ok: false, message: e instanceof Error ? e.message : "连接失败" };
    }
}

// ── Unified Search ──

export type UnifiedSearchResult = {
    source: "local" | "netease";
    localTrack?: MusicTrack;
    neteaseResult?: NeteaseSearchResult;
    title: string;
    artist: string;
};

/** Search local library first, then Netease */
export async function unifiedSearch(query: string): Promise<UnifiedSearchResult[]> {
    const results: UnifiedSearchResult[] = [];
    const q = query.toLowerCase();

    // 1. Local search
    try {
        const tracks = await loadAllTracks();
        for (const t of tracks) {
            if (t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)) {
                results.push({ source: "local", localTrack: t, title: t.title, artist: t.artist });
            }
        }
    } catch { /* ignore */ }

    // 2. Netease search (if configured)
    if (isNeteaseConfigured()) {
        try {
            const online = await searchNetease(query, 15);
            for (const s of online) {
                results.push({ source: "netease", neteaseResult: s, title: s.name, artist: s.artists });
            }
        } catch { /* ignore */ }
    }

    return results;
}

/** Search for a specific song (by title-artist) and return the best match */
export async function findBestMatch(title: string, artist?: string): Promise<UnifiedSearchResult | null> {
    const query = artist ? `${title} ${artist}` : title;
    const results = await unifiedSearch(query);
    if (results.length === 0) return null;

    // Prefer local exact match
    const titleLower = title.toLowerCase();
    const localExact = results.find(r => r.source === "local" && r.title.toLowerCase() === titleLower);
    if (localExact) return localExact;

    // Return first result (local results come first)
    return results[0];
}

/**
 * Find best PLAYABLE match — tries each result until one has a valid play URL.
 * Falls back to findBestMatch if all fail.
 */
export async function findPlayableMatch(title: string, _artist?: string): Promise<{ result: UnifiedSearchResult; playUrl?: string } | null> {
    const results = await unifiedSearch(title);
    if (results.length === 0) return null;

    // Local tracks are always playable
    const titleLower = title.toLowerCase();
    const localExact = results.find(r => r.source === "local" && r.title.toLowerCase() === titleLower);
    if (localExact) return { result: localExact };
    const localAny = results.find(r => r.source === "local");
    if (localAny) return { result: localAny };

    // Try netease results one by one until we find a playable URL
    const neteaseResults = results.filter(r => r.source === "netease" && r.neteaseResult);
    for (const r of neteaseResults.slice(0, 5)) {
        const url = await getNeteasePlayUrl(r.neteaseResult!.id);
        if (url) return { result: r, playUrl: url };
    }

    return null;
}


// ── 「我的」页真数据接口（全部优雅降级：接口缺失/未登录返回空） ──

export type NeteaseDjRadio = {
    id: number;
    name: string;
    picUrl?: string;
    programCount?: number;
    dj?: string;
    lastProgramName?: string;
};

/** 订阅的播客电台 /dj/sublist */
export async function getDjSublist(): Promise<NeteaseDjRadio[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/dj/sublist?timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.djRadios || []).map((r: NeteaseApiRecord) => ({
            id: r.id,
            name: r.name || "",
            picUrl: secureHttpUrl(r.picUrl),
            programCount: r.programCount,
            dj: r.dj?.nickname || "",
            lastProgramName: r.lastProgramName || "",
        }));
    } catch { return []; }
}

export type NeteaseDjProgram = {
    id: number;
    name: string;
    mainSongId: number;
    duration: number;
    coverUrl?: string;
    createTime?: number;
    listenerCount?: number;
};

/** 电台节目列表 /dj/program（节目经 mainSong 走普通歌曲播放链路） */
export async function getDjPrograms(radioId: number, limit = 50): Promise<NeteaseDjProgram[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/dj/program?rid=${radioId}&limit=${limit}&timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.programs || []).map((p: NeteaseApiRecord) => ({
            id: p.id,
            name: p.name || "",
            mainSongId: p.mainSong?.id || 0,
            duration: p.mainSong?.duration || p.duration || 0,
            coverUrl: secureHttpUrl(p.coverUrl),
            createTime: p.createTime,
            listenerCount: p.listenerCount,
        })).filter((p: NeteaseDjProgram) => p.mainSongId);
    } catch { return []; }
}

export type NeteaseAlbumSub = {
    id: number;
    name: string;
    picUrl?: string;
    artist?: string;
    size?: number;
};

/** 收藏的专辑 /album/sublist */
export async function getAlbumSublist(): Promise<NeteaseAlbumSub[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/album/sublist?timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.data || []).map((a: NeteaseApiRecord) => ({
            id: a.id,
            name: a.name || "",
            picUrl: secureHttpUrl(a.picUrl),
            artist: (a.artists || []).map((x: NeteaseApiArtist) => x.name).filter(Boolean).join("/"),
            size: a.size,
        }));
    } catch { return []; }
}

/** 专辑曲目 /album */
export async function getAlbumTracks(albumId: number): Promise<NeteaseSearchResult[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/album?id=${albumId}&timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.songs || []).map(mapSongToSearchResult);
    } catch { return []; }
}

export type NeteaseUserEvent = {
    id: number;
    time?: number;
    text: string;
    pics: string[];
    song?: NeteaseSearchResult | null;
};

/** 用户动态（笔记）/user/event —— json 字段是字符串化的载荷 */
export async function getUserEvents(limit = 30): Promise<NeteaseUserEvent[]> {
    const base = neteaseBase();
    if (!base) return [];
    const uid = await getLoginUid();
    if (!uid) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/user/event?uid=${uid}&limit=${limit}&timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.events || []).map((ev: NeteaseApiRecord) => {
            let payload: NeteaseApiRecord = {};
            try { payload = JSON.parse(ev.json || "{}"); } catch { /* 保底空载荷 */ }
            const song = payload?.song ? mapSongToSearchResult(payload.song) : null;
            return {
                id: ev.id,
                time: ev.eventTime,
                text: typeof payload.msg === "string" ? payload.msg : "",
                pics: (ev.pics || []).map((p: NeteaseApiPicture) => secureHttpUrl(p.originUrl || p.pcSquareUrl || p.squareUrl)).filter(Boolean),
                song: song && song.id ? song : null,
            };
        }).filter((ev: NeteaseUserEvent) => ev.text || ev.pics.length > 0 || ev.song);
    } catch { return []; }
}

/** 真·最近播放（跨设备）/record/recent/song */
export async function getRecentSongs(limit = 100): Promise<NeteaseSearchResult[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/record/recent/song?limit=${limit}&timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.data?.list || []).map((item: NeteaseApiRecord) => mapSongToSearchResult(item.data || {})).filter((s: NeteaseSearchResult) => s.id);
    } catch { return []; }
}

/** 心动模式 /playmode/intelligence/list —— 以喜欢列表为底、种子歌曲展开的智能队列 */
export async function getIntelligenceList(seedSongId: number, likePlaylistId: number): Promise<NeteaseSearchResult[]> {
    const base = neteaseBase();
    if (!base) return [];
    try {
        const resp = await fetch(withNeteaseParams(`${base}/playmode/intelligence/list?id=${seedSongId}&pid=${likePlaylistId}&timestamp=${Date.now()}`));
        const data = await resp.json();
        return (data?.data || []).map((item: NeteaseApiRecord) => mapSongToSearchResult(item.songInfo || {})).filter((s: NeteaseSearchResult) => s.id);
    } catch { return []; }
}
