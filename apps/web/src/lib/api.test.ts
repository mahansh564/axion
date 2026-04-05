import { describe, expect, it, vi } from "vitest";

import { buildAuthHeaders, getJson } from "@/lib/api";

describe("api auth", () => {
  it("returns empty headers when api key absent", () => {
    expect(buildAuthHeaders("")).toEqual({});
  });

  it("returns bearer auth when api key present", () => {
    expect(buildAuthHeaders("secret-token")).toEqual({ Authorization: "Bearer secret-token" });
  });

  it("sends authorization header when requesting JSON", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await getJson<{ ok: boolean }>({
      apiBaseUrl: "http://127.0.0.1:3000",
      apiKey: "abc",
      pathname: "/timeline/events",
      query: { topic: "berlin" },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/timeline/events?topic=berlin",
      expect.objectContaining({
        headers: { Authorization: "Bearer abc" },
      }),
    );

    fetchSpy.mockRestore();
  });
});
