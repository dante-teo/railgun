import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { McpServer, McpServerUpsert } from "../../shared/types";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
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

  if (loadError !== undefined) return <div className="settings-load-state" role="alert"><p>{loadError}</p><Button size="sm" onClick={() => void load()}>Retry</Button></div>;
  if (servers === undefined) return <div className="settings-skeleton" role="status" aria-label="Loading MCP servers"><i /><i /></div>;
  return <div className="mcp-settings" id="setting-mcp-servers" tabIndex={-1}>
    <div className="mcp-toolbar"><p>Changes apply to new Railgun backend sessions. The currently running backend session is not reconfigured.</p><Button size="sm" onClick={() => { setOperationError(undefined); setDraft(draftFor()); }}><Plus aria-hidden="true" />Add server</Button></div>
    {servers.length === 0 ? <div className="mcp-empty"><strong>No MCP servers configured</strong><span>Add a server to make its tools available to future sessions.</span></div> : servers.map(server => <article className="mcp-card" key={server.name}><div><h2>{server.name}</h2><code>{server.command}</code></div><dl><dt>Arguments</dt><dd>{server.args.length === 0 ? "None" : <ol>{server.args.map((arg, index) => <li key={index}><code>{arg}</code></li>)}</ol>}</dd><dt>Environment</dt><dd>{server.env.length === 0 ? "None" : <ul>{server.env.map(entry => <li key={entry.name}><code>{entry.name}</code> <span>Saved secret</span></li>)}</ul>}</dd></dl><footer><Button size="sm" variant="ghost" onClick={() => { setOperationError(undefined); setDraft(draftFor(server)); }}>Edit</Button><Button size="sm" variant="ghost" onClick={() => { setOperationError(undefined); setConfirmDelete(server); }}><Trash2 aria-hidden="true" />Remove</Button></footer></article>)}
    {operationError === undefined || draft !== undefined || confirmDelete !== undefined ? null : <p role="alert" className="settings-operation-error">{operationError}</p>}
    <Dialog open={draft !== undefined} onOpenChange={open => { if (!open && !busy) { setDraft(undefined); setOperationError(undefined); } }}><DialogContent className="mcp-dialog"><DialogHeader><DialogTitle>{draft?.existing ? "Edit MCP server" : "Add MCP server"}</DialogTitle><DialogDescription>{draft?.existing ? "The server name is immutable. Add a new server, then remove this one to rename it." : "Configure a server for future backend sessions."}</DialogDescription></DialogHeader>{draft === undefined ? null : <div className="mcp-form"><label>Name<input value={draft.name} disabled={draft.existing || busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label>Command<input value={draft.command} disabled={busy} onChange={event => setDraft({ ...draft, command: event.target.value })} /></label><fieldset><legend>Arguments</legend>{draft.args.map((arg, index) => <div className="mcp-edit-row" key={index}><input aria-label={`Argument ${index + 1}`} value={arg} disabled={busy} onChange={event => setDraft({ ...draft, args: draft.args.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} /><Button type="button" size="sm" variant="ghost" aria-label={`Remove argument ${index + 1}`} disabled={busy} onClick={() => setDraft({ ...draft, args: draft.args.filter((_, itemIndex) => itemIndex !== index) })}>Remove</Button></div>)}<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft({ ...draft, args: [...draft.args, ""] })}>Add argument</Button></fieldset><fieldset><legend>Environment variables</legend>{draft.env.map((row, index) => <div className="mcp-edit-row env" key={row.id}><input aria-label={`Environment key ${index + 1}`} value={row.name} disabled={busy} onChange={event => setDraft({ ...draft, env: draft.env.map(item => item.id === row.id ? { ...item, name: event.target.value } : item) })} /><input type="password" aria-label={`Environment value ${index + 1}`} placeholder={row.saved ? "Saved secret" : "Value"} value={row.value} disabled={busy} onChange={event => setDraft({ ...draft, env: draft.env.map(item => item.id === row.id ? { ...item, value: event.target.value, valueEdited: true } : item) })} /><Button type="button" size="sm" variant="ghost" aria-label={`Remove environment variable ${index + 1}`} disabled={busy} onClick={() => removeEnvRow(row.id)}>Remove</Button></div>)}<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft({ ...draft, env: [...draft.env, { id: nextRowId++, name: "", value: "", valueEdited: true, saved: false }] })}>Add environment variable</Button></fieldset>{operationError === undefined ? null : <p role="alert" className="settings-operation-error">{operationError}</p>}</div>}<DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save server"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={confirmDelete !== undefined} onOpenChange={open => { if (!open && !busy) { setConfirmDelete(undefined); setOperationError(undefined); } }}><DialogContent><DialogHeader><DialogTitle>Remove {confirmDelete?.name}?</DialogTitle><DialogDescription>This removes the server from future backend sessions. The current session is unchanged.</DialogDescription></DialogHeader>{operationError === undefined ? null : <p role="alert" className="settings-operation-error">{operationError}</p>}<DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(undefined)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? "Removing…" : "Remove server"}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
};
