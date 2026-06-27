import { Check, ChevronDown, Sparkles } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { cn } from "../../lib/utils";

type ModelGroup = {
  readonly service: string;
  readonly label: string;
  readonly models: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
};

export interface TaskRuntimeControlsProps {
  readonly groupedModels: ReadonlyArray<ModelGroup>;
  readonly selectedModel: string | null;
  readonly selectedService: string | null;
  readonly quickMode: boolean;
  readonly hideQuickMode?: boolean;
  readonly editable?: boolean;
  readonly compact?: boolean;
  readonly inline?: boolean;
  readonly onModelChange: (model: string, service: string) => void;
  readonly onQuickModeChange: (next: boolean) => void;
  readonly onModelMenuOpen?: () => void;
  readonly onManageModels?: () => void;
  readonly className?: string;
  readonly label?: string;
}

export function TaskRuntimeControls({
  groupedModels,
  selectedModel,
  selectedService,
  quickMode,
  hideQuickMode = false,
  editable = true,
  compact = false,
  inline = false,
  onModelChange,
  onQuickModeChange,
  onModelMenuOpen,
  onManageModels,
  className,
  label,
}: TaskRuntimeControlsProps) {
  const resolvedLabel = label ?? (hideQuickMode ? "模型" : "模型 / 快速模式");
  const modelText = selectedService && selectedModel ? `${selectedService}/${selectedModel}` : "选择模型";
  const triggerClassName = compact
    ? "inline-flex min-w-0 items-center gap-1 rounded-md border border-border/50 bg-background/80 px-2 py-1 text-[11px] text-foreground hover:bg-secondary/40 disabled:opacity-50"
    : "inline-flex min-w-0 items-center gap-1 rounded-md border border-border/50 bg-background/80 px-3 py-2 text-sm text-foreground hover:bg-secondary/40 disabled:opacity-50";
  const toggleClassName = compact
    ? cn("inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors", quickMode ? "border-primary/20 bg-primary/10 text-primary" : "border-border/50 bg-background/80 text-muted-foreground")
    : cn("inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-sm transition-colors", quickMode ? "border-primary/20 bg-primary/10 text-primary" : "border-border/50 bg-background/80 text-muted-foreground");
  const disabledNote = editable ? null : (
    <span className="text-[11px] text-muted-foreground">仅在任务未运行时可修改</span>
  );

  if (inline) {
    return (
      <div className={cn("space-y-1.5 text-xs text-muted-foreground", className)}>
        <div className="flex min-w-0 flex-wrap items-center gap-2 lg:flex-nowrap">
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{resolvedLabel}</span>
          {groupedModels.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger disabled={!editable} className={triggerClassName} onPointerDown={onModelMenuOpen} onFocus={onModelMenuOpen}>
                <span className="max-w-[220px] truncate">{modelText}</span>
                <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="start" className="w-64 max-h-80 flex flex-col">
                <div className="overflow-y-auto flex-1">
                  {groupedModels.map((group) => (
                    <div key={group.service}>
                      <div className="px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                        {group.label}
                      </div>
                      {group.models.map((model) => {
                        const isSelected = selectedModel === model.id && selectedService === group.service;
                        return (
                          <DropdownMenuItem
                            key={`${group.service}:${model.id}`}
                            onClick={() => onModelChange(model.id, group.service)}
                            className={isSelected ? "bg-muted/50" : ""}
                          >
                            <div className="flex flex-1 items-center justify-between gap-2">
                              <span className="truncate text-sm">{model.name ?? model.id}</span>
                              {isSelected && <Check size={14} className="shrink-0 text-primary" />}
                            </div>
                          </DropdownMenuItem>
                        );
                      })}
                    </div>
                  ))}
                </div>
                {onManageModels ? (
                  <div className="border-t border-border/30">
                    <DropdownMenuItem onClick={onManageModels} className="text-primary">
                      管理模型
                    </DropdownMenuItem>
                  </div>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : onManageModels ? (
            <button type="button" onClick={onManageModels} className={triggerClassName}>
              配置模型
            </button>
          ) : (
            <span className={triggerClassName}>无可用模型</span>
          )}
          {!hideQuickMode ? (
            <button
              type="button"
              onClick={() => onQuickModeChange(!quickMode)}
              disabled={!editable}
              className={toggleClassName}
            >
              <Sparkles size={12} />
              快速模式 {quickMode ? "开" : "关"}
            </button>
          ) : null}
        </div>
        {disabledNote}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-xs text-muted-foreground xl:flex-nowrap", className)}>
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{resolvedLabel}</span>
      {groupedModels.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger disabled={!editable} className={triggerClassName} onPointerDown={onModelMenuOpen} onFocus={onModelMenuOpen}>
            <span className="max-w-[220px] truncate">{modelText}</span>
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="start" className="w-64 max-h-80 flex flex-col">
            <div className="overflow-y-auto flex-1">
              {groupedModels.map((group) => (
                <div key={group.service}>
                  <div className="px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {group.label}
                  </div>
                  {group.models.map((model) => {
                    const isSelected = selectedModel === model.id && selectedService === group.service;
                    return (
                      <DropdownMenuItem
                        key={`${group.service}:${model.id}`}
                        onClick={() => onModelChange(model.id, group.service)}
                        className={isSelected ? "bg-muted/50" : ""}
                      >
                        <div className="flex flex-1 items-center justify-between gap-2">
                          <span className="truncate text-sm">{model.name ?? model.id}</span>
                          {isSelected && <Check size={14} className="shrink-0 text-primary" />}
                        </div>
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              ))}
            </div>
            {onManageModels ? (
              <div className="border-t border-border/30">
                <DropdownMenuItem onClick={onManageModels} className="text-primary">
                  管理模型
                </DropdownMenuItem>
              </div>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : onManageModels ? (
        <button type="button" onClick={onManageModels} className={triggerClassName}>
          配置模型
        </button>
      ) : (
        <span className={triggerClassName}>无可用模型</span>
      )}
      {!hideQuickMode ? (
        <button
          type="button"
          onClick={() => onQuickModeChange(!quickMode)}
          disabled={!editable}
          className={toggleClassName}
        >
          <Sparkles size={12} />
          快速模式 {quickMode ? "开" : "关"}
        </button>
      ) : null}
      {disabledNote}
    </div>
  );
}
