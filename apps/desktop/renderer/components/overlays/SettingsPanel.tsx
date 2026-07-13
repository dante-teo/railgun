import React, { useEffect, useRef, useState } from "react";
import { useListKeyboard } from "./useListKeyboard.js";

export interface SettingsPanelProps {
  readonly approvalMode: "manual" | "smart" | "off";
  readonly reviewerModel: string | null;
  readonly activeMoaPreset: string | null;
  readonly moaPresetNames: readonly string[];
  readonly advisorEnabled: boolean;
  readonly advisorModel: string | null;
  readonly availableModels: readonly string[];
  readonly theme: "dark" | "light";
  readonly selectedIndex: number;
  readonly onNavigate: (index: number) => void;
  readonly onUpdateConfig: (patch: Record<string, unknown>) => void;
  readonly onToggleTheme: () => void;
  readonly onCancel: () => void;
}

type SubView = "top" | "approval" | "reviewer" | "moa" | "advisor";

interface ListItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly current?: boolean;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  approvalMode,
  reviewerModel,
  activeMoaPreset,
  moaPresetNames,
  advisorEnabled,
  advisorModel,
  availableModels,
  theme,
  selectedIndex,
  onNavigate,
  onUpdateConfig,
  onToggleTheme,
  onCancel,
}) => {
  const [subView, setSubView] = useState<SubView>("top");
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const goBack = (): void => {
    setSubView("top");
    onNavigate(0);
  };

  const topItems: readonly ListItem[] = [
    { id: "approval", label: "Approval mode", detail: approvalMode },
    { id: "reviewer", label: "Reviewer model", detail: reviewerModel ?? "Off" },
    { id: "moa", label: "MoA preset", detail: activeMoaPreset ?? "Off" },
    { id: "advisor", label: "Advisor", detail: advisorEnabled ? (advisorModel ?? "On") : "Off" },
    { id: "theme", label: "Theme", detail: theme, current: true },
  ];

  const subItems = (): readonly ListItem[] => {
    switch (subView) {
      case "approval":
        return [
          { id: "manual", label: "manual", current: approvalMode === "manual" },
          { id: "smart", label: "smart", current: approvalMode === "smart" },
          { id: "off", label: "off", current: approvalMode === "off" },
        ];
      case "reviewer":
        return [
          { id: "off", label: "Off", current: reviewerModel === null },
          ...availableModels.map(m => ({ id: m, label: m, current: m === reviewerModel })),
        ];
      case "moa":
        return [
          { id: "off", label: "Off", current: activeMoaPreset === null },
          ...moaPresetNames.map(p => ({ id: p, label: p, current: p === activeMoaPreset })),
        ];
      case "top":
        return [];
      case "advisor":
        return [
          { id: "off", label: "Off", current: !advisorEnabled },
          ...availableModels.map(m => ({ id: m, label: m, current: m === (advisorEnabled ? advisorModel : null) })),
        ];
    }
  };

  const items: readonly ListItem[] = subView === "top" ? topItems : subItems();
  const title = subView === "top"
    ? "Settings"
    : `Settings · ${topItems.find(i => i.id === subView)?.label ?? ""}`;

  const handleConfirm = (index: number): void => {
    if (subView === "top") {
      const item = topItems[index];
      if (!item) return;
      if (item.id === "theme") {
        onToggleTheme();
        return;
      }
      setSubView(item.id as SubView);
      onNavigate(0);
      return;
    }

    const selected = items[index];
    if (!selected) return;

    switch (subView) {
      case "approval":
        onUpdateConfig({ approvalMode: selected.id });
        break;
      case "reviewer":
        onUpdateConfig({ reviewerModel: selected.id === "off" ? undefined : selected.id });
        break;
      case "moa":
        onUpdateConfig(selected.id === "off" ? { activeMoaPreset: undefined } : { activeMoaPreset: selected.id });
        break;
      case "advisor":
        onUpdateConfig(selected.id === "off"
          ? { advisor: { enabled: false } }
          : { advisor: { enabled: true, model: selected.id } });
        break;
    }

    goBack();
  };

  const handleCancel = (): void => {
    if (subView === "top") {
      onCancel();
    } else {
      goBack();
    }
  };

  useListKeyboard({
    length: items.length,
    selectedIndex,
    onNavigate,
    onConfirm: handleConfirm,
    onCancel: handleCancel,
  });

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="overlay__header">{title}</div>
      <div className="overlay__list" role="listbox">
        {items.map((item, i) => (
          <div
            key={item.id}
            ref={i === selectedIndex ? selectedRef : undefined}
            className={[
              "overlay__item",
              i === selectedIndex ? "overlay__item--selected" : "",
              item.current ? "overlay__item--current" : "",
            ].filter(Boolean).join(" ")}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => handleConfirm(i)}
          >
            <span>{item.label}</span>
            {item.detail !== undefined && (
              <span className="overlay__item__detail">{item.detail}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
