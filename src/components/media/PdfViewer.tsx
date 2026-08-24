import { useEffect, useRef, useState, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

interface PdfViewerProps {
  path: string;
  /** true = dipakai di stack preview kecil (1 halaman + prev/next).
   *  false = mode penuh: semua halaman ditumpuk, bisa discroll + fullscreen. */
  compact?: boolean;
}

const MAX_RENDER_SCALE = 3; // batas atas kualitas render supaya tidak terlalu berat

export default function PdfViewer({ path, compact = false }: PdfViewerProps) {
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ---- state khusus compact (single page) ----
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(0.9);

  // ---- state khusus full/scroll mode ----
  const scrollWrapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [fullScale, setFullScale] = useState(1.3); // zoom logis, terpisah dari resolusi render
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pageCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());

  const dpr =
    typeof window !== "undefined"
      ? Math.min(2, window.devicePixelRatio || 1)
      : 1;

  // Load dokumen setiap kali path berubah
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPageNum(1);
    pageCanvasRefs.current.clear();

    const url = convertFileSrc(path);
    const task = pdfjsLib.getDocument(url);

    task.promise
      .then((doc) => {
        if (cancelled) return;
        docRef.current = doc;
        setNumPages(doc.numPages);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      docRef.current?.destroy();
      docRef.current = null;
    };
  }, [path]);

  // ---- Render satu halaman ke canvas tertentu, dengan resolusi tinggi ----
  const renderPageToCanvas = useCallback(
    async (pageIndex: number, canvas: HTMLCanvasElement, cssScale: number) => {
      const doc = docRef.current;
      if (!doc) return;
      const page = await doc.getPage(pageIndex);
      const renderScale = Math.min(cssScale * dpr, MAX_RENDER_SCALE);
      const viewport = page.getViewport({ scale: renderScale });
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      // ukuran tampil (CSS) tetap di skala logis, bukan skala render —
      // ini yang membuat gambar terlihat tajam di layar retina
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      await page.render({ canvasContext: ctx, viewport }).promise;
    },
    [dpr],
  );

  // ---- Mode compact: render halaman aktif saja ----
  const renderCompactPage = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      await renderPageToCanvas(pageNum, canvas, scale);
    } catch (e) {
      setError(String(e));
    }
  }, [pageNum, scale, renderPageToCanvas]);

  useEffect(() => {
    if (compact && !loading && !error) renderCompactPage();
  }, [compact, loading, error, renderCompactPage]);

  // ---- Mode full: render semua halaman begitu numPages diketahui / zoom berubah ----
  useEffect(() => {
    if (compact || loading || error || numPages === 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 1; i <= numPages; i++) {
        if (cancelled) return;
        const canvas = pageCanvasRefs.current.get(i);
        if (canvas) {
          try {
            await renderPageToCanvas(i, canvas, fullScale);
          } catch (e) {
            if (!cancelled) setError(String(e));
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compact, loading, error, numPages, fullScale, renderPageToCanvas]);

  // ---- Fullscreen toggle (Fullscreen API pada wrapper modal) ----
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handler = () =>
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const goPrev = () => setPageNum((p) => Math.max(1, p - 1));
  const goNext = () => setPageNum((p) => Math.min(numPages, p + 1));
  const zoomIn = () => setScale((s) => Math.min(3, s + 0.2));
  const zoomOut = () => setScale((s) => Math.max(0.4, s - 0.2));

  const fullZoomIn = () => setFullScale((s) => Math.min(3, s + 0.2));
  const fullZoomOut = () => setFullScale((s) => Math.max(0.5, s - 0.2));

  if (error) {
    return (
      <div className="pdf-viewer pdf-viewer-error mono">
        Gagal memuat PDF: {error}
      </div>
    );
  }

  // ================= Mode compact (stack preview) =================
  if (compact) {
    return (
      <div className="pdf-viewer pdf-viewer-compact">
        {loading ? (
          <div className="pdf-viewer-loading mono">Memuat PDF…</div>
        ) : (
          <>
            <div className="pdf-canvas-wrap">
              <canvas ref={canvasRef} className="pdf-canvas" />
            </div>
            <div className="pdf-toolbar mono">
              <button
                type="button"
                className="ghost-btn"
                onClick={goPrev}
                disabled={pageNum <= 1}
              >
                ‹ Prev
              </button>
              <span className="pdf-page-label">
                {pageNum} / {numPages || "?"}
              </span>
              <button
                type="button"
                className="ghost-btn"
                onClick={goNext}
                disabled={pageNum >= numPages}
              >
                Next ›
              </button>
              <span className="pdf-toolbar-sep" />
              <button type="button" className="ghost-btn" onClick={zoomOut}>
                −
              </button>
              <span className="pdf-zoom-label">{Math.round(scale * 100)}%</span>
              <button type="button" className="ghost-btn" onClick={zoomIn}>
                +
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // ================= Mode full: scroll semua halaman + fullscreen =================
  return (
    <div
      ref={containerRef}
      className={`pdf-viewer pdf-viewer-full${isFullscreen ? " is-fullscreen" : ""}`}
    >
      {loading ? (
        <div className="pdf-viewer-loading mono">Memuat PDF…</div>
      ) : (
        <>
          <div className="pdf-full-toolbar mono">
            <span className="pdf-page-label">{numPages} halaman</span>
            <span className="pdf-toolbar-sep" />
            <button type="button" className="ghost-btn" onClick={fullZoomOut}>
              −
            </button>
            <span className="pdf-zoom-label">
              {Math.round(fullScale * 100)}%
            </span>
            <button type="button" className="ghost-btn" onClick={fullZoomIn}>
              +
            </button>
            <span className="pdf-toolbar-sep" />
            <button
              type="button"
              className="ghost-btn"
              onClick={toggleFullscreen}
            >
              {isFullscreen ? "Keluar layar penuh" : "Layar penuh"}
            </button>
          </div>
          <div ref={scrollWrapRef} className="pdf-full-scroll">
            {Array.from({ length: numPages }).map((_, i) => {
              const pageIndex = i + 1;
              return (
                <div className="pdf-full-page" key={pageIndex}>
                  <canvas
                    ref={(el) => {
                      if (el) pageCanvasRefs.current.set(pageIndex, el);
                      else pageCanvasRefs.current.delete(pageIndex);
                    }}
                    className="pdf-canvas"
                  />
                  <span className="pdf-full-page-num mono">{pageIndex}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
