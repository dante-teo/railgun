import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Layers, Sparkles } from "lucide-react";
import type {
  AgentControlUpdate,
  ChatControlsSnapshot,
  ControlMutationResult,
  DesktopAgentEvent,
  ModelPersistenceMode,
} from "../../shared/types";
import { Button } from "../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { errorMessage } from "../lib/utils";

interface ContextUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ChatToolbarControlsProps {
  readonly running: boolean;
  readonly available: boolean;
  readonly resetKey: number;
}

const tokenCount = new Intl.NumberFormat("en-US");
const compactTokenCount = (value: number): string => value >= 1_000
  ? `${Number((value / 1_000).toFixed(value >= 100_000 ? 0 : 1))}k`
  : String(value);

export const formatContextUsage = (usage: ContextUsage | undefined, contextWindow: number | null): string => {
  if (usage === undefined || contextWindow === null) return "Not measured yet";
  const used = usage.inputTokens + usage.outputTokens;
  const percentage = Number(((used / contextWindow) * 100).toFixed(2));
  return `${tokenCount.format(used)} / ${tokenCount.format(contextWindow)} tokens (${String(percentage)}%)`;
};

const modelDetail = (model: ChatControlsSnapshot["models"][number]): string => [
  `${compactTokenCount(model.contextWindow)} context`,
  `${compactTokenCount(model.maxOutputTokens)} output`,
  model.reasoning ? "Reasoning" : undefined,
  model.inputs.includes("image") ? "Images" : undefined,
  model.supportsTools ? "Tools" : undefined,
].filter((value): value is string => value !== undefined).join(" · ");

interface ModelDialogProps {
  readonly controls: ChatControlsSnapshot;
  readonly disabled: boolean;
  readonly error?: string;
  readonly onSelect: (modelId: string, persistence: ModelPersistenceMode) => Promise<boolean>;
}

const ModelDialog = ({ controls, disabled, error, onSelect }: ModelDialogProps): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(controls.activeModelId);
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle === "" ? controls.models : controls.models.filter(model =>
      model.name.toLocaleLowerCase().includes(needle) || model.id.toLocaleLowerCase().includes(needle));
  }, [controls.models, query]);
  const current = controls.models.find(model => model.id === controls.activeModelId);
  const selectedIsVisible = filtered.some(model => model.id === selected);
  const setDialogOpen = (next: boolean): void => {
    setOpen(next);
    if (!next) return;
    setQuery("");
    setSelected(controls.activeModelId);
    setActiveIndex(Math.max(0, controls.models.findIndex(model => model.id === controls.activeModelId)));
  };
  const apply = async (persistence: ModelPersistenceMode): Promise<void> => {
    if (!selectedIsVisible) return;
    if (await onSelect(selected, persistence)) setOpen(false);
  };
  useEffect(() => { setActiveIndex(index => Math.min(index, Math.max(0, filtered.length - 1))); }, [filtered.length]);
  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild><Button type="button" size="sm" variant="tonal" disabled={disabled} aria-label="Choose model">
        {current?.name ?? controls.activeModelId}<ChevronDown aria-hidden="true" />
      </Button></DialogTrigger>
      <DialogContent className="model-dialog">
        <DialogHeader><DialogTitle>Choose a model</DialogTitle><DialogDescription>Select for this chat or save it as the default.</DialogDescription></DialogHeader>
        <Input
          autoFocus
          aria-label="Search models"
          role="combobox"
          aria-controls="model-options"
          aria-expanded="true"
          aria-activedescendant={filtered[activeIndex] === undefined ? undefined : `model-option-${String(activeIndex)}`}
          value={query}
          onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={event => {
            if (filtered.length === 0) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const offset = event.key === "ArrowDown" ? 1 : -1;
              setActiveIndex(index => (index + offset + filtered.length) % filtered.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const model = filtered[activeIndex];
              if (model !== undefined) setSelected(model.id);
            }
          }}
        />
        <div id="model-options" role="listbox" aria-label="Available models" className="model-options">
          {filtered.length === 0 ? <p className="control-empty">No models match “{query}”.</p> : filtered.map((model, index) => (
            <button
              type="button"
              id={`model-option-${String(index)}`}
              role="option"
              aria-selected={selected === model.id}
              className={index === activeIndex ? "active" : ""}
              key={model.id}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => setSelected(model.id)}
            ><span>{model.name}</span><small>{modelDetail(model)}</small></button>
          ))}
        </div>
        {error === undefined ? null : <p className="control-error" role="alert">{error}</p>}
        <DialogFooter className="model-actions">
          <Button type="button" variant="tonal" disabled={disabled || !selectedIsVisible} onClick={() => void apply("chat")}>This chat</Button>
          <Button type="button" disabled={disabled || !selectedIsVisible} onClick={() => void apply("default")}>Make default</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface AgentDialogProps {
  readonly controls: ChatControlsSnapshot;
  readonly disabled: boolean;
  readonly error?: string;
  readonly onUpdate: (update: AgentControlUpdate) => Promise<boolean>;
  readonly onCompact: () => Promise<boolean>;
}

