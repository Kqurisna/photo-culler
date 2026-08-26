import { useEffect, useRef, useState, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

interface PdfViewerProps {
  path: string;
  /** true = dipakai di stack preview kecil.
   *  false = mode penuh (modal "Lihat PDF") dengan toolbar lengkap + fullscreen.
   *  Keduanya sama-sama scroll semua halaman via trackpad/mouse wheel. */
  compact?: boolean;
}

const MAX_RENDER_SCALE = 3;
const COMPACT_SCALE = 0.75;
const DEFAULT_FULL_SCALE = 1.1; // 110%
const MIN_SCALE = 0.4;
const MAX_SCALE = 3;

export default function PdfViewer({ path, compact = false }: PdfViewerProps) {
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(compact ? COMPACT_SCALE : DEFAULT_FULL_SCALE);
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
    setScale(compact ? COMPACT_SCALE : DEFAULT_FULL_SCALE);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Render satu halaman ke canvas. Canvas TIDAK dibatasi max-width di CSS —
  // container-nya (overflow: auto) yang menangani scroll saat konten lebih
  // besar dari area tampil, supaya zoom di atas 100% benar-benar kelihatan.
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
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      await page.render({ canvasContext: ctx, viewport }).promise;
    },
    [dpr],
  );

  // Render semua halaman begitu numPages diketahui / zoom berubah
  useEffect(() => {
    if (loading || error || numPages === 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 1; i <= numPages; i++) {
        if (cancelled) return;
        const canvas = pageCanvasRefs.current.get(i);
        if (canvas) {
          try {
            await renderPageToCanvas(i, canvas, scale);
          } catch (e) {
            if (!cancelled) setError(String(e));
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, error, numPages, scale, renderPageToCanvas]);

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
    if (compact) return; // tombol fullscreen cuma ada di mode full
    const handler = () =>
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, [compact]);

  const zoomIn = () => setScale((s) => Math.min(MAX_SCALE, s + 0.2));
  const zoomOut = () => setScale((s) => Math.max(MIN_SCALE, s - 0.2));

  if (error) {
    return (
      <div className="pdf-viewer pdf-viewer-error mono">
        Gagal memuat PDF: {error}
      </div>
    );
  }

  const scrollClass = compact ? "pdf-compact-scroll" : "pdf-full-scroll";
  const pageWrapClass = compact ? "pdf-compact-page" : "pdf-full-page";

  return (
    <div
      ref={containerRef}
      className={`pdf-viewer${compact ? " pdf-viewer-compact" : " pdf-viewer-full"}${
        isFullscreen ? " is-fullscreen" : ""
      }`}
    >
      {loading ? (
        <div className="pdf-viewer-loading mono">Memuat PDF…</div>
      ) : (
        <>
          <div className={compact ? "pdf-toolbar mono" : "pdf-full-toolbar mono"}>
            <span className="pdf-page-label">{numPages} halaman</span>
            <span className="pdf-toolbar-sep" />
            <button type="button" className="ghost-btn" onClick={zoomOut}>
              −
            </button>
            <span className="pdf-zoom-label">{Math.round(scale * 100)}%</span>
            <button type="button" className="ghost-btn" onClick={zoomIn}>
              +
            </button>
            {!compact && (
              <>
                <span className="pdf-toolbar-sep" />
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={toggleFullscreen}
                >
                  {isFullscreen ? "Keluar layar penuh" : "Layar penuh"}
                </button>
              </>
            )}
          </div>
          {/* Scroll murni pakai overflow:auto native — trackpad/mouse wheel
              langsung jalan tanpa handler khusus, jadi tidak perlu dibedakan
              per-engine webview (WebKit/Chromium) seperti pinch-zoom. */}
          <div className={scrollClass}>
            {Array.from({ length: numPages }).map((_, i) => {
              const pageIndex = i + 1;
              return (
                <div className={pageWrapClass} key={pageIndex}>
                  <canvas
                    ref={(el) => {
                      if (el) pageCanvasRefs.current.set(pageIndex, el);
                      else pageCanvasRefs.current.delete(pageIndex);
                    }}
                    className="pdf-canvas"
                  />
                  {!compact && (
                    <span className="pdf-full-page-num mono">{pageIndex}</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
