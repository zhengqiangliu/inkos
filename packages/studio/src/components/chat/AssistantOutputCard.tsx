import type { ReactNode, HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type AssistantOutputCardTone = "default" | "subtle" | "error";

const toneClasses: Record<AssistantOutputCardTone, string> = {
  default: "rounded-2xl border border-border/50 bg-card/80 px-4 py-3 shadow-sm",
  subtle: "rounded-2xl border border-border/40 bg-card/60 px-3 py-2.5",
  error: "rounded-2xl border border-destructive/15 bg-destructive/5 px-4 py-3",
};

export interface AssistantOutputCardProps extends HTMLAttributes<HTMLDivElement> {
  readonly heading?: ReactNode;
  readonly titleClassName?: string;
  readonly tone?: AssistantOutputCardTone;
  readonly children: ReactNode;
}

export function AssistantOutputCard({
  className,
  heading,
  titleClassName,
  tone = "default",
  children,
  ...props
}: AssistantOutputCardProps) {
  return (
    <div className={cn(toneClasses[tone], className)} {...props}>
      {heading ? (
        <div className={cn("mb-2 text-xs font-medium text-muted-foreground", titleClassName)}>{heading}</div>
      ) : null}
      {children}
    </div>
  );
}
