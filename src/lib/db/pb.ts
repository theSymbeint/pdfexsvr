import PocketBase from "pocketbase"
import { logger, maskSecret, maskUrlCredentials } from "../logger.js"

const dburl = process.env.DBURL || 'https://pb-pdfex-dev.eemerg.dev/'

const pbClient = new PocketBase(dburl)

// Server-side client sharing one auth store across requests: the SDK's
// auto-cancellation aborts "duplicate" in-flight requests that share a method+URL
// (e.g. two simultaneous renders, or the per-request superuser login). In a
// server that is exactly what concurrent traffic looks like, and the aborted
// call surfaces as a 500. Disable it.
pbClient.autoCancellation(false)

/** Resolved PocketBase base URL - exported so startup logs can report the target. */
export const pbBaseUrl = dburl

// ---------------------------------------------------------------------------
// Every PocketBase HTTP call funnels through the SDK's beforeSend/afterSend
// hooks, so logging them here captures each database query in one place.
//
// Caveat worth knowing: the SDK only invokes afterSend on a *successful*
// response. Failures therefore get logged by the call site that catches them
// (routes / resource_loader), which includes the failed filter and full error.
// ---------------------------------------------------------------------------
const inFlightStarts: number[] = []
let dbCallSeq = 0

/** Auth bodies carry the password; log bodies are sanitised by the logger. */
const parseBody = (body: unknown): unknown => {
  if (body === undefined || body === null) return undefined
  if (typeof body === "string") {
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return `<FormData ${[...body.keys()].join(", ")}>`
  }
  return body
}

pbClient.beforeSend = (url, options) => {
  dbCallSeq += 1
  inFlightStarts.push(performance.now())
  logger.debug("db.request", {
    dbCallId: `db${dbCallSeq}`,
    method: options?.method ?? "GET",
    url: maskUrlCredentials(url),
    headers: options?.headers,
    body: parseBody(options?.body),
  })
  return { url, options }
}

// The SDK types afterSend as the intersection of a 2-arg and a 3-arg signature,
// so the `options` parameter must be optional for this to type-check.
pbClient.afterSend = (response: Response, data: any, options?: any) => {
  // beforeSend always precedes afterSend on the same client, so the oldest
  // pending timestamp belongs to this response. Approximate under concurrency,
  // which is fine for a duration figure.
  const startedAt = inFlightStarts.shift()
  logger.debug("db.response", {
    method: options?.method ?? "GET",
    status: response?.status,
    durationMs: startedAt === undefined ? undefined : Math.round((performance.now() - startedAt) * 100) / 100,
    contentLength: response?.headers?.get?.("content-length") ?? undefined,
    // Full parsed response: this is the data the server is about to act on.
    data,
  })
  return data
}

/**
 * Authenticate as the PocketBase superuser.
 *
 * PocketBase >= 0.23 removed the `/api/admins/*` endpoints in favour of the
 * `_superusers` auth collection, and the JS SDK dropped `pb.admins` in 0.22 -
 * the old `pbClient.admins.authWithPassword()` call 404s against v0.40.
 */
export async function authSuperuser(): Promise<void> {
  const email = process.env.DBUSER
  const password = process.env.DBPASSWD
  if (!email || !password) {
    logger.error("db.auth.skipped", {
      reason: "DBUSER/DBPASSWD not set",
      userConfigured: Boolean(email),
      passwordConfigured: Boolean(password),
      url: maskUrlCredentials(dburl),
    })
    throw new Error('DBUSER/DBPASSWD not set')
  }

  logger.debug("db.auth.start", {
    url: maskUrlCredentials(dburl),
    collection: "_superusers",
    email,
    password: maskSecret(password),
  })

  const startedAt = performance.now()
  try {
    const auth = await pbClient.collection('_superusers').authWithPassword(email, password)
    logger.info("db.auth.ok", {
      // The account email is logged in full (it identifies WHICH account
      // authenticated); passwords/keys/tokens stay fingerprinted.
      email: auth?.record?.email ?? email,
      recordId: auth?.record?.id,
      token: maskSecret(auth?.token, { prefix: 4 }),
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    })
  } catch (e: any) {
    logger.error("db.auth.failed", {
      url: maskUrlCredentials(dburl),
      email,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      status: e?.status,
      statusText: e?.response?.message ?? e?.message,
      responseData: e?.response?.data ?? e?.data,
      hint:
        e?.status === 400
          ? "400 from /auth-with-password usually means the email or password is wrong"
          : undefined,
      error: logger.serializeError(e),
    })
    throw e
  }
}

export default pbClient
