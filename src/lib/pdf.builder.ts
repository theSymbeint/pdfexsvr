import PDFDocument from "pdfkit";
import blobStream from "blob-stream";
import {
  Page,
  Label,
  Data,
  Font,
  Image,
  Shape,
} from "./types/template.types.js";
import { HELVETICA } from "./types/font.types.js";
import fetch from "node-fetch";
import { getFontResource, getImageResource } from "./resource_loader.js";
import { logger, serializeError } from "./logger.js";

export default class PdfBuilder {
  private templateStr: string;
  private dataStr: string;
  private templateObj: any;
  private ctx: any;
  private doc: typeof PDFDocument | undefined;
  private currentPage: Page | undefined;
  private baseFont: string | undefined;
  private baseFontSize: number | undefined;
  private allowLineBreakDefault: boolean | undefined;
  //private baseFontColor: string | Array<number> | undefined

  constructor(docTemplate: string, docData: string) {
    this.templateStr = docTemplate;
    this.dataStr = docData;
    logger.debug("builder.template_received", {
      chars: typeof docTemplate === "string" ? docTemplate.length : undefined,
    });
    logger.debug("builder.data_received", {
      chars: typeof docData === "string" ? docData.length : undefined,
      data: docData,
    });

    try {
      this.templateObj = JSON.parse(docTemplate);
    } catch (e) {
      // A blank/garbage `doc` field in the templates collection lands here.
      logger.error("builder.template_parse_failed", {
        template: docTemplate,
        hint: "the template's `doc` field is not valid JSON (an empty doc field hits this)",
        error: serializeError(e),
      });
      throw e;
    }

    try {
      this.ctx = JSON.parse(docData);
    } catch (e) {
      logger.error("builder.data_parse_failed", {
        data: docData,
        hint: "the token's `docData` field is not valid JSON",
        error: serializeError(e),
      });
      throw e;
    }

    logger.debug("builder.parsed", {
      pages: Array.isArray(this.templateObj) ? this.templateObj.length : "template is not an array",
      dataKeys: this.ctx && typeof this.ctx === "object" ? Object.keys(this.ctx) : undefined,
    });
    this.currentPage = undefined;
  }

