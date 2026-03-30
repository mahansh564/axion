import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import FormData from "form-data";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("axion api integration", () => {
  let testRoot: string;
  let app: Awaited<ReturnType<typeof import("./app.js").buildApp>>;

  beforeAll(async () => {
    testRoot = mkdtempSync(join(tmpdir(), "axion-api-"));
    process.env.DATA_DIR = testRoot;
    process.env.DATABASE_URL = join(testRoot, "test.db");
    process.env.PYTHON_WORKER_URL = "http://worker.test";
    process.env.API_KEY = "";

    vi.stubGlobal(
      "fetch",
      async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const u = String(input);
        if (u.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (u.includes("/transcribe")) {
          return new Response(
            JSON.stringify({
              text: "I think Berlin is interesting and Paris too.",
              model_id: "stub",
              language: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u.includes("/extract")) {
          return new Response(
            JSON.stringify({
              model_id: "stub-extract",
              entities: [
                { label: "Berlin", kind: "place", span_start: null, span_end: null },
                { label: "Paris", kind: "place", span_start: null, span_end: null },
              ],
              relations: [
                {
                  subject: "Berlin",
                  predicate: "mentioned_with",
                  object: "Paris",
                  confidence: 0.5,
                },
              ],
              emotion: null,
              uncertainty: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );

    const { runMigrations } = await import("./db/client.js");
    runMigrations();
    const { buildApp } = await import("./app.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("voice upload pipeline and qa", async () => {
    const buf = Buffer.from("fake-audio-bytes");
    const form = new FormData();
    form.append("file", buf, { filename: "note.wav", contentType: "audio/wav" });

    const res = await app.inject({
      method: "POST",
      url: "/experiences/voice",
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { experienceId: string; documentId: string };
    expect(body.experienceId).toBeTruthy();
    expect(body.documentId).toBeTruthy();

    const qa = await app.inject({
      method: "POST",
      url: "/qa",
      payload: { question: "What did I say about Berlin?" },
      headers: { "content-type": "application/json" },
    });
    expect(qa.statusCode).toBe(200);
    const qaBody = JSON.parse(qa.body) as {
      citations: Array<{ document_id: string }>;
      answer: string;
    };
    expect(qaBody.citations.some((c) => c.document_id === body.documentId)).toBe(true);
    expect(qaBody.answer.toLowerCase()).toContain("berlin");
  });
});
