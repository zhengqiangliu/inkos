import { AlertTriangle } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import { cn } from "../../lib/utils";

export function TaskInlineNote({
  label,
  value,
  tone = "error",
  className,
}: {
  readonly label: string;
  readonly value: string | null | undefined;
  readonly tone?: "error" | "warning" | "muted";
  readonly className?: string;
}) {
  const text = value?.trim() ?? "";
  const toneClass = tone === "warning"
    ? "text-amber-600 dark:text-amber-400"
    : tone === "muted"
      ? "text-muted-foreground"
      : "text-destructive";
  const triggerClassName = cn(
    "flex min-w-0 w-full items-center gap-1.5 rounded-md px-0.5 py-0.5 text-xs text-left transition-colors",
    text ? "hover:bg-secondary/40" : "cursor-default",
    toneClass,
    className,
  );

  if (!text) {
    return (
      <div className={triggerClassName}>
        <AlertTriangle size={12} className="shrink-0" />
        <span className="shrink-0">{label}：</span>
        <span className="truncate">无</span>
      </div>
    );
  }

  return (
    <HoverCard>
      <HoverCardTrigger
        href="#"
        delay={120}
        closeDelay={80}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        className={triggerClassName}
        aria-label={`${label}：${text}`}
      >
        <AlertTriangle size={12} className="shrink-0" />
        <span className="shrink-0">{label}：</span>
        <span className="min-w-0 truncate">{text}</span>
      </HoverCardTrigger>
      <HoverCardContent className="w-[min(28rem,calc(100vw-2rem))]">
        <div className="space-y-1.5">
          <div className={cn("text-xs font-medium", toneClass)}>{label}</div>
          <div className="whitespace-pre-wrap break-words text-sm leading-6 text-popover-foreground">
            {text}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
