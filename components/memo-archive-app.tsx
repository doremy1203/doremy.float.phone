"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  ArrowLeft, Archive, BookOpen, CheckCircle2, ChevronDown, Copy, Folder, FolderPlus,
  House, MoreHorizontal, Pin, Plus, Search, Settings2, Share2, Trash2, X
} from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import {
  createMemoFolder, deleteMemoFolder, updateMemoFolder, exportMemoArchive,
  importMemoArchive, loadMemoArchive, moveMemoToRecycleBin,
  permanentlyDeleteMemo, restoreMemo, saveMemoNote, setMemoShare,
  getMemoReviewIntervalHours, getMemoReviewStatus, loadMemoMaintenanceHistory, setMemoReviewIntervalHours, forceMemoReviewOnNextChat,
  type MemoFolder, type MemoNote, type MemoOwner
} from "@/lib/memo-archive-storage";
import styles from "./memo-archive-app.module.css";

type Props = { onClose: () => void; onNotice?: (message: string) => void };
type Tab = "home" | "notes" | "todos" | "categories" | "settings" | "archived" | "recycle";
const USER: MemoOwner = { type: "user", id: "local-user" };
const MEMO_RICH_PREFIX = "<!--memo-rich-v1-->";
const sanitizeMemoHtml = (html: string) => DOMPurify.sanitize(html, {
  ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "del", "h1", "h2", "h3", "blockquote", "ul", "ol", "li", "a", "span", "div"],
  ALLOWED_ATTR: ["href", "title", "target", "rel", "data-type", "data-checked"],
});
const memoBodyHtml = (value: string) => sanitizeMemoHtml(value.startsWith(MEMO_RICH_PREFIX)
  ? value.slice(MEMO_RICH_PREFIX.length)
  : String(marked.parse(value || "", { async: false })));
