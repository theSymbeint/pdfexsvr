import PDFDocument from "pdfkit";
import blobStream from "blob-stream";
import { Page, Label, Data, Font, Image, Shape } from "./types/template.types";
import { HELVETICA } from "./types/font.types";
import fetch from "node-fetch";
import { getFontResource, getImageResource } from "./resource_loader";

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
    console.log("DOCUMENT STRING LOADED");
    this.dataStr = docData;
    console.log("DATA STRING LOADED");
    this.templateObj = JSON.parse(docTemplate);
    console.log("DOCUMENT SERIALIZED");
    this.ctx = JSON.parse(docData);
    console.log("DATA SERIALIZED");
    this.currentPage = undefined;
  }

  async build() {
    for (const page of this.templateObj) {
      const index: any = this.templateObj.indexOf(page);
      console.log("Doc Index: ", index);
      this.doc = new PDFDocument({
        size: page.format,
        layout: page.orientation,
        margin: page.margin || 0,
      });
      this.allowLineBreakDefault = page.allowLineBreak || false;
      this.currentPage = page;
      await this.loadFonts();
      //TODO Load these based off env vars
      await this.processBgImg();
      // await this.processImages()
      await this.processShapes();
      if (this.currentPage?.labels) {
        await this.processLabels(); //Process all objects in the label array
      } else {
        console.log("NO LABELS TO PROCESS");
      }

      if (this.currentPage?.data) {
        await this.processData(); //Process all objects in the data array
      } else {
        console.log("NO DATA TO PROCESS");
      }
    }

    return;
  }

  protected async loadFonts() {
    console.log("LOADING FONTS FROM TEMPLATE");
    for (const f of this.currentPage?.fonts || []) {
      console.log("FONT DATA: ", f);
      const ab = await getFontResource(f.fontId);
      this.doc?.registerFont(f.fontId, ab);
    }
  }

  protected async processBgImg() {
    console.log("NOW PROCESSING IMAGES");
    //loop through images in template document.
    for (const img of this.currentPage?.bgImages || []) {
      console.log("IMAGE DATA: ", img);
      const ab = await getImageResource(img.fileName as string);
      this.doc?.image(ab, img.x, img.y, this.extractImageOptions(img));
    }
  }

  protected async processImages() {
    console.log("NOW PROCESSING WEB IMAGES");
    if (this.currentPage!.images == undefined) {
      console.log("NO WEB IMAGES TO PROCESS");
      return;
    }

    for (const img of this.currentPage!.images) {
      if (img.url == undefined) {
        return;
      }
      console.log("IMAGE: ", img);
      console.log("RETREIVING IMAGE: ", img.url);
      const response = await fetch(img.url);
      if (!response.ok) {
        console.log("HTTP-Error: " + response.status);
        return;
      }
      const arrayBuffer = await response.arrayBuffer();
      console.log("IMAGE BUFFER: ", arrayBuffer);

      this.doc?.image(arrayBuffer, img.x, img.y, this.extractImageOptions(img));
    }
    return;
  }

  protected async processShapes() {
    console.log("NOW PROCESSING SHAPES");
    if (this.currentPage!.shapes == undefined) {
      console.log("NO SHAPES TO PROCESS");
      return;
    }

    this.currentPage!.shapes?.forEach((shape: Shape, index: number) => {
      console.log("SHAPE: ", shape);
      if (shape.type == "rect") {
        console.log("FILL AND STROKE EXECUTED");
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
    });
  }

  protected async processLabels() {
    console.log("NOW PROCESSING LABELS");
    this.currentPage!.labels?.forEach((lblObj: Label, index: number) => {
      console.log("Label Index: ", index);
      console.log("LABEL: ", lblObj);
      if (lblObj.font) {
        this.doc
          ?.font(lblObj.font)
          .fontSize(<number>lblObj.fontSize || <number>this.baseFontSize)
          .fillColor(lblObj.color || "black")
          .text(this.resolveFormatAndType(lblObj), lblObj.x, lblObj.y, {
            lineBreak: lblObj.allowLineBreak || this.allowLineBreakDefault,
          });
      } else {
        this.doc
          ?.fontSize(<number>lblObj.fontSize || <number>this.baseFontSize) // Use font size if its available
          .fillColor(lblObj.color || "black")
          .text(this.resolveFormatAndType(lblObj), lblObj.x, lblObj.y, {
            lineBreak: lblObj.allowLineBreak || this.allowLineBreakDefault,
          });
      }
      this.resetFont();
    });
  }

  protected async processData() {
    console.log("NOW PROCESSING DATA");
    //Process all data assets
    this.currentPage!.data.forEach((dataObj: Data, index: number) => {
      console.log("DATA: ", dataObj.name);
      if (dataObj.font) {
        //Prints data with specific font
        this.doc
          ?.font(dataObj.font)
          .fillColor(dataObj.color || "black")
          .fontSize(dataObj.fontSize as number)
          .text(this.resolveFormatAndType(dataObj), dataObj.x, dataObj.y, {
            lineBreak: dataObj.allowLineBreak || this.allowLineBreakDefault,
          });
      } else {
        //Prints data with base font
        this.doc
          ?.fillColor(dataObj.color || "black")
          .fontSize(<number>dataObj.fontSize || <number>this.baseFontSize) //use font size if available
          .text(this.resolveFormatAndType(dataObj), dataObj.x, dataObj.y, {
            lineBreak: dataObj.allowLineBreak || this.allowLineBreakDefault,
          });
      }
      this.resetFont();
    });
  }

  protected resolveFormatAndType(dataObj: Data | Label): string {
    if ((<Data>dataObj).name) {
      const obj = <Data>dataObj; //Cast object to shorter name
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
    //Working delivery method
    this.doc?.pipe(stream);
    this.doc?.end();
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
