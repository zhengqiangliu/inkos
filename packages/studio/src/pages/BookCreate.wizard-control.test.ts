import { describe, expect, it, vi } from "vitest";
import { mergeCreationWizardState, buildBookCreateCommand } from "./book-create-state";

describe("BookCreate wizard control", () => {
  it("advances with stable wizard step ids rather than localized titles", () => {
    const instruction = buildBookCreateCommand({
      kind: "advance",
      language: "zh",
      stepTitle: "简介 / 故事背景",
      currentStep: "intro",
      nextStep: "world",
      title: "夜港账本",
      genre: "urban",
      platform: "tomato",
      targetChapters: 120,
      chapterWordCount: 2800,
    }).instruction;

    expect(instruction).toBe("/wizard advance current=intro next=world title=夜港账本 genre=urban platform=tomato target=120 words=2800");
  });

  it("keeps back navigation on control requests instead of streaming chat", async () => {
    const sendMessage = vi.fn();
    const request = {
      intent: "retreat_book_wizard",
      language: "zh" as const,
      stepTitle: "世界观",
      wizardStep: "world" as const,
    };

    expect(request.intent).toBe("retreat_book_wizard");
    expect({
      url: "/interaction/session",
      method: "POST",
      request,
      response: "已返回上一步。",
    }).toMatchObject({
      url: "/interaction/session",
      method: "POST",
      request: {
        intent: "retreat_book_wizard",
        wizardStep: "world",
      },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("treats discard as a control flow action instead of a chat request", () => {
    const request = {
      intent: "discard_book_draft" as const,
      language: "zh" as const,
      stepTitle: "简介 / 故事背景",
      wizardStep: "intro" as const,
    };

    expect(request).toMatchObject({
      intent: "discard_book_draft",
      wizardStep: "intro",
    });
  });

  it("keeps the current step when a stale refresh reports an earlier wizard step", () => {
    const merged = mergeCreationWizardState({
      current: {
        currentStep: "world",
        completedSteps: ["intro"],
        stepNotes: {},
        updatedAt: 100,
      },
      fetched: {
        currentStep: "intro",
        completedSteps: [],
        stepNotes: {},
        updatedAt: 200,
      },
      pendingStep: "world",
    });

    expect(merged?.currentStep).toBe("world");
  });
});
