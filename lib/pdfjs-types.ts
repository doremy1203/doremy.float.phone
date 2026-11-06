export type PdfJsTextItem = {
  str?: string;
  transform?: number[];
};

export type PdfJsViewport = {
  width: number;
  height: number;
};

export interface PdfJsPage {
  getTextContent(): Promise<{ items: PdfJsTextItem[] }>;
  getViewport(options: { scale: number }): PdfJsViewport;
  render(options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfJsViewport;
  }): { promise: Promise<void>; cancel?: () => void };
  cleanup?(): void;
}

export interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
  destroy?(): Promise<void>;
}

export interface PdfJsLibrary {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(source: { url: string } | Uint8Array): { promise: Promise<PdfJsDocument> };
}
