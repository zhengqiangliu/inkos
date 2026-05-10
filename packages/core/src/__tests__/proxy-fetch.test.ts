import { describe, expect, it, vi } from "vitest";
import { fetchWithProxy, resolveProxyUrl } from "../utils/proxy-fetch.js";

describe("proxy-fetch", () => {
  it("resolves proxy URL from explicit value first", () => {
    const proxy = resolveProxyUrl("http://127.0.0.1:8080", {
      HTTPS_PROXY: "http://proxy.example:8888",
    });
    expect(proxy).toBe("http://127.0.0.1:8080");
  });

  it("throws on unsupported proxy protocol", () => {
    expect(() => resolveProxyUrl("socks5://127.0.0.1:1080", {})).toThrow(/Unsupported proxy protocol/);
  });

  it("calls fetch successfully without proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await fetchWithProxy("https://example.com", { method: "GET" }, undefined, {});
    expect(fetchMock).toHaveBeenCalledWith("https://example.com", expect.objectContaining({ method: "GET" }));
  });
});
