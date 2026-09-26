import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import pdfRoutes from "./app/pdf.routes.js";
import { httpLogging } from "./lib/http-logging.js";
import { logger, maskSecret, maskUrlCredentials, serializeError } from "./lib/logger.js";

const app = new Hono();

// First in the chain so every request is logged even if a later middleware throws.
app.use("*", httpLogging());
app.use("*", cors());
app.use("/*", serveStatic({ root: "./public" }));

app.get("/healthcheck", (c) => {
  // Debug level: container orchestrators poll this every few seconds.
  logger.debug("healthcheck.ok");
  return c.text("OK!!");
});

app.route("/", pdfRoutes);

// Replaces Hono's default error handling: same response shape, but the error is
// logged with its full stack before the response is built.
app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 500;
  logger.error("http.handler_error", {
    status,
    route: c.req.routePath || undefined,
    method: c.req.method,
    error: serializeError(err),
  });
  if (err instanceof HTTPException) return err.getResponse();
  return c.text("Internal Server Error", 500);
});

// A crash or a floating rejection used to be silent; log it before dying.
process.on("unhandledRejection", (reason) => {
  logger.error("process.unhandled_rejection", { error: serializeError(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error("process.uncaught_exception", { error: serializeError(err) });
  process.exit(1);
});

// Defaults to 8080; PORT is respected so a second instance can run alongside a
// dev server (and for platforms that inject their own port). The image EXPOSEs 8080.
const port = Number(process.env.PORT) || 8080;

const dbUser = process.env.DBUSER;
const dbPass = process.env.DBPASSWD;
const dbUrl = process.env.DBURL || "https://pb-pdfex-dev.eemerg.dev/";

logger.info("service.starting", {
  port,
  pid: process.pid,
  node: process.version,
  env: process.env.NODE_ENV ?? "development",
  database: {
    url: maskUrlCredentials(dbUrl),
    email: dbUser ? dbUser : "<unset>",
    password: dbPass ? maskSecret(dbPass) : "<unset>",
    ready: Boolean(dbUser && dbPass),
  },
  logging: {
    level: logger.config.level,
    format: logger.config.format,
    bodies: logger.config.bodies,
    // Loud on purpose: this is the switch that puts raw credentials in the logs.
    secrets: logger.config.secrets ? "RAW SECRETS ENABLED (LOG_SECRETS=1)" : "masked",
    maxString: logger.config.maxString,
    maxArray: logger.config.maxArray,
  },
});

serve(
  {
    fetch: app.fetch,
    port,
  },
  () => {
    logger.info("service.listening", { port, url: `http://localhost:${port}` });
  },
);