const AgentDialog = ({ controls, disabled, error, onUpdate, onCompact }: AgentDialogProps): React.JSX.Element => {
  const advisorModelId = controls.advisor.modelId ?? controls.activeModelId;
  const summary = `${controls.activeMoaPreset === null ? "MoA off" : controls.activeMoaPreset} · Advisor ${controls.advisor.enabled ? "on" : "off"}`;
  return <Dialog>
    <DialogTrigger asChild><Button type="button" size="sm" variant="tonal" disabled={disabled} aria-label="Agent settings"><Sparkles aria-hidden="true" />{summary}</Button></DialogTrigger>
    <DialogContent className="agent-controls-dialog">
      <DialogHeader><DialogTitle>Agent settings</DialogTitle><DialogDescription>Defaults apply to the next run, not one already in progress.</DialogDescription></DialogHeader>
      <div className="agent-control-fields">
        <label><span>Mixture of Agents</span><Select
          value={controls.activeMoaPreset ?? "__off__"}
          disabled={disabled}
          onValueChange={value => void onUpdate({ moaPreset: value === "__off__" ? null : value })}
        >
          <SelectTrigger aria-label="MoA preset"><Layers aria-hidden="true" /><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="__off__">Off</SelectItem>{controls.moaPresets.map(preset => (
            <SelectItem value={preset.name} key={preset.name}>{preset.name} · {preset.referenceModels.length} refs → {preset.aggregatorModel}</SelectItem>
          ))}</SelectContent>
        </Select></label>
        <div className="agent-advisor-row"><div><span>Advisor</span><small>Review completed primary-model steps.</small></div><Button
          type="button"
          size="sm"
          variant={controls.advisor.enabled ? "capsule" : "tonal"}
          aria-pressed={controls.advisor.enabled}
          disabled={disabled}
          onClick={() => void onUpdate({ advisor: { enabled: !controls.advisor.enabled, modelId: advisorModelId } })}
        >{controls.advisor.enabled ? "On" : "Off"}</Button></div>
        <label><span>Advisor model</span><Select
          value={advisorModelId}
          disabled={disabled}
          onValueChange={modelId => void onUpdate({ advisor: { enabled: controls.advisor.enabled, modelId } })}
        >
          <SelectTrigger aria-label="Advisor model"><SelectValue /></SelectTrigger>
          <SelectContent>{controls.models.map(model => <SelectItem value={model.id} key={model.id}>{model.name}</SelectItem>)}</SelectContent>
        </Select></label>
        <div className="agent-compact-row"><div><span>Context</span><small>Summarize the current history to free context space.</small></div><Button
          type="button"
          size="sm"
          variant="tonal"
          aria-label="Compact context"
          disabled={disabled || controls.messageCount === 0}
          onClick={() => void onCompact()}
        >Compact</Button></div>
      </div>
      {error === undefined ? null : <p className="control-error" role="alert">{error}</p>}
      <DialogFooter><DialogClose asChild><Button type="button">Done</Button></DialogClose></DialogFooter>
    </DialogContent>
  </Dialog>;
};

export const ChatToolbarControls = ({ running, available, resetKey }: ChatToolbarControlsProps): React.JSX.Element => {
  const [controls, setControls] = useState<ChatControlsSnapshot>();
  const [usage, setUsage] = useState<ContextUsage>();
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    if (!available) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.railgunDesktop.getChatControls();
      if (mounted.current) setControls(next);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause, "Unable to load chat controls"));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  useEffect(() => { setUsage(undefined); }, [resetKey]);
  useEffect(() => {
    const handle = (event: DesktopAgentEvent): void => {
      if (event.type === "context-usage") setUsage({ inputTokens: event.inputTokens, outputTokens: event.outputTokens });
      else if (event.type === "context-reset") setUsage(undefined);
      else if (event.type === "run-end") void load();
    };
    return window.railgunDesktop.onAgentEvent(handle);
  }, [load]);

  const mutation = async (action: () => Promise<ControlMutationResult>, resetUsage = false): Promise<boolean> => {
    setMutating(true);
    setError(undefined);
    try {
      const result = await action();
      if (!mounted.current) return false;
      setControls(result.controls);
      if (resetUsage) setUsage(undefined);
      if (result.warning !== undefined) setError(result.warning);
      return true;
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause, "Unable to update chat controls"));
      return false;
    } finally {
      if (mounted.current) setMutating(false);
    }
  };

  if (controls === undefined && !available) return <div className="chat-controls-state"><span>Controls unavailable</span></div>;
  if (controls === undefined) return <div className="chat-controls-state">
    {loading ? <span role="status">Loading controls…</span> : <><span role="alert">{error}</span><Button type="button" size="sm" variant="tonal" onClick={() => void load()}>Retry</Button></>}
  </div>;

  const disabled = !available || running || mutating;
  return <div className="chat-controls" aria-label="Chat controls">
    <ModelDialog
      controls={controls}
      disabled={disabled}
      {...(error === undefined ? {} : { error })}
      onSelect={(modelId, persistence) => mutation(() => window.railgunDesktop.setChatModel(modelId, persistence), true)}
    />
    <AgentDialog
      controls={controls}
      disabled={disabled}
      {...(error === undefined ? {} : { error })}
      onUpdate={update => mutation(() => window.railgunDesktop.updateAgentControls(update))}
      onCompact={() => mutation(() => window.railgunDesktop.compactContext(), true)}
    />
    <span className="context-usage" role="status" title="Latest provider-reported input and output token usage">{formatContextUsage(usage, controls.contextWindow)}</span>
    {error === undefined ? null : <span className="toolbar-control-error" role="alert">{error}</span>}
  </div>;
};
