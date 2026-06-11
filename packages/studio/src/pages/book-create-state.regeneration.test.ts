import { describe, expect, it } from "vitest";
import { buildWizardStepRegenerationInstruction } from "./book-create-state";

describe("buildWizardStepRegenerationInstruction", () => {
  it("uses the correct wizard file for outline and volume steps", () => {
    expect(buildWizardStepRegenerationInstruction({
      step: "outline",
      title: "小说大纲",
      language: "zh",
    })).toContain("wizard/outline.md");

    expect(buildWizardStepRegenerationInstruction({
      step: "volume",
      title: "卷纲规划",
      language: "zh",
    })).toContain("wizard/volume.md");

    expect(buildWizardStepRegenerationInstruction({
      step: "volume",
      title: "Volume Plan",
      language: "en",
    })).toContain("wizard/volume.md");
  });
});
