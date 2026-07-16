import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { McpServer, McpServerUpsert } from "../../shared/types";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { EmptyState, ErrorState } from "../components/ui/state";
import { SettingsSkeleton } from "../components/ui/product";
import { errorMessage } from "../lib/utils";

interface EnvRow { readonly id: number; name: string; value: string; valueEdited: boolean; readonly originalName?: string; readonly saved: boolean }
interface Draft { readonly existing: boolean; name: string; command: string; args: string[]; env: EnvRow[]; removedEnv: string[] }
let nextRowId = 1;
const draftFor = (server?: McpServer): Draft => server === undefined
  ? { existing: false, name: "", command: "", args: [], env: [], removedEnv: [] }
  : { existing: true, name: server.name, command: server.command, args: [...server.args], env: server.env.map(entry => ({ id: nextRowId++, name: entry.name, value: "", valueEdited: false, originalName: entry.name, saved: true })), removedEnv: [] };

export const McpSettingsPanel = (): React.JSX.Element => {
  const [servers, setServers] = useState<readonly McpServer[]>();
  const [loadError, setLoadError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [confirmDelete, setConfirmDelete] = useState<McpServer>();
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    setLoadError(undefined);
    try { setServers(await window.railgunDesktop.listMcpServers()); }
    catch (error) { setLoadError(errorMessage(error, "Unable to load MCP servers")); }
  };
  useEffect(() => { void load(); }, []);

  const removeEnvRow = (id: number): void => setDraft(current => {
    if (current === undefined) return current;
    const row = current.env.find(item => item.id === id);
    return { ...current, env: current.env.filter(item => item.id !== id), removedEnv: row?.originalName === undefined ? current.removedEnv : [...current.removedEnv, row.originalName] };
  });
  const validate = (value: Draft): string | undefined => {
    if (value.name.trim() === "") return "Server name is required.";
    if (value.command.trim() === "") return "Command is required.";
    if (!value.existing && servers?.some(server => server.name === value.name.trim()) === true) return `A server named ${value.name.trim()} already exists. Edit it instead.`;
    if (value.env.some(row => row.name.trim() === "")) return "Environment keys cannot be empty.";
    const keys = value.env.map(row => row.name.trim());
    if (new Set(keys).size !== keys.length) return "Environment keys must be unique.";
    if (value.env.some(row => row.saved && row.name !== row.originalName && !row.valueEdited)) return "Enter a value when renaming a saved environment key.";
    return undefined;
  };
  const save = async (): Promise<void> => {
    if (draft === undefined || busy) return;
    const validation = validate(draft);
    if (validation !== undefined) { setOperationError(validation); return; }
    const removals = new Set(draft.removedEnv);
    for (const row of draft.env) if (row.originalName !== undefined && row.originalName !== row.name) removals.add(row.originalName);
    for (const row of draft.env) removals.delete(row.name.trim());
    const env: McpServerUpsert["env"] = [
      ...[...removals].map(name => ({ name, value: null })),
      ...draft.env.flatMap(row => row.saved && row.name === row.originalName && !row.valueEdited ? [] : [{ name: row.name.trim(), value: row.value }]),
    ];
    setBusy(true); setOperationError(undefined);
    try {
      setServers(await window.railgunDesktop.upsertMcpServer({ name: draft.name.trim(), command: draft.command.trim(), args: draft.args, env }));
      setDraft(undefined);
    } catch (error) { setOperationError(errorMessage(error, "Unable to save the MCP server")); }
    finally { setBusy(false); }
  };
  const remove = async (): Promise<void> => {
    if (confirmDelete === undefined || busy) return;
    setBusy(true); setOperationError(undefined);
    try { setServers(await window.railgunDesktop.removeMcpServer(confirmDelete.name)); setConfirmDelete(undefined); }
    catch (error) { setOperationError(errorMessage(error, "Unable to remove the MCP server")); }
    finally { setBusy(false); }
  };

  if (loadError !== undefined) return <ErrorState title="MCP servers unavailable" description={loadError}><Button size="sm" onClick={() => void load()}>Retry</Button></ErrorState>;
  if (servers === undefined) return <SettingsSkeleton rows={2} role="status" aria-label="Loading MCP servers" />;
  return <div className="grid gap-3 outline-none focus-visible:outline-2 focus-visible:outline-focus" id="setting-mcp-servers" tabIndex={-1}>
    <div className="flex items-center justify-between gap-4"><p className="m-0 max-w-lg text-caption leading-snug text-foreground-secondary">Changes apply to new Railgun backend sessions. The currently running backend session is not reconfigured.</p><Button size="sm" onClick={() => { setOperationError(undefined); setDraft(draftFor()); }}><Plus aria-hidden="true" />Add server</Button></div>
    {servers.length === 0 ? <EmptyState title="No MCP servers configured" description="Add a server to make its tools available to future sessions." /> : servers.map(server => <Card key={server.name}><article><CardHeader className="flex-row items-baseline justify-between gap-3 p-4"><h2 className="m-0 text-heading">{server.name}</h2><code className="text-caption [overflow-wrap:anywhere]">{server.command}</code></CardHeader><CardContent className="px-4 pb-4"><dl className="my-0 grid grid-cols-[6rem_minmax(0,1fr)] gap-2 text-control [&_dd]:m-0 [&_dt]:text-foreground-secondary"><dt>Arguments</dt><dd>{server.args.length === 0 ? "None" : <ol className="m-0 pl-5">{server.args.map((arg, index) => <li key={index}><code>{arg}</code></li>)}</ol>}</dd><dt>Environment</dt><dd>{server.env.length === 0 ? "None" : <ul className="m-0 pl-5">{server.env.map(entry => <li key={entry.name}><code>{entry.name}</code> <span className="ml-2 text-caption text-foreground-tertiary">Saved secret</span></li>)}</ul>}</dd></dl><footer className="mt-4 flex justify-end gap-2 border-t border-border pt-3"><Button size="sm" variant="ghost" onClick={() => { setOperationError(undefined); setDraft(draftFor(server)); }}>Edit</Button><Button size="sm" variant="ghost" onClick={() => { setOperationError(undefined); setConfirmDelete(server); }}><Trash2 aria-hidden="true" />Remove</Button></footer></CardContent></article></Card>)}
    {operationError === undefined || draft !== undefined || confirmDelete !== undefined ? null : <p role="alert" className="m-0 text-caption text-destructive">{operationError}</p>}
    <Dialog open={draft !== undefined} onOpenChange={open => { if (!open && !busy) { setDraft(undefined); setOperationError(undefined); } }}><DialogContent className="w-[min(42rem,calc(100vw_-_2rem))]"><DialogHeader><DialogTitle>{draft?.existing ? "Edit MCP server" : "Add MCP server"}</DialogTitle><DialogDescription>{draft?.existing ? "The server name is immutable. Add a new server, then remove this one to rename it." : "Configure a server for future backend sessions."}</DialogDescription></DialogHeader>{draft === undefined ? null : <div className="-m-1 grid max-h-[60vh] gap-4 overflow-auto p-1"><label className="grid gap-1 text-control font-medium">Name<Input value={draft.name} disabled={draft.existing || busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label className="grid gap-1 text-control font-medium">Command<Input value={draft.command} disabled={busy} onChange={event => setDraft({ ...draft, command: event.target.value })} /></label><fieldset className="grid gap-2 rounded-sm border border-border p-3"><legend className="px-1 text-control font-medium">Arguments</legend>{draft.args.map((arg, index) => <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2" key={index}><Input aria-label={`Argument ${index + 1}`} value={arg} disabled={busy} onChange={event => setDraft({ ...draft, args: draft.args.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} /><Button type="button" size="sm" variant="ghost" aria-label={`Remove argument ${index + 1}`} disabled={busy} onClick={() => setDraft({ ...draft, args: draft.args.filter((_, itemIndex) => itemIndex !== index) })}>Remove</Button></div>)}<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft({ ...draft, args: [...draft.args, ""] })}>Add argument</Button></fieldset><fieldset className="grid gap-2 rounded-sm border border-border p-3"><legend className="px-1 text-control font-medium">Environment variables</legend>{draft.env.map((row, index) => <div className="grid grid-cols-[minmax(7rem,0.8fr)_minmax(8rem,1fr)_auto] gap-2" key={row.id}><Input aria-label={`Environment key ${index + 1}`} value={row.name} disabled={busy} onChange={event => setDraft({ ...draft, env: draft.env.map(item => item.id === row.id ? { ...item, name: event.target.value } : item) })} /><Input type="password" aria-label={`Environment value ${index + 1}`} placeholder={row.saved ? "Saved secret" : "Value"} value={row.value} disabled={busy} onChange={event => setDraft({ ...draft, env: draft.env.map(item => item.id === row.id ? { ...item, value: event.target.value, valueEdited: true } : item) })} /><Button type="button" size="sm" variant="ghost" aria-label={`Remove environment variable ${index + 1}`} disabled={busy} onClick={() => removeEnvRow(row.id)}>Remove</Button></div>)}<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft({ ...draft, env: [...draft.env, { id: nextRowId++, name: "", value: "", valueEdited: true, saved: false }] })}>Add environment variable</Button></fieldset>{operationError === undefined ? null : <p role="alert" className="m-0 text-caption text-destructive">{operationError}</p>}</div>}<DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save server"}</Button></DialogFooter></DialogContent></Dialog>
    <ConfirmDialog
      open={confirmDelete !== undefined}
      title={`Remove ${confirmDelete?.name ?? "server"}?`}
      description="This removes the server from future backend sessions. The current session is unchanged."
      confirmLabel="Remove server"
      busyLabel="Removing…"
      busy={busy}
      destructive
      error={operationError}
      onOpenChange={open => { if (!open) { setConfirmDelete(undefined); setOperationError(undefined); } }}
      onConfirm={() => void remove()}
    />
  </div>;
};
