import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowLeft, Bot, Brain, CircleUserRound, FileText, Search, Server, ShieldCheck, SlidersHorizontal, Sparkles, Stethoscope } from "lucide-react";
import { DESKTOP_CONTROL_LIMITS } from "../../shared/schemas";
import type { ArchivedSessionSummary, BackendSnapshot, MockScenario, SettingsSection, SettingsSnapshot, SettingsUpdate } from "../../shared/types";
import { PHASE_COPY, RETRYABLE_PHASES } from "../backendStatus";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { SegmentedControl, SegmentedControlItem } from "../components/ui/radio-group";
import { Switch } from "../components/ui/switch";
import { SearchField } from "../components/ui/form";
import { Input } from "../components/ui/input";
import { StatusBadge } from "../components/ui/badge";
import { SettingsColumn, SettingsDetail, SettingsHeading, SettingsInline, SettingsNav, SettingsNavGroup, SettingsNavItem, SettingsRow, SettingsRowCopy, SettingsSave, SettingsSearchResult, SettingsSearchResults, SettingsSection as SettingsSectionCard, SettingsShell, SettingsSidebar, SettingsSkeleton } from "../components/ui/product";
import { KnowledgePage, knowledgeDestinationMetadata } from "../knowledge/KnowledgePage";
import type { KnowledgeDestination } from "../knowledge/KnowledgePage";
import { errorMessage } from "../lib/utils";
import { BackgroundAutomationSettingsPanel } from "./BackgroundAutomationSettingsPanel";
import { McpSettingsPanel } from "./McpSettingsPanel";

interface SettingsPageProps {
  readonly backend: BackendSnapshot;
  readonly agentRunning: boolean;
  readonly scenarios: readonly MockScenario[];
  readonly onBack: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onSaved: () => void;
  readonly onRetryBackend: () => Promise<void>;
  readonly onSelectScenario: (id: string) => Promise<void>;
  readonly onSessionsChanged?: () => Promise<void>;
}

type SettingsPageSection = SettingsSection | KnowledgeDestination;
interface SettingsSectionDefinition { readonly id: SettingsPageSection; readonly label: string; readonly icon: typeof Bot }
interface SettingsSectionGroup { readonly label: string; readonly sections: readonly SettingsSectionDefinition[] }

const sectionGroups: readonly SettingsSectionGroup[] = [
  { label: "Railgun", sections: [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "agent", label: "Agent", icon: Bot },
    { id: "trust", label: "Trust", icon: ShieldCheck },
    { id: "archives", label: "Archived Tasks", icon: Archive },
  ] },
  { label: "Knowledge", sections: [
    { id: "memories", label: knowledgeDestinationMetadata.memories.label, icon: Brain },
    { id: "notes", label: knowledgeDestinationMetadata.notes.label, icon: FileText },
    { id: "instructions", label: knowledgeDestinationMetadata.instructions.label, icon: Sparkles },
    { id: "skills", label: knowledgeDestinationMetadata.skills.label, icon: Search },
  ] },
  { label: "Connections", sections: [
    { id: "provider", label: "Provider", icon: CircleUserRound },
    { id: "mcp", label: "MCP", icon: Server },
  ] },
  { label: "System", sections: [
    { id: "diagnostics", label: "Diagnostics", icon: Stethoscope },
  ] },
];

const sections = sectionGroups.flatMap(group => group.sections);

