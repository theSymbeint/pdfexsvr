/**
 * Loads font/image binaries from PocketBase.
 *
 * Lookup convention: the `name` field of the `fonts`/`images` record is the code
 * a template must reference (e.g. `FON-IPMG`), NOT the original filename - the
 * builder passes whatever the template has in `fontId` / `fileName`, and a
 * mismatch surfaces here as a PocketBase 404. Both the query and the failure are
 * logged with the exact filter so that mismatch is obvious in the logs.
 */
import pbClient from "./db/pb.js";
import fetch from "node-fetch";
import { logger, serializeError } from "./logger.js";

export async function getFontResource(fontName: string): Promise<ArrayBuffer> {
  return getResource(fontName, "fonts");
}

export async function getImageResource(
  imageName: string,
): Promise<ArrayBuffer> {
  return getResource(imageName, "images");
}

async function getResource(name: string, type: string): Promise<ArrayBuffer> {
  const filter = `name = "${name}"`;
  const startedAt = performance.now();

  logger.debug("resource.lookup", { collection: type, requestedName: name, filter });

  let res: any;
  try {
    res = await pbClient.collection(type).getFirstListItem(filter);
  } catch (e: any) {
    logger.error("resource.lookup_failed", {
      collection: type,
      requestedName: name,
      filter,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      status: e?.status,
      hint:
        e?.status === 404
          ? `no ${type} record has name="${name}". Templates must reference the record's \`name\` code (e.g. FON-IPMG), not a filename.`
          : undefined,
      error: serializeError(e),
    });
    throw e;
  }

  logger.debug("resource.found", {
    collection: type,
    requestedName: name,
    recordId: res?.id,
    recordName: res?.name,
    originalName: res?.originalName,
    file: res?.file,
    template: res?.template,
  });

  const url = pbClient.files.getURL(res, res.file);
  logger.debug("resource.fetch", { collection: type, requestedName: name, url });

  const fileRes = await fetch(url, { method: "GET" });
  if (!fileRes.ok) {
    logger.error("resource.fetch_failed", {
      collection: type,
      requestedName: name,
      url,
      status: fileRes.status,
      statusText: fileRes.statusText,
      hint:
        "the file endpoint sends no auth header - the collection needs public list/view rules",
    });
    throw new Error(`failed to fetch ${type} file: ${fileRes.status} ${fileRes.statusText}`);
  }

  const buffer = await fileRes.arrayBuffer();
  logger.debug("resource.loaded", {
    collection: type,
    requestedName: name,
    url,
    bytes: buffer.byteLength,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  });
  return buffer;
}
