import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import pdfRoutes from "./app/pdf.routes.js";

const app = new Hono();

app.use("*", cors());
app.use(logger());
app.use("/*", serveStatic({ root: "./public" }));

app.get("/healthcheck", (c) => {
  return c.text("OK!!");
});

app.route("/", pdfRoutes);

const port = 8080;
console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