const memoBodyPlainText = (value: string) => {
  const node = document.createElement("div");
  node.innerHTML = memoBodyHtml(value);
  return node.textContent || "";
};
const date = (time: number) => new Date(time).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
const time = (stamp: number) => new Date(stamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export function MemoArchiveApp({ onClose, onNotice }: Props) {
  const [owner, setOwner] = useState<MemoOwner>(() => {
    try {
      const raw = localStorage.getItem("ai_phone_memo_owner_v1");
      if (raw) {
        const parsed = JSON.parse(raw) as { type?: string; id?: string };
        if (parsed && (parsed.type === "user" || parsed.type === "character") && parsed.id) {
          return { type: parsed.type, id: parsed.id } as MemoOwner;
        }
      }
    } catch { /* 读不到就用默认 */ }
    return USER;
  });
  const [characters, setCharacters] = useState<ReturnType<typeof loadCharacters>>([]);
  const [folders, setFolders] = useState<MemoFolder[]>([]);
  const [notes, setNotes] = useState<MemoNote[]>([]);
  const [tab, setTab] = useState<Tab>("home");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoNote | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [title, setTitle] = useState("");
  const editorRef = useRef<HTMLDivElement | null>(null);
  const editorInitialBodyRef = useRef("");
  const [tags, setTags] = useState("");
  const [pinned, setPinned] = useState(false);
  const [todos, setTodos] = useState<MemoNote["todos"]>([]);
  const [todoText, setTodoText] = useState("");
  const [noteFolderId, setNoteFolderId] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderColor, setFolderColor] = useState("#d8c8ae");
  const [categoryEditId, setCategoryEditId] = useState<string | null>(null);
  const [categoryEditName, setCategoryEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState("botanical");
  const [font, setFont] = useState("serif");
  const [fontSize, setFontSize] = useState("16");
  const [lineHeight, setLineHeight] = useState("1.8");
  const [paperWidth, setPaperWidth] = useState("normal");
  const [reviewHours, setReviewHours] = useState(24);
  const [reviewRefreshKey, setReviewRefreshKey] = useState(0);
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [spaceMenu, setSpaceMenu] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [bulkFolderId, setBulkFolderId] = useState("");

  const refresh = useCallback(async () => {
    const data = await loadMemoArchive(owner, tab === "recycle");
    setFolders(data.folders);
    setNotes(data.notes);
  }, [owner, tab]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { try { setCharacters(loadCharacters()); } catch { setCharacters([]); } }, []);
  useEffect(() => {
    setReviewHours(owner.type === "character" ? getMemoReviewIntervalHours(owner.id) : 24);
    try {
      setTheme(localStorage.getItem("memo-archive-theme:" + owner.type + ":" + owner.id) || "botanical");
      const raw = localStorage.getItem("memo-archive-appearance:" + owner.type + ":" + owner.id);
      const value = raw ? JSON.parse(raw) : {};
      setFont(["serif", "sans", "mono"].includes(value.font) ? value.font : "serif");
      setFontSize(["14", "16", "18"].includes(value.fontSize) ? value.fontSize : "16");
      setLineHeight(["1.6", "1.8", "2"].includes(value.lineHeight) ? value.lineHeight : "1.8");
      setPaperWidth(value.paperWidth === "compact" ? "compact" : "normal");
    } catch { /* use defaults */ }
    setSelectedId(null);
    setEditing(null);
    setEditorOpen(false);
    setCategoryFilter("all");
  }, [owner]);

  useEffect(() => {
    if (editorOpen && editorRef.current) editorRef.current.innerHTML = memoBodyHtml(editorInitialBodyRef.current);
  }, [editorOpen, editing?.id]);

  const selected = notes.find(note => note.id === selectedId) ?? null;
  const visible = useMemo(() => notes.filter(note => {
    if (tab !== "recycle" && note.deletedAt) return false;
    if (tab === "recycle" && !note.deletedAt) return false;
    if (tab === "archived" && !note.archived) return false;
    if (tab !== "recycle" && tab !== "archived" && note.archived) return false;
    if (categoryFilter !== "all" && note.folderId !== categoryFilter) return false;
    const q = query.trim().toLocaleLowerCase();
    return !q || (note.title + " " + memoBodyPlainText(note.body) + " " + note.tags.join(" ")).toLocaleLowerCase().includes(q);
  }), [notes, query, categoryFilter, tab]);
  const activeTodos = notes.flatMap(note => note.todos.filter(todo => !todo.done).map(todo => ({ ...todo, noteId: note.id, noteTitle: note.title })));
  const completedTodos = notes.flatMap(note => note.todos.filter(todo => todo.done).map(todo => ({ ...todo, noteId: note.id, noteTitle: note.title })));
  const openCount = activeTodos.length;
  const reviewStatus = owner.type === "character" ? getMemoReviewStatus(owner.id, notes) : null;
  void reviewRefreshKey;
  const reviewHistory = owner.type === "character" ? loadMemoMaintenanceHistory(owner.id).slice(0, 5) : [];


  const renameNote = async (note: MemoNote) => {
    const next = window.prompt("重命名手记", note.title);
    if (!next?.trim() || next.trim() === note.title) return;
    await saveMemoNote(owner, { ...note, title: next.trim() });
    await refresh();
  };
  const duplicateNote = async (note: MemoNote) => {
    const copy = await saveMemoNote(owner, { ...note, id: undefined, title: note.title + "（副本）", pinned: false, archived: false, folderId: note.folderId, todos: note.todos.map(todo => ({ ...todo, id: crypto.randomUUID(), done: false, completedAt: undefined })) });
    await refresh(); onNotice?.("已复制一份手记"); setSelectedId(copy.id);
  };
  const moveNote = async (note: MemoNote, folderId: string | null) => { await saveMemoNote(owner, { ...note, folderId }); await refresh(); };
  const toggleSelectedNote = (id: string) => setSelectedNoteIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const moveSelectedNotes = async () => {
    const targets = notes.filter(note => selectedNoteIds.includes(note.id));
    for (const note of targets) await saveMemoNote(owner, { ...note, folderId: bulkFolderId || null });
    setSelectedNoteIds([]); await refresh(); onNotice?.("已移动 " + targets.length + " 页手记");
  };
  const changeOwner = (next: MemoOwner) => {
    setSelectedNoteIds([]);
    setOwner(next);
    try { localStorage.setItem("ai_phone_memo_owner_v1", JSON.stringify(next)); } catch { /* 忽略 */ }
    setTab("home");
    setQuery("");
    setSpaceMenu(false);
  };
  const openEditor = (note?: MemoNote) => {
    setEditing(note ?? null);
    setTitle(note?.title ?? "");
    editorInitialBodyRef.current = note?.body ?? "";
    setTags(note?.tags.join(" ") ?? "");
    setPinned(note?.pinned ?? false);
    setTodos(note?.todos ?? []);
    setNoteFolderId(note?.folderId ?? null);
    setSelectedId(note?.id ?? null);
    setEditorOpen(true);
  };
  const applyEditorCommand = (command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
  };
  const save = async () => {
    const html = sanitizeMemoHtml(editorRef.current?.innerHTML || "");
    const plainText = (() => { const node = document.createElement("div"); node.innerHTML = html; return node.textContent || ""; })();
    if (!title.trim() && !plainText.trim()) { onNotice?.("先写下一点内容吧"); return; }
    setBusy(true);
    try {
      const storedBody = plainText.trim() ? MEMO_RICH_PREFIX + html : "";
      const note = await saveMemoNote(owner, {
        id: editing?.id, title: title.trim() || plainText.trim().slice(0, 24), body: storedBody,
        tags: tags.split(/[，,\\s]+/).filter(Boolean), pinned, todos, folderId: noteFolderId
      });
      setSelectedId(note.id);
      setEditorOpen(false);
      await refresh();
      onNotice?.("已妥帖收好");
    } catch (error) { onNotice?.(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  };
  const updateTodo = async (noteId: string, todoId: string, done: boolean) => {
    const note = notes.find(item => item.id === noteId);
    if (!note) return;
    await saveMemoNote(owner, { ...note, todos: note.todos.map(item => item.id === todoId ? { ...item, done, completedAt: done ? Date.now() : undefined } : item) });
    await refresh();
  };
  const addCategory = async () => {
    if (!folderName.trim()) return;
    try { await createMemoFolder(owner, folderName, folderColor); setFolderName(""); await refresh(); onNotice?.("分类已添好"); }
    catch (error) { onNotice?.(error instanceof Error ? error.message : "创建分类失败"); }
  };
  const changeTheme = (value: string) => {
    setTheme(value);
    try { localStorage.setItem("memo-archive-theme:" + owner.type + ":" + owner.id, value); } catch { /* ignore */ }
  };
  const changeAppearance = (key: "font" | "fontSize" | "lineHeight" | "paperWidth", value: string) => {
    const next = { font, fontSize, lineHeight, paperWidth, [key]: value };
    setFont(next.font); setFontSize(next.fontSize); setLineHeight(next.lineHeight); setPaperWidth(next.paperWidth);
    try { localStorage.setItem("memo-archive-appearance:" + owner.type + ":" + owner.id, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const exportData = async () => {
    const payload = { ...await exportMemoArchive(owner), appearance: { theme, font, fontSize, lineHeight, paperWidth } };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "备忘录-" + owner.id + "-备份.json"; anchor.click();
    URL.revokeObjectURL(url);
    onNotice?.("备份已导出");
  };
  const importData = async (file?: File) => {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (importMode === "replace") {
        const backup = { ...await exportMemoArchive(owner), appearance: { theme, font, fontSize, lineHeight, paperWidth } };
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = "备忘录替换前备份.json"; anchor.click(); URL.revokeObjectURL(url);
      }
      await importMemoArchive(owner, payload, importMode);
      const appearance = payload?.appearance;
      if (appearance && typeof appearance === "object") {
        if (["botanical", "kraft", "midnight", "vermilion", "celadon"].includes(appearance.theme)) changeTheme(appearance.theme);
        if (["serif", "sans", "mono"].includes(appearance.font)) changeAppearance("font", appearance.font);
        if (["14", "16", "18"].includes(appearance.fontSize)) changeAppearance("fontSize", appearance.fontSize);
        if (["1.6", "1.8", "2"].includes(appearance.lineHeight)) changeAppearance("lineHeight", appearance.lineHeight);
        if (["normal", "compact"].includes(appearance.paperWidth)) changeAppearance("paperWidth", appearance.paperWidth);
      }
      await refresh(); onNotice?.("备忘录已导入");
    } catch (error) { onNotice?.(error instanceof Error ? error.message : "导入失败"); }
  };
  const goBack = () => {
    if (editorOpen) { setEditorOpen(false); return; }
    if (selectedId) { setSelectedId(null); return; }
    onClose();
  };

  return <main className={styles.root} data-theme={theme} data-font={font} data-font-size={fontSize} data-line-height={lineHeight} data-paper-width={paperWidth}>
    <header className={styles.topbar}>
      <button className={styles.iconButton} onClick={goBack} aria-label="返回"><ArrowLeft size={19}/></button>
      <div className={styles.brand}><span className={styles.brandMark}><BookOpen size={18}/></span><div><strong>拾页</strong><small>把日子，写成值得珍藏的句子</small></div></div>
      <div className={styles.spaceWrap}>
        <button className={styles.spaceButton} onClick={() => setSpaceMenu(value => !value)}>
          <span className={styles.spaceDot}/>{owner.type === "user" ? "我的备忘录" : characters.find(item => item.id === owner.id)?.name || "角色备忘录"}<ChevronDown size={15}/>
        </button>
        {spaceMenu && <div className={styles.spaceMenu}>
          <button onClick={() => changeOwner(USER)} className={owner.type === "user" ? styles.chosenSpace : ""}>我的备忘录</button>
          {characters.map(character => <button key={character.id} onClick={() => changeOwner({ type: "character", id: character.id })} className={owner.type === "character" && owner.id === character.id ? styles.chosenSpace : ""}>{character.name} · 角色备忘录</button>)}
          {!characters.length && <small>还没有可切换的角色</small>}
        </div>}
      </div>
      <button className={styles.iconButton} onClick={() => { setSelectedId(null); setTab("settings"); }} aria-label="设置"><Settings2 size={19}/></button>
    </header>

    {editorOpen ? <section className={styles.editorPage}>
      <div className={styles.editorTop}><button onClick={() => setEditorOpen(false)}><X size={18}/> 取消</button><span>{editing ? "修改这页手记" : "写下一页手记"}</span><button className={styles.saveButton} disabled={busy} onClick={() => void save()}>{busy ? "保存中" : "保存"}</button></div>
      <input className={styles.titleInput} value={title} onChange={event => setTitle(event.target.value)} placeholder="给这页手记起个名字"/>
      <div className={styles.formatToolbar} aria-label="文字格式工具">
        <select aria-label="段落样式" defaultValue="p" onChange={event => applyEditorCommand("formatBlock", event.target.value)}>
          <option value="p">正文</option><option value="h1">标题</option><option value="h2">副标题</option><option value="h3">小标题</option><option value="blockquote">引用</option>
        </select>
        <button type="button" title="粗体" aria-label="粗体" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand("bold")}><strong>B</strong></button>
        <button type="button" title="斜体" aria-label="斜体" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand("italic")}><em>I</em></button>
        <button type="button" title="下划线" aria-label="下划线" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand("underline")}><u>U</u></button>
        <button type="button" title="删除线" aria-label="删除线" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand("strikeThrough")}><s>S</s></button>
        <span className={styles.toolbarDivider}/>
        <button type="button" title="项目符号列表" aria-label="项目符号列表" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand("insertUnorderedList")}>• 列表</button>
        <button type="button" title="编号列表" aria-label="编号列表" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand("insertOrderedList")}>1. 列表</button>
        <button type="button" title="待办清单" aria-label="待办清单" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand("insertHTML", '<ul data-type="checklist"><li data-checked="false">新清单项目</li></ul><p><br></p>')}>☑ 清单</button>
        <button type="button" title="减少缩进" aria-label="减少缩进" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand("outdent")}>⇤</button>
        <button type="button" title="增加缩进" aria-label="增加缩进" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand("indent")}>⇥</button>
      </div>
      <div ref={editorRef} data-memo-editor contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" className={styles.richEditor} data-placeholder="写下此刻想到的事……" onClick={event => { const item=(event.target as HTMLElement).closest("ul[data-type='checklist'] li") as HTMLElement | null; if(item){ item.dataset.checked=item.dataset.checked==="true"?"false":"true"; } }} />
      <div className={styles.editorTools}><input value={tags} onChange={event => setTags(event.target.value)} placeholder="关键词 · 用空格分开"/><select value={noteFolderId ?? ""} onChange={event => setNoteFolderId(event.target.value || null)}><option value="">未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><label><input type="checkbox" checked={pinned} onChange={event => setPinned(event.target.checked)}/> 置顶</label></div>
      <section className={styles.todoComposer}><div className={styles.sectionTitle}><strong>顺手记下要做的事</strong><small>{todos.filter(todo => !todo.done).length} 项未完成</small></div>
        {todos.map(todo => <label className={styles.todoLine} key={todo.id}><input type="checkbox" checked={todo.done} onChange={event => setTodos(current => current.map(item => item.id === todo.id ? { ...item, done: event.target.checked } : item))}/><span className={todo.done ? styles.doneText : ""}>{todo.text}</span><button onClick={() => setTodos(current => current.filter(item => item.id !== todo.id))} aria-label="移除待办"><X size={14}/></button></label>)}
        <div className={styles.addTodo}><input value={todoText} onChange={event => setTodoText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && todoText.trim()) { setTodos(current => [...current, { id: crypto.randomUUID(), text: todoText.trim(), done: false, createdAt: Date.now() }].slice(0, 100)); setTodoText(""); } }} placeholder="添加一个待办"/><button onClick={() => { if (todoText.trim()) setTodos(current => [...current, { id: crypto.randomUUID(), text: todoText.trim(), done: false, createdAt: Date.now() }].slice(0, 100)); setTodoText(""); }}><Plus size={16}/></button></div>
      </section>
    </section> : selectedId && selected ? <article className={styles.detailPage}>
      <div className={styles.detailMeta}>{date(selected.createdAt)} · {selected.pinned ? "已置顶" : "一页手记"}</div>
      <h1>{selected.title}</h1>
      <div className={styles.tagList}>{selected.tags.map(tag => <span key={tag}># {tag}</span>)}</div>
      <div className={styles.detailBody} dangerouslySetInnerHTML={{ __html: memoBodyHtml(selected.body) }}/>
      {selected.todos.length > 0 && <section className={styles.detailTodos}><h3>这页里的待办</h3>{selected.todos.map(todo => <label key={todo.id}><input type="checkbox" checked={todo.done} onChange={event => void updateTodo(selected.id, todo.id, event.target.checked)}/><span className={todo.done ? styles.doneText : ""}>{todo.text}</span></label>)}</section>}
      <div className={styles.detailActions}><button onClick={() => openEditor(selected)}>编辑手记</button><button onClick={async () => { await saveMemoNote(owner, { ...selected, pinned: !selected.pinned }); await refresh(); }}><Pin size={15}/>{selected.pinned ? "取消置顶" : "置顶"}</button><button onClick={async () => { await saveMemoNote(owner, { ...selected, archived: true }); setSelectedId(null); await refresh(); }}>收进旧日</button><button className={styles.subtleDanger} onClick={async () => { await moveMemoToRecycleBin(selected.id, owner); setSelectedId(null); await refresh(); }}>移入回收站</button></div>
      {owner.type === "user" && <section className={styles.sharePanel}><h3><Share2 size={15}/> 分享给角色（只读）</h3>{characters.map(character => <label key={character.id}><input type="checkbox" checked={selected.sharedWith.includes(character.id)} onChange={async event => { await setMemoShare(selected.id, owner, character.id, event.target.checked); await refresh(); }}/>{character.name}</label>)}</section>}
      <div className={styles.updatedAt}>最近修改于 {time(selected.updatedAt)}</div>
    </article> : <div className={styles.workspace}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarCaption}>随手记下，慢慢整理</div>
        <button className={tab === "home" ? styles.navActive : styles.navItem} onClick={() => { setTab("home"); setSelectedId(null); }}><House size={17}/> 首页</button>
        <button className={tab === "notes" ? styles.navActive : styles.navItem} onClick={() => { setTab("notes"); setSelectedId(null); }}><BookOpen size={17}/> 全部手记 <span>{notes.filter(note => !note.archived && !note.deletedAt).length}</span></button>
        <button className={tab === "todos" ? styles.navActive : styles.navItem} onClick={() => { setTab("todos"); setSelectedId(null); }}><CheckCircle2 size={17}/> 待办清单 <span>{openCount}</span></button>
        <button className={tab === "categories" ? styles.navActive : styles.navItem} onClick={() => { setTab("categories"); setSelectedId(null); }}><Folder size={17}/> 分类</button>
        <div className={styles.sidebarDivider}/>
        <button className={tab === "archived" ? styles.navActive : styles.navItem} onClick={() => { setTab("archived"); setSelectedId(null); }}><Archive size={17}/> 已收起</button>
        <button className={tab === "recycle" ? styles.navActive : styles.navItem} onClick={() => { setTab("recycle"); setSelectedId(null); }}><Trash2 size={17}/> 回收站</button>
        <div className={styles.sidebarQuote}>“生活不是等待风暴过去，<br/>而是学会在雨中起舞。”</div>
      </aside>
      <section className={styles.content}>
        {tab === "home" && <>
          <div className={styles.welcome}><div><span className={styles.eyebrow}>A LITTLE NOTEBOOK</span><h1>把灵感与日常，<br/><em>轻轻收进这里。</em></h1><p>{date(Date.now())} · 今天也值得被认真记下</p></div><div className={styles.welcomeIllustration}><span>✳</span><i>✿</i><b>notes<br/>& days</b></div></div>
          <button className={styles.quickWrite} onClick={() => openEditor()}><Plus size={20}/><span>写一页新手记</span><small>把刚刚想到的事情记下来</small></button>
          <div className={styles.homeColumns}><section><div className={styles.sectionTitle}><strong>最近写下</strong><button onClick={() => setTab("notes")}>查看全部 →</button></div>
            {notes.filter(note => !note.archived && !note.deletedAt).slice(0, 5).map(note => <button className={styles.noteCard} key={note.id} onClick={() => setSelectedId(note.id)}><span>{date(note.updatedAt)}{note.pinned ? " · 置顶" : ""}</span><strong>{note.title}</strong><small>{memoBodyPlainText(note.body).slice(0, 84) || "还没有写下正文"}{memoBodyPlainText(note.body).length > 84 ? "…" : ""}</small></button>)}
            {!notes.some(note => !note.archived && !note.deletedAt) && <div className={styles.emptyState}>这里还很安静。<br/>写下第一件想留下的事吧。</div>}
          </section><section><div className={styles.sectionTitle}><strong>别忘了这些</strong><button onClick={() => setTab("todos")}>全部待办 →</button></div>
            {activeTodos.slice(0, 5).map(todo => <label className={styles.todoPreview} key={todo.id}><input type="checkbox" onChange={() => void updateTodo(todo.noteId, todo.id, true)}/><span>{todo.text}<small>{todo.noteTitle}</small></span></label>)}
            {!activeTodos.length && <div className={styles.emptyState}>今天没有待办，<br/>给自己一点空白也很好。</div>}
          </section></div>
        </>}
        {tab === "notes" && <><div className={styles.pageHeading}><span className={styles.eyebrow}>YOUR PAGES</span><h1>全部手记</h1><p>写过的每一页，都有它自己的位置。</p></div><label className={styles.search}><Search size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、正文或关键词"/></label><div className={styles.filterRow}><button className={categoryFilter === "all" ? styles.filterActive : ""} onClick={() => setCategoryFilter("all")}>全部</button>{folders.map(folder => <button className={categoryFilter === folder.id ? styles.filterActive : ""} key={folder.id} onClick={() => setCategoryFilter(folder.id)}>{folder.name}</button>)}</div><div className={styles.batchToolbar}><span>已选 {selectedNoteIds.length} 页</span><select value={bulkFolderId} onChange={event => setBulkFolderId(event.target.value)}><option value="">移动到未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><button disabled={!selectedNoteIds.length} onClick={() => void moveSelectedNotes()}>批量移动</button><button onClick={() => setSelectedNoteIds([])}>清空选择</button></div><div className={styles.noteGrid}>{visible.map(note => <article className={styles.noteListCard} key={note.id}><div className={styles.noteListTop}><input type="checkbox" aria-label="选择手记" checked={selectedNoteIds.includes(note.id)} onChange={() => toggleSelectedNote(note.id)}/><span>{date(note.updatedAt)}{note.pinned ? " · 置顶" : ""}</span><button className={styles.noteTitleButton} onClick={() => void renameNote(note)}>{note.title}</button><button className={styles.noteOpenButton} onClick={() => setSelectedId(note.id)}>阅读</button></div><button className={styles.noteExcerpt} onClick={() => setSelectedId(note.id)}>{note.body.slice(0, 110) || "空白手记"}{note.body.length > 110 ? "…" : ""}</button>{note.tags.length > 0 && <i>{note.tags.slice(0, 3).map(tag => "#" + tag).join("　")}</i>}<div className={styles.noteQuickActions}><label>移动至<select aria-label="移动分类" value={note.folderId ?? ""} onChange={event => void moveNote(note, event.target.value || null)}><option value="">未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><button onClick={() => void saveMemoNote(owner, { ...note, pinned: !note.pinned }).then(refresh)}><Pin size={14}/>{note.pinned ? "取消置顶" : "置顶"}</button><button onClick={() => void duplicateNote(note)}><Copy size={14}/>复制</button></div></article>)}</div>{!visible.length && <div className={styles.emptyState}>没有找到相关手记。</div>}</>}
        {tab === "todos" && <><div className={styles.pageHeading}><span className={styles.eyebrow}>LITTLE BY LITTLE</span><h1>待办清单</h1><p>不必一次完成所有事，先做好眼前这一件。</p></div><div className={styles.todoSummary}><strong>{openCount}</strong><span>件待完成</span><i>{completedTodos.length} 件已完成</i></div><div className={styles.todoList}>{activeTodos.map(todo => <label key={todo.id}><input type="checkbox" onChange={() => void updateTodo(todo.noteId, todo.id, true)}/><span>{todo.text}<small>来自：{todo.noteTitle}</small></span></label>)}{!activeTodos.length && <div className={styles.emptyState}>清单暂时清空了。<br/>愿今天从容一些。</div>}</div>{completedTodos.length > 0 && <details className={styles.completed}><summary>已完成 · {completedTodos.length}</summary>{completedTodos.map(todo => <label key={todo.id}><input type="checkbox" checked onChange={() => void updateTodo(todo.noteId, todo.id, false)}/><span>{todo.text}<small>{todo.noteTitle}</small></span></label>)}</details>}</>}
        {tab === "categories" && <><div className={styles.pageHeading}><span className={styles.eyebrow}>A PLACE FOR EACH THOUGHT</span><h1>分类</h1><p>按自己的习惯整理，不必拘泥于规则。</p></div><div className={styles.categoryCreate}><input value={folderName} onChange={event => setFolderName(event.target.value)} placeholder="例如：生活灵感、读书摘录、重要日子"/><input aria-label="分类颜色" type="color" value={folderColor} onChange={event => setFolderColor(event.target.value)}/><button onClick={() => void addCategory()}><FolderPlus size={16}/> 新建分类</button></div><div className={styles.categoryGrid}>{folders.map(folder => <article key={folder.id} className={styles.categoryCard}><span style={{ background: folder.color }}/><div>{categoryEditId === folder.id ? <input className={styles.categoryNameInput} value={categoryEditName} onChange={event => setCategoryEditName(event.target.value)} onKeyDown={async event => { if (event.key === "Enter" && categoryEditName.trim()) { await updateMemoFolder(folder.id, owner, { name: categoryEditName.trim() }); setCategoryEditId(null); await refresh(); } }} /> : <strong>{folder.name}</strong>}<small>{notes.filter(note => note.folderId === folder.id && !note.deletedAt).length} 页手记</small></div><button aria-label="编辑分类名称" onClick={async () => { if (categoryEditId === folder.id) { if (categoryEditName.trim()) await updateMemoFolder(folder.id, owner, { name: categoryEditName.trim() }); setCategoryEditId(null); await refresh(); } else { setCategoryEditId(folder.id); setCategoryEditName(folder.name); } }}>{categoryEditId === folder.id ? "保存" : "改名"}</button><input aria-label="分类颜色" type="color" value={folder.color} onChange={async event => { await updateMemoFolder(folder.id, owner, { color: event.target.value }); await refresh(); }}/><button aria-label="上移分类" onClick={async () => { await updateMemoFolder(folder.id, owner, { order: Math.max(0, folder.order - 1) }); await refresh(); }}>↑</button><button aria-label="下移分类" onClick={async () => { await updateMemoFolder(folder.id, owner, { order: folder.order + 1 }); await refresh(); }}>↓</button><button aria-label="删除分类" onClick={async () => { await deleteMemoFolder(folder.id, owner, "loose"); await refresh(); onNotice?.("分类已删除，手记已保留"); }}><Trash2 size={15}/></button></article>)}</div>{!folders.length && <div className={styles.emptyState}>还没有分类。<br/>可以从一个小小的主题开始。</div>}</>}
        {tab === "settings" && <><div className={styles.pageHeading}><span className={styles.eyebrow}>MAKE IT YOURS</span><h1>偏好与备份</h1><p>让这本小小的手记，更像你自己的样子。</p></div><section className={styles.settingsGroup}><h2>纸页的模样</h2><label>配色<select value={theme} onChange={event => changeTheme(event.target.value)}><option value="botanical">植物手札</option><option value="kraft">暖棕纸页</option><option value="midnight">夜色墨笺</option><option value="vermilion">朱砂印记</option><option value="celadon">青瓷浅绿</option></select></label><label>字体<select value={font} onChange={event => changeAppearance("font", event.target.value)}><option value="serif">衬线</option><option value="sans">无衬线</option><option value="mono">等宽</option></select></label><label>字号<select value={fontSize} onChange={event => changeAppearance("fontSize", event.target.value)}><option value="14">小</option><option value="16">标准</option><option value="18">大</option></select></label><label>行距<select value={lineHeight} onChange={event => changeAppearance("lineHeight", event.target.value)}><option value="1.6">紧凑</option><option value="1.8">舒适</option><option value="2">宽松</option></select></label><label>正文宽度<select value={paperWidth} onChange={event => changeAppearance("paperWidth", event.target.value)}><option value="normal">标准</option><option value="compact">窄幅</option></select></label></section><section className={styles.settingsGroup}><h2>角色定期维护</h2><p>角色会检查自己的手记，按需补充、修正、合并或归档。只有实际提交维护结果后才会更新状态。</p><label>回顾频率<select value={reviewHours} disabled={owner.type !== "character"} onChange={event => { const value = Number(event.target.value); setReviewHours(value); if (owner.type === "character") setMemoReviewIntervalHours(owner.id, value); }}><option value={0}>关闭</option><option value={1/60}>每分钟（测试）</option><option value={1}>每小时</option><option value={24}>每天</option><option value={48}>每两天</option><option value={72}>每三天</option><option value={168}>每周</option></select></label>{owner.type !== "character" ? <small>切换到角色备忘录后，可查看该角色的回顾状态。</small> : <div className={styles.reviewPanel}><div className={styles.reviewStats}><span><strong>{reviewStatus?.dueCount ?? 0}</strong> 条待维护</span><span><strong>{reviewStatus?.reviewedCount ?? 0}</strong> 条已维护</span><span>最近维护：{reviewHistory[0] ? time(Date.parse(reviewHistory[0].timestamp)) : "尚无记录"}</span></div><small className={styles.reviewHint}>到期维护在下一次一对一私聊请求中触发；应用未运行时不会自行唤醒。</small><button className={styles.forceReviewButton} onClick={() => { forceMemoReviewOnNextChat(owner.id); setReviewRefreshKey(value => value + 1); onNotice?.("已安排在下一次私聊中维护；发送一条消息即可触发"); }}>下次私聊立即维护</button><div className={styles.reviewRows}>{reviewStatus?.rows.slice(0, 8).map(row => <div key={row.id}><span>{row.title}</span><small>{row.lastReviewedAt ? "上次 " + time(row.lastReviewedAt) : "从未维护"} · {row.due ? "待维护" : row.nextReviewAt ? "下次 " + time(row.nextReviewAt) : "待首次回顾"}</small></div>)}{!reviewStatus?.rows.length && <small>当前没有可回顾的手记。</small>}</div>{reviewHistory.length > 0 && <div className={styles.reviewHistory}><strong>最近维护记录</strong>{reviewHistory.map(item => <small key={item.id}>{time(Date.parse(item.timestamp))} · {item.summary}{item.changes.length ? " · " + item.changes.join("；") : " · 检查后无需修改"}</small>)}</div>}</div>}</section><section className={styles.settingsGroup}><h2>带走或迁入</h2><p>数据保存在本机。导入前请确认当前所处的备忘录空间。</p><div className={styles.backupActions}><button onClick={() => void exportData()}><Archive size={16}/> 导出当前空间</button><label>导入方式<select value={importMode} onChange={event => setImportMode(event.target.value as "merge" | "replace")}><option value="merge">合并，不覆盖已有内容</option><option value="replace">替换当前空间（自动先备份）</option></select></label><label className={styles.importButton}>选择备份文件<input type="file" accept="application/json,.json" onChange={event => { void importData(event.target.files?.[0]); event.currentTarget.value = ""; }}/></label></div></section></>}
        {tab === "archived" && <><div className={styles.pageHeading}><span className={styles.eyebrow}>KEPT FOR ANOTHER DAY</span><h1>已收起的手记</h1><p>暂时不在日常列表里，但仍然好好保存着。</p></div>{notes.filter(note => note.archived && !note.deletedAt).map(note => <article className={styles.recycleRow} key={note.id}><strong>{note.title}</strong><small>{time(note.updatedAt)}</small><button onClick={async () => { await saveMemoNote(owner, { ...note, archived: false }); await refresh(); }}>放回手记</button><button onClick={() => setSelectedId(note.id)}>查看</button></article>)}{!notes.some(note => note.archived && !note.deletedAt) && <div className={styles.emptyState}>还没有收起的手记。</div>}</>}
        {tab === "recycle" && <><div className={styles.pageHeading}><span className={styles.eyebrow}>A SECOND CHANCE</span><h1>回收站</h1><p>误删的手记，可以在这里找回来。</p></div>{notes.filter(note => note.deletedAt).map(note => <article className={styles.recycleRow} key={note.id}><strong>{note.title}</strong><small>{time(note.deletedAt || note.updatedAt)}</small><button onClick={async () => { await restoreMemo(note.id, owner); await refresh(); }}>恢复</button><button className={styles.subtleDanger} onClick={async () => { await permanentlyDeleteMemo(note.id, owner); await refresh(); }}>永久删除</button></article>)}{!notes.some(note => note.deletedAt) && <div className={styles.emptyState}>回收站是空的。</div>}</>}
      </section>
      <button className={styles.fab} onClick={() => openEditor()} aria-label="新建手记"><Plus size={22}/></button>
      <nav className={styles.mobileNav}><button className={tab === "home" ? styles.mobileActive : ""} onClick={() => setTab("home")}><House size={18}/>首页</button><button className={tab === "notes" ? styles.mobileActive : ""} onClick={() => setTab("notes")}><BookOpen size={18}/>手记</button><button className={tab === "todos" ? styles.mobileActive : ""} onClick={() => setTab("todos")}><CheckCircle2 size={18}/>待办</button><button className={tab === "categories" ? styles.mobileActive : ""} onClick={() => setTab("categories")}><Folder size={18}/>分类</button><button className={mobileMoreOpen || tab === "archived" || tab === "recycle" ? styles.mobileActive : ""} onClick={() => setMobileMoreOpen(value => !value)}><MoreHorizontal size={18}/>更多</button></nav>{mobileMoreOpen && <div className={styles.mobileMore}><button onClick={() => { setTab("archived"); setMobileMoreOpen(false); }}>已收起的手记</button><button onClick={() => { setTab("recycle"); setMobileMoreOpen(false); }}>回收站</button><button onClick={() => { setTab("settings"); setMobileMoreOpen(false); }}>偏好与备份</button></div>}
    </div>}
  </main>;
}
