/**
 * HTTP logging middleware: one line when a request arrives (with every parameter
 * and payload it carries) and one when it completes (status, duration, size) -
 * or a full error dump if it throws.
 *
 * Binary payloads (the rendered PDFs) are never buffered or logged as text - only
 * their size, so streaming responses stay streaming.
 */
import type { Context, MiddlewareHandler } from "hono";
import {
  logConfig,
  logger,
  maskSecret,
  newRequestId,
  runWithContext,
  serializeError,
  updateContext,
  type LogContext,
} from "./logger.js";

/**
 * Path segments that are credentials/bearer handles. Masked by SKIPPING a stable
 * fingerprint because a bare path segment carries no key name for the generic
 * sanitiser to key off. Listed explicitly against this server's routes rather
 * than guessed, so `/pdf/invoice/<id>` keeps its readable docname.
 */
const SECRET_PATH_PATTERNS: Array<RegExp> = [
  /^(\/token\/)([^/]+)(\/?)$/,
  /^(\/pdf\/[^/]+\/)([^/]+)(\/?)$/,
  /^(\/pdf-test\/[^/]+\/)([^/]+)(\/?)$/,
];

const maskPathSecrets = (path: string): string => {
  for (const re of SECRET_PATH_PATTERNS) {
    const m = path.match(re);
    if (m) return `${m[1]}${maskSecret(m[2], { prefix: 3 })}${m[3]}`;
  }
  return path;
};

/**
 * Mask credentials inside a FULL url. The pattern list above is anchored to a
 * leading "/" and must NOT be applied to `c.req.url` directly - on
 * "http://host/token/<key>" it silently matches nothing and leaks the key.
 */
const maskUrlSecrets = (rawUrl: string): string => {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${maskPathSecrets(u.pathname)}${u.search}`;
  } catch {
    return maskPathSecrets(rawUrl);
  }
};

/** Credentials present in a path, registered for whole-request redaction. */
const secretsFromPath = (path: string): string[] =>
  SECRET_PATH_PATTERNS.map((re) => path.match(re)?.[2]).filter((s): s is string => Boolean(s));

const headersToObject = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
};

/**
 * Read a copy of the request body. `c.req.raw.clone()` is used so the handler
 * still receives an unconsumed body.
 */
const captureRequestBody = async (c: Context): Promise<unknown> => {
  if (!logConfig.bodies) return "<capture disabled: LOG_BODIES=0>";
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) return undefined;

  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (logConfig.maxBodyBytes && contentLength > logConfig.maxBodyBytes) {
    return `<body ${contentLength} bytes exceeds LOG_MAX_BODY=${logConfig.maxBodyBytes}, not captured>`;
  }

  try {
    const text = await c.req.raw.clone().text();
    if (text === "") return "<empty body>";
    if (logConfig.maxBodyBytes && text.length > logConfig.maxBodyBytes) {
      return `${text.slice(0, logConfig.maxBodyBytes)}…<truncated ${text.length - logConfig.maxBodyBytes} chars>`;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text; // non-JSON body, logged as-is
    }
  } catch (e) {
    return `<body unreadable: ${(e as Error).message}>`;
  }
};

/** Peek at a JSON response body. Never touches binary/streamed responses. */
const captureResponseBody = async (c: Context): Promise<unknown> => {
  if (!logConfig.bodies) return undefined;
  const contentType = c.res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return undefined;
  const contentLength = Number(c.res.headers.get("content-length") ?? 0);
  if (logConfig.maxBodyBytes && contentLength > logConfig.maxBodyBytes) {
    return `<response body ${contentLength} bytes exceeds LOG_MAX_BODY, not captured>`;
  }
  try {
    const text = await c.res.clone().text();
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (e) {
    return `<response body unreadable: ${(e as Error).message}>`;
  }
};

const elapsed = (startedAt: number): number => Math.round((performance.now() - startedAt) * 100) / 100;

export const httpLogging = (): MiddlewareHandler => async (c, next) => {
  const reqId = c.req.header("x-request-id")?.trim() || newRequestId();
  const method = c.req.method;
  const path = c.req.path;

  const ctx: LogContext = {
    reqId,
    method,
    path: maskPathSecrets(path),
    // Anything containing these gets redacted anywhere in the request's logs.
    secrets: secretsFromPath(path),
  };

  // Echo the id back so a user-reported failure can be traced to its log lines.
  c.header("x-request-id", reqId);

  return runWithContext(ctx, async () => {
    const startedAt = performance.now();

    logger.info("http.request", {
      url: maskUrlSecrets(c.req.url),
      query: Object.fromEntries(new URL(c.req.url).searchParams),
      params: c.req.param(),
      headers: headersToObject(c.req.raw.headers),
      contentLength: c.req.header("content-length"),
      ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? undefined,
      body: await captureRequestBody(c),
    });

    try {
      await next();
    } catch (e) {
      // Log everything about the failure, then let Hono's onError build the response.
      logger.error("http.request.failed", {
        durationMs: elapsed(startedAt),
        error: serializeError(e),
      });
      throw e;
    }

    // routePath is only populated once routing has happened. A middleware mounted
    // at "/*" (serveStatic) leaves it as "/*" even when no real route matched, so
    // that value means "unmatched" rather than a route name.
    const routePath = c.req.routePath;
    const realRoute = routePath && routePath !== "/*" ? routePath : undefined;
    updateContext({ route: realRoute, params: c.req.param() });

    const contentType = c.res.headers.get("content-type") ?? "";
    const status = c.res.status;

    logger[status >= 500 ? "error" : status >= 400 ? "warn" : "info"]("http.response", {
      status,
      durationMs: elapsed(startedAt),
      route: realRoute ?? "<no route matched: static file or 404>",
      contentType: contentType || undefined,
      contentLength: c.res.headers.get("content-length") ?? undefined,
      responseBody: await captureResponseBody(c),
    });

    if (!realRoute && status === 404) {
      logger.warn("http.unmatched_route", {
        path: maskPathSecrets(path),
        hint: "no route matched and serveStatic found no file under ./public",
      });
    }
  });
};
