import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Brain, FileText, Search, Sparkles } from "lucide-react";
import type { DreamProgress, DreamSummary, InstructionFile, InstructionFileId, InstructionFileSummary, Memory, NoteResult, NoteSearchMode, SkillDetail, SkillSummary } from "../../shared/types";
import { Button } from "../components/ui/button";
import { ErrorState, LoadingState } from "../components/ui/state";
import { MarkdownMessage } from "../chat/MarkdownMessage";
import { errorMessage } from "../lib/utils";

type Destination = "memories" | "notes" | "instructions" | "skills";
interface Props { readonly onBack: () => void; readonly onDirtyChange?: (dirty: boolean) => void }

const confirmDiscard = (): boolean => window.confirm("Discard your unsaved instruction changes?");
const knowledge = () => window.railgunDesktop;

export const KnowledgePage = ({ onBack, onDirtyChange = () => undefined }: Props): React.JSX.Element => {
  const [destination, setDestination] = useState<Destination>("skills");
  const [instructionDirty, setInstructionDirty] = useState(false);
  useEffect(() => onDirtyChange(instructionDirty), [instructionDirty, onDirtyChange]);
  useEffect(() => {
    if (!instructionDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent): void => { event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [instructionDirty]);
  const navigate = (next: Destination): void => {
    if (next === destination || (instructionDirty && !confirmDiscard())) return;
    setInstructionDirty(false); setDestination(next);
  };

  return <main className="knowledge-page">
    <aside className="knowledge-nav">
      <Button variant="ghost" onClick={onBack}><ArrowLeft aria-hidden="true" />Back to Railgun</Button>
      <div><h1>Knowledge</h1><p>Manage what Railgun remembers and follows.</p></div>
      <nav aria-label="Knowledge destinations">
        <button className={destination === "memories" ? "active" : ""} onClick={() => navigate("memories")}><Brain aria-hidden="true" />Memories</button>
        <button className={destination === "notes" ? "active" : ""} onClick={() => navigate("notes")}><FileText aria-hidden="true" />Notes</button>
        <button className={destination === "instructions" ? "active" : ""} onClick={() => navigate("instructions")}><Sparkles aria-hidden="true" />Instructions</button>
        <button className={destination === "skills" ? "active" : ""} onClick={() => navigate("skills")}><Search aria-hidden="true" />Skills</button>
      </nav>
    </aside>
    <section className="knowledge-content">
      {destination === "memories" ? <Memories /> : destination === "notes" ? <Notes /> : destination === "instructions" ? <Instructions onDirtyChange={setInstructionDirty} /> : <Skills />}
    </section>
  </main>;
};

const Memories = (): React.JSX.Element => {
  const [memories, setMemories] = useState<readonly Memory[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<Memory | "new">();
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("fact");
  const [saving, setSaving] = useState(false);
  const request = useRef(0);

  const refreshTotalCount = async (): Promise<void> => {
    try {
      setTotalCount((await knowledge().listMemories()).length);
    } catch {
      // The visible request reports errors; eligibility keeps its last known value.
    }
  };

  const load = async (search = query): Promise<void> => {
    const id = ++request.current;
    const normalizedSearch = search.trim();
    setLoading(true);
    setError(undefined);
    try {
      const values = await knowledge().listMemories(normalizedSearch || undefined);
      if (id !== request.current) return;
      setMemories(values);
      if (!normalizedSearch) setTotalCount(values.length);
    } catch (cause) {
      if (id === request.current) setError(errorMessage(cause, "Unable to load memories"));
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  const refreshAfterMutation = async (): Promise<void> => {
    await load();
    if (query.trim()) await refreshTotalCount();
  };

  useEffect(() => {
    const timer = setTimeout(() => void load(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  const open = (memory: Memory | "new"): void => {
    setEditing(memory);
    setContent(memory === "new" ? "" : memory.content);
    setCategory(memory === "new" ? "fact" : memory.category);
  };

  const save = async (): Promise<void> => {
    if (editing === undefined || !content.trim() || !category.trim()) return;
    setSaving(true); setError(undefined);
    try {
      if (editing === "new") await knowledge().createMemory({ content, category });
      else await knowledge().updateMemory(editing.id, { content, category });
      setEditing(undefined);
      await refreshAfterMutation();
    } catch (cause) {
      setError(errorMessage(cause, "Unable to save memory"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (memory: Memory): Promise<void> => {
    if (!window.confirm("Delete this memory? This cannot be undone.")) return;
    try {
      await knowledge().deleteMemory(memory.id);
      await refreshAfterMutation();
    } catch (cause) {
      setError(errorMessage(cause, "Unable to delete memory"));
    }
  };
  return <>
    <header className="knowledge-header"><div><h2>Memories</h2><p>The 100 most recent facts and preferences.</p></div><Button onClick={() => open("new")}>New memory</Button></header>
    <div className="knowledge-toolbar"><input aria-label="Search memories" placeholder="Search memory content" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <DreamCard count={totalCount} onComplete={refreshAfterMutation} />
    {error ? <ErrorState title="Memories unavailable" description={error}><Button onClick={() => void load()}>Retry</Button></ErrorState>
      : loading ? <LoadingState title="Loading memories…" />
        : memories.length === 0 ? <p className="knowledge-empty" role="status">{query ? "No memories match your search." : "No memories yet."}</p>
          : <ul className="knowledge-list">{memories.map(memory => <li key={memory.id}><div><span className="knowledge-badge">{memory.category}</span><p>{memory.content}</p></div><div><Button size="sm" variant="ghost" onClick={() => open(memory)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => void remove(memory)}>Delete</Button></div></li>)}</ul>}
    {editing === undefined ? null : <div className="knowledge-modal" role="dialog" aria-modal="true" aria-labelledby="memory-dialog-title"><form onSubmit={event => { event.preventDefault(); void save(); }}><h3 id="memory-dialog-title">{editing === "new" ? "Create memory" : "Edit memory"}</h3><label>Category<input value={category} maxLength={100} onChange={event => setCategory(event.target.value)} /></label><label>Content<textarea value={content} maxLength={100000} onChange={event => setContent(event.target.value)} /></label><div><Button type="button" variant="ghost" disabled={saving} onClick={() => setEditing(undefined)}>Cancel</Button><Button type="submit" disabled={saving || !content.trim() || !category.trim()}>{saving ? "Saving…" : "Save"}</Button></div></form></div>}
  </>;
};

const DreamCard = ({ count, onComplete }: { readonly count: number; readonly onComplete: () => Promise<void> }): React.JSX.Element => {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DreamProgress>();
  const [result, setResult] = useState<DreamSummary>();
  const [error, setError] = useState<string>();
  useEffect(() => knowledge().onDreamProgress(setProgress), []);

  const run = async (): Promise<void> => {
    setRunning(true);
    setProgress(undefined);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await knowledge().runDream());
      await onComplete();
    } catch (cause) {
      setError(errorMessage(cause, "Dream failed"));
    } finally {
      setRunning(false);
    }
  };
  return <section className="dream-card"><div><h3><Sparkles aria-hidden="true" />Dream</h3><p>{count < 5 ? `${5 - count} more memories needed.` : "Consolidate memories and promote stable preferences."}</p>{progress ? <p role="status">{progress.stage} · {progress.memoryCount} memories</p> : null}{result ? <p role="status">{result.status}: {result.beforeCount} → {result.afterCount}</p> : null}{error ? <p role="alert">{error}</p> : null}</div><Button disabled={running || count < 5} onClick={() => void run()}>{running ? "Dreaming…" : "Run Dream"}</Button></section>;
};

const Notes = (): React.JSX.Element => {
  const [query, setQuery] = useState(""); const [mode, setMode] = useState<NoteSearchMode>("semantic"); const [results, setResults] = useState<readonly NoteResult[]>([]); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string>(); const [error, setError] = useState<string>(); const request = useRef(0);
  const search = async (): Promise<void> => { if (!query.trim()) return; const id = ++request.current; setBusy(true); setError(undefined); try { const next = await knowledge().searchNotes(query, mode); if (id === request.current) setResults(next); } catch (cause) { if (id === request.current) setError(errorMessage(cause, "Unable to search notes")); } finally { if (id === request.current) setBusy(false); } };
  const importNotes = async (): Promise<void> => { setBusy(true); setError(undefined); try { const result = await knowledge().importNotes(); if (!result.cancelled) setMessage(`Imported ${result.imported} note chunks with semantic embeddings.`); } catch (cause) { setError(errorMessage(cause, "Unable to import notes")); } finally { setBusy(false); } };
  return <><header className="knowledge-header"><div><h2>Notes</h2><p>Import Markdown and text files, then test retrieval.</p></div><Button disabled={busy} onClick={() => void importNotes()}>Import folder</Button></header><form className="notes-search" onSubmit={event => { event.preventDefault(); void search(); }}><input aria-label="Search notes" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="Search mode" value={mode} onChange={event => setMode(event.target.value as NoteSearchMode)}><option value="semantic">Semantic</option><option value="keyword">Keyword</option></select><Button disabled={busy || !query.trim()}>{busy ? "Searching…" : "Search"}</Button></form>{message ? <p role="status">{message}</p> : null}{error ? <p role="alert">{error}</p> : null}{!busy && query && results.length === 0 ? <p className="knowledge-empty">No note chunks matched.</p> : <ul className="knowledge-list">{results.map(result => <li key={result.id}><div><strong>{result.sourceName}</strong><p>{result.snippet}</p></div></li>)}</ul>}</>;
};

const Skills = (): React.JSX.Element => {
  const [skills, setSkills] = useState<readonly SkillSummary[]>();
  const [selectedName, setSelectedName] = useState<string>();
  const [detail, setDetail] = useState<SkillDetail>();
  const [query, setQuery] = useState("");
  const [listError, setListError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [detailRetry, setDetailRetry] = useState(0);

  const loadSkills = async (): Promise<void> => {
    setListError(undefined);
    try {
      const next = await knowledge().listSkills();
      setSkills(next);
      setSelectedName(current => current !== undefined && next.some(skill => skill.name === current) ? current : next[0]?.name);
    } catch (cause) {
      setListError(errorMessage(cause, "Unable to load skills"));
    }
  };

  useEffect(() => { void loadSkills(); }, []);
  useEffect(() => {
    if (selectedName === undefined) { setDetail(undefined); return; }
    let active = true;
    setDetail(undefined);
    setDetailError(undefined);
    void knowledge().getSkill(selectedName).then(
      value => { if (active) setDetail(value); },
      cause => { if (active) setDetailError(errorMessage(cause, "Unable to load the skill")); },
    );
    return () => { active = false; };
  }, [selectedName, detailRetry]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return skills?.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle)) ?? [];
  }, [query, skills]);

  return <>
    <header className="knowledge-header"><div><h2>Skills</h2><p>Instructions available to Railgun.</p></div></header>
    <label className="settings-search-wrap"><Search aria-hidden="true" /><input type="search" aria-label="Search skills" placeholder="Search skills" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="instruction-layout">
      <nav className="instruction-files" aria-label="Skills">
        {skills === undefined && listError === undefined ? <p role="status">Loading skills…</p> : null}
        {listError === undefined ? null : <div role="alert"><p>{listError}</p><Button size="sm" onClick={() => void loadSkills()}>Retry</Button></div>}
        {skills !== undefined && skills.length === 0 ? <p>No skills installed</p> : null}
        {skills !== undefined && skills.length > 0 && filtered.length === 0 ? <p>No matching skills</p> : null}
        {filtered.map(skill => <button type="button" key={skill.name} aria-current={selectedName === skill.name ? "page" : undefined} className={selectedName === skill.name ? "active" : ""} onClick={() => setSelectedName(skill.name)}><strong>{skill.name}</strong><span>{skill.description}</span></button>)}
      </nav>
      <section className="knowledge-detail" aria-label="Skill detail">
        {selectedName === undefined ? <div className="knowledge-state"><h2>Skills</h2><p>Select a skill to read its instructions.</p></div>
          : detailError !== undefined ? <div className="knowledge-state" role="alert"><p>{detailError}</p><Button size="sm" onClick={() => setDetailRetry(value => value + 1)}>Retry</Button></div>
            : detail === undefined ? <div className="knowledge-state" role="status">Loading skill…</div>
              : <article><header><h1>{detail.name}</h1><p>{detail.description}</p><span className={`skill-status ${detail.disableModelInvocation ? "disabled" : "enabled"}`}>{detail.disableModelInvocation ? "Model invocation disabled" : "Available to model"}</span></header><MarkdownMessage>{detail.body}</MarkdownMessage></article>}
      </section>
    </div>
  </>;
};

const Instructions = ({ onDirtyChange }: { readonly onDirtyChange: (dirty: boolean) => void }): React.JSX.Element => {
  const [files, setFiles] = useState<readonly InstructionFileSummary[]>([]);
  const [selected, setSelected] = useState<InstructionFileId>();
  const [file, setFile] = useState<InstructionFile>();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const dirty = file !== undefined && content !== file.content;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const loadList = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await knowledge().listInstructionFiles();
      setFiles(next);
      if (selected === undefined) setSelected(next[0]?.id);
    } catch (cause) {
      setError(errorMessage(cause, "Unable to list instruction files"));
    } finally {
      setLoading(false);
    }
  };

  const loadFile = async (id: InstructionFileId): Promise<void> => {
    const requestId = ++request.current;
    setFile(undefined);
    setLoading(true);
    setError(undefined);
    try {
      const next = await knowledge().getInstructionFile(id);
      if (requestId !== request.current) return;
      setFile(next);
      setContent(next.content);
    } catch (cause) {
      if (requestId === request.current) setError(errorMessage(cause, "Unable to load instruction file"));
    } finally {
      if (requestId === request.current) setLoading(false);
    }
  };

  useEffect(() => { void loadList(); }, []);
  useEffect(() => { if (selected !== undefined) void loadFile(selected); }, [selected]);

  const retry = (): void => {
    if (selected === undefined) void loadList();
    else void loadFile(selected);
  };

  const choose = (id: InstructionFileId): void => {
    if (id === selected || (dirty && !confirmDiscard())) return;
    setSelected(id);
  };

  const save = async (): Promise<void> => {
    if (selected === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await knowledge().updateInstructionFile(selected, content);
      setFile(next);
      await loadList();
    } catch (cause) {
      setError(errorMessage(cause, "Unable to save instructions"));
    } finally {
      setSaving(false);
    }
  };

  return <>
    <header className="knowledge-header">
      <div><h2>Instructions</h2><p>Global Markdown loaded for newly created, loaded, or forked tasks.</p></div>
    </header>
    <div className="instruction-layout">
      <ul className="instruction-files">{files.map(item => <li key={item.id}>
        <button className={selected === item.id ? "active" : ""} onClick={() => choose(item.id)}>
          <span>{item.label}</span><small className={item.status}>{item.status}</small>
        </button>
      </li>)}</ul>
      <div className="instruction-editor">
        {error ? <ErrorState title="Instructions unavailable" description={error}><Button onClick={retry}>Retry</Button></ErrorState>
          : loading || file === undefined ? <LoadingState title="Loading instructions…" />
            : <>
                <label htmlFor="instruction-content">Markdown instructions</label>
                <textarea id="instruction-content" value={content} spellCheck="true" onChange={event => setContent(event.target.value)} />
                <div><span>{dirty ? "Unsaved changes" : "Saved"}</span><Button variant="ghost" disabled={!dirty || saving} onClick={() => setContent(file.content)}>Revert</Button><Button disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button></div>
              </>}
      </div>
    </div>
  </>;
};
