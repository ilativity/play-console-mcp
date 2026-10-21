import { parseJson, type PlayClient, type Query } from "./client.js";

/** Files above this size go through a resumable session instead of a single media upload. */
export const RESUMABLE_THRESHOLD = 10 * 1024 * 1024;
/** Resumable chunks must be a multiple of 256 KiB (except the last). */
export const CHUNK_SIZE = 8 * 1024 * 1024;

const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * Uploads `data` to an `upload`-API path. Small files use `uploadType=media`; larger ones
 * open a resumable session and send it in chunks, resuming from the offset Google reports.
 */
export async function uploadMedia<T>(
  client: PlayClient,
  path: string,
  data: Uint8Array,
  contentType: string,
  query: Query = {},
): Promise<T> {
  if (data.byteLength <= RESUMABLE_THRESHOLD) {
    return client.request<T>("upload", path, {
      method: "POST",
      query: { ...query, uploadType: "media" },
      body: data,
      headers: { "content-type": contentType },
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  }
  return uploadResumable<T>(client, path, data, contentType, query);
}

async function uploadResumable<T>(
  client: PlayClient,
  path: string,
  data: Uint8Array,
  contentType: string,
  query: Query,
): Promise<T> {
  const total = data.byteLength;
  const init = await client.raw("upload", path, {
    method: "POST",
    query: { ...query, uploadType: "resumable" },
    headers: {
      "x-upload-content-type": contentType,
      "x-upload-content-length": String(total),
    },
  });
  await init.body?.cancel().catch(() => {});
  const session = init.headers.get("location");
  if (!session) throw new Error("Resumable upload: Google did not return a session URL.");

  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total);
    const res = await client.rawUrl(session, {
      method: "PUT",
      body: data.subarray(offset, end),
      headers: {
        "content-type": contentType,
        "content-range": `bytes ${offset}-${end - 1}/${total}`,
      },
      acceptStatus: [308],
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (res.status !== 308) return parseJson<T>(res);
    await res.body?.cancel().catch(() => {});
    // "Range: bytes=0-N" says what Google has; continue right after it.
    const range = res.headers.get("range");
    const m = range ? /bytes=0-(\d+)/.exec(range) : null;
    offset = m ? Number(m[1]) + 1 : end;
  }
  throw new Error("Resumable upload: all bytes sent but Google never confirmed completion.");
}
