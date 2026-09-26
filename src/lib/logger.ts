/**
 * Structured logging for pdfexsvr.
 *
 * Goals: on any request, success or failure, the logs should say exactly what
 * happened - who called, with which parameters and payload, which database
 * queries ran, which template/font/image was resolved, how long each step took,
 * and on failure the full error (stack, PocketBase status + response body).
 *
 * Request correlation: a request id is generated per HTTP request and stored in
 * AsyncLocalStorage, so EVERY log line written while that request is in flight -
 * including ones from the PocketBase client hooks and the PDF builder - carries
 * the same `reqId` without threading it through every function call.
 *
 * Secrets: `LOG_SECRETS=1` logs raw credential values. By default they are
 * replaced with a stable fingerprint (`<redacted len=32 sha=1a2b3c4d ...>`) so you
 * can still tell *which* key/password was used and whether two requests used the
 * same one, without the value landing in a log aggregator.
 *
 * Env vars (all optional):
 *   LOG_LEVEL      error|warn|info|debug|silent   (default: debug)
 *   LOG_FORMAT     json|pretty                    (default: json, or pretty on a TTY)
 *   LOG_BODIES     1|0 - capture request/response payloads (default: 1)
 *   LOG_SECRETS    1|0 - log raw credentials instead of fingerprints (default: 0)
 *   LOG_COLORS     1|0 - colourise pretty output (default: on when a TTY)
 *   LOG_MAX_STRING max characters per logged string, 0 = unlimited (default: 8000)
 *   LOG_MAX_ARRAY  max array items per logged array, 0 = unlimited (default: 50)
 *   LOG_MAX_BODY   max request body bytes captured, 0 = unlimited (default: 1000000)
 *   LOG_DEPTH      max object nesting depth (default: 8)
 *   LOG_SERVICE    service name in every line (default: pdfexsvr)
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import util from "node:util";

export type LogLevel = "error" | "warn" | "info" | "debug" | "silent";
export type LogFormat = "json" | "pretty";

export interface LogContext {
  reqId?: string;
  method?: string;
  path?: string;
  route?: string;
  /**
   * Credential values observed for this request. Registered by the HTTP layer /
   * routes so that ANY string containing them - a DB filter, a PocketBase error
   * url, a request body - is redacted wherever it appears, not just under a
   * secret-looking key name.
   */
  secrets?: string[];
  [key: string]: unknown;
}

const RANK: Record<Exclude<LogLevel, "silent">, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};
const VALID_LEVELS = ["error", "warn", "info", "debug", "silent"];

const truthy = (v: string | undefined, dflt: boolean): boolean => {
  if (v === undefined || v.trim() === "") return dflt;
  return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
};
const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

/** Read once at import time - changing these needs a restart (documented). */
export const logConfig = {
  level: ((): LogLevel => {
    const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
    return raw && VALID_LEVELS.includes(raw) ? (raw as LogLevel) : "debug";
  })(),
  format: ((): LogFormat => {
    const raw = process.env.LOG_FORMAT?.trim().toLowerCase();
    if (raw === "json" || raw === "pretty") return raw as LogFormat;
    // Machine-readable in a container/log aggregator, readable in a terminal.
    return process.stdout.isTTY ? "pretty" : "json";
  })(),
  bodies: truthy(process.env.LOG_BODIES, true),
  secrets: truthy(process.env.LOG_SECRETS, false),
  colors: truthy(process.env.LOG_COLORS, process.stdout.isTTY === true),
  maxString: num(process.env.LOG_MAX_STRING, 8000),
  maxArray: num(process.env.LOG_MAX_ARRAY, 50),
  maxBodyBytes: num(process.env.LOG_MAX_BODY, 1_000_000),
  depth: num(process.env.LOG_DEPTH, 8),
  service: process.env.LOG_SERVICE?.trim() || "pdfexsvr",
  environment: process.env.NODE_ENV?.trim() || "development",
};

// ---------------------------------------------------------------------------
// masking
// ---------------------------------------------------------------------------

/**
 * Keys whose values are credentials. Deliberately anchored: a substring match
 * would redact harmless field names like the `pTokens` collection or
 * `docReqCount`, which are exactly the things we need to read in the logs.
 */
const SECRET_KEY_RE =
  /^(?:pass(?:word|wd)?|password[-_]?hash|dbpass(?:wd)?|pwd|secret|api[-_]?key|apikey|auth|authorization|bearer|cookie|jwt|credential|credentials|private[-_]?key|p[-_]?token|ptoken|tokens?|token[-_]?key|session)$/i;

/** Keys whose value is a key-like handle - worth showing a prefix of. */
const KEYLIKE_RE = /(?:api[-_]?key|apikey|token|bearer)/i;

