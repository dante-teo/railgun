import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bot, CircleUserRound, Search, Server, ShieldCheck, SlidersHorizontal, Stethoscope } from "lucide-react";
import type { BackendSnapshot, MockScenario, SettingsSection, SettingsSnapshot, SettingsUpdate } from "../../shared/types";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { errorMessage } from "../lib/utils";
import { McpSettingsPanel } from "./McpSettingsPanel";

interface SettingsPageProps {
  readonly backend: BackendSnapshot;
  readonly agentRunning: boolean;
  readonly scenarios: readonly MockScenario[];
  readonly onBack: () => void;
  readonly onSaved: () => void;
  readonly onRetryBackend: () => Promise<void>;
  readonly onSelectScenario: (id: string) => Promise<void>;
}

const sections = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "agent", label: "Agent", icon: Bot },
  { id: "trust", label: "Trust", icon: ShieldCheck },
  { id: "provider", label: "Provider", icon: CircleUserRound },
  { id: "mcp", label: "MCP", icon: Server },
  { id: "diagnostics", label: "Diagnostics", icon: Stethoscope },
] as const;

const searchRows = [
  { section: "general", id: "default-model", label: "Default model", description: "Model used for new tasks" },
  { section: "general", id: "operation-timeout", label: "Operation timeout", description: "Maximum time for an operation" },
  { section: "agent", id: "moa-preset", label: "Mixture of Agents preset", description: "Read-only configured collaboration preset" },
  { section: "agent", id: "advisor", label: "Advisor", description: "Enable and choose the advisor model" },
  { section: "trust", id: "approval-mode", label: "Approval mode", description: "Manual, smart review, or off" },
  { section: "trust", id: "reviewer-model", label: "Smart-review model", description: "Model that reviews tool approvals" },
  { section: "provider", id: "devin-provider", label: "Devin provider", description: "Credential source, sign in, and sign out" },
  { section: "mcp", id: "mcp-servers", label: "MCP servers", description: "Commands, arguments, and saved environment secrets" },
  { section: "diagnostics", id: "backend-health", label: "Backend health", description: "Connection status, retry, and redacted diagnostics" },
] as const satisfies readonly { section: SettingsSection; id: string; label: string; description: string }[];

type EditableSection = Extract<SettingsSection, "general" | "agent" | "trust">;

const sectionDraft = (settings: SettingsSnapshot, section: EditableSection): SettingsUpdate => {
  if (section === "general") return { section, ...settings.general };
  if (section === "agent") return { section, moaPreset: settings.agent.moaPreset, advisor: settings.agent.advisor };
  return { section, ...settings.trust };
};

