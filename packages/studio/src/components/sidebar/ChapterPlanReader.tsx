import { SidebarCard } from "./SidebarCard";

interface ChapterPlan {
  readonly chapterNumber: number;
  readonly chapterName: string;
  readonly highlight: string;
  readonly coreConflict: string;
  readonly plotAndConflict: string;
  readonly emotionalTone: string;
  readonly endingHook: string;
  readonly status: string;
  readonly source: string;
  readonly version: number;
  readonly needsReview?: boolean;
  readonly lockedFields?: ReadonlyArray<string>;
  readonly driftFlags?: ReadonlyArray<{ readonly code: string; readonly message: string }>;
  readonly maxNewHooks?: number;
  readonly maxRecoveryPerChapter?: number;
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    planned: "计划中",
    backfilled: "已回填",
    approved: "已通过",
    locked: "已锁定",
    used: "已使用",
  };
  return map[status] ?? status;
}

function field(text: string | undefined | null): string {
  const value = typeof text === "string" ? text.trim() : "";
  return value || "暂无内容";
}

export function ChapterPlanReader({ plan }: { readonly plan: ChapterPlan | null }) {
  return (
    <SidebarCard title="分章设计">
      {!plan ? (
        <p className="text-xs text-muted-foreground">暂无分章设计</p>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">第{plan.chapterNumber}章</span>
            <span className="rounded-full bg-secondary/60 px-2 py-0.5 text-[10px] text-muted-foreground">{statusLabel(plan.status)}</span>
            <span className="rounded-full bg-secondary/60 px-2 py-0.5 text-[10px] text-muted-foreground">v{plan.version}</span>
            <span className="text-[10px] text-muted-foreground">{plan.source}</span>
          </div>

          <div>
            <div className="text-[11px] font-medium text-muted-foreground">章节名称</div>
            <div className="mt-1 rounded-lg border border-border/30 bg-background/50 px-3 py-2">{field(plan.chapterName)}</div>
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <Block label="看点" value={plan.highlight} />
            <Block label="核心冲突" value={plan.coreConflict} />
            <Block label="情绪基调" value={plan.emotionalTone} />
            <Block label="结尾钩子" value={plan.endingHook} />
          </div>

          <Block label="剧情与冲突" value={plan.plotAndConflict} />

          <div className="grid gap-2 md:grid-cols-2">
            <Block label="新增伏笔上限" value={typeof plan.maxNewHooks === "number" ? String(plan.maxNewHooks) : "3"} />
            <Block label="每章最多回收" value={typeof plan.maxRecoveryPerChapter === "number" ? String(plan.maxRecoveryPerChapter) : "3"} />
          </div>

          {plan.lockedFields && plan.lockedFields.length > 0 && (
            <div className="text-[11px] text-muted-foreground">锁定字段：{plan.lockedFields.join("、")}</div>
          )}
          {plan.needsReview && (
            <div className="text-[11px] text-amber-600">需要复核</div>
          )}
          {plan.driftFlags && plan.driftFlags.length > 0 && (
            <div className="space-y-1 text-[11px] text-orange-600">
              {plan.driftFlags.slice(0, 3).map((item) => (
                <div key={item.code}>{item.message}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </SidebarCard>
  );
}

function Block({ label, value }: { readonly label: string; readonly value: string | undefined | null }) {
  return (
    <div>
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 rounded-lg border border-border/30 bg-background/50 px-3 py-2 text-xs leading-6 text-foreground">
        {field(value)}
      </div>
    </div>
  );
}