const searchRows = [
  { section: "general", id: "default-model", label: "Default model", description: "Model used for new tasks" },
  { section: "general", id: "operation-timeout", label: "Operation timeout", description: "Maximum time for an operation" },
  { section: "general", id: "background-automation", label: "Background automation", description: "Run scheduled prompts and nightly maintenance while Railgun is closed" },
  { section: "agent", id: "moa-preset", label: "Mixture of Agents preset", description: "Read-only configured collaboration preset" },
  { section: "agent", id: "advisor", label: "Advisor", description: "Enable and choose the advisor model" },
  { section: "trust", id: "approval-mode", label: "Approval mode", description: "Manual, smart review, or off" },
  { section: "trust", id: "reviewer-model", label: "Smart-review model", description: "Model that reviews tool approvals" },
  { section: "archives", id: "archived-tasks", label: "Archived tasks", description: "Restore tasks or choose how long archives are retained" },
  { section: "memories", id: "memories", label: "Memories", description: "Facts and preferences remembered by Railgun" },
  { section: "notes", id: "notes", label: "Notes", description: "Imported notes available to Railgun" },
  { section: "instructions", id: "instructions", label: "Instructions", description: "Global instructions followed by Railgun" },
  { section: "skills", id: "skills", label: "Skills", description: "Reusable instruction packages available to Railgun" },
  { section: "provider", id: "devin-provider", label: "Devin provider", description: "Credential source, sign in, and sign out" },
  { section: "mcp", id: "mcp-servers", label: "MCP servers", description: "Commands, arguments, and saved environment secrets" },
  { section: "diagnostics", id: "backend-health", label: "Backend health", description: "Connection status, retry, and redacted diagnostics" },
] as const satisfies readonly { section: SettingsPageSection; id: string; label: string; description: string }[];

type EditableSection = Extract<SettingsSection, "general" | "agent" | "trust" | "archives">;
const knowledgeDestinations = new Set<SettingsPageSection>(["memories", "notes", "instructions", "skills"]);
const isKnowledgeDestination = (section: SettingsPageSection): section is KnowledgeDestination => knowledgeDestinations.has(section);
const statusVariant = (state: string): "success" | "warning" | "destructive" | "neutral" =>
  state === "ready" || state === "signed-in" ? "success"
    : state === "failed" || state === "disconnected" ? "destructive"
      : state.includes("required") || state === "starting" ? "warning" : "neutral";
const NULL_MODEL_SELECT_VALUE = `railgun:null:model:${"-".repeat(DESKTOP_CONTROL_LIMITS.modelId)}`;
const NULL_PRESET_SELECT_VALUE = `railgun:null:preset:${"-".repeat(DESKTOP_CONTROL_LIMITS.presetName)}`;
const archiveRetentionOptions = [1, 7, 30, 90] as const;
type ArchiveRetentionDays = typeof archiveRetentionOptions[number];

const sectionDraft = (settings: SettingsSnapshot, section: EditableSection): SettingsUpdate => {
  if (section === "general") return { section, ...settings.general };
  if (section === "agent") return { section, moaPreset: settings.agent.moaPreset, advisor: settings.agent.advisor };
  if (section === "archives") return { section, ...settings.archives };
  return { section, ...settings.trust };
};

