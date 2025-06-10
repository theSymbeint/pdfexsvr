import pbClient from "./db/pb.js";
import fetch from "node-fetch";

export async function getFontResource(fontName: string): Promise<ArrayBuffer> {
  return getResource(fontName, "fonts");
}

export async function getImageResource(
  imageName: string,
): Promise<ArrayBuffer> {
  return getResource(imageName, "images");
}

async function getResource(name: string, type: string): Promise<ArrayBuffer> {
  const res = await pbClient
    .collection(type)
    .getFirstListItem(`name = "${name}"`);
  const url = pbClient.files.getUrl(res, res.file);
  const font_res = await fetch(url, { method: "GET" });
  return await font_res.arrayBuffer();
}
