import type { BookCreationWizardStep } from "@actalk/inkos-core";

export interface BookCreationRoutingState {
  readonly creationState?: "wizard" | "ready";
  readonly creation?: {
    readonly shellCreated?: boolean;
    readonly wizardCompleted?: boolean;
    readonly completedCount?: number;
    readonly totalSteps?: number;
    readonly resumeStep?: string;
    readonly completedSteps?: ReadonlyArray<string>;
  };
}

export function isWizardIncompleteBook(book: BookCreationRoutingState): boolean {
  if (book.creationState === "ready") return false;
  if (book.creationState === "wizard") return true;
  if (book.creation?.shellCreated === true) return true;
  return book.creation?.wizardCompleted === false;
}

export function resolveBookPrimaryNavigation(book: BookCreationRoutingState): "book" | "book-create" {
  return isWizardIncompleteBook(book) ? "book-create" : "book";
}

export function resolveWizardProgressLabel(
  book: BookCreationRoutingState,
  fallbackTotalSteps = 7,
): string | null {
  if (!isWizardIncompleteBook(book)) return null;
  return `${book.creation?.completedCount ?? 0}/${book.creation?.totalSteps ?? fallbackTotalSteps}`;
}

export function shouldRedirectBookDetailToWizard(book: BookCreationRoutingState | null | undefined): boolean {
  if (!book) return false;
  if (book.creationState === "ready") return false;
  if (book.creationState === "wizard") return true;
  if (book.creation?.shellCreated === true) return true;
  return book.creation?.wizardCompleted === false;
}

export function resolvePersistedDraftSessionId(
  draftSessionId?: string,
  storedSessionId?: string | null,
  availableSessionIds?: ReadonlyArray<string>,
): string | null {
  const candidate = draftSessionId ?? storedSessionId ?? null;
  if (!candidate) return null;
  if (!availableSessionIds) return candidate;
  return availableSessionIds.includes(candidate) ? candidate : null;
}

export function resolveWizardStepsToPrefetch(
  book: BookCreationRoutingState,
): ReadonlyArray<BookCreationWizardStep> {
  const validSteps = new Set<BookCreationWizardStep>([
    "intro",
    "world",
    "outline",
    "volume",
    "characters",
    "arc",
    "relation",
  ]);
  const steps = new Set<BookCreationWizardStep>();
  const pushStep = (step: string | undefined): void => {
    if (!step || !validSteps.has(step as BookCreationWizardStep)) return;
    steps.add(step as BookCreationWizardStep);
  };
  for (const step of book.creation?.completedSteps ?? []) {
    pushStep(step);
  }
  pushStep(book.creation?.resumeStep);
  return [...steps];
}
