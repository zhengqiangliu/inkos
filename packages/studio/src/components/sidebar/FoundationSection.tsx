import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { useChatStore } from "../../store/chat";
import { fetchJson } from "../../hooks/use-api";
import { SidebarCard } from "./SidebarCard";
import { getArtifactLabel } from "../../utils/book-artifacts";

const FOUNDATION_FILES: ReadonlyArray<{ file: string; label: string }> = [
  { file: "story_bible.md", label: getArtifactLabel("story_bible.md").title },
  { file: "volume_outline.md", label: getArtifactLabel("volume_outline.md").title },
  { file: "book_rules.md", label: getArtifactLabel("book_rules.md").title },
  { file: "current_state.md", label: getArtifactLabel("current_state.md").title },
  { file: "pending_hooks.md", label: getArtifactLabel("pending_hooks.md").title },
  { file: "subplot_board.md", label: getArtifactLabel("subplot_board.md").title },
  { file: "emotional_arcs.md", label: getArtifactLabel("emotional_arcs.md").title },
  { file: "character_matrix.md", label: getArtifactLabel("character_matrix.md").title },
];

interface TruthFileInfo {
  name: string;
  size: number;
}

interface FoundationSectionProps {
  readonly bookId: string;
}

export function FoundationSection({ bookId }: FoundationSectionProps) {
  const [files, setFiles] = useState<ReadonlyArray<TruthFileInfo>>([]);
  const openArtifact = useChatStore((s) => s.openArtifact);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);

  useEffect(() => {
    fetchJson<{ files: TruthFileInfo[] }>(`/books/${bookId}/truth`)
      .then((data) => setFiles(data.files))
      .catch(() => setFiles([]));
  }, [bookId, bookDataVersion]);

  const available = FOUNDATION_FILES.filter((f) => files.some((tf) => tf.name === f.file));
  if (available.length === 0) return null;

  return (
    <SidebarCard title="核心文件">
      <ul className="space-y-1">
        {available.map((item) => (
          <li key={item.file}>
            <button
              onClick={() => openArtifact(item.file)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground font-['SimSun','Songti_SC','STSong',serif]"
            >
              <FileText size={14} className="shrink-0 text-muted-foreground/60" />
              <span className="truncate">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </SidebarCard>
  );
}
