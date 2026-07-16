import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { BackgroundAutomationStatus } from "../../shared/types";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { SettingsInline, SettingsRow, SettingsRowCopy, SettingsSection } from "../components/ui/product";
import { errorMessage } from "../lib/utils";

type AutomationOperation = "enabling" | "disabling" | "repairing";

const statusMessage = (
  operation: AutomationOperation | undefined,
  error: string | undefined,
  automation: BackgroundAutomationStatus | undefined,
): string => operation === "enabling" ? "Turning background automation on…"
  : operation === "disabling" ? "Turning background automation off…"
    : operation === "repairing" ? "Repairing background automation…"
      : error ?? automation?.message ?? "Checking background automation…";

const repairNeeded = (automation: BackgroundAutomationStatus | undefined): boolean =>
  automation?.state === "repair-needed" || (automation?.state === "unavailable" && automation.enabled);

export const BackgroundAutomationSettingsPanel = (): React.JSX.Element => {
  const [automation, setAutomation] = useState<BackgroundAutomationStatus>();
  const [operation, setOperation] = useState<AutomationOperation>();
  const [error, setError] = useState<string>();
  const busy = operation !== undefined;

  const load = async (): Promise<void> => {
    try {
      setAutomation(await window.railgunDesktop.getAutomationStatus());
      setError(undefined);
    } catch (nextError) { setError(errorMessage(nextError, "Unable to read background automation status")); }
  };
  useEffect(() => { void load(); }, []);

  const setEnabled = async (enabled: boolean): Promise<void> => {
    if (busy || automation?.state === "unavailable") return;
    setOperation(enabled ? "enabling" : "disabling");
    setError(undefined);
    try {
      setAutomation(enabled
        ? await window.railgunDesktop.enableAutomation()
        : await window.railgunDesktop.disableAutomation());
    } catch (nextError) { setError(errorMessage(nextError, "Unable to update background automation")); }
    finally { setOperation(undefined); }
  };
  const repair = async (): Promise<void> => {
    if (busy) return;
    setOperation("repairing");
    setError(undefined);
    try { setAutomation(await window.railgunDesktop.repairAutomation()); }
    catch (nextError) { setError(errorMessage(nextError, "Unable to repair background automation")); }
    finally { setOperation(undefined); }
  };

  return <SettingsSection>
    <SettingsRow id="setting-background-automation" tabIndex={-1}>
      <SettingsRowCopy><strong>Background automation</strong><small>Run scheduled prompts and nightly maintenance while Railgun is closed.</small><small className="flex items-center gap-1 text-foreground-tertiary" role="status">{busy ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}{statusMessage(operation, error, automation)}</small></SettingsRowCopy>
      <SettingsInline>
        {repairNeeded(automation) ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void repair()}>{busy ? "Repairing…" : "Repair"}</Button> : null}
        <Switch aria-label="Enable background automation" checked={automation?.enabled ?? false} disabled={busy || automation?.state === "unavailable"} onCheckedChange={checked => void setEnabled(checked)} aria-busy={busy} />
      </SettingsInline>
    </SettingsRow>
  </SettingsSection>;
};
