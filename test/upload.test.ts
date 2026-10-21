import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, RESUMABLE_THRESHOLD, uploadMedia } from "../src/google/upload.js";
import { FakeFetch, testClient } from "./helpers.js";

const PATH = "/applications/com.example.app/edits/e1/bundles";
const SESSION = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/com.example.app/edits/e1/bundles?upload_id=xyz";

describe("uploadMedia", () => {
  it("uses a single media upload at or below 10 MB", async () => {
    const fake = new FakeFetch().on("POST", /\/upload\/.*\/bundles$/, { json: { versionCode: 7 } });
    const res = await uploadMedia(testClient(fake), PATH, new Uint8Array(RESUMABLE_THRESHOLD), "application/octet-stream");
    expect(res).toEqual({ versionCode: 7 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url.searchParams.get("uploadType")).toBe("media");
    expect(fake.calls[0]!.url.pathname).toMatch(/^\/upload\/androidpublisher\/v3\//);
    expect(fake.calls[0]!.bytes).toBe(RESUMABLE_THRESHOLD);
  });

  it("switches to a resumable, chunked upload above 10 MB", async () => {
    const total = RESUMABLE_THRESHOLD + 1;
    let received = 0;
    const fake = new FakeFetch()
      .on("POST", /\/upload\/.*\/bundles$/, { status: 200, headers: { location: SESSION } })
      .on("PUT", /\/upload\/.*\/bundles$/, (c) => {
        received += c.bytes ?? 0;
        if (received < total) return { status: 308, headers: { range: `bytes=0-${received - 1}` } };
        return { json: { versionCode: 8 } };
      });
    const res = await uploadMedia(testClient(fake), PATH, new Uint8Array(total), "application/octet-stream");
    expect(res).toEqual({ versionCode: 8 });

    const init = fake.calls[0]!;
    expect(init.url.searchParams.get("uploadType")).toBe("resumable");
    expect(init.headers["x-upload-content-length"]).toBe(String(total));
    const puts = fake.find("PUT", /bundles$/);
    expect(puts).toHaveLength(Math.ceil(total / CHUNK_SIZE));
    expect(puts[0]!.headers["content-range"]).toBe(`bytes 0-${CHUNK_SIZE - 1}/${total}`);
    expect(puts.at(-1)!.headers["content-range"]).toBe(`bytes ${CHUNK_SIZE}-${total - 1}/${total}`);
    expect(received).toBe(total);
  });

  it("resumes from the offset Google reports, not the one it sent", async () => {
    const total = RESUMABLE_THRESHOLD + 1;
    let n = 0;
    const fake = new FakeFetch()
      .on("POST", /bundles$/, { headers: { location: SESSION } })
      .on("PUT", /bundles$/, () => (n++ === 0 ? { status: 308, headers: { range: "bytes=0-99" } } : { json: { versionCode: 9 } }));
    await uploadMedia(testClient(fake), PATH, new Uint8Array(total), "application/octet-stream");
    expect(fake.find("PUT", /bundles$/)[1]!.headers["content-range"]).toBe(`bytes 100-${Math.min(100 + CHUNK_SIZE, total) - 1}/${total}`);
  });

  it("restarts from 0 when a 308 carries no Range header (nothing stored yet)", async () => {
    const total = RESUMABLE_THRESHOLD + 1;
    let n = 0;
    const fake = new FakeFetch()
      .on("POST", /bundles$/, { headers: { location: SESSION } })
      .on("PUT", /bundles$/, (c) =>
        n++ === 0 ? { status: 308 } : c.headers["content-range"]?.endsWith(`-${total - 1}/${total}`) ? { json: { versionCode: 9 } } : { status: 308, headers: { range: `bytes=0-${CHUNK_SIZE - 1}` } },
      );
    await uploadMedia(testClient(fake), PATH, new Uint8Array(total), "application/octet-stream");
    expect(fake.find("PUT", /bundles$/)[1]!.headers["content-range"]).toBe(`bytes 0-${CHUNK_SIZE - 1}/${total}`);
  });

  it("refuses a session URL on a foreign host", async () => {
    const fake = new FakeFetch().on("POST", /bundles$/, { headers: { location: "https://evil.example/steal" } });
    await expect(uploadMedia(testClient(fake), PATH, new Uint8Array(RESUMABLE_THRESHOLD + 1), "x")).rejects.toThrow(/allowlist/);
    expect(fake.calls.every((c) => c.url.hostname.endsWith("googleapis.com"))).toBe(true);
  });
});