const fingerprint = (value: unknown): string => {
  const s = typeof value === "string" ? value : safeStringify(value);
  const sha = createHash("sha256").update(s).digest("hex").slice(0, 8);
  return `<redacted len=${s.length} sha=${sha}>`;
};

/**
 * Replace a credential with a stable, non-reversible fingerprint. Exported so
 * call sites can mask a value they *know* is secret even when it is a bare
 * string (e.g. a path parameter) with no secret-looking key to go by.
 */
export const maskSecret = (value: unknown, opts: { prefix?: number } = {}): string => {
  if (logConfig.secrets) return typeof value === "string" ? value : safeStringify(value);
  if (value === undefined || value === null) return "<unset>";
  const s = typeof value === "string" ? value : safeStringify(value);
  if (s === "") return "<empty>";
  const fp = fingerprint(s);
  const prefix = opts.prefix ?? 0;
  if (prefix > 0 && s.length > prefix) {
    return `<redacted prefix=${s.slice(0, prefix)}*** len=${s.length} sha=${fp.slice(-9, -1)}>`;
  }
  return fp;
};

/** `dandre@example.com` -> `<redacted local-part>@example.com` */
export const maskEmail = (value: unknown): string => {
  if (logConfig.secrets) return String(value);
  const s = String(value ?? "");
  const at = s.indexOf("@");
  if (at <= 0) return maskSecret(s, { prefix: 2 });
  return `${s.slice(0, 1)}***${s.slice(at)}`;
};

/** Strip any `user:pass@` userinfo from a URL before logging it. */
export const maskUrlCredentials = (url: string): string => {
  if (logConfig.secrets) return url;
  return url.replace(/\/\/([^/@\s]+)@/g, "//<redacted>@");
};

/** Output of maskSecret/maskEmail - never mask an already-masked value again,
 *  which would hide the fingerprint that makes the redaction traceable. */
const ALREADY_MASKED_RE = /^<(?:redacted|unset|empty)\b/;

/**
 * Replace any credential registered on the current request wherever it appears
 * inside `value`. Catches what key-based masking cannot: `apikey = "x"` in a
 * database filter, `?filter=...` in a PocketBase error url, a body echoing a key.
 */