const focusRow = (id: string): void => {
  requestAnimationFrame(() => {
    const row = document.getElementById(`setting-${id}`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
    row?.focus({ preventScroll: true });
  });
};

export const SettingsPage = ({ backend, agentRunning, scenarios, onBack, onSaved, onRetryBackend, onSelectScenario }: SettingsPageProps): React.JSX.Element => {
  const [settings, setSettings] = useState<SettingsSnapshot>();
  const [selected, setSelected] = useState<SettingsSection>("general");
  const [drafts, setDrafts] = useState<Partial<Record<EditableSection, SettingsUpdate>>>({});
  const [query, setQuery] = useState("");
  const [loadingError, setLoadingError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [authOperation, setAuthOperation] = useState<"signing-in" | "signing-out">();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [discardAction, setDiscardAction] = useState<(() => void) | undefined>();
  const searchRef = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);

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

  const activeDraft = settings !== undefined && (selected === "general" || selected === "agent" || selected === "trust")
    ? drafts[selected] ?? sectionDraft(settings, selected) : undefined;
  const dirty = settings !== undefined && activeDraft !== undefined
    && JSON.stringify(activeDraft) !== JSON.stringify(sectionDraft(settings, activeDraft.section));
  const busy = saving || authOperation !== undefined || agentRunning || settings?.running === true;

  const navigate = (action: () => void): void => {
    if (dirty) setDiscardAction(() => action);
    else action();
  };
  const chooseSection = (section: SettingsSection, rowId?: string): void => navigate(() => {
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
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === "") return [];
    return searchRows.filter(row => `${row.section} ${row.label} ${row.description}`.toLocaleLowerCase().includes(needle));
  }, [query]);

  return <main className="settings-shell">
    <aside className="settings-sidebar">
      <div className="settings-traffic-clearance" aria-hidden="true" />
      <button type="button" className="settings-back" onClick={() => navigate(onBack)}><ArrowLeft aria-hidden="true" />Back to Railgun</button>
      <div className="settings-search-wrap">
        <Search aria-hidden="true" />
        <input ref={searchRef} type="search" aria-label="Search settings" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      {query === "" ? <nav aria-label="Settings sections">{sections.map(section => <button type="button" key={section.id} className={selected === section.id ? "selected" : ""} aria-current={selected === section.id ? "page" : undefined} onClick={() => chooseSection(section.id)}><section.icon aria-hidden="true" /><span>{section.label}</span></button>)}</nav>
        : <div className="settings-search-results" role="listbox" aria-label="Settings search results">{results.length === 0 ? <p>No settings found</p> : results.map(result => <button type="button" role="option" aria-selected="false" key={result.id} onClick={() => chooseSection(result.section, result.id)}><strong>{result.label}</strong><span>{result.description}</span></button>)}</div>}
    </aside>
    <section className="settings-detail" aria-label="Settings detail">
      <div className="settings-detail-scroll">
        <div className="settings-column">
          <header className="settings-heading"><h1>{sections.find(section => section.id === selected)?.label}</h1><p>{selected === "general" ? "Defaults for new tasks." : selected === "agent" ? "Configure collaboration for the next run." : selected === "trust" ? "Choose how Railgun approves tool use." : selected === "provider" ? "Manage the Devin provider and authentication." : selected === "mcp" ? "Manage Model Context Protocol servers." : "Inspect the local backend connection."}</p></header>
          {loadingError !== undefined ? <div className="settings-load-state" role="alert"><p>{loadingError}</p><Button size="sm" onClick={() => void load()}>Retry</Button></div> : settings === undefined ? <div className="settings-skeleton" role="status" aria-label="Loading settings"><i /><i /><i /></div> : <>
            {selected === "general" && activeDraft?.section === "general" ? <div className="settings-group">
              <label className="settings-row" id="setting-default-model" tabIndex={-1}><span><strong>Default model</strong><small>Used for new tasks. The current task is unchanged.</small></span><select value={activeDraft.defaultModelId ?? ""} disabled={busy} onChange={event => updateDraft({ ...activeDraft, defaultModelId: event.target.value || null })}><option value="">Automatic</option>{settings.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
              <label className="settings-row" id="setting-operation-timeout" tabIndex={-1}><span><strong>Operation timeout</strong><small>Maximum duration before an operation is stopped.</small></span><span className="settings-number"><input aria-label="Operation timeout in seconds" type="number" min="1" max="86400" value={activeDraft.operationTimeoutSeconds} disabled={busy} onChange={event => updateDraft({ ...activeDraft, operationTimeoutSeconds: Number(event.target.value) })} /><em>seconds</em></span></label>
            </div> : null}
            {selected === "agent" && activeDraft?.section === "agent" ? <div className="settings-group">
              <label className="settings-row" id="setting-moa-preset" tabIndex={-1}><span><strong>Mixture of Agents</strong><small>Presets are defined in Railgun configuration and are read-only here.</small></span><select value={activeDraft.moaPreset ?? ""} disabled={busy} onChange={event => updateDraft({ ...activeDraft, moaPreset: event.target.value || null })}><option value="">Off</option>{settings.moaPresets.map(preset => <option key={preset.name} value={preset.name}>{preset.name}</option>)}</select></label>
              <div className="settings-row" id="setting-advisor" tabIndex={-1}><span><strong>Advisor</strong><small>Applies to the next run, never work already running.</small></span><div className="settings-inline"><label className="settings-switch"><input type="checkbox" aria-label="Enable advisor" checked={activeDraft.advisor.enabled} disabled={busy} onChange={event => updateDraft({ ...activeDraft, advisor: { ...activeDraft.advisor, enabled: event.target.checked } })} /><span /></label><select aria-label="Advisor model" value={activeDraft.advisor.modelId ?? ""} disabled={busy} onChange={event => updateDraft({ ...activeDraft, advisor: { ...activeDraft.advisor, modelId: event.target.value || null } })}><option value="">Choose model</option>{settings.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></div></div>
            </div> : null}
            {selected === "trust" && activeDraft?.section === "trust" ? <div className="settings-group">
              <div className="settings-row" id="setting-approval-mode" tabIndex={-1}><span><strong>Approval mode</strong><small>Controls approval checks for the next run.</small></span><div className="settings-segmented" role="radiogroup" aria-label="Approval mode">{(["manual", "smart", "off"] as const).map(mode => <button key={mode} type="button" role="radio" aria-checked={activeDraft.approvalMode === mode} disabled={busy} onClick={() => updateDraft({ ...activeDraft, approvalMode: mode })}>{mode[0]?.toUpperCase()}{mode.slice(1)}</button>)}</div></div>
              <label className="settings-row" id="setting-reviewer-model" tabIndex={-1}><span><strong>Smart-review model</strong><small>Required when smart approval is selected.</small></span><select value={activeDraft.reviewerModelId ?? ""} disabled={busy || activeDraft.approvalMode !== "smart"} aria-invalid={activeDraft.approvalMode === "smart" && activeDraft.reviewerModelId === null} onChange={event => updateDraft({ ...activeDraft, reviewerModelId: event.target.value || null })}><option value="">Choose model</option>{settings.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
            </div> : null}
            {selected === "provider" ? <div className="settings-group"><div className="settings-row" id="setting-devin-provider" tabIndex={-1}><span><strong>Devin provider</strong><small>{settings.provider.message}</small><span className={`provider-status ${settings.provider.state}`}>{settings.provider.state.replaceAll("-", " ")}</span></span><div className="settings-inline">{settings.provider.state === "sign-in-required" || settings.provider.state === "unavailable" ? <Button disabled={busy || backend.mode === "mock"} onClick={() => void authenticate("in")}>{authOperation === "signing-in" ? "Signing in…" : "Sign In"}</Button> : <Button variant="destructive" disabled={busy || backend.mode === "mock"} onClick={() => setConfirmSignOut(true)}>{authOperation === "signing-out" ? "Signing out…" : "Sign Out"}</Button>}</div></div></div> : null}
            {selected === "mcp" ? <McpSettingsPanel /> : null}
            {selected === "diagnostics" ? <div className="settings-group"><div className="settings-row" id="setting-backend-health" tabIndex={-1}><span><strong>Backend health</strong><small>{backend.error ?? (backend.phase === "ready" ? "Backend is healthy." : "Backend is not ready.")}</small><span className={`provider-status ${backend.phase}`}>{backend.phase.replaceAll("-", " ")}</span></span><Button disabled={authOperation !== undefined || backend.phase === "starting"} onClick={() => void onRetryBackend()}>Retry</Button></div>{backend.diagnostics.length > 0 ? <details className="settings-diagnostics"><summary>Redacted diagnostics</summary><ol>{backend.diagnostics.slice(-20).map((entry, index) => <li key={index}>{entry}</li>)}</ol></details> : null}{backend.mode === "mock" ? <label className="settings-row"><span><strong>Mock scenario</strong><small>Restart with a deterministic desktop scenario.</small></span><select value={backend.scenarioId} onChange={event => void onSelectScenario(event.target.value)}>{scenarios.map(scenario => <option key={scenario.id} value={scenario.id}>{scenario.label}</option>)}</select></label> : null}</div> : null}
            {operationError === undefined ? null : <p className="settings-operation-error" role="alert">{operationError}</p>}
            {activeDraft === undefined ? null : <footer className="settings-save"><span role="status">{saved ? "Saved" : dirty ? "Unsaved changes" : "No changes"}</span><Button disabled={!dirty || busy || (activeDraft.section === "agent" && activeDraft.advisor.enabled && activeDraft.advisor.modelId === null) || (activeDraft.section === "trust" && activeDraft.approvalMode === "smart" && activeDraft.reviewerModelId === null)} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button></footer>}
          </>}
        </div>
      </div>
    </section>
    <Dialog open={discardAction !== undefined} onOpenChange={open => { if (!open) setDiscardAction(undefined); }}><DialogContent><DialogHeader><DialogTitle>Discard unsaved changes?</DialogTitle><DialogDescription>Your edits in this section have not been saved.</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" autoFocus onClick={() => setDiscardAction(undefined)}>Cancel</Button><Button variant="destructive" onClick={() => { const action = discardAction; setDiscardAction(undefined); setDrafts({}); action?.(); }}>Discard Changes</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={confirmSignOut} onOpenChange={setConfirmSignOut}><DialogContent><DialogHeader><DialogTitle>Sign out of Devin?</DialogTitle><DialogDescription>This removes only Railgun’s cached credential. An active DEVIN_TOKEN will continue to provide access.</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" autoFocus onClick={() => setConfirmSignOut(false)}>Cancel</Button><Button variant="destructive" onClick={() => void authenticate("out")}>Sign Out</Button></DialogFooter></DialogContent></Dialog>
  </main>;
};
