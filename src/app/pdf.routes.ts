import { Hono } from "hono";
import { Transform } from "node:stream";
import PdfBuilder from "../lib/pdf.builder.js";
import pbClient, { authSuperuser, pbBaseUrl } from "../lib/db/pb.js";
import { HTTPException } from "hono/http-exception";
import {
  logger,
  maskSecret,
  maskUrlCredentials,
  serializeError,
  updateContext,
} from "../lib/logger.js";

const user = process.env.DBUSER;
const passwd = process.env.DBPASSWD;

// Stub/blank values in .env are the normal state before a database is linked,
// so treat empty or whitespace-only as "not set" - otherwise the guard below
// passes and authSuperuser() fails later with a confusing "Database Error".
const notSet = (v: string | undefined) => v == null || v.trim() === "";

const app = new Hono();

//This middleware checks to see if the database credentials are set.
app.use(async (c, next) => {
  if (notSet(user) || notSet(passwd)) {
    logger.error("guard.credentials_not_set", {
      route: c.req.routePath || c.req.path,
      database: maskUrlCredentials(pbBaseUrl),
      email: user ? user : "<unset or blank>",
      passwordConfigured: Boolean(passwd),
      hint: "set DBUSER and DBPASSWD (shell env, .env for `pnpm dev`, or container env vars)",
    });
    throw new HTTPException(500, { message: "DATABASE CREDENTIALS NOT SET" });
  } else {
    await next();
  }
});

/**
 * Passes PDF bytes straight through while counting them, so a render can report
 * its exact size without ever buffering the document in memory.
 */
const countingStream = (label: string) => {
  let bytes = 0;
  const startedAt = performance.now();
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    },
    flush(cb) {
      logger.info("pdf.stream.finished", {
        label,
        bytes,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
      cb();
    },
  });
  counter.on("error", (e) => {
    logger.error("pdf.stream.error", { label, bytesSoFar: bytes, error: serializeError(e) });
  });
  return counter;
};

app.get("/test", async (c) => {
  logger.debug("route.test", { note: "connectivity probe" });
  return c.text("Hello World!");
});

