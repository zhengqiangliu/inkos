import { describe, expect, it } from "vitest";
import { buildDashboardExportSaveRequest } from "./Dashboard";

describe("buildDashboardExportSaveRequest", () => {
  it("targets export-save with a txt export payload", () => {
    const request = buildDashboardExportSaveRequest("demo-book");

    expect(request.path).toBe("/books/demo-book/export-save");
    expect(request.init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(request.init.body).toBe(JSON.stringify({ format: "txt", approvedOnly: false }));
  });
});
