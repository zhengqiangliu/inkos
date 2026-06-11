import { describe, expect, it } from "vitest";
import {
  isWizardIncompleteBook,
  resolveBookPrimaryNavigation,
  resolvePersistedDraftSessionId,
  resolveWizardProgressLabel,
  resolveWizardStepsToPrefetch,
  shouldRedirectBookDetailToWizard,
} from "./book-creation-routing";
import { GUIDE_MENU_ITEMS, getArtifactLabel, normalizeArtifactFile } from "./book-artifacts";

describe("book creation routing helpers", () => {
  it("treats incomplete wizard books as create-bound", () => {
    const book = {
      creationState: "wizard" as const,
      creation: {
        wizardCompleted: false,
        completedCount: 3,
        totalSteps: 7,
      },
    };

    expect(isWizardIncompleteBook(book)).toBe(true);
    expect(resolveBookPrimaryNavigation(book)).toBe("book-create");
    expect(resolveWizardProgressLabel(book)).toBe("3/7");
  });

  it("treats ready books as book-bound", () => {
    const book = {
      creationState: "ready" as const,
      creation: {
        wizardCompleted: true,
        completedCount: 7,
        totalSteps: 7,
      },
    };

    expect(isWizardIncompleteBook(book)).toBe(false);
    expect(resolveBookPrimaryNavigation(book)).toBe("book");
    expect(resolveWizardProgressLabel(book)).toBeNull();
    expect(shouldRedirectBookDetailToWizard(book)).toBe(false);
  });

  it("keeps draft session ids stable for resume routing", () => {
    expect(resolvePersistedDraftSessionId("draft-a", "stored-b")).toBe("draft-a");
    expect(resolvePersistedDraftSessionId(undefined, "stored-b")).toBe("stored-b");
    expect(resolvePersistedDraftSessionId(undefined, null)).toBeNull();
    expect(resolvePersistedDraftSessionId(undefined, "stored-b", ["stored-b", "stored-c"])).toBe("stored-b");
    expect(resolvePersistedDraftSessionId(undefined, "stale", ["stored-b", "stored-c"])).toBeNull();
    expect(resolvePersistedDraftSessionId("draft-a", "stored-b", ["stored-b", "stored-c"])).toBeNull();
  });

  it("redirects book detail only when wizard is explicitly incomplete", () => {
    expect(shouldRedirectBookDetailToWizard({
      creationState: "wizard",
      creation: { wizardCompleted: false },
    })).toBe(true);
    expect(shouldRedirectBookDetailToWizard({
      creationState: "wizard",
      creation: { wizardCompleted: true },
    })).toBe(true);
    expect(shouldRedirectBookDetailToWizard({
      creationState: undefined,
      creation: { wizardCompleted: true },
    })).toBe(false);
    expect(shouldRedirectBookDetailToWizard({
      creationState: undefined,
      creation: { shellCreated: true, wizardCompleted: true },
    })).toBe(true);
  });

  it("prefetches completed wizard steps and the resume step", () => {
    expect(resolveWizardStepsToPrefetch({
      creation: {
        wizardCompleted: false,
        resumeStep: "outline",
        completedSteps: ["intro", "world", "outline"],
      },
    })).toEqual(["intro", "world", "outline"]);
  });

  it("treats shell-created books as still incomplete until creationState becomes ready", () => {
    expect(resolveBookPrimaryNavigation({
      creationState: undefined,
      creation: {
        shellCreated: true,
        wizardCompleted: true,
      },
    })).toBe("book-create");
  });

  it("reads promoted character arc from truth artifacts", () => {
    expect(GUIDE_MENU_ITEMS.find((item) => item.file === "character_arc.md")?.mode).toBe("truth");
  });

  it("reads promoted relationship map from truth artifacts", () => {
    expect(GUIDE_MENU_ITEMS.find((item) => item.file === "relationship_map.md")?.mode).toBe("truth");
  });

  it("shows the novel outline with a Chinese label in guide menus", () => {
    expect(getArtifactLabel("novel_outline.md")).toEqual({
      title: "小说大纲",
      subtitle: "novel_outline.md",
    });
  });

  it("keeps canonical volume map paths normalized to the new outline file", () => {
    expect(normalizeArtifactFile("story/outline/volume_map.md")).toBe("outline/volume_map.md");
  });
});
