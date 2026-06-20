import { describe, expect, it, vi } from "vitest";

import {
  CerebeAuthError,
  CerebeStorage,
  CerebeUploadError,
  resolveCerebeConfig,
  sha256Hex,
} from "../../src/evidence/cerebe.js";

const CONFIG = { baseUrl: "https://cerebe.example", apiKey: "ck_live_xyz" };
const BYTES = new TextEncoder().encode("hello");
// sha256("hello")
const HELLO_SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function okResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const noSleep = () => Promise.resolve();

function upload(storage: CerebeStorage) {
  return storage.uploadFile({
    bytes: BYTES,
    filename: "evidence.json",
    contentType: "application/json",
    sessionId: "df-publish:abc123",
    userId: "dark-factory",
  });
}

describe("resolveCerebeConfig", () => {
  it("returns null when CEREBE_API_URL is unset (air-gap fail-soft)", () => {
    expect(resolveCerebeConfig({ CEREBE_API_KEY: "k" })).toBeNull();
  });

  it("returns null when CEREBE_API_KEY is unset", () => {
    expect(resolveCerebeConfig({ CEREBE_API_URL: "https://x" })).toBeNull();
  });

  it("returns null when either value is blank/whitespace", () => {
    expect(resolveCerebeConfig({ CEREBE_API_URL: "  ", CEREBE_API_KEY: "k" })).toBeNull();
  });

  it("resolves config and trims a trailing slash from the base url", () => {
    const c = resolveCerebeConfig({
      CEREBE_API_URL: "https://cerebe.example/",
      CEREBE_API_KEY: "k",
    });
    expect(c).toEqual({ baseUrl: "https://cerebe.example", apiKey: "k" });
  });

  it("picks up the optional project", () => {
    const c = resolveCerebeConfig({
      CEREBE_API_URL: "https://cerebe.example",
      CEREBE_API_KEY: "k",
      CEREBE_PROJECT: "proj_1",
    });
    expect(c?.project).toBe("proj_1");
  });
});

describe("sha256Hex", () => {
  it("computes lowercase-hex SHA-256", () => {
    expect(sha256Hex(BYTES)).toBe(HELLO_SHA);
  });
});

describe("CerebeStorage.uploadFile", () => {
  it("POSTs multipart to /storage/upload with the X-API-Key header and returns the pointer", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe("https://cerebe.example/storage/upload");
      expect(init.method).toBe("POST");
      expect(init.headers["X-API-Key"]).toBe("ck_live_xyz");
      // FormData body — fetch sets multipart Content-Type itself, so we must
      // NOT set it in headers.
      expect(init.headers["Content-Type"]).toBeUndefined();
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get("session_id")).toBe("df-publish:abc123");
      expect((init.body as FormData).get("user_id")).toBe("dark-factory");
      return okResponse({ upload_id: "up_1", cdn_url: "https://cdn/x", status: "clean" });
    });
    const storage = new CerebeStorage(CONFIG, { fetch: fetchMock as any });
    const r = await upload(storage);
    expect(r).toEqual({
      uploadId: "up_1",
      sha256: HELLO_SHA,
      sizeBytes: 5,
      contentType: "application/json",
      cdnUrl: "https://cdn/x",
      status: "clean",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends X-Cerebe-Project when configured", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(init.headers["X-Cerebe-Project"]).toBe("proj_1");
      return okResponse({ upload_id: "up_1" });
    });
    const storage = new CerebeStorage({ ...CONFIG, project: "proj_1" }, { fetch: fetchMock as any });
    await upload(storage);
  });

  it("retries on a 503 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream down", { status: 503 }))
      .mockResolvedValueOnce(okResponse({ upload_id: "up_2" }));
    const storage = new CerebeStorage(CONFIG, { fetch: fetchMock as any, sleep: noSleep });
    const r = await upload(storage);
    expect(r.uploadId).toBe("up_2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on a thrown network error then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(okResponse({ upload_id: "up_3" }));
    const storage = new CerebeStorage(CONFIG, { fetch: fetchMock as any, sleep: noSleep });
    const r = await upload(storage);
    expect(r.uploadId).toBe("up_3");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws CerebeAuthError on 401 without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    const storage = new CerebeStorage(CONFIG, { fetch: fetchMock as any, sleep: noSleep });
    await expect(upload(storage)).rejects.toBeInstanceOf(CerebeAuthError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws CerebeUploadError after exhausting retries on persistent 500", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    const storage = new CerebeStorage(CONFIG, {
      fetch: fetchMock as any,
      sleep: noSleep,
      maxRetries: 2,
    });
    await expect(upload(storage)).rejects.toBeInstanceOf(CerebeUploadError);
    // initial attempt + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-auth 4xx", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
    const storage = new CerebeStorage(CONFIG, { fetch: fetchMock as any, sleep: noSleep });
    await expect(upload(storage)).rejects.toBeInstanceOf(CerebeUploadError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws when the response is missing upload_id", async () => {
    const fetchMock = vi.fn(async () => okResponse({ cdn_url: "https://cdn/x" }));
    const storage = new CerebeStorage(CONFIG, { fetch: fetchMock as any, sleep: noSleep });
    await expect(upload(storage)).rejects.toBeInstanceOf(CerebeUploadError);
  });
});