  async build() {
    const startedAt = performance.now();
    const pageCount = Array.isArray(this.templateObj) ? this.templateObj.length : 1;
    logger.info("builder.build.start", { pages: pageCount });

    for (const page of this.templateObj) {
      const index: any = this.templateObj.indexOf(page);
      const pageStartedAt = performance.now();
      logger.debug("builder.page.start", {
        index,
        format: page.format,
        orientation: page.orientation,
        margin: page.margin,
        baseFont: page.baseFont,
        baseFontSize: page.baseFontSize,
        fonts: page.fonts?.length ?? 0,
        bgImages: page.bgImages?.length ?? 0,
        shapes: page.shapes?.length ?? 0,
        labels: page.labels?.length ?? 0,
        data: page.data?.length ?? 0,
      });

      this.doc = new PDFDocument({
        size: page.format,
        layout: page.orientation,
        margin: page.margin || 0,
        bufferPages: true,
      });
      this.allowLineBreakDefault = page.allowLineBreak || false;
      this.currentPage = page;

      const stage = async (name: string, fn: () => Promise<void>) => {
        const stageStartedAt = performance.now();
        await fn();
        logger.debug("builder.stage.done", {
          index,
          stage: name,
          durationMs: Math.round((performance.now() - stageStartedAt) * 100) / 100,
        });
      };

      await stage("fonts", () => this.loadFonts());
      //TODO Load these based off env vars
      await stage("bgImages", () => this.processBgImg());
      // await this.processImages()
      await stage("shapes", () => this.processShapes());
      if (this.currentPage?.labels) {
        await stage("labels", () => this.processLabels()); //Process all objects in the label array
      } else {
        logger.debug("builder.labels.skipped", { index });
      }

      if (this.currentPage?.data) {
        await stage("data", () => this.processData()); //Process all objects in the data array
      } else {
        logger.debug("builder.data.skipped", { index });
      }

      logger.info("builder.page.done", {
        index,
        durationMs: Math.round((performance.now() - pageStartedAt) * 100) / 100,
      });
    }

    logger.info("builder.build.done", {
      pages: pageCount,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
    return;
  }

  protected async loadFonts() {
    const fonts = this.currentPage?.fonts || [];
    logger.debug("builder.loadFonts", { count: fonts.length });
    for (const f of fonts) {
      logger.debug("builder.font.request", { fontId: f.fontId, fontFile: f.fontFile });
      let ab: ArrayBuffer;
      try {
        // Looked up in the `fonts` collection by `name` - a missing record is a 404.
        ab = await getFontResource(f.fontId);
      } catch (e) {
        logger.error("builder.font.failed", {
          fontId: f.fontId,
          fontFile: f.fontFile,
          hint: "no `fonts` record has this name; templates must reference the record's `name` code",
          error: serializeError(e),
        });
        throw e;
      }
      logger.debug("builder.font.registering", { fontId: f.fontId, bytes: ab.byteLength });
      this.doc?.registerFont(f.fontId, ab);
    }
  }

  protected async processBgImg() {
    const images = this.currentPage?.bgImages || [];
    logger.debug("builder.processBgImg", { count: images.length });
    //loop through images in template document.
    for (const img of images) {
      logger.debug("builder.image.request", img);
      const ab = await getImageResource(img.fileName as string);
      logger.debug("builder.image.registering", {
        fileName: img.fileName,
        bytes: ab.byteLength,
        x: img.x,
        y: img.y,
        options: this.extractImageOptions(img),
      });
      this.doc?.image(ab, img.x, img.y, this.extractImageOptions(img));
    }
  }

  protected async processImages() {
    const images = this.currentPage!.images;
    logger.debug("builder.processImages", { count: images?.length ?? 0 });
    if (images == undefined) {
      logger.debug("builder.images.skipped", { reason: "no images on this page" });
      return;
    }

    for (const img of images) {
      if (img.url == undefined) {
        logger.warn("builder.image.skipped", { reason: "image has no url", image: img });
        return;
      }
      logger.debug("builder.image.fetching", { url: img.url });
      const response = await fetch(img.url);
      if (!response.ok) {
        logger.error("builder.image.fetch_failed", {
          url: img.url,
          status: response.status,
          statusText: response.statusText,
        });
        return;
      }
      const arrayBuffer = await response.arrayBuffer();
      logger.debug("builder.image.fetched", { url: img.url, bytes: arrayBuffer.byteLength });

      this.doc?.image(arrayBuffer, img.x, img.y, this.extractImageOptions(img));
    }
    return;
  }

  protected async processShapes() {
    const shapes = this.currentPage!.shapes;
    logger.debug("builder.processShapes", { count: shapes?.length ?? 0 });
    if (shapes == undefined) {
      logger.debug("builder.shapes.skipped", { reason: "no shapes on this page" });
      return;
    }

    shapes?.forEach((shape: Shape, index: number) => {
      logger.debug("builder.shape", { index, type: shape.type, shape });
      if (shape.type == "rect") {
        logger.debug("builder.shape.rect", { index, fill: shape.fillColor, stroke: shape.strokeColor });
        this.doc?.lineWidth(shape.lineWidth || 0);
        this.doc
          ?.roundedRect(
            shape.x,
            shape.y,
            <number>shape.width,
            <number>shape.height,
            shape.radius || 0,
          )
          .fillOpacity(shape.fillOpacity || 1)
          .strokeOpacity(shape.strokeOpacity || 1)
          .fillAndStroke(
            shape.fillColor || "white",
            shape.strokeColor || "white",
          );
        return;
      }

      if (shape.type == "circle") {
        logger.debug("builder.shape.circle", { index, fill: shape.fillColor, stroke: shape.strokeColor });
        this.doc?.lineWidth(shape.lineWidth || 0);
        if (shape.dash && shape.space) {
          this.doc
            ?.circle(shape.x, shape.y, <number>shape.radius)
            .fillOpacity(shape.fillOpacity || 1)
            .dash(shape.dash || 0, { space: shape.space || 0 })
            .strokeOpacity(shape.strokeOpacity || 1)
            .fillAndStroke(
              shape.fillColor || "white",
              shape.strokeColor || "white",
            );
          return;
        }
        this.doc
          ?.circle(shape.x, shape.y, <number>shape.radius)
          .fillOpacity(shape.fillOpacity || 1)
          .strokeOpacity(shape.strokeOpacity || 1)
          .fillAndStroke(
            shape.fillColor || "white",
            shape.strokeColor || "white",
          );
        return;
      }

      if (shape.type == "line") {
        logger.debug("builder.shape.line", { index, stroke: shape.strokeColor });
        this.doc?.lineWidth(shape.lineWidth || 0);
        if (shape.dash && shape.space) {
          this.doc?.moveTo(shape.x, shape.y);
          this.doc
            ?.lineTo(
              shape.toX || this.doc?.page.width,
              shape.toY || this.doc?.page.height,
            )
            .dash(shape.dash || 0, { space: shape.space || 0 })
            .stroke(shape.strokeColor || "black");
          return;
        }
        this.doc?.moveTo(shape.x, shape.y);
        this.doc
          ?.lineTo(
            shape.toX || this.doc?.page.width,
            shape.toY || this.doc?.page.height,
          )
          .stroke(shape.strokeColor || "black");
        return;
      }

      logger.warn("builder.shape.unknown_type", { index, type: shape.type, shape });
    });
  }

  protected async processLabels() {
    logger.debug("builder.processLabels", { count: this.currentPage!.labels?.length ?? 0 });
    this.currentPage!.labels?.forEach((lblObj: Label, index: number) => {
      const resolved = this.resolveFormatAndType(lblObj);
      logger.debug("builder.label", { index, label: lblObj, resolved });
      if (lblObj.font) {
        this.doc
          ?.font(lblObj.font)
          .fontSize(<number>lblObj.fontSize || <number>this.baseFontSize)
          .fillColor(lblObj.color || "black")
          .text(resolved, lblObj.x, lblObj.y, {
            lineBreak: lblObj.allowLineBreak || this.allowLineBreakDefault,
          });
      } else {
        this.doc
          ?.fontSize(<number>lblObj.fontSize || <number>this.baseFontSize) // Use font size if its available
          .fillColor(lblObj.color || "black")
          .text(resolved, lblObj.x, lblObj.y, {
            lineBreak: lblObj.allowLineBreak || this.allowLineBreakDefault,
          });
      }
      this.resetFont();
    });
  }

  protected async processData() {
    logger.debug("builder.processData", { count: this.currentPage!.data?.length ?? 0 });
    //Process all data assets
    this.currentPage!.data.forEach((dataObj: Data, index: number) => {
      const resolved = this.resolveFormatAndType(dataObj);
      logger.debug("builder.data_item", { index, name: dataObj.name, type: dataObj.type, format: dataObj.format, resolved });
      if (dataObj.font) {
        //Prints data with specific font
        this.doc
          ?.font(dataObj.font)
          .fillColor(dataObj.color || "black")
          .fontSize(dataObj.fontSize as number)
          .text(resolved, dataObj.x, dataObj.y, {
            lineBreak: dataObj.allowLineBreak || this.allowLineBreakDefault,
          });
      } else {
        //Prints data with base font
        this.doc
          ?.fillColor(dataObj.color || "black")
          .fontSize(<number>dataObj.fontSize || <number>this.baseFontSize) //use font size if available
          .text(resolved, dataObj.x, dataObj.y, {
            lineBreak: dataObj.allowLineBreak || this.allowLineBreakDefault,
          });
      }
      this.resetFont();
    });
  }

  protected resolveFormatAndType(dataObj: Data | Label): string {
    if ((<Data>dataObj).name) {
      const obj = <Data>dataObj; //Cast object to shorter name
      // A template field with no matching key in the submitted payload renders
      // as blank/undefined - worth knowing about when a PDF comes out empty.
      if (this.ctx?.[obj.name] === undefined) {
        logger.warn("builder.data_field_missing", {
          field: obj.name,
          availableKeys: this.ctx && typeof this.ctx === "object" ? Object.keys(this.ctx) : undefined,
          hint: "the template references this field but the payload/token does not contain it",
        });
      }
      if (obj.type == "string") {
        //Checks if data type is a string
        switch (
          obj.format //checks case type
        ) {
          case "ucase":
            return <string>this.ctx[obj.name].toUpperCase();
          case "lcase":
            return <string>this.ctx[obj.name].toLowerCase();
          default:
            return <string>this.ctx[obj.name];
        }
      }
      //TODO ADD NUMBER FORMATER
      //TODO ADD DATE FORMATER
      if (obj.type == "date") {
        Intl.DateTimeFormat;
      }
      return this.ctx[(<Data>obj).name];
    }

    if ((<Label>dataObj).text) {
      const obj = <Label>dataObj; //Cast object to shorter name
      switch (
        obj.format //checks case type
      ) {
        case "ucase":
          return obj.text.toUpperCase();
        case "lcase":
          return obj.text.toLowerCase();
        default:
          return obj.text;
      }
    }

    logger.warn("builder.entry_unresolved", { entry: dataObj });
    return "ERROR";
  }

  private resetFont() {
    this.baseFont = this.currentPage!.baseFont || HELVETICA;
    this.baseFontSize = this.currentPage!.baseFontSize || 12;
    // this.baseFontColor = this.currentPage!.baseFontColor || 'black'
    this.doc!.font(this.baseFont as string);
    this.doc!.fontSize(this.baseFontSize as number);
    this.doc!.fillColor("black");
    this.doc!.fillOpacity(1);
  }

  async renderS(stream: any) {
    logger.debug("builder.renderS", {
      docDefined: Boolean(this.doc),
      docConstructor: this.doc ? this.doc.constructor.name : undefined,
      stream: stream?.constructor?.name,
    });
    if (!this.doc) throw new Error('No PDFDocument instance available');

    this.doc.pipe(stream);
    this.doc.end();
  }

  end() {
    this.doc?.end();
  }

  protected extractImageOptions(imgObj: Image): Object {
    const imgOpt: Image = {};
    if (imgObj.scale) {
      const { scale } = imgObj;
      imgOpt["scale"] = scale;
    }
    if (imgObj.width) {
      const { width } = imgObj;
      imgOpt["width"] = width;
    }
    if (imgObj.height) {
      const { height } = imgObj;
      imgOpt["height"] = height;
    }
    if (imgObj.fit) {
      const { fit } = imgObj;
      imgOpt["fit"] = fit;
    }
    return imgOpt;
  }

  render() {
    //this.doc!.output("dataurlnewwindow", { filename: "doc.pdf" });
    const stream = this.doc?.pipe(blobStream());
    this.doc?.end();

    stream!.on("finish", function () {
      // get a blob you can do whatever you like with
      // const blob = stream.toBlob('application/pdf');
      // or get a blob URL for display in the browser
      //    const url = stream!.toBlobURL('application/pdf')
      //  window.open(url, '_blank')
    });
  }
}