export const redactKnownSecrets = (value: string): string => {
  if (logConfig.secrets) return value;
  const secrets = als.getStore()?.secrets;
  if (!secrets || secrets.length === 0) return value;
  let out = value;
  for (const secret of secrets) {
    // Ignore trivially short values - replacing every "a" would shred the logs.
    if (secret && secret.length >= 6 && out.includes(secret)) {
      out = out.split(secret).join(maskSecret(secret, { prefix: 3 }));
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const truncate = (s: string): string => {
  if (!logConfig.maxString || s.length <= logConfig.maxString) return s;
  return `${s.slice(0, logConfig.maxString)}…<truncated ${s.length - logConfig.maxString} chars>`;
};

const safeStringify = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/** Convert an Error (incl. PocketBase ClientResponseError) into loggable fields. */
export const serializeError = (e: unknown, depth = 0): Record<string, unknown> => {
  if (e === null || e === undefined) return { error: null };
  if (!(e instanceof Error)) return { error: typeof e === "string" ? e : sanitize(e, depth) };
  const out: Record<string, unknown> = {
    name: e.name,
    message: e.message,
    stack: e.stack,
  };
  // PocketBase ClientResponseError carries the HTTP status + parsed body.
  const anyErr = e as any;
  if (anyErr.status !== undefined) out.status = anyErr.status;
  if (anyErr.url) out.url = maskUrlCredentials(String(anyErr.url));
  if (anyErr.data !== undefined) out.data = sanitize(anyErr.data, depth + 1);
  if (anyErr.response?.data !== undefined) out.responseData = sanitize(anyErr.response.data, depth + 1);
  if (anyErr.originalError?.message) out.originalError = anyErr.originalError.message;
  if (e.cause !== undefined && e.cause !== e) out.cause = serializeError(e.cause, depth + 1);
  if (anyErr.code) out.code = anyErr.code;
  return out;
};

/** Depth-limited, circular-safe, secret-aware value serialiser. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") return truncate(redactKnownSecrets(value as string));
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function") return `<function ${(value as Function).name || "anonymous"}>`;
  if (t === "symbol") return String(value);
  if (value instanceof Date) return (value as Date).toISOString();
  if (value instanceof Error) return serializeError(value, depth);
  if (value instanceof ArrayBuffer) return `<ArrayBuffer ${(value as ArrayBuffer).byteLength} bytes>`;
  if (ArrayBuffer.isView(value)) return `<${(value as any).constructor?.name ?? "View"} ${(value as any).byteLength} bytes>`;
  if (value instanceof Response) return `<Response status=${value.status} type=${value.headers.get("content-type") ?? "?"}>`;
  if (typeof (value as any).pipe === "function") return `<Stream ${(value as any).constructor?.name ?? ""}>`;
  if (depth >= logConfig.depth) return "<max-depth reached>";
  if (Array.isArray(value)) {
    const items = logConfig.maxArray ? value.slice(0, logConfig.maxArray) : value;
    const mapped = items.map((v) => sanitize(v, depth + 1));
    if (logConfig.maxArray && value.length > logConfig.maxArray) {
      mapped.push(`…<${value.length - logConfig.maxArray} more items>`);
    }
    return mapped;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && v !== undefined) {
        // Key-like handles keep a short prefix so you can tell which one it was.
        out[k] =
          v === null || v === "" || typeof v === "boolean"
            ? v // status flags like `apikey_set: true` are not credentials
            : typeof v === "string" && ALREADY_MASKED_RE.test(v)
              ? v // already redacted by an explicit maskSecret/maskEmail call
              : maskSecret(v, { prefix: KEYLIKE_RE.test(k) ? 3 : 0 });
      } else {
        out[k] = sanitize(v, depth + 1);
      }
    }
    return out;
  }
  // PocketBase record/model instances, streams, etc.
  if (typeof (value as any).toJSON === "function") return sanitize((value as any).toJSON(), depth + 1);
  return truncate(safeStringify(value));
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

const als = new AsyncLocalStorage<LogContext>();

export const newRequestId = (): string => randomUUID();

/** Run `fn` with `ctx` attached to every log line it produces (async-safe). */
export const runWithContext = <T>(ctx: LogContext, fn: () => T): T => als.run(ctx, fn);
export const getContext = (): LogContext | undefined => als.getStore();
export const updateContext = (patch: Partial<LogContext>): void => {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
};

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const COLORS: Record<string, string> = {
  error: "\x1b[31m",
  warn: "\x1b[33m",
  info: "\x1b[36m",
  debug: "\x1b[90m",
  reset: "\x1b[0m",
};

const pretty = (level: string, event: string, ctx: LogContext, fields: Record<string, unknown> | undefined): string => {
  const ts = new Date().toISOString();
  const lvl = level.toUpperCase().padEnd(5);
  const tag = ctx.reqId ? ` [${String(ctx.reqId).slice(0, 8)}]` : "";
  const where = ctx.method ? ` ${ctx.method} ${ctx.route || ctx.path || ""}` : "";
  const head = `${ts} ${lvl}${tag}${where} ${event}`;
  const colored = logConfig.colors ? `${COLORS[level] ?? ""}${head}${COLORS.reset}` : head;
  if (!fields || Object.keys(fields).length === 0) return colored;
  const body = util.inspect(fields, {
    depth: logConfig.depth,
    colors: logConfig.colors,
    breakLength: 120,
    compact: 3,
    maxArrayLength: logConfig.maxArray || null,
    maxStringLength: logConfig.maxString || null,
  });
  return `${colored}\n${body}`;
};

const write = (level: Exclude<LogLevel, "silent">, event: string, fields?: Record<string, unknown>): void => {
  if (logConfig.level === "silent") return;
  if (RANK[level] > RANK[logConfig.level as Exclude<LogLevel, "silent">]) return;

  // `secrets` is internal bookkeeping used by sanitize to redact matches. It is
  // never emitted - stripping it also avoids repeating raw credentials in every
  // line when LOG_SECRETS=1 is on.
  const { secrets: _internalSecrets, ...ctx } = als.getStore() ?? {};
  const sanitizedFields = fields ? (sanitize(fields) as Record<string, unknown>) : undefined;

  let line: string;
  if (logConfig.format === "json") {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: logConfig.service,
      env: logConfig.environment,
      event,
      ...(sanitize(ctx) as Record<string, unknown>),
      ...(sanitizedFields ?? {}),
    });
  } else {
    line = pretty(level, event, ctx, sanitizedFields);
  }

  // errors/warnings to stderr so they survive log-level filtering downstream;
  // docker/Coolify merge both streams into one ordered log anyway.
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

export const logger = {
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  isEnabled: (level: Exclude<LogLevel, "silent">): boolean =>
    logConfig.level !== "silent" && RANK[level] <= RANK[logConfig.level as Exclude<LogLevel, "silent">],
  serializeError,
  sanitize,
  maskSecret,
  maskEmail,
  maskUrlCredentials,
  config: logConfig,
};

export default logger;
