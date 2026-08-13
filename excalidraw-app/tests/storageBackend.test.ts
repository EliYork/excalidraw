import { describe, expect, it, vi, afterEach } from "vitest";

import { HttpStorageBackend, parsePrefix } from "../data/storage/httpBackend";

const base = "http://storage.test";
const encoded = (suffix: string) =>
  new Uint8Array([0, 0, 0, 1, ...new TextEncoder().encode(suffix)]);

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parsePrefix", () => {
  it("parses room and share-link prefixes", () => {
    expect(parsePrefix("files/rooms/0123456789abcdef0123")).toEqual({
      kind: "rooms",
      ownerId: "0123456789abcdef0123",
    });
    expect(parsePrefix("/files/shareLinks/abc123")).toEqual({
      kind: "shareLinks",
      ownerId: "abc123",
    });
  });

  it("rejects malformed prefixes", () => {
    expect(parsePrefix("files/rooms")).toBeNull();
    expect(parsePrefix("scenes/123")).toBeNull();
    expect(parsePrefix("files/other/123")).toBeNull();
    expect(parsePrefix("files/rooms/")).toBeNull();
    expect(parsePrefix("")).toBeNull();
  });
});

describe("HttpStorageBackend.getScene", () => {
  it("returns null on 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new HttpStorageBackend(base);
    const scene = await backend.getScene("0123456789abcdef0123");
    expect(scene).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://storage.test/api/v2/scenes/0123456789abcdef0123",
    );
  });

  it("decodes base64 fields and etag", async () => {
    const iv = new TextEncoder().encode("123456789012");
    const ciphertext = new TextEncoder().encode("secret-bytes");
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        sceneVersion: 7,
        iv: Buffer.from(iv).toString("base64"),
        ciphertext: Buffer.from(ciphertext).toString("base64"),
        etag: "7-1234",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const backend = new HttpStorageBackend(base);
    const scene = await backend.getScene("0123456789abcdef0123");
    expect(scene?.sceneVersion).toBe(7);
    expect(scene?.etag).toBe("7-1234");
    expect(new TextDecoder().decode(scene?.iv)).toBe("123456789012");
    expect(new TextDecoder().decode(scene?.ciphertext)).toBe("secret-bytes");
  });
});

describe("HttpStorageBackend.putScene", () => {
  it("sends If-Match and base64 body; returns etag", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { etag: "8-9999" }));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new HttpStorageBackend(base);
    const result = await backend.putScene(
      "0123456789abcdef0123",
      {
        sceneVersion: 8,
        iv: new TextEncoder().encode("123456789012"),
        ciphertext: new TextEncoder().encode("xyz"),
      },
      "7-1234",
    );

    expect(result).toEqual({ ok: true, etag: "8-9999" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://storage.test/api/v2/scenes/0123456789abcdef0123");
    expect(init.method).toBe("PUT");
    expect(init.headers["If-Match"]).toBe("7-1234");
    const body = JSON.parse(init.body);
    expect(body.sceneVersion).toBe(8);
    expect(Buffer.from(body.iv, "base64").toString()).toBe("123456789012");
  });

  it("omits If-Match for create-only and maps 409 to conflict", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(409, { error: "conflict" }));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new HttpStorageBackend(base);
    const result = await backend.putScene(
      "0123456789abcdef0123",
      {
        sceneVersion: 1,
        iv: new TextEncoder().encode("123456789012"),
        ciphertext: new TextEncoder().encode("a"),
      },
      null,
    );

    expect(result).toEqual({ ok: false, conflict: true });
    expect(fetchMock.mock.calls[0][1].headers["If-Match"]).toBeUndefined();
  });
});

describe("HttpStorageBackend.saveFiles", () => {
  it("uploads each file to the right path and collects errors", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      if (url.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new HttpStorageBackend(base);
    const result = await backend.saveFiles("files/rooms/0123456789abcdef0123", [
      { id: "a".repeat(40), buffer: encoded("one") },
      { id: "b".repeat(40), buffer: encoded("two") },
    ]);

    expect(result.savedFiles).toEqual(["a".repeat(40)]);
    expect(result.erroredFiles).toEqual(["b".repeat(40)]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://storage.test/api/v2/files/rooms/0123456789abcdef0123/${"a".repeat(
        40,
      )}`,
    );
  });

  it("rejects invalid prefix", async () => {
    const backend = new HttpStorageBackend(base);
    await expect(
      backend.saveFiles("bogus/prefix", [
        { id: "a".repeat(40), buffer: new Uint8Array() },
      ]),
    ).rejects.toThrow("invalid file prefix");
  });

  it("rejects a non-compressData payload before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const backend = new HttpStorageBackend(base);

    const result = await backend.saveFiles("files/rooms/0123456789abcdef0123", [
      { id: "a".repeat(40), buffer: new Uint8Array([1, 2, 3, 4]) },
    ]);

    expect(result).toEqual({
      savedFiles: [],
      erroredFiles: ["a".repeat(40)],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("HttpStorageBackend.loadFiles", () => {
  it("dedupes ids, decodes buffers, collects errors", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith("a".repeat(40))) {
        return new Response(new TextEncoder().encode("blob-a"), {
          status: 200,
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new HttpStorageBackend(base);
    const result = await backend.loadFiles("files/rooms/0123456789abcdef0123", [
      "a".repeat(40),
      "a".repeat(40),
      "b".repeat(40),
    ]);

    expect(result.loadedFiles).toHaveLength(1);
    expect(new TextDecoder().decode(result.loadedFiles[0].buffer)).toBe(
      "blob-a",
    );
    expect(result.erroredFiles).toEqual(["b".repeat(40)]);
    // deduped: only 2 fetches despite 3 ids
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
