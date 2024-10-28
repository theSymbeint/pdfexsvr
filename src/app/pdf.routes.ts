import { Hono } from "hono";
import { PassThrough } from "node:stream";
import PdfBuilder from "../lib/pdf.builder";
import pbClient from "../lib/db/pb";
import { HTTPException } from "hono/http-exception";

const user = process.env.DBUSER;
const passwd = process.env.DBPASSWD;

const app = new Hono();

//This middleware checks to see if the database credentials are set.
app.use(async (c, next) => {
  if (user == undefined || passwd == undefined) {
    throw new HTTPException(500, { message: "DATABASE CREDENTIALS NOT SET" });
  } else {
    await next();
  }
});

app.get("/test", async (c) => {
  return c.text("Hello World!");
});

//This route is used to create the print token. This allows the data
// to be over first and stored in a token record.
app.post("/token/:apikey", async (c) => {
  try {
    await pbClient.admins.authWithPassword(user as string, passwd as string);

    const apikey = c.req.param("apikey"); //TODO run apikey through filter for saftey
    console.log("APIKEY: ", apikey);
    try {
      await pbClient
        .collection("users")
        .getFirstListItem(`apikey = "${apikey}"`);
    } catch (e: any) {
      return c.json({ msg: "Unauthorized" }, 401);
    }

    const body = await c.req.json();

    const tempId = body.tempId;
    const data = body.data;

    const ptoken = {
      tempId,
      docData: JSON.stringify(data),
      docReqCount: 0,
      active: true,
    };
    console.log("PTOKEN: ", ptoken);
    const pRec = await pbClient.collection("pTokens").create(ptoken);
    // pbClient.collection('pTokens').update(pRec.id,{docReqCount:pRec.docReqCount+1})

    return c.json({ msg: "ok", token: pRec.id });
  } catch (e: any) {
    console.log(e);
    return c.json({ err: e.message }, 500);
  }
});

//This route creates the PDF for a doc template and a token rec data.
app.get("/pdf/:docname/:ptoken", async (c) => {
  let docrec: any;
  let tokrec: any;
  try {
    console.debug("PARAMS ARE: ", c.req.param());
    //Grab access to database
    await pbClient.admins.authWithPassword(user as string, passwd as string);

    //Get the doc template record
    docrec = await pbClient
      .collection("templates")
      .getFirstListItem(`docName = "${c.req.param("docname")}"`);

    //Get the token record with data
    tokrec = await pbClient
      .collection("pTokens")
      .getFirstListItem(`id = "${c.req.param("ptoken")}"`);

    //increment the docReqCount
    await pbClient
      .collection("pTokens")
      .update(tokrec.id, { docReqCount: tokrec.docReqCount + 1 });
    console.log(`${new Date().toISOString()} DOC DATA:`, tokrec.docData);
  } catch (e: any) {
    throw new HTTPException(500, { message: "Database Error" });
  }

  //Create the PDF builder
  const doc = new PdfBuilder(docrec.doc, tokrec.docData);

  //Create a stream to pipe the PDF to the response
  const s = new PassThrough();

  // Set the response headers
  c.header("Content-Type", "application/pdf");
  c.header("Content-Disposition", "filename=sample.pdf");

  //Build the PDF
  await doc.build();
  console.log(`${new Date().toISOString()} RENDERING PDF:`);

  //Render the PDF to the stream
  await doc.renderS(s);

  return c.body(s as any);
});

app.get("/pdf-test/:docname/:apikey", async (c: any) => {
  await pbClient.admins.authWithPassword(user as string, passwd as string);

  const docname = c.req.param("docname");
  const apikey = c.req.param("apikey");
  console.log("PARAMS ARE: ", c.req.param());
  let _user: any = null;
  try {
    _user = await pbClient
      .collection("users")
      .getFirstListItem(`apikey = "${apikey}"`);
  } catch (e: any) {
    c.json({ msg: "Unauthorized" }, 401);
    return;
  }

  try {
    const rec = await pbClient
      .collection("templates")
      .getFirstListItem(`docName = "${docname}" && userId = "${_user!.id}" `);
    console.log("REC  DATA: ", rec.doc);
    const doc = new PdfBuilder(rec.doc, rec.testData); // new PDFDocument();
    const s = new PassThrough();

    // Set the response headers
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", 'inline; filename="sample.pdf"');

    await doc.build();
    await doc.renderS(s);

    return c.body(s);
  } catch (e: any) {
    console.log(e);
    throw new HTTPException(500, e.message);
  }
});

export default app;
