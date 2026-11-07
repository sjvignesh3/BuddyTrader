// -----------------------------------------------------------------------------
// PDF → positioned text, entirely in the browser. pdf.js is imported on demand
// so it only downloads when someone actually picks a file. The legacy build is
// used on purpose: it runs on older phone browsers (iOS Safari) too.
// -----------------------------------------------------------------------------
import type { TextItem } from "pdfjs-dist/types/src/display/api";

export interface PdfTextItem {
  str: string;
  /** PDF user-space coordinates, origin bottom-left. */
  x: number;
  y: number;
  /** Rotation in degrees (watermarks are drawn at an angle). */
  rot: number;
}

export type PdfPageText = PdfTextItem[];

export async function readPdfText(file: File | ArrayBuffer): Promise<PdfPageText[]> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.min.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const data = new Uint8Array(file instanceof ArrayBuffer ? file : await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  try {
    const pages: PdfPageText[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push(
        tc.items
          .filter((it): it is TextItem => "str" in it && it.str.trim() !== "")
          .map((it) => {
            const [a, b, , , x, y] = it.transform as number[];
            return { str: it.str, x: x ?? 0, y: y ?? 0, rot: Math.round((Math.atan2(b ?? 0, a ?? 1) * 180) / Math.PI) };
          }),
      );
    }
    return pages;
  } finally {
    void doc.destroy();
  }
}
