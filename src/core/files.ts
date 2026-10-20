import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { generic } from "./errors.js";

/** Streams a download to dest via dest.tmp + rename, so a failed transfer never leaves a partial file. */
export async function saveResponse(res: Response, dest: string): Promise<void> {
  if (!res.body) throw generic("download returned no body");
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
