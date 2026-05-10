export interface RoundHeaderProps {
  round: number;
  phase: "audit" | "revise";
  maxRounds: number;
  mode?: string;
  isActive?: boolean;
}

export function RoundHeader({ round, phase, maxRounds, mode, isActive }: RoundHeaderProps) {
  const phaseLabel = phase === "audit" ? "审计" : "修订";

  return (
    <div className={`flex items-center gap-2 pt-4 first:pt-0 ${isActive ? "round-active" : ""}`}>
      <div className={`h-px flex-1 ${isActive ? "bg-primary/40" : "bg-border/30"}`} />
      <span className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider whitespace-nowrap">
        <span className="round-enter inline-block">
          第{round}/{maxRounds}轮{phaseLabel}
          {mode ? ` · ${mode}` : ""}
        </span>
        {isActive && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
        )}
      </span>
      <div className={`h-px flex-1 ${isActive ? "bg-primary/40" : "bg-border/30"}`} />
    </div>
  );
}

