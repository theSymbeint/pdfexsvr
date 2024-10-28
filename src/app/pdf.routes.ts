import { Hono } from "hono";
import { PassThrough } from "node:stream";
import PdfBuilder from "../lib/pdf.builder";
import pbClient from "../lib/db/pb";

const user = process.env.DBUSER || "dandregregory@yahoo.com";
const passwd = process.env.DBPASS || "007trishten1";

const app = new Hono();

app.get("/test", async (c) => {
  return c.text("Hello World!");
});

//This route is used to create the print token. This allows the data
// to be over first and stored in a token record.
app.post("/token/:apikey", async (c) => {
  try {
    const auth = await pbClient.admins.authWithPassword(user, passwd);

    const apikey = c.req.param("apikey"); //TODO run apikey through filter for saftey
    console.log("APIKEY: ", apikey);
    let _user = null;
    try {
      _user = await pbClient
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
  /*try {
    console.debug('PARAMS ARE: ', req.params)
    //Grab access to database
    const auth = await pbClient.admins.authWithPassword(user, passwd)

    //Get the doc template record
    const docrec = await pbClient
        .collection('templates')
        .getFirstListItem(`docName = "${req.params['docname']}"`)

    //Get the token record with data
    const tokrec = await pbClient
        .collection('pTokens')
        .getFirstListItem(`id = "${req.params['ptoken']}"`)

    //increment the docReqCount
    pbClient
        .collection('pTokens')
        .update(tokrec.id, { docReqCount: tokrec.docReqCount + 1 })
    console.log(`${new Date().toISOString()} DOC DATA:`, tokrec.docData)

    //Create the PDF builder
    const doc = new PdfBuilder(docrec.doc, tokrec.docData)

    //Create a stream to pipe the PDF to the response
    const stream = new PassThrough()

    // Set the response headers
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'filename=sample.pdf')

    //Build the PDF
    await doc.build()
    console.log(`${new Date().toISOString()} RENDERING PDF:`)

    //Render the PDF to the stream
    doc.renderS(stream)
    console.log(`${new Date().toISOString()} PIPING PDF TO RESPONSE`)

    //Pipe the stream to the response
    stream.pipe(res)
    console.log(`${new Date().toISOString()} SENT PDF TO CLIENT`)
  } catch (e: any) {
    console.log(e)
    res.send('error')
  }*/
  return c.text("");
});

app.get("/pdf-test/:docname/:apikey", async (c: any) => {
  const auth = await pbClient.admins.authWithPassword(user, passwd);

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
    c.text("error");
  }
});

export default app;
