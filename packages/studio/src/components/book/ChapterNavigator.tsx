import type { TFunction } from "../../hooks/use-i18n";

export interface NavigatorItem {
  readonly id: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly subtitle?: string;
}

export function ChapterNavigator({
  title,
  items,
  activeItemId,
  onSelect,
  t,
}: {
  readonly title: string;
  readonly items: ReadonlyArray<NavigatorItem>;
  readonly activeItemId: number | null;
  readonly onSelect: (item: NavigatorItem) => void;
  readonly t: TFunction;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/40 bg-card/60">
      <div className="flex items-center justify-between border-b border-border/20 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
        <span className="text-[11px] text-muted-foreground">{items.length}</span>
      </div>
      <div className="space-y-1 p-2">
        {items.map((item) => {
          const active = activeItemId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item)}
              className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                active ? "bg-primary/10 text-primary" : "hover:bg-secondary/60 text-foreground"
              }`}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {String(item.id).padStart(2, "0")} {item.title || t("chapter.label").replace("{n}", String(item.id))}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {item.subtitle ? `${item.subtitle} · ` : ""}
                  {item.status} · {(item.wordCount ?? 0).toLocaleString()}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
