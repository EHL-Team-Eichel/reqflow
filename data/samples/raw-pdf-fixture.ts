import { PDFDocument, createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";

/** Generated synthetic documents, never BMW originals. */
export function textPdf(pages: { lines: string[] }[]): Uint8Array {
  const doc = new PDFDocument();
  for (const page of pages) {
    const ctx = doc.beginPage(600, 400);
    ctx.font = "16px sans-serif";
    page.lines.forEach((line, index) => ctx.fillText(line, 50, 50 + index * 30));
    doc.endPage();
  }
  return new Uint8Array(doc.close());
}

export async function scannedPdf(text: string): Promise<Uint8Array> {
  const canvas = createCanvas(800, 300);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 800, 300);
  ctx.fillStyle = "black";
  ctx.font = "bold 40px sans-serif";
  ctx.fillText(text, 50, 150);
  const image = await loadImage(canvas.toBuffer("image/png"));
  const doc = new PDFDocument();
  // The PDF context supports drawImage at runtime but omits it from its declaration.
  const page = doc.beginPage(800, 300) as unknown as Pick<SKRSContext2D, "drawImage">;
  page.drawImage(image, 0, 0);
  doc.endPage();
  return new Uint8Array(doc.close());
}