//This route is used to create the print token. This allows the data
// to be over first and stored in a token record.
app.post("/token/:apikey", async (c) => {
  const startedAt = performance.now();
  const apikey = c.req.param("apikey");
  // Redact this credential wherever it appears, including inside DB filters.
  updateContext({ secrets: [apikey] });

  try {
    logger.info("route.token.start", {
      apikey: maskSecret(apikey, { prefix: 3 }),
      apikeyLength: apikey?.length,
    });

    const authStart = performance.now();
    await authSuperuser();
    logger.debug("route.token.authenticated", {
      durationMs: Math.round((performance.now() - authStart) * 100) / 100,
    });

    const body = await c.req.json();
    const tempId = body.tempId;
    const data = body.data;

    logger.info("route.token.payload", {
      tempId,
      dataKeys: data && typeof data === "object" ? Object.keys(data) : undefined,
      data,
      bodyKeys: Object.keys(body ?? {}),
    });

    let res: any;
    try {
      const filter = `apikey = "${apikey}"`;
      logger.debug("route.token.lookup_apikey", { collection: "apikeys", filter, expand: "userId" });
      res = await pbClient
        .collection("apikeys")
        .getFirstListItem(filter, {
          expand: `userId`,
          fields: "*,expand.userId.id",
        });
      logger.debug("route.token.apikey_found", {
        apikeyRecordId: res?.id,
        apikeyName: res?.name,
        userId: res?.userId,
        active: res?.active,
        expandedUserId: res?.expand?.userId?.id,
      });

      const templateFilter = `docName = "${tempId}" && userId = "${res.userId}"`;
      logger.debug("route.token.lookup_template", { collection: "templates", filter: templateFilter });
      const tpl = await pbClient
        .collection("templates")
        .getFirstListItem(templateFilter);
      logger.debug("route.token.template_found", {
        templateId: tpl?.id,
        docName: tpl?.docName,
        docChars: typeof tpl?.doc === "string" ? tpl.doc.length : undefined,
      });
    } catch (e: any) {
      //Will throw a not found error if the apikey is not found. meaning the user is unauthorized.
      logger.warn("route.token.unauthorized", {
        apikey: maskSecret(apikey, { prefix: 3 }),
        tempId,
        status: e?.status,
        reason: e?.message,
        error: serializeError(e),
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
      return c.json({ msg: "Unauthorized" }, 401);
    }

    const ptoken = {
      tempId,
      docData: JSON.stringify(data),
      docReqCount: 0,
      active: true,
    };
    logger.info("route.token.creating_ptoken", { ptoken });
    const pRec = await pbClient.collection("pTokens").create(ptoken);
    logger.info("route.token.created", {
      ptokenId: pRec?.id,
      tempId: pRec?.tempId,
      docReqCount: pRec?.docReqCount,
      active: pRec?.active,
      created: pRec?.created,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });

    return c.json({ msg: "ok", token: pRec.id });
  } catch (e: any) {
    logger.error("route.token.failed", {
      apikey: maskSecret(apikey, { prefix: 3 }),
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: serializeError(e),
    });
    return c.json({ err: e.message }, 500);
  }
});

//This route creates the PDF for a doc template and a token rec data.
app.get("/pdf/:docname/:ptoken", async (c) => {
  const startedAt = performance.now();
  const docname = c.req.param("docname");
  const ptoken = c.req.param("ptoken");
  // Redact this credential wherever it appears, including inside DB filters.
  updateContext({ secrets: [ptoken] });

  let docrec: any;
  let tokrec: any;
  try {
    logger.info("route.pdf.start", {
      docname,
      ptoken: maskSecret(ptoken, { prefix: 3 }),
    });
    //Grab access to database
    await authSuperuser();

    //Get the doc template record
    const tplStart = performance.now();
    const tplFilter = `docName = "${docname}"`;
    logger.debug("route.pdf.lookup_template", { collection: "templates", filter: tplFilter });
    docrec = await pbClient
      .collection("templates")
      .getFirstListItem(tplFilter);
    logger.info("route.pdf.template", {
      templateId: docrec?.id,
      docName: docrec?.docName,
      userId: docrec?.userId,
      docChars: typeof docrec?.doc === "string" ? docrec.doc.length : undefined,
      durationMs: Math.round((performance.now() - tplStart) * 100) / 100,
    });

    //Get the token record with data
    const tokStart = performance.now();
    const tokFilter = `id = "${ptoken}"`;
    logger.debug("route.pdf.lookup_ptoken", { collection: "pTokens", filter: tokFilter });
    tokrec = await pbClient
      .collection("pTokens")
      .getFirstListItem(tokFilter);
    logger.info("route.pdf.ptoken", {
      ptokenId: tokrec?.id,
      tempId: tokrec?.tempId,
      active: tokrec?.active,
      docReqCount: tokrec?.docReqCount,
      docDataChars: typeof tokrec?.docData === "string" ? tokrec.docData.length : undefined,
      durationMs: Math.round((performance.now() - tokStart) * 100) / 100,
    });

    // A template/token mismatch is a common cause of a confusing blank PDF.
    if (tokrec?.tempId && docrec?.docName && tokrec.tempId !== docrec.docName) {
      logger.warn("route.pdf.template_token_mismatch", {
        tokenTempId: tokrec.tempId,
        requestedDocName: docrec.docName,
      });
    }

    //increment the docReqCount
    const newCount = tokrec.docReqCount + 1;
    logger.debug("route.pdf.increment_docReqCount", {
      ptokenId: tokrec.id,
      from: tokrec.docReqCount,
      to: newCount,
    });
    await pbClient
      .collection("pTokens")
      .update(tokrec.id, { docReqCount: newCount });
    logger.info("route.pdf.docReqCount_incremented", { ptokenId: tokrec.id, docReqCount: newCount });

    logger.info("route.pdf.docData", { docData: tokrec.docData });
  } catch (e: any) {
    // The original code swallowed this cause entirely - the response stays
    // identical, but the logs now carry the real reason.
    logger.error("route.pdf.database_error", {
      docname,
      ptoken: maskSecret(ptoken, { prefix: 3 }),
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: serializeError(e),
    });
    throw new HTTPException(500, { message: "Database Error" });
  }

  //Create the PDF builder
  logger.debug("route.pdf.builder_start", { docname });
  const doc = new PdfBuilder(docrec.doc, tokrec.docData);

  // Set the response headers
  c.header("Content-Type", "application/pdf");
  c.header("Content-Disposition", "filename=sample.pdf");

  const stream = countingStream(`GET /pdf/${docname}`);

  //Build the PDF
  const buildStart = performance.now();
  await doc.build();
  logger.info("route.pdf.built", {
    docname,
    buildMs: Math.round((performance.now() - buildStart) * 100) / 100,
  });
  logger.debug("route.pdf.rendering");

  //Render the PDF to the stream
  await doc.renderS(stream);
  logger.info("route.pdf.responded", {
    docname,
    totalMs: Math.round((performance.now() - startedAt) * 100) / 100,
  });

  return c.body(stream as any);
});

app.get("/pdf-test/:docname/:apikey", async (c: any) => {
  const startedAt = performance.now();
  const docname = c.req.param("docname");
  const apikey = c.req.param("apikey");
  // Redact this credential wherever it appears, including inside DB filters.
  updateContext({ secrets: [apikey] });

  logger.info("route.pdf_test.start", {
    docname,
    apikey: maskSecret(apikey, { prefix: 3 }),
  });

  await authSuperuser();

  let _user: any = null;
  try {
    const filter = `apikey = "${apikey}"`;
    logger.debug("route.pdf_test.lookup_user", { collection: "users", filter });
    _user = await pbClient
      .collection("users")
      .getFirstListItem(filter);
    logger.debug("route.pdf_test.user_found", {
      userId: _user?.id,
      email: _user?.email,
      name: _user?.name,
    });
  } catch (e: any) {
    // Returning the response matters: `c.json(...)` alone leaves the handler
    // returning undefined, which Hono then blows up on (TypeError -> 500)
    // instead of replying 401.
    logger.warn("route.pdf_test.unauthorized", {
      apikey: maskSecret(apikey, { prefix: 3 }),
      docname,
      status: e?.status,
      reason: e?.message,
      error: serializeError(e),
    });
    return c.json({ msg: "Unauthorized" }, 401);
  }

  try {
    const filter = `docName = "${docname}" && userId = "${_user!.id}" `;
    logger.debug("route.pdf_test.lookup_template", { collection: "templates", filter });
    const rec = await pbClient
      .collection("templates")
      .getFirstListItem(filter);
    logger.info("route.pdf_test.template", {
      templateId: rec?.id,
      docName: rec?.docName,
      userId: rec?.userId,
      docChars: typeof rec?.doc === "string" ? rec.doc.length : undefined,
      testDataChars: typeof rec?.testData === "string" ? rec.testData.length : undefined,
    });
    logger.debug("route.pdf_test.template_doc", { doc: rec.doc });
    logger.debug("route.pdf_test.template_testData", { testData: rec.testData });

    const doc = new PdfBuilder(rec.doc, rec.testData);

    // Set the response headers
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", 'inline; filename="sample.pdf"');

    const stream = countingStream(`GET /pdf-test/${docname}`);

    const buildStart = performance.now();
    await doc.build();
    logger.info("route.pdf_test.built", {
      docname,
      buildMs: Math.round((performance.now() - buildStart) * 100) / 100,
    });

    await doc.renderS(stream);
    logger.info("route.pdf_test.responded", {
      docname,
      totalMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });

    return c.body(stream);
  } catch (e: any) {
    logger.error("route.pdf_test.failed", {
      docname,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: serializeError(e),
    });
    throw new HTTPException(500, e.message);
  }
});

export default app;
