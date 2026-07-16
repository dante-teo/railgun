import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Brain, FileText, Search, Sparkles } from "lucide-react";
import type { DreamProgress, DreamSummary, InstructionFile, InstructionFileId, InstructionFileSummary, Memory, NoteResult, NoteSearchMode, SkillDetail, SkillSummary } from "../../shared/types";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input, Textarea } from "../components/ui/input";
import { SearchField } from "../components/ui/form";
import { StatusBadge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { MarkdownMessage } from "../chat/MarkdownMessage";
import { SplitLayout } from "../components/layouts";
import { KnowledgeContent, KnowledgeHeader as KnowledgeHeaderFrame, KnowledgeNav, KnowledgeNavItem, KnowledgeShell, KnowledgeSidebar, SettingsInline, SettingsRow, SettingsRowCopy, SettingsSection } from "../components/ui/product";
import { errorMessage } from "../lib/utils";

export type KnowledgeDestination = "memories" | "notes" | "instructions" | "skills";
export const knowledgeDestinationMetadata: Record<KnowledgeDestination, { readonly label: string; readonly description: string }> = {
  memories: { label: "Memories", description: "Manage facts and preferences Railgun remembers." },
  notes: { label: "Notes", description: "Import and search notes available to Railgun." },
  instructions: { label: "Instructions", description: "Edit the global instructions Railgun follows." },
  skills: { label: "Skills", description: "Browse reusable instruction packages available to Railgun." },
};
interface Props { readonly embedded?: boolean; readonly destination?: KnowledgeDestination; readonly onBack?: () => void; readonly onDirtyChange?: (dirty: boolean) => void }

const knowledge = () => window.railgunDesktop;
const KnowledgeHeader = ({ destination, embedded }: { readonly destination: KnowledgeDestination; readonly embedded: boolean }): React.JSX.Element | null => {
  if (embedded) return null;
  const metadata = knowledgeDestinationMetadata[destination];
  return <KnowledgeHeaderFrame><div><h2>{metadata.label}</h2><p>{metadata.description}</p></div></KnowledgeHeaderFrame>;
};

export const KnowledgePage = ({ embedded = false, destination: controlledDestination, onBack = () => undefined, onDirtyChange = () => undefined }: Props): React.JSX.Element => {
  const [destination, setDestination] = useState<KnowledgeDestination>("skills");
  const activeDestination = controlledDestination ?? destination;
  const [instructionDirty, setInstructionDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<KnowledgeDestination | "back">();
  useEffect(() => onDirtyChange(instructionDirty), [instructionDirty, onDirtyChange]);
  useEffect(() => {
    if (!instructionDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent): void => { event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [instructionDirty]);
  const navigate = (next: KnowledgeDestination): void => {
    if (next === activeDestination) return;
    if (instructionDirty) { setPendingNavigation(next); return; }
    setDestination(next);
  };
  const navigateBack = (): void => {
    if (instructionDirty) { setPendingNavigation("back"); return; }
    onBack();
  };

  const destinationNavigation = <KnowledgeNav aria-label="Knowledge destinations">
    <KnowledgeNavItem aria-current={activeDestination === "memories" ? "page" : undefined} onClick={() => navigate("memories")}><Brain aria-hidden="true" />Memories</KnowledgeNavItem>
    <KnowledgeNavItem aria-current={activeDestination === "notes" ? "page" : undefined} onClick={() => navigate("notes")}><FileText aria-hidden="true" />Notes</KnowledgeNavItem>
    <KnowledgeNavItem aria-current={activeDestination === "instructions" ? "page" : undefined} onClick={() => navigate("instructions")}><Sparkles aria-hidden="true" />Instructions</KnowledgeNavItem>
    <KnowledgeNavItem aria-current={activeDestination === "skills" ? "page" : undefined} onClick={() => navigate("skills")}><Search aria-hidden="true" />Skills</KnowledgeNavItem>
  </KnowledgeNav>;
  const destinationContent = activeDestination === "memories" ? <Memories embedded={embedded} /> : activeDestination === "notes" ? <Notes embedded={embedded} /> : activeDestination === "instructions" ? <Instructions embedded={embedded} onDirtyChange={setInstructionDirty} /> : <Skills embedded={embedded} />;

  if (embedded) return <section className="min-h-0 min-w-0 outline-none" id={`setting-${activeDestination}`} tabIndex={-1}>{destinationContent}</section>;

  return <KnowledgeShell>
    <KnowledgeSidebar>
      <Button size="sm" variant="ghost" onClick={navigateBack}><ArrowLeft aria-hidden="true" />Back to Railgun</Button>
      <div><h1 className="m-0">Knowledge</h1><p className="mb-0 mt-1 text-control leading-snug text-foreground-secondary">Manage what Railgun remembers and follows.</p></div>
      {destinationNavigation}
    </KnowledgeSidebar>
    <KnowledgeContent>{destinationContent}</KnowledgeContent>
    <ConfirmDialog
      open={pendingNavigation !== undefined}
      title="Discard unsaved changes?"
      description="Your instruction edits have not been saved."
      confirmLabel="Discard Changes"
      destructive
      onOpenChange={open => { if (!open) setPendingNavigation(undefined); }}
      onConfirm={() => {
        const next = pendingNavigation;
        setPendingNavigation(undefined);
        setInstructionDirty(false);
        if (next === "back") onBack();
        else if (next !== undefined) setDestination(next);
      }}
    />
  </KnowledgeShell>;
};

const Memories = ({ embedded }: { readonly embedded: boolean }): React.JSX.Element => {
  const [memories, setMemories] = useState<readonly Memory[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<Memory | "new">();
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("fact");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Memory>();
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
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

  const remove = async (): Promise<void> => {
    if (deleting === undefined || deletingBusy) return;
    setDeletingBusy(true);
    setDeleteError(undefined);
    try {
      await knowledge().deleteMemory(deleting.id);
      setDeleting(undefined);
      await refreshAfterMutation();
    } catch (cause) {
      setDeleteError(errorMessage(cause, "Unable to delete memory"));
    } finally {
      setDeletingBusy(false);
    }
  };
  return <>
    <KnowledgeHeader destination="memories" embedded={embedded} />
    <SettingsSection>
      <SettingsRow><SettingsRowCopy><strong>Memory library</strong><small>The 100 most recent facts and preferences.</small></SettingsRowCopy><Button size="sm" onClick={() => open("new")}>New memory</Button></SettingsRow>
      <SettingsRow><SettingsRowCopy><strong>Search memories</strong><small>Filter memory content.</small></SettingsRowCopy><SearchField aria-label="Search memories" placeholder="Search memory content" value={query} onChange={event => setQuery(event.target.value)} /></SettingsRow>
      <DreamCard count={totalCount} onComplete={refreshAfterMutation} />
    </SettingsSection>
    {error ? <ErrorState title="Memories unavailable" description={error}><Button size="sm" onClick={() => void load()}>Retry</Button></ErrorState>
      : loading ? <LoadingState title="Loading memories…" />
        : memories.length === 0 ? <EmptyState role="status" title={query ? "No memories match your search." : "No memories yet."} />
          : <SettingsSection asChild><ul className="m-0 mt-4 list-none p-0">{memories.map(memory => <SettingsRow asChild key={memory.id}><li><div><span className="text-caption uppercase tracking-[0.05em] text-foreground-secondary">{memory.category}</span><p className="mb-0 mt-2 whitespace-pre-wrap">{memory.content}</p></div><SettingsInline><Button size="sm" variant="ghost" onClick={() => open(memory)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => setDeleting(memory)}>Delete</Button></SettingsInline></li></SettingsRow>)}</ul></SettingsSection>}
    <Dialog open={editing !== undefined} onOpenChange={next => { if (!next && !saving) setEditing(undefined); }}>
      <DialogContent>
        <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <DialogHeader><DialogTitle>{editing === "new" ? "Create memory" : "Edit memory"}</DialogTitle></DialogHeader>
          <label className="mt-4 grid gap-2 text-control text-foreground-secondary">Category<Input autoFocus value={category} maxLength={100} onChange={event => setCategory(event.target.value)} /></label>
          <label className="mt-4 grid gap-2 text-control text-foreground-secondary">Content<Textarea className="min-h-36" value={content} maxLength={100000} onChange={event => setContent(event.target.value)} /></label>
          <DialogFooter><Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(undefined)}>Cancel</Button><Button type="submit" size="sm" disabled={saving || !content.trim() || !category.trim()}>{saving ? "Saving…" : "Save"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      open={deleting !== undefined}
      title="Delete this memory?"
      description="This action cannot be undone."
      confirmLabel="Delete Memory"
      busyLabel="Deleting…"
      busy={deletingBusy}
      error={deleteError}
      destructive
      onOpenChange={next => { if (!next) { setDeleting(undefined); setDeleteError(undefined); } }}
      onConfirm={() => void remove()}
    />
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
  return <SettingsRow><div><h3 className="m-0 flex items-center gap-2 text-heading [&_svg]:size-4"><Sparkles aria-hidden="true" />Dream</h3><p className="mb-0 mt-1 text-control text-foreground-secondary">{count < 5 ? `${5 - count} more memories needed.` : "Consolidate memories and promote stable preferences."}</p>{progress ? <p className="mb-0 mt-1 text-control text-foreground-secondary" role="status">{progress.stage} · {progress.memoryCount} memories</p> : null}{result ? <p className="mb-0 mt-1 text-control text-foreground-secondary" role="status">{result.status}: {result.beforeCount} → {result.afterCount}</p> : null}{error ? <p className="mb-0 mt-1 text-control text-destructive" role="alert">{error}</p> : null}</div><Button size="sm" disabled={running || count < 5} onClick={() => void run()}>{running ? "Dreaming…" : "Run Dream"}</Button></SettingsRow>;
};

const Notes = ({ embedded }: { readonly embedded: boolean }): React.JSX.Element => {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<NoteSearchMode>("semantic");
  const [results, setResults] = useState<readonly NoteResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const search = async (): Promise<void> => {
    if (!query.trim()) return;
    const id = ++request.current;
    setBusy(true);
    setError(undefined);
    try {
      const next = await knowledge().searchNotes(query, mode);
      if (id === request.current) setResults(next);
    } catch (cause) {
      if (id === request.current) setError(errorMessage(cause, "Unable to search notes"));
    } finally {
      if (id === request.current) setBusy(false);
    }
  };
  const importNotes = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await knowledge().importNotes();
      if (!result.cancelled) setMessage(`Imported ${result.imported} note chunks with semantic embeddings.`);
    } catch (cause) {
      setError(errorMessage(cause, "Unable to import notes"));
    } finally {
      setBusy(false);
    }
  };
  const hasQuery = query.trim() !== "";
  return <>
    <KnowledgeHeader destination="notes" embedded={embedded} />
    <SettingsSection>
      <SettingsRow>
        <SettingsRowCopy><strong>Note library</strong><small>Import Markdown and text files.</small></SettingsRowCopy>
        <Button size="sm" disabled={busy} onClick={() => void importNotes()}>Import folder</Button>
      </SettingsRow>
      <SettingsRow asChild><form onSubmit={event => { event.preventDefault(); void search(); }}>
        <SettingsRowCopy><strong>Search notes</strong><small>Find note content by meaning or keyword.</small></SettingsRowCopy>
        <div className="grid min-w-[min(28rem,60%)] grid-cols-[minmax(8rem,1fr)_8rem_auto] items-center gap-2 max-compact:w-full max-compact:min-w-0 max-compact:grid-cols-1">
          <SearchField aria-label="Search notes" value={query} onChange={event => setQuery(event.target.value)} />
          <Select value={mode} onValueChange={value => setMode(value as NoteSearchMode)}>
            <SelectTrigger aria-label="Search mode"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="semantic">Semantic</SelectItem><SelectItem value="keyword">Keyword</SelectItem></SelectContent>
          </Select>
          <Button size="sm" disabled={busy || !hasQuery}>{busy ? "Searching…" : "Search"}</Button>
        </div>
      </form></SettingsRow>
    </SettingsSection>
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!busy && hasQuery && results.length === 0 ? <EmptyState title="No note chunks matched." /> : null}
    {results.length > 0 ? <SettingsSection asChild><ul className="m-0 mt-4 list-none p-0">{results.map(result => <SettingsRow asChild key={result.id}><li><div><strong>{result.sourceName}</strong><p className="mb-0 mt-2 whitespace-pre-wrap">{result.snippet}</p></div></li></SettingsRow>)}</ul></SettingsSection> : null}
  </>;
};

const Skills = ({ embedded }: { readonly embedded: boolean }): React.JSX.Element => {
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
    <KnowledgeHeader destination="skills" embedded={embedded} />
    <SearchField className="mb-4" aria-label="Search skills" placeholder="Search skills" value={query} onChange={event => setQuery(event.target.value)} />
    <SplitLayout>
      <SettingsSection asChild><nav className="m-0 content-start" aria-label="Skills">
        {skills === undefined && listError === undefined ? <p className="m-0 p-4 text-foreground-secondary" role="status">Loading skills…</p> : null}
        {listError === undefined ? null : <div className="p-4" role="alert"><p>{listError}</p><Button size="sm" onClick={() => void loadSkills()}>Retry</Button></div>}
        {skills !== undefined && skills.length === 0 ? <p className="m-0 p-4 text-foreground-secondary">No skills installed</p> : null}
        {skills !== undefined && skills.length > 0 && filtered.length === 0 ? <p className="m-0 p-4 text-foreground-secondary">No matching skills</p> : null}
        {filtered.map(skill => <button type="button" key={skill.name} aria-current={selectedName === skill.name ? "page" : undefined} className="grid min-h-16 w-full content-center gap-1 border-0 border-b border-border bg-transparent px-4 py-3 text-left last:border-b-0 hover:bg-surface-muted aria-[current=page]:bg-surface-control [&>span]:truncate [&>span]:text-caption [&>span]:text-foreground-secondary" onClick={() => setSelectedName(skill.name)}><strong>{skill.name}</strong><span>{skill.description}</span></button>)}
      </nav></SettingsSection>
      <SettingsSection aria-label="Skill detail">
        {selectedName === undefined ? <EmptyState title="Skills" description="Select a skill to read its instructions." />
          : detailError !== undefined ? <ErrorState title="Skill unavailable" description={detailError}><Button size="sm" onClick={() => setDetailRetry(value => value + 1)}>Retry</Button></ErrorState>
            : detail === undefined ? <LoadingState title="Loading skill…" />
              : <article className="mx-auto w-full p-4"><header className="border-b border-border pb-5 [&_h1]:m-0 [&_h1]:text-display [&_p]:mb-2 [&_p]:mt-2 [&_p]:text-foreground-secondary"><h1>{detail.name}</h1><p>{detail.description}</p><StatusBadge variant={detail.disableModelInvocation ? "neutral" : "success"}>{detail.disableModelInvocation ? "Model invocation disabled" : "Available to model"}</StatusBadge></header><div className="pt-5"><MarkdownMessage>{detail.body}</MarkdownMessage></div></article>}
      </SettingsSection>
    </SplitLayout>
  </>;
};

const Instructions = ({ embedded, onDirtyChange }: { readonly embedded: boolean; readonly onDirtyChange: (dirty: boolean) => void }): React.JSX.Element => {
  const [files, setFiles] = useState<readonly InstructionFileSummary[]>([]);
  const [selected, setSelected] = useState<InstructionFileId>();
  const [file, setFile] = useState<InstructionFile>();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingSelection, setPendingSelection] = useState<InstructionFileId>();
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
    if (id === selected) return;
    if (dirty) { setPendingSelection(id); return; }
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
    <KnowledgeHeader destination="instructions" embedded={embedded} />
    <SplitLayout>
      <SettingsSection asChild><ul className="m-0 list-none p-0">{files.map(item => <li key={item.id}>
        <button className="grid min-h-16 w-full content-center gap-1 border-0 border-b border-border bg-transparent px-4 py-3 text-left last:border-b-0 hover:bg-surface-muted aria-[current=page]:bg-surface-control" aria-current={selected === item.id ? "page" : undefined} onClick={() => choose(item.id)}>
          <span>{item.label}</span><StatusBadge variant={item.status === "active" ? "success" : item.status === "shadowed" ? "destructive" : "neutral"}>{item.status}</StatusBadge>
        </button>
      </li>)}</ul></SettingsSection>
      <SettingsSection className="flex min-w-0 flex-col gap-2 p-4">
        {error ? <ErrorState title="Instructions unavailable" description={error}><Button size="sm" onClick={retry}>Retry</Button></ErrorState>
          : loading ? <LoadingState title="Loading instructions…" />
            : files.length === 0 ? <EmptyState title="No instruction files available" description="Railgun did not report any editable instruction files." />
              : file === undefined ? <LoadingState title="Loading instructions…" />
            : <>
                <label htmlFor="instruction-content">Markdown instructions</label>
                <Textarea className="min-h-[28rem] flex-1 resize-y font-mono leading-relaxed" id="instruction-content" value={content} spellCheck="true" onChange={event => setContent(event.target.value)} />
                <div className="flex items-center justify-end gap-2"><span className="mr-auto text-caption text-foreground-secondary">{dirty ? "Unsaved changes" : "Saved"}</span><Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => setContent(file.content)}>Revert</Button><Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button></div>
              </>}
      </SettingsSection>
      <ConfirmDialog open={pendingSelection !== undefined} title="Discard unsaved changes?" description="Your instruction edits have not been saved." confirmLabel="Discard Changes" destructive onOpenChange={next => { if (!next) setPendingSelection(undefined); }} onConfirm={() => { const next = pendingSelection; setPendingSelection(undefined); if (next !== undefined) setSelected(next); }} />
    </SplitLayout>
  </>;
};
