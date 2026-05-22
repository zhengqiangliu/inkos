import { describe, expect, it } from "vitest";
import { parseHash, routeToHash } from "./use-hash-route";

describe("hash route", () => {
  describe("parseHash", () => {
    it("parses empty hash as dashboard", () => {
      expect(parseHash("")).toEqual({ page: "dashboard" });
    });

    it("parses #/ as dashboard", () => {
      expect(parseHash("#/")).toEqual({ page: "dashboard" });
    });

    it("parses book route", () => {
      expect(parseHash("#/book/my-novel")).toEqual({ page: "book", bookId: "my-novel" });
    });

    it("decodes encoded bookId", () => {
      expect(parseHash("#/book/%E4%B9%9D%E9%BE%99")).toEqual({ page: "book", bookId: "九龙" });
    });

    it("parses book/new as book-create", () => {
      expect(parseHash("#/book/new")).toEqual({ page: "book-create" });
    });

    it("parses config as services (redirect)", () => {
      expect(parseHash("#/config")).toEqual({ page: "services" });
    });

    it("parses services", () => {
      expect(parseHash("#/services")).toEqual({ page: "services" });
    });

    it("parses tasks route", () => {
      expect(parseHash("#/tasks")).toEqual({ page: "tasks" });
    });

    it("parses logs route", () => {
      expect(parseHash("#/logs")).toEqual({ page: "logs" });
    });

    it("parses genres route", () => {
      expect(parseHash("#/genres")).toEqual({ page: "genres" });
    });

    it("parses style route", () => {
      expect(parseHash("#/style")).toEqual({ page: "style" });
    });

    it("parses import route", () => {
      expect(parseHash("#/import")).toEqual({ page: "import" });
    });

    it("parses radar route", () => {
      expect(parseHash("#/radar")).toEqual({ page: "radar" });
    });

    it("parses doctor route", () => {
      expect(parseHash("#/doctor")).toEqual({ page: "doctor" });
    });

    it("parses service-detail", () => {
      expect(parseHash("#/services/openai")).toEqual({ page: "service-detail", serviceId: "openai" });
    });

    it("parses analytics route", () => {
      expect(parseHash("#/analytics/demo-book")).toEqual({ page: "analytics", bookId: "demo-book" });
    });

    it("parses truth route", () => {
      expect(parseHash("#/truth/demo-book")).toEqual({ page: "truth", bookId: "demo-book" });
    });

    it("parses chapter route", () => {
      expect(parseHash("#/chapter/demo-book/12")).toEqual({ page: "chapter", bookId: "demo-book", chapterNumber: 12 });
    });

    it("decodes encoded serviceId", () => {
      expect(parseHash("#/services/%E8%87%AA%E5%AE%9A%E4%B9%89")).toEqual({ page: "service-detail", serviceId: "自定义" });
    });

    it("falls back to dashboard for unknown hash", () => {
      expect(parseHash("#/unknown/route")).toEqual({ page: "dashboard" });
    });
  });

  describe("routeToHash", () => {
    it("dashboard -> #/", () => {
      expect(routeToHash({ page: "dashboard" })).toBe("#/");
    });

    it("book -> #/book/{id}", () => {
      expect(routeToHash({ page: "book", bookId: "novel-1" })).toBe("#/book/novel-1");
    });

    it("encodes Chinese bookId", () => {
      const hash = routeToHash({ page: "book", bookId: "九龙城夜行" });
      expect(hash).toContain("#/book/");
      expect(decodeURIComponent(hash)).toContain("九龙城夜行");
    });

    it("book-create -> #/book/new", () => {
      expect(routeToHash({ page: "book-create" })).toBe("#/book/new");
    });

    it("services -> #/services", () => {
      expect(routeToHash({ page: "services" })).toBe("#/services");
    });

    it("tasks -> #/tasks", () => {
      expect(routeToHash({ page: "tasks" })).toBe("#/tasks");
    });

    it("logs -> #/logs", () => {
      expect(routeToHash({ page: "logs" })).toBe("#/logs");
    });

    it("genres -> #/genres", () => {
      expect(routeToHash({ page: "genres" })).toBe("#/genres");
    });

    it("style -> #/style", () => {
      expect(routeToHash({ page: "style" })).toBe("#/style");
    });

    it("import -> #/import", () => {
      expect(routeToHash({ page: "import" })).toBe("#/import");
    });

    it("radar -> #/radar", () => {
      expect(routeToHash({ page: "radar" })).toBe("#/radar");
    });

    it("doctor -> #/doctor", () => {
      expect(routeToHash({ page: "doctor" })).toBe("#/doctor");
    });

    it("service-detail -> #/services/{id}", () => {
      expect(routeToHash({ page: "service-detail", serviceId: "openai" })).toBe("#/services/openai");
    });

    it("analytics -> #/analytics/{id}", () => {
      expect(routeToHash({ page: "analytics", bookId: "demo-book" })).toBe("#/analytics/demo-book");
    });

    it("truth -> #/truth/{id}", () => {
      expect(routeToHash({ page: "truth", bookId: "demo-book" })).toBe("#/truth/demo-book");
    });

    it("chapter -> #/chapter/{id}/{num}", () => {
      expect(routeToHash({ page: "chapter", bookId: "demo-book", chapterNumber: 12 })).toBe("#/chapter/demo-book/12");
    });

    it("encodes Chinese serviceId", () => {
      const hash = routeToHash({ page: "service-detail", serviceId: "自定义" });
      expect(hash).toContain("#/services/");
      expect(decodeURIComponent(hash)).toContain("自定义");
    });

    it("daemon returns empty string", () => {
      expect(routeToHash({ page: "daemon" })).toBe("");
    });
  });
});