const focusRow = (id: string): void => {
  requestAnimationFrame(() => {
    const row = document.getElementById(`setting-${id}`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
    row?.focus({ preventScroll: true });
  });
};

interface ArchiveSettingsPanelProps {
  readonly retentionDays: ArchiveRetentionDays;
  readonly sessions: readonly ArchivedSessionSummary[];
  readonly query: string;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly onRetentionDaysChange: (days: ArchiveRetentionDays) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onUnarchive: (sessionId: string) => void;
}

const ArchiveSettingsPanel = ({ retentionDays, sessions, query, loading, busy, onRetentionDaysChange, onQueryChange, onUnarchive }: ArchiveSettingsPanelProps): React.JSX.Element => <>
  <SettingsSectionCard>
    <SettingsRow asChild><label id="setting-archived-tasks" tabIndex={-1}>
      <SettingsRowCopy><strong>Archive retention</strong><small>Archived tasks are permanently deleted on the next Dream run after this age.</small></SettingsRowCopy>
      <Select value={String(retentionDays)} disabled={busy} onValueChange={value => onRetentionDaysChange(Number(value) as ArchiveRetentionDays)}>
        <SelectTrigger aria-label="Archive retention"><SelectValue /></SelectTrigger>
        <SelectContent>
          {archiveRetentionOptions.map(days => <SelectItem key={days} value={String(days)}>{days} day{days === 1 ? "" : "s"}</SelectItem>)}
        </SelectContent>
      </Select>
    </label></SettingsRow>
  </SettingsSectionCard>
  <SettingsSectionCard>
    <SettingsRow>
      <SettingsRowCopy><strong>Archived tasks</strong><small>Archived tasks remain restorable until retention cleanup.</small></SettingsRowCopy>
      <SearchField aria-label="Search archived tasks" placeholder="Search archived tasks" value={query} onChange={event => onQueryChange(event.target.value)} />
    </SettingsRow>
    {loading ? <p className="m-0 px-4 py-3 text-caption text-foreground-secondary" role="status">Loading archived tasks…</p>
      : sessions.length === 0 ? <p className="m-0 px-4 py-3 text-caption text-foreground-secondary">No archived tasks</p>
        : sessions.map(session => <SettingsRow key={session.id}>
          <SettingsRowCopy><strong>{session.firstUserPreview || "Untitled chat"}</strong><small>{session.model} · archived {new Date(session.archivedAt).toLocaleString()}</small></SettingsRowCopy>
          <Button size="sm" disabled={busy} onClick={() => onUnarchive(session.id)}>Unarchive</Button>
        </SettingsRow>)}
  </SettingsSectionCard>
</>;

export const SettingsPage = ({ backend, agentRunning, scenarios, onBack, onDirtyChange, onSaved, onRetryBackend, onSelectScenario, onSessionsChanged = async () => undefined }: SettingsPageProps): React.JSX.Element => {
  const [settings, setSettings] = useState<SettingsSnapshot>();
  const [selected, setSelected] = useState<SettingsPageSection>("general");
  const [knowledgeDirty, setKnowledgeDirty] = useState(false);
  const [knowledgeResetKey, setKnowledgeResetKey] = useState(0);
  const [drafts, setDrafts] = useState<Partial<Record<EditableSection, SettingsUpdate>>>({});
  const [query, setQuery] = useState("");
  const [loadingError, setLoadingError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [authOperation, setAuthOperation] = useState<"signing-in" | "signing-out">();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState<readonly ArchivedSessionSummary[]>([]);
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [unarchiving, setUnarchiving] = useState(false);
  const [discardAction, setDiscardAction] = useState<(() => void) | undefined>();
  const searchRef = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);
  const restoreInFlight = useRef(false);

  const load = async (): Promise<void> => {
    const sequence = ++loadSequence.current;
    setLoadingError(undefined);
    try {
      const next = await window.railgunDesktop.getSettings();
      if (sequence !== loadSequence.current) return;
      setSettings(next);
    } catch (error) {
      if (sequence === loadSequence.current) setLoadingError(errorMessage(error, "Unable to load settings"));
    }
  };
  useEffect(() => { void load(); }, [backend.phase, backend.scenarioId, agentRunning]);

  const loadArchived = async (): Promise<void> => {
    if (backend.phase !== "ready") return;
    setArchiveLoading(true);
    try { setArchivedSessions(await window.railgunDesktop.listArchivedSessions()); }
    catch (error) { setOperationError(errorMessage(error, "Unable to load archived tasks")); }
    finally { setArchiveLoading(false); }
  };
  useEffect(() => { if (selected === "archives") void loadArchived(); }, [selected, backend.phase]);

  const activeDraft = settings !== undefined && (selected === "general" || selected === "agent" || selected === "trust" || selected === "archives")
    ? drafts[selected] ?? sectionDraft(settings, selected) : undefined;
  const settingsDirty = settings !== undefined && activeDraft !== undefined
    && JSON.stringify(activeDraft) !== JSON.stringify(sectionDraft(settings, activeDraft.section));
  const dirty = settingsDirty || knowledgeDirty;
  const busy = saving || authOperation !== undefined || agentRunning || settings?.running === true;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const navigate = (action: () => void): void => {
    if (dirty) setDiscardAction(() => action);
    else action();
  };
  const chooseSection = (section: SettingsPageSection, rowId?: string): void => navigate(() => {
    if (!isKnowledgeDestination(section)) setKnowledgeDirty(false);
    setSelected(section);
    setQuery("");
    if (rowId !== undefined) focusRow(rowId);
  });
  const updateDraft = (update: SettingsUpdate): void => setDrafts(current => ({ ...current, [update.section]: update }));
  const save = async (): Promise<void> => {
    if (activeDraft === undefined || busy) return;
    setSaving(true); setSaved(false); setOperationError(undefined);
    try {
      const next = await window.railgunDesktop.updateSettings(activeDraft);
      setSettings(next); setDrafts({}); setSaved(true); onSaved();
      window.setTimeout(() => setSaved(false), 2_000);
    } catch (error) { setOperationError(errorMessage(error, "Unable to save settings")); }
    finally { setSaving(false); }
  };
  const authenticate = async (action: "in" | "out"): Promise<void> => {
    setConfirmSignOut(false); setOperationError(undefined); setAuthOperation(action === "in" ? "signing-in" : "signing-out");
    try {
      const next = action === "in" ? await window.railgunDesktop.signInDevin() : await window.railgunDesktop.signOutDevin();
      setSettings(next); onSaved();
    } catch (error) { setOperationError(errorMessage(error, action === "in" ? "Unable to sign in" : "Unable to sign out")); }
    finally { setAuthOperation(undefined); }
  };
  const unarchive = async (sessionId: string): Promise<void> => {
    if (busy || restoreInFlight.current) return;
    restoreInFlight.current = true;
    setUnarchiving(true);
    setOperationError(undefined);
    try {
      await window.railgunDesktop.unarchiveSession(sessionId);
      await Promise.all([loadArchived(), onSessionsChanged()]);
    } catch (error) { setOperationError(errorMessage(error, "Unable to restore the task")); }
    finally {
      restoreInFlight.current = false;
      setUnarchiving(false);
    }
  };
  const filteredArchivedSessions = archivedSessions.filter(session => `${session.firstUserPreview} ${session.model}`.toLocaleLowerCase().includes(archiveQuery.trim().toLocaleLowerCase()));
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === "") return [];
    return searchRows.filter(row => `${row.section} ${row.label} ${row.description}`.toLocaleLowerCase().includes(needle));
  }, [query]);
  const discardChanges = (): void => {
    const action = discardAction;
    setDiscardAction(undefined);
    setDrafts({});
    if (knowledgeDirty) setKnowledgeResetKey(key => key + 1);
    setKnowledgeDirty(false);
    action?.();
  };

  return <SettingsShell>
    <SettingsSidebar>
      <SettingsNavItem onClick={() => navigate(onBack)}><ArrowLeft aria-hidden="true" />Back to Railgun</SettingsNavItem>
      <SearchField className="[-webkit-app-region:no-drag]" ref={searchRef} aria-label="Search settings" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} />
      {query === "" ? <SettingsNav aria-label="Settings sections">{sectionGroups.map(group => <SettingsNavGroup key={group.label} aria-labelledby={`settings-group-${group.label.toLocaleLowerCase()}`}><h2 id={`settings-group-${group.label.toLocaleLowerCase()}`}>{group.label}</h2>{group.sections.map(section => <SettingsNavItem key={section.id} aria-current={selected === section.id ? "page" : undefined} onClick={() => chooseSection(section.id)}><section.icon aria-hidden="true" /><span>{section.label}</span></SettingsNavItem>)}</SettingsNavGroup>)}</SettingsNav>
        : <SettingsSearchResults role="navigation" aria-label="Settings search results">{results.length === 0 ? <p>No settings found</p> : results.map(result => <SettingsSearchResult key={result.id} onClick={() => chooseSection(result.section, result.id)}><strong>{result.label}</strong><span>{result.description}</span></SettingsSearchResult>)}</SettingsSearchResults>}
    </SettingsSidebar>
    <SettingsDetail aria-label="Settings detail">
        <SettingsColumn>
          <SettingsHeading><h1>{sections.find(section => section.id === selected)?.label}</h1><p>{selected === "general" ? "Defaults for new tasks." : selected === "agent" ? "Configure collaboration for the next run." : selected === "trust" ? "Choose how Railgun approves tool use." : selected === "archives" ? "Restore archived tasks and choose how long they are retained." : isKnowledgeDestination(selected) ? knowledgeDestinationMetadata[selected].description : selected === "provider" ? "Manage the Devin provider and authentication." : selected === "mcp" ? "Manage Model Context Protocol servers." : "Inspect the local backend connection."}</p></SettingsHeading>
          {isKnowledgeDestination(selected) ? backend.phase === "ready" ? <KnowledgePage key={knowledgeResetKey} embedded destination={selected} onDirtyChange={setKnowledgeDirty} /> : <div className="grid justify-items-start gap-3 rounded-md border border-border p-5" role={backend.phase === "failed" || backend.phase === "disconnected" ? "alert" : "status"}><strong>{PHASE_COPY[backend.phase].title}</strong><p className="m-0 text-destructive">{PHASE_COPY[backend.phase].description}</p>{RETRYABLE_PHASES.has(backend.phase) ? <Button size="sm" onClick={() => void onRetryBackend()}>Retry</Button> : null}</div> : loadingError !== undefined ? <div className="grid justify-items-start gap-3 rounded-md border border-border p-5" role="alert"><p className="m-0 text-destructive">{loadingError}</p><Button size="sm" onClick={() => void load()}>Retry</Button></div> : settings === undefined ? <SettingsSkeleton role="status" aria-label="Loading settings" /> : <>
            {selected === "general" && activeDraft?.section === "general" ? <SettingsSectionCard>
              <SettingsRow asChild><label id="setting-default-model" tabIndex={-1}><SettingsRowCopy><strong>Default model</strong><small>Used for new tasks. The current task is unchanged.</small></SettingsRowCopy><Select value={activeDraft.defaultModelId ?? NULL_MODEL_SELECT_VALUE} disabled={busy} onValueChange={value => updateDraft({ ...activeDraft, defaultModelId: value === NULL_MODEL_SELECT_VALUE ? null : value })}><SelectTrigger aria-label="Default model"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NULL_MODEL_SELECT_VALUE}>Automatic</SelectItem>{settings.models.map(model => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent></Select></label></SettingsRow>
              <SettingsRow asChild><label id="setting-operation-timeout" tabIndex={-1}><SettingsRowCopy><strong>Operation timeout</strong><small>Maximum duration before an operation is stopped.</small></SettingsRowCopy><span className="flex items-center gap-2 text-caption text-foreground-secondary"><Input className="h-7 min-h-7 w-24 text-right" aria-label="Operation timeout in seconds" type="number" min="1" max="86400" value={activeDraft.operationTimeoutSeconds} disabled={busy} onChange={event => updateDraft({ ...activeDraft, operationTimeoutSeconds: Number(event.target.value) })} />seconds</span></label></SettingsRow>
            </SettingsSectionCard> : null}
            {selected === "general" ? <BackgroundAutomationSettingsPanel /> : null}
            {selected === "agent" && activeDraft?.section === "agent" ? <SettingsSectionCard>
              <SettingsRow asChild><label id="setting-moa-preset" tabIndex={-1}><SettingsRowCopy><strong>Mixture of Agents</strong><small>Presets are defined in Railgun configuration and are read-only here.</small></SettingsRowCopy><Select value={activeDraft.moaPreset ?? NULL_PRESET_SELECT_VALUE} disabled={busy} onValueChange={value => updateDraft({ ...activeDraft, moaPreset: value === NULL_PRESET_SELECT_VALUE ? null : value })}><SelectTrigger aria-label="Mixture of Agents preset"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NULL_PRESET_SELECT_VALUE}>Off</SelectItem>{settings.moaPresets.map(preset => <SelectItem key={preset.name} value={preset.name}>{preset.name}</SelectItem>)}</SelectContent></Select></label></SettingsRow>
              <SettingsRow id="setting-advisor" tabIndex={-1}><SettingsRowCopy><strong>Advisor</strong><small>Applies to the next run, never work already running.</small></SettingsRowCopy><SettingsInline><Switch aria-label="Enable advisor" checked={activeDraft.advisor.enabled} disabled={busy} onCheckedChange={checked => updateDraft({ ...activeDraft, advisor: { ...activeDraft.advisor, enabled: checked } })} /><Select value={activeDraft.advisor.modelId ?? NULL_MODEL_SELECT_VALUE} disabled={busy} onValueChange={value => updateDraft({ ...activeDraft, advisor: { ...activeDraft.advisor, modelId: value === NULL_MODEL_SELECT_VALUE ? null : value } })}><SelectTrigger aria-label="Advisor model"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NULL_MODEL_SELECT_VALUE}>Choose model</SelectItem>{settings.models.map(model => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent></Select></SettingsInline></SettingsRow>
            </SettingsSectionCard> : null}
            {selected === "trust" && activeDraft?.section === "trust" ? <SettingsSectionCard>
              <SettingsRow id="setting-approval-mode" tabIndex={-1}><SettingsRowCopy><strong>Approval mode</strong><small>Controls approval checks for the next run.</small></SettingsRowCopy><SegmentedControl aria-label="Approval mode" value={activeDraft.approvalMode} disabled={busy} onValueChange={approvalMode => updateDraft({ ...activeDraft, approvalMode: approvalMode as typeof activeDraft.approvalMode })}>{(["manual", "smart", "off"] as const).map(mode => <SegmentedControlItem key={mode} value={mode}>{mode[0]?.toUpperCase()}{mode.slice(1)}</SegmentedControlItem>)}</SegmentedControl></SettingsRow>
              <SettingsRow asChild><label id="setting-reviewer-model" tabIndex={-1}><SettingsRowCopy><strong>Smart-review model</strong><small>Required when smart approval is selected.</small></SettingsRowCopy><Select value={activeDraft.reviewerModelId ?? NULL_MODEL_SELECT_VALUE} disabled={busy || activeDraft.approvalMode !== "smart"} onValueChange={value => updateDraft({ ...activeDraft, reviewerModelId: value === NULL_MODEL_SELECT_VALUE ? null : value })}><SelectTrigger aria-label="Smart-review model" aria-invalid={activeDraft.approvalMode === "smart" && activeDraft.reviewerModelId === null}><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NULL_MODEL_SELECT_VALUE}>Choose model</SelectItem>{settings.models.map(model => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent></Select></label></SettingsRow>
            </SettingsSectionCard> : null}
            {selected === "archives" && activeDraft?.section === "archives" ? <ArchiveSettingsPanel
              retentionDays={activeDraft.archiveRetentionDays}
              sessions={filteredArchivedSessions}
              query={archiveQuery}
              loading={archiveLoading}
              busy={busy || unarchiving}
              onRetentionDaysChange={archiveRetentionDays => updateDraft({ section: "archives", archiveRetentionDays })}
              onQueryChange={setArchiveQuery}
              onUnarchive={sessionId => void unarchive(sessionId)}
            /> : null}
            {selected === "provider" ? <SettingsSectionCard><SettingsRow id="setting-devin-provider" tabIndex={-1}><SettingsRowCopy><strong>Devin provider</strong><small>{settings.provider.message}</small><StatusBadge variant={statusVariant(settings.provider.state)}>{settings.provider.state.replaceAll("-", " ")}</StatusBadge></SettingsRowCopy><SettingsInline>{settings.provider.state === "sign-in-required" || settings.provider.state === "unavailable" ? <Button disabled={busy || backend.mode === "mock"} onClick={() => void authenticate("in")}>{authOperation === "signing-in" ? "Signing in…" : "Sign In"}</Button> : <Button variant="destructive" disabled={busy || backend.mode === "mock"} onClick={() => setConfirmSignOut(true)}>{authOperation === "signing-out" ? "Signing out…" : "Sign Out"}</Button>}</SettingsInline></SettingsRow></SettingsSectionCard> : null}
            {selected === "mcp" ? <McpSettingsPanel /> : null}
            {selected === "diagnostics" ? <SettingsSectionCard><SettingsRow id="setting-backend-health" tabIndex={-1}><SettingsRowCopy><strong>Backend health</strong><small>{backend.error ?? (backend.phase === "ready" ? "Backend is healthy." : "Backend is not ready.")}</small><StatusBadge variant={statusVariant(backend.phase)}>{backend.phase.replaceAll("-", " ")}</StatusBadge></SettingsRowCopy><Button disabled={authOperation !== undefined || backend.phase === "starting"} onClick={() => void onRetryBackend()}>Retry</Button></SettingsRow>{backend.diagnostics.length > 0 ? <details className="m-0 border-t border-border px-4 py-3"><summary className="cursor-pointer text-caption text-foreground-secondary">Redacted diagnostics</summary><ol className="mt-3 max-h-48 overflow-auto pl-5 font-mono text-caption">{backend.diagnostics.slice(-20).map((entry, index) => <li key={index}>{entry}</li>)}</ol></details> : null}{backend.mode === "mock" && backend.scenarioId !== undefined ? <SettingsRow asChild><label><SettingsRowCopy><strong>Mock scenario</strong><small>Restart with a deterministic desktop scenario.</small></SettingsRowCopy><Select value={backend.scenarioId} onValueChange={value => void onSelectScenario(value)}><SelectTrigger aria-label="Mock scenario"><SelectValue /></SelectTrigger><SelectContent>{scenarios.map(scenario => <SelectItem key={scenario.id} value={scenario.id}>{scenario.label}</SelectItem>)}</SelectContent></Select></label></SettingsRow> : null}</SettingsSectionCard> : null}
            {operationError === undefined ? null : <p className="mt-3 min-h-5 text-caption text-destructive" role="alert">{operationError}</p>}
            {activeDraft === undefined ? null : <SettingsSave><span role="status">{saved ? "Saved" : dirty ? "Unsaved changes" : "No changes"}</span><Button disabled={!dirty || busy || (activeDraft.section === "agent" && activeDraft.advisor.enabled && activeDraft.advisor.modelId === null) || (activeDraft.section === "trust" && activeDraft.approvalMode === "smart" && activeDraft.reviewerModelId === null)} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button></SettingsSave>}
          </>}
        </SettingsColumn>
    </SettingsDetail>
    <ConfirmDialog open={discardAction !== undefined} title="Discard unsaved changes?" description="Your edits in this section have not been saved." confirmLabel="Discard Changes" destructive onOpenChange={open => { if (!open) setDiscardAction(undefined); }} onConfirm={discardChanges} />
    <ConfirmDialog open={confirmSignOut} title="Sign out of Devin?" description="This removes only Railgun’s cached credential. An active DEVIN_TOKEN will continue to provide access." confirmLabel="Sign Out" destructive onOpenChange={setConfirmSignOut} onConfirm={() => void authenticate("out")} />
  </SettingsShell>;
};
