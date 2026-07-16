import { LoaderCircle } from "lucide-react";

export const UpdateCheckPage = (): React.JSX.Element => (
  <main className="grid size-full place-items-center overflow-hidden bg-background text-foreground">
    <div role="status" aria-live="polite" className="grid justify-items-center gap-3 text-control font-medium">
      <span data-glass-surface="control" className="grid size-10 place-items-center rounded-full border border-border bg-popover shadow-control backdrop-blur-popover" aria-hidden="true">
        <LoaderCircle className="size-6 animate-spin text-primary motion-reduce:animate-none" />
      </span>
      <span>Checking for updates…</span>
    </div>
  </main>
);
