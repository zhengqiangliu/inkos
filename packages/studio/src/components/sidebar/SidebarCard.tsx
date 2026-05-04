import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

interface SidebarCardProps {
  readonly title: string;
  readonly defaultOpen?: boolean;
  readonly children: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
}

export function SidebarCard({
  title,
  defaultOpen = true,
  children,
  actions,
  className,
  contentClassName,
}: SidebarCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn("rounded-xl bg-card/60", className)}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2.5"
      >
        <span className="text-base font-medium text-foreground font-['SimSun','Songti_SC','STSong',serif]">{title}</span>
        <div className="flex items-center gap-1.5">
          {actions}
          <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </div>
      </button>
      {open && <div className={cn("px-3 pb-3", contentClassName)}>{children}</div>}
    </div>
  );
}
