import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import PdfViewer from "./components/media/PdfViewer";
import VideoViewer from "./components/media/VideoViewer";

type PhotoKind = "image" | "pdf" | "video";
type PhotoEntry = {
  path: string;
  name: string;
  kind: PhotoKind;
};

type Stage = "setup" | "sorting" | "done";
type ExitDirection = "left" | "right" | null;
type HistoryEntry = { type: "reject" | "select"; photo: PhotoEntry };
type Toast = { id: number; message: string };

const SWIPE_THRESHOLD = 110;
const VELOCITY_THRESHOLD = 0.55; // px/ms — a fast flick clears even under the distance threshold
const STACK_DEPTH = 4; // how many sheets show behind the top photo
const HISTORY_LIMIT = 25;
// Exit animation durations (320ms left / 460ms right) live in App.css as
// `.preview-card.exit-left` / `.exit-right` — keep them in sync if changed.

// Deterministic "randomness" from a filename, so each sheet in the stack
// keeps the same tiny tilt/offset across re-renders instead of jittering.
function seededOffset(seed: string, index: number) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i);
    h |= 0;
  }
  const n = (i: number) => {
    const x = Math.sin(h + i * 97.13) * 10000;
    return x - Math.floor(x); // 0..1
  };
  const rotate = (n(index) - 0.5) * 3; // subtle — minimal stack, not a paper toss
  const shiftX = (n(index + 1) - 0.5) * 6;
  return { rotate, shiftX };
}

let toastId = 0;

function App() {
  const [stage, setStage] = useState<Stage>("setup");
  const [sourceFolder, setSourceFolder] = useState<string>("");
  const [destFolder, setDestFolder] = useState<string>("");
  // Filter jenis media yang ditampilkan di stack sorting. Bisa diganti
  // kapan saja SETELAH folder dipilih (di top-bar layar sorting), bukan
  // di layar setup. Item jenis lain tetap ada di `queue`, cuma disembunyikan.
  const [mediaFilter, setMediaFilter] = useState<"all" | PhotoKind>("all");
  const [queue, setQueue] = useState<PhotoEntry[]>([]);
  const [totalLoaded, setTotalLoaded] = useState(0);
  const [selectedCount, setSelectedCount] = useState(0);
  const [previewSrc, setPreviewSrc] = useState<string>("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [immersive, setImmersive] = useState(false);

  // drag state (not React state, to avoid re-render thrash while dragging)
  const [dragX, setDragX] = useState(0);
  const [isSettling, setIsSettling] = useState(false);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartT = useRef(0);
  const lastMoveX = useRef(0);
  const lastMoveT = useRef(0);
  const pointerId = useRef<number | null>(null);

  // exit animation: which direction the top print is currently leaving in.
  // "left"  -> not decided yet, slides back into the waiting pile
  // "right" -> selected, lifts off toward the tray
  const [exitDir, setExitDir] = useState<ExitDirection>(null);
  const [exitStartX, setExitStartX] = useState(0);
  const [exitStartRot, setExitStartRot] = useState(0);
  const [trayBump, setTrayBump] = useState(false);

  const previewCache = useRef<Map<string, string>>(new Map());
  const history = useRef<HistoryEntry[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [undoFlash, setUndoFlash] = useState(false);

  // Selected-photos list (most recent first) backing the tray dropdown,
  // plus whether that dropdown is currently open.
  const [selectedPhotos, setSelectedPhotos] = useState<PhotoEntry[]>([]);
  // --- Mode Banding (Compare Mode) ---
  // referencePhoto = foto "patokan" di kotak kiri, statis selama mode aktif.
  // Diaktifkan lewat ArrowDown (dari kartu current saat sorting biasa) atau
  // klik foto di tray Selected. Dinonaktifkan lewat ArrowUp.
  const [compareMode, setCompareMode] = useState(false);
  const [referencePhoto, setReferencePhoto] = useState<PhotoEntry | null>(null);
  // Lebar kotak patokan (kiri) dalam persen dari total lebar compare-stage.
  // Diubah lewat drag pada resize handle di antara kotak kiri-kanan.
  const [referenceWidthPct, setReferenceWidthPct] = useState(50);
  // Rasio lebar/tinggi asli media yang sedang tampil — dipakai supaya
  // bingkai foto (preview-photo-inner) dan kotak patokan (compare-reference-box)
  // "memeluk" bentuk asli media (persegi panjang lebar untuk PDF/foto
  // landscape, tinggi untuk potret) alih-alih selalu kotak besar dengan
  // letterbox kosong di kiri-kanan/atas-bawah.
  const [currentAspectRatio, setCurrentAspectRatio] = useState<number | null>(null);
  const [referenceAspectRatio, setReferenceAspectRatio] = useState<number | null>(null);

  useEffect(() => {
    setReferenceAspectRatio(null); // reset — menunggu patokan baru selesai load
  }, [referencePhoto]);
  const compareStageRef = useRef<HTMLDivElement>(null);
  const isResizingCompare = useRef(false);

  // --- Resize kotak patokan (drag divider antara kiri-kanan) ---
  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isResizingCompare.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isResizingCompare.current || !compareStageRef.current) return;
    const rect = compareStageRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setReferenceWidthPct(Math.min(75, Math.max(25, pct)));
  }, []);

  const onResizePointerUp = useCallback((e: React.PointerEvent) => {
    isResizingCompare.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }, []);
  const [trayOpen, setTrayOpen] = useState(false);
  const trayRef = useRef<HTMLDivElement>(null);

  // A photo from the dropdown currently shown large in the lightbox.
  const [viewingPhoto, setViewingPhoto] = useState<PhotoEntry | null>(null);
  const [fullViewPhoto, setFullViewPhoto] = useState<PhotoEntry | null>(null);
  // --- Toasts (replace inline red text with a stack that self-clears) ---
  const pushToast = useCallback((message: string) => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, message }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4200);
  }, []);

  // --- Pilih folder sumber foto ---
  const pickSourceFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Pilih folder berisi foto",
    });
    if (selected && typeof selected === "string") {
      setSourceFolder(selected);
    }
  };

  // --- Pilih folder tujuan (foto yang dipilih) ---
  const pickDestFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Pilih folder tujuan untuk foto terpilih",
    });
    if (selected && typeof selected === "string") {
      setDestFolder(selected);
    }
  };

  // --- Mulai proses: load semua foto dari folder sumber ---
  const startSorting = async () => {
    try {
      const photos = await invoke<PhotoEntry[]>("list_photos", {
        folder: sourceFolder,
      });
      if (photos.length === 0) {
        pushToast("Tidak ada foto ditemukan di folder tersebut.");
        return;
      }
      history.current = [];
      setCanUndo(false);
      setMediaFilter("all");
      setQueue(photos);
      setTotalLoaded(photos.length);
      setSelectedCount(0);
      setStage("sorting");
    } catch (e) {
      pushToast(String(e));
    }
  };

  // --- Load preview untuk foto di posisi paling depan queue ---
  // PDF tidak lewat get_preview (backend sengaja menolaknya) — PdfViewer
  // merender PDF sendiri lewat pdfjs-dist + convertFileSrc.
  const visibleQueue =
    mediaFilter === "all"
      ? queue
      : queue.filter((p) => p.kind === mediaFilter);

  useEffect(() => {
    if (stage !== "sorting" || visibleQueue.length === 0) {
      setPreviewSrc("");
      return;
    }
    setCurrentAspectRatio(null); // reset — menunggu media baru selesai load
    const current = visibleQueue[0];

    if (current.kind === "pdf" || current.kind === "video") {
      setPreviewSrc("");
      setLoadingPreview(false);
      return;
    }

    const cached = previewCache.current.get(current.path);
    if (cached) {
      setPreviewSrc(cached);
      return;
    }

    let cancelled = false;
    setLoadingPreview(true);
    invoke<string>("get_preview", { path: current.path })
      .then((dataUrl) => {
        if (!cancelled) {
          previewCache.current.set(current.path, dataUrl);
          setPreviewSrc(dataUrl);
        }
      })
      .catch((e) => {
        if (!cancelled) pushToast(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });

    // prefetch the next couple of frames so the swipe never stalls on load
    visibleQueue.slice(1, 3).forEach((p) => {
      if (
        p.kind !== "pdf" &&
        p.kind !== "video" &&
        !previewCache.current.has(p.path)
      ) {
        invoke<string>("get_preview", { path: p.path })
          .then((dataUrl) => previewCache.current.set(p.path, dataUrl))
          .catch(() => {});
      }
    });

    return () => {
      cancelled = true;
    };
  }, [visibleQueue, stage, pushToast]);

  const recordHistory = useCallback((entry: HistoryEntry) => {
    history.current = [...history.current, entry].slice(-HISTORY_LIMIT);
    setCanUndo(true);
  }, []);

  // --- Reject: foto pindah ke belakang queue ---
  const handleReject = useCallback(
    (photo: PhotoEntry) => {
      setQueue((prev) => [...prev.filter((p) => p.path !== photo.path), photo]);
      recordHistory({ type: "reject", photo });
    },
    [recordHistory],
  );

  // --- Select: foto di-move ke destFolder, keluar dari queue ---
  const handleSelect = useCallback(
    async (photo: PhotoEntry) => {
      setIsProcessing(true);
      try {
        await invoke("move_photo", {
          source: photo.path,
          destFolder: destFolder,
        });
        setSelectedCount((c) => c + 1);
        setQueue((prev) => prev.filter((p) => p.path !== photo.path));
        setSelectedPhotos((prev) => [photo, ...prev]);
        recordHistory({ type: "select", photo });
        setTrayBump(true);
        window.setTimeout(() => setTrayBump(false), 260);
      } catch (e) {
        pushToast(String(e));
      } finally {
        setIsProcessing(false);
      }
    },
    [destFolder, recordHistory, pushToast],
  );

  // --- Undo the last decision: reverses a reject (reorder) or a select
  // (moves the file back to the source folder and restores it to front) ---
  const handleUndo = useCallback(async () => {
    const last = history.current[history.current.length - 1];
    if (!last || isProcessing || exitDir) return;
    history.current = history.current.slice(0, -1);
    setCanUndo(history.current.length > 0);
    setUndoFlash(true);
    window.setTimeout(() => setUndoFlash(false), 320);

    if (last.type === "reject") {
      setQueue((prev) => [
        last.photo,
        ...prev.filter((p) => p.path !== last.photo.path),
      ]);
      return;
    }

    // last.type === "select"
    setIsProcessing(true);
    try {
      await invoke("move_photo", {
        source: `${destFolder}/${last.photo.name}`.replace(/\/+/g, "/"),
        destFolder: sourceFolder,
      });
      setSelectedCount((c) => Math.max(0, c - 1));
      setSelectedPhotos((prev) =>
        prev.filter((p) => p.path !== last.photo.path),
      );
      setQueue((prev) => [last.photo, ...prev]);
    } catch (e) {
      pushToast(`Gagal membatalkan: ${String(e)}`);
      // put the history entry back since the undo didn't actually happen
      history.current = [...history.current, last];
      setCanUndo(true);
    } finally {
      setIsProcessing(false);
    }
  }, [destFolder, sourceFolder, isProcessing, exitDir, pushToast]);
  // --- Remove a photo from the selected tray: moves it back from
  // destFolder to sourceFolder and puts it back at the front of the
  // queue, regardless of whether it was the most recent selection. ---
  const handleRemoveSelected = useCallback(
    async (photo: PhotoEntry) => {
      if (isProcessing) return;
      setIsProcessing(true);
      try {
        await invoke("move_photo", {
          source: `${destFolder}/${photo.name}`.replace(/\/+/g, "/"),
          destFolder: sourceFolder,
        });
        setSelectedCount((c) => Math.max(0, c - 1));
        setSelectedPhotos((prev) => prev.filter((p) => p.path !== photo.path));
        setQueue((prev) => [
          photo,
          ...prev.filter((p) => p.path !== photo.path),
        ]);
        // Drop the matching "select" entry from history so undo doesn't
        // later try to reverse a selection that's already been removed.
        history.current = history.current.filter(
          (h) => !(h.type === "select" && h.photo.path === photo.path),
        );
        setCanUndo(history.current.length > 0);
        if (viewingPhoto?.path === photo.path) setViewingPhoto(null);
      } catch (e) {
        pushToast(`Gagal menghapus: ${String(e)}`);
      } finally {
        setIsProcessing(false);
      }
    },
    [destFolder, sourceFolder, isProcessing, viewingPhoto, pushToast],
  );
  // --- Fullscreen / immersive mode: hides the surrounding chrome and lets
  // the print fill the window. Also asks the OS window to go fullscreen
  // where that API is available; falls back to the in-app layout only. ---
  const toggleImmersive = useCallback(() => {
    setImmersive((prev) => {
      const next = !prev;
      getCurrentWindow()
        .setFullscreen(next)
        .catch(() => {
          /* windowed platforms / denied permission: layout still adapts */
        });
      return next;
    });
  }, []);

  useEffect(() => {
    if (stage !== "sorting" && immersive) {
      setImmersive(false);
      getCurrentWindow()
        .setFullscreen(false)
        .catch(() => {});
    }
  }, [stage, immersive]);

  // --- Close the selected-photos dropdown on an outside click or Escape;
  // Escape closes the lightbox first if it's open. ---
  useEffect(() => {
    if (!trayOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        trayRef.current &&
        !trayRef.current.contains(e.target as Node) &&
        !viewingPhoto
      ) {
        setTrayOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (viewingPhoto) {
          setViewingPhoto(null);
        } else {
          setTrayOpen(false);
        }
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [trayOpen, viewingPhoto]);

  // --- Snap back to center when a drag didn't cross the threshold ---
  const settleTo = useCallback((x: number) => {
    setIsSettling(true);
    setDragX(x);
  }, []);

  // Ref jembatan supaya triggerExit bisa panggil handleExitAnimationEnd
  // walau fungsi itu baru didefinisikan setelah triggerExit di bawah ini.
  const handleExitAnimationEndRef = useRef<() => void>(() => {});

  // --- Kick off the direction-specific exit animation for the top print.
  // startX/startRot let a released drag continue smoothly into the
  // animation instead of jumping back to center first; keyboard/button
  // triggers just start from 0 (center). ---
  const triggerExit = useCallback(
    (direction: "left" | "right", startX = 0, startRot = 0) => {
      if (queue.length === 0 || isProcessing || exitDir) return;
      dragging.current = false;
      setIsSettling(false);
      setExitStartX(startX);
      setExitStartRot(startRot);
      setExitDir(direction);
      // Failsafe: if the CSS animationend event never fires for any reason
      // (heavy main-thread work, a video that failed to load, etc.), force
      // the exit to complete anyway so the buttons never stay stuck disabled.
      window.setTimeout(() => {
        handleExitAnimationEndRef.current();
      }, 600);
    },
    [queue.length, isProcessing, exitDir],
  );

  // --- Called once the CSS exit animation finishes: commit the real
  // state change (requeue or select-and-move) and reset for the next card. ---
  const handleExitAnimationEnd = useCallback(() => {
    const finishedDirection = exitDir;
    const photo = visibleQueue[0];
    setExitDir(null);
    setDragX(0);
    setExitStartX(0);
    setExitStartRot(0);
    if (!photo) return;
    if (finishedDirection === "left") {
      handleReject(photo);
    } else if (finishedDirection === "right") {
      handleSelect(photo);
    }
  }, [exitDir, visibleQueue, handleReject, handleSelect]);

  useEffect(() => {
    handleExitAnimationEndRef.current = handleExitAnimationEnd;
  }, [handleExitAnimationEnd]);

  // --- Drag-to-swipe on the preview card, with velocity tracking so a
  // quick flick clears the card even if it didn't travel far. ---
  const onPointerDown = (e: React.PointerEvent) => {
    if (queue.length === 0 || isProcessing || exitDir) return;
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragStartT.current = performance.now();
    lastMoveX.current = e.clientX;
    lastMoveT.current = dragStartT.current;
    setIsSettling(false);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointerId.current = e.pointerId;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    setDragX(e.clientX - dragStartX.current);
    lastMoveX.current = e.clientX;
    lastMoveT.current = performance.now();
  };

  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;

    const dt = Math.max(1, performance.now() - lastMoveT.current + 1);
    const velocity = (lastMoveX.current - dragStartX.current) / dt;
    const clears =
      Math.abs(dragX) > SWIPE_THRESHOLD ||
      Math.abs(velocity) > VELOCITY_THRESHOLD;

    if (clears && dragX > 0) {
      const rotation = Math.max(-1, Math.min(1, dragX / SWIPE_THRESHOLD)) * 8;
      triggerExit("right", dragX, rotation);
    } else if (clears && dragX < 0) {
      const rotation = Math.max(-1, Math.min(1, dragX / SWIPE_THRESHOLD)) * 8;
      triggerExit("left", dragX, rotation);
    } else {
      settleTo(0);
    }
  };

  // --- Keyboard listener ---
  useEffect(() => {
    if (stage !== "sorting") return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        triggerExit("left");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        triggerExit("right");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!compareMode && visibleQueue[0] && exitDir === null) {
          setReferencePhoto(visibleQueue[0]);
          setCompareMode(true);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (compareMode) {
          setCompareMode(false);
          setReferencePhoto(null);
        }
      } else if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleUndo();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        handleUndo();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleImmersive();
      } else if (e.key === "Escape" && immersive) {
        e.preventDefault();
        toggleImmersive();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [stage, triggerExit, handleUndo, toggleImmersive, immersive, compareMode, visibleQueue, exitDir]);

  const finishSorting = () => {
    setStage("done");
  };

  const resetApp = () => {
    setStage("setup");
    setSourceFolder("");
    setDestFolder("");
    setQueue([]);
    setTotalLoaded(0);
    setSelectedCount(0);
    setPreviewSrc("");
    setDragX(0);
    setExitDir(null);
    history.current = [];
    setCanUndo(false);
    setSelectedPhotos([]);
    setTrayOpen(false);
    previewCache.current.clear();
    if (immersive) toggleImmersive();
  };

  // ================= UI =================

  const ToastStack = toasts.length > 0 && (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast mono" key={t.id}>
          {t.message}
        </div>
      ))}
    </div>
  );

  if (stage === "setup") {
    const ready = sourceFolder && destFolder;
    return (
      <div className="container setup-screen">
        {ToastStack}
        <div className="brand">
          <span className="brand-mark">Selecta</span>
          <h1>Aplikasi yang memudahkan untuk memanage foto seabrek</h1>
        </div>

        <div className="setup-card">
          <button
            type="button"
            className={`setup-row${sourceFolder ? " is-filled" : ""}`}
            onClick={pickSourceFolder}
          >
            <span className="setup-row-label">
              <span className="setup-icon" aria-hidden="true">
                <FolderGlyph />
              </span>
              <span className="setup-text">
                <span className="setup-title">Folder sumber</span>
                <span className="path-label">
                  {sourceFolder || "klik untuk memilih…"}
                </span>
              </span>
            </span>
            <span className="setup-chevron" aria-hidden="true">
              {sourceFolder ? "✓" : "›"}
            </span>
          </button>

          <button
            type="button"
            className={`setup-row${destFolder ? " is-filled" : ""}`}
            onClick={pickDestFolder}
          >
            <span className="setup-row-label">
              <span className="setup-icon" aria-hidden="true">
                <TrayGlyph />
              </span>
              <span className="setup-text">
                <span className="setup-title">Folder tujuan</span>
                <span className="path-label">
                  {destFolder || "klik untuk memilih…"}
                </span>
              </span>
            </span>
            <span className="setup-chevron" aria-hidden="true">
              {destFolder ? "✓" : "›"}
            </span>
          </button>
        </div>

        <button className="primary" disabled={!ready} onClick={startSorting}>
          {ready ? "Mulai Sortir" : "Pilih kedua folder dulu"}
        </button>

        <div className="setup-keys">
          <span>
            <kbd>←</kbd> lewati
          </span>
          <span>
            <kbd>→</kbd> pilih
          </span>
          <span>
            <kbd>⌘Z</kbd> batal
          </span>
          <span>
            <kbd>F</kbd> layar penuh
          </span>
        </div>
      </div>
    );
  }

  if (stage === "done") {
    const rate = totalLoaded
      ? Math.round((selectedCount / totalLoaded) * 100)
      : 0;
    return (
      <div className="container done-screen">
        {ToastStack}
        <span className="brand-mark">Selecta</span>
        <h1>Selesai</h1>
        <div className="done-ring">
          <RollDial progress={rate} size={188} />
          <div className="done-ring-label">
            <span className="done-ring-pct mono">{rate}%</span>
            <span className="done-ring-sub">disimpan</span>
          </div>
        </div>
        <p className="done-tally">
          <span className="stat-value">{selectedCount}</span> dari {totalLoaded}{" "}
          foto disimpan
        </p>
        <p className="done-path mono">{destFolder}</p>
        <button className="primary" onClick={resetApp}>
          Mulai Roll Baru
        </button>
      </div>
    );
  }

  // stage === "sorting"
  const current = visibleQueue[0];
  const frameNumber = totalLoaded - queue.length + 1;
  const swipeProgress = Math.max(-1, Math.min(1, dragX / SWIPE_THRESHOLD));
  const rotation = swipeProgress * 8;
  const isExiting = exitDir !== null;
  const percentDone = totalLoaded
    ? Math.round(((frameNumber - 1) / totalLoaded) * 100)
    : 0;
  const reviewedCount = Math.max(0, frameNumber - 1);
  const rejectedCount = Math.max(0, reviewedCount - selectedCount);

  return (
    <div className={`container sorting-screen${immersive ? " immersive" : ""}`}>
      {ToastStack}

      {/* Signature device: a hairline bar across the very top of the window
          that fills as the roll progresses. Replaces decorative chrome
          with a literal, always-visible readout of where you are. */}
      <div className="roll-progress" aria-hidden="true">
        <div
          className="roll-progress-fill"
          style={{ width: `${percentDone}%` }}
        />
      </div>

      <div className="top-bar">
        <div className="top-bar-progress">
          <ProgressRing progress={percentDone} size={30} strokeWidth={3} />
          <span>
            <span className="stat-value">{queue.length}</span> sisa
          </span>
        </div>
        <span className="top-bar-mid">
          <span className="stat-value">{selectedCount}</span> / {totalLoaded}{" "}
          terpilih
        </span>
        <div className="media-filter" role="group" aria-label="Filter jenis media">
          {(
            [
              { value: "all", label: "Semua", count: queue.length },
              {
                value: "image",
                label: "Foto",
                count: queue.filter((p) => p.kind === "image").length,
              },
              {
                value: "pdf",
                label: "PDF",
                count: queue.filter((p) => p.kind === "pdf").length,
              },
              {
                value: "video",
                label: "Video",
                count: queue.filter((p) => p.kind === "video").length,
              },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`media-filter-btn${mediaFilter === opt.value ? " is-active" : ""}`}
              onClick={() => setMediaFilter(opt.value)}
              disabled={isProcessing || isExiting}
            >
              {opt.label}
              <span className="media-filter-count mono">{opt.count}</span>
            </button>
          ))}
        </div>
        <div className="top-bar-actions">
          <button
            className={`ghost-btn${undoFlash ? " undo-flash" : ""}`}
            onClick={handleUndo}
            disabled={!canUndo || isProcessing || isExiting}
            title="Batalkan keputusan terakhir (⌘Z)"
          >
            Batal
          </button>
          <button
            className="ghost-btn"
            onClick={toggleImmersive}
            title="Layar penuh (F)"
          >
            Penuh
          </button>
          <button onClick={finishSorting}>Selesai</button>
        </div>
      </div>

      <div className="sorting-layout">
        <div className="sorting-main">
          <div
            ref={compareStageRef}
            className={`compare-stage${compareMode ? " compare-mode" : ""}`}
            onPointerMove={compareMode ? onResizePointerMove : undefined}
            onPointerUp={compareMode ? onResizePointerUp : undefined}
            onPointerLeave={compareMode ? onResizePointerUp : undefined}
          >
            {compareMode && referencePhoto && (
              <>
                <div
                  className="compare-reference"
                  style={{ flex: `0 0 ${referenceWidthPct}%` }}
                >
                  <div className="compare-reference-label mono">
                    Patokan · <span className="compare-hint-inline">↑ keluar</span>
                  </div>
                  <div
                    className="compare-reference-box"
                    style={
                      referenceAspectRatio
                        ? { aspectRatio: `${referenceAspectRatio}` }
                        : undefined
                    }
                  >
                    {referencePhoto.kind === "pdf" ? (
                      <PdfViewer
                        path={referencePhoto.path}
                        compact
                        onDimensionsChange={setReferenceAspectRatio}
                      />
                    ) : referencePhoto.kind === "video" ? (
                      <VideoViewer
                        path={referencePhoto.path}
                        compact
                        onDimensionsChange={setReferenceAspectRatio}
                      />
                    ) : (
                      <img
                        src={previewCache.current.get(referencePhoto.path) ?? ""}
                        alt={referencePhoto.name}
                        className="preview-img"
                        draggable={false}
                        onLoad={(e) => {
                          const img = e.currentTarget;
                          if (img.naturalWidth && img.naturalHeight) {
                            setReferenceAspectRatio(
                              img.naturalWidth / img.naturalHeight,
                            );
                          }
                        }}
                      />
                    )}
                  </div>
                  <p className="compare-reference-name mono">
                    {referencePhoto.name}
                  </p>
                </div>
                <div
                  className="compare-resize-handle"
                  onPointerDown={onResizePointerDown}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Geser untuk mengubah lebar kotak patokan"
                >
                  <span className="compare-resize-grip" aria-hidden="true" />
                </div>
              </>
            )}
            <div className="filmstrip">
            <div className="sprocket-row" aria-hidden="true">
              {Array.from({ length: 16 }).map((_, i) => (
                <span key={i} />
              ))}
            </div>

            <div
              className={`preview-box${isExiting ? " is-exiting" : ""}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerLeave={endDrag}
            >
              {/* sheets waiting underneath — back to front so the top photo lands last */}
              {queue
                .slice(1, STACK_DEPTH)
                .map((p, i) => {
                  const depth = i + 1; // 1..STACK_DEPTH-1
                  const { rotate, shiftX } = seededOffset(p.path, depth);
                  return (
                    <div
                      key={p.path}
                      className="stack-sheet"
                      style={{
                        transform: `translate(${shiftX}px, ${depth * 3}px) rotate(${rotate}deg)`,
                        zIndex: STACK_DEPTH - depth,
                        opacity: 1 - depth * 0.16,
                      }}
                      aria-hidden="true"
                    />
                  );
                })
                .reverse()}

              {loadingPreview && (
                <div
                  className="preview-placeholder"
                  style={{ zIndex: STACK_DEPTH + 1 }}
                >
                  <span className="loading-ticks" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  Memuat preview…
                </div>
              )}

              {!loadingPreview && (previewSrc || current?.kind === "pdf" || current?.kind === "video") && (
                <div
                  className={
                    "preview-card" +
                    (isSettling ? " settling" : "") +
                    (exitDir === "left" ? " exit-left" : "") +
                    (exitDir === "right" ? " exit-right" : "")
                  }
                  style={
                    isExiting
                      ? ({
                          "--start-x": `${exitStartX}px`,
                          "--start-rot": `${exitStartRot}deg`,
                          zIndex: STACK_DEPTH + 1,
                        } as React.CSSProperties)
                      : {
                          transform: `translateX(${dragX}px) rotate(${rotation}deg)`,
                          zIndex: STACK_DEPTH + 1,
                        }
                  }
                  onAnimationEnd={handleExitAnimationEnd}
                >
                  <div
                    className={
                      "preview-photo-inner" +
                      (current?.kind === "pdf" || current?.kind === "video"
                        ? " is-clickable"
                        : "")
                    }
                    style={
                      currentAspectRatio
                        ? { aspectRatio: `${currentAspectRatio}` }
                        : undefined
                    }
                    onClick={() => {
                      if (
                        current &&
                        (current.kind === "pdf" || current.kind === "video")
                      ) {
                        setFullViewPhoto(current);
                      }
                    }}
                  >
                    {current?.kind === "pdf" ? (
                      <PdfViewer
                        path={current.path}
                        compact
                        onDimensionsChange={setCurrentAspectRatio}
                      />
                    ) : current?.kind === "video" ? (
                      <VideoViewer
                        path={current.path}
                        compact
                        onDimensionsChange={setCurrentAspectRatio}
                      />
                    ) : (
                      <img
                        src={previewSrc}
                        alt={current?.name}
                        className="preview-img"
                        draggable={false}
                        onLoad={(e) => {
                          const img = e.currentTarget;
                          if (img.naturalWidth && img.naturalHeight) {
                            setCurrentAspectRatio(
                              img.naturalWidth / img.naturalHeight,
                            );
                          }
                        }}
                      />
                    )}
                  </div>
                  {current && (
                    <span className="frame-counter mono">
                      {String(frameNumber).padStart(3, "0")} /{" "}
                      {String(totalLoaded).padStart(3, "0")}
                    </span>
                  )}
                </div>
              )}

              {!loadingPreview && !previewSrc && queue.length === 0 && (
                <div
                  className="preview-placeholder empty-state"
                  style={{ zIndex: STACK_DEPTH + 1 }}
                >
                  <span className="empty-glyph" aria-hidden="true">
                    <TrayGlyph large />
                  </span>
                  <span className="empty-title">Tumpukan habis</span>
                  <span className="hint-inline">
                    Klik &quot;Selesai&quot; untuk melihat hasil roll ini.
                  </span>
                </div>
              )}

              {swipeProgress > 0.15 && !isExiting && (
                <span
                  className="stamp stamp-select"
                  style={{ opacity: swipeProgress }}
                >
                  Pilih
                </span>
              )}
              {swipeProgress < -0.15 && !isExiting && (
                <span
                  className="stamp stamp-reject"
                  style={{ opacity: -swipeProgress }}
                >
                  Lewati
                </span>
              )}
            </div>

            <div className="sprocket-row" aria-hidden="true">
              {Array.from({ length: 16 }).map((_, i) => (
                <span key={i} />
              ))}
            </div>
          </div>
          </div>

          {immersive && (
            <button
              className="immersive-exit"
              onClick={toggleImmersive}
              title="Keluar layar penuh (Esc)"
            >
              Esc — keluar layar penuh
            </button>
          )}

          {current && <p className="filename mono">{current.name}</p>}

          <div className="controls">
            <button
              className="reject-btn"
              onClick={() => triggerExit("left")}
              disabled={queue.length === 0 || isExiting}
            >
              ← Lewati
            </button>
            {current &&
              (current.kind === "pdf" || current.kind === "video") && (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setFullViewPhoto(current)}
                  disabled={isExiting}
                >
                  {current.kind === "pdf" ? "Lihat PDF" : "Putar Video"}{" "}
                </button>
              )}
            <button
              className="select-btn"
              onClick={() => triggerExit("right")}
              disabled={queue.length === 0 || isProcessing || isExiting}
            >
              Pilih →
            </button>
          </div>

          <p className="hint">
            seret foto, atau pakai <kbd>←</kbd> <kbd>→</kbd> — <kbd>⌘Z</kbd>{" "}
            batal — <kbd>F</kbd> layar penuh
          </p>
        </div>

        <aside className="side-panel">
          <div className="side-card">
            <div className="side-card-title">Sesi Ini</div>
            <div className="stat-row">
              <span className="stat-row-label">Terpilih</span>
              <span className="stat-row-value is-accent">{selectedCount}</span>
            </div>
            <div className="stat-row">
              <span className="stat-row-label">Dilewati</span>
              <span className="stat-row-value is-reject">{rejectedCount}</span>
            </div>
            <div className="stat-row">
              <span className="stat-row-label">Sisa</span>
              <span className="stat-row-value">{queue.length}</span>
            </div>
            <div className="stat-row">
              <span className="stat-row-label">Total roll</span>
              <span className="stat-row-value">{totalLoaded}</span>
            </div>
          </div>

          <div className="side-card">
            <div className="side-card-title">Tujuan</div>
            <div className="side-dest">
              <span className="side-dest-path mono">{destFolder}</span>
            </div>
          </div>

          <div className="side-card">
            <div className="side-card-title">Pintasan</div>
            <div className="shortcut-list">
              <div className="shortcut-row">
                <span>Lewati</span>
                <kbd>←</kbd>
              </div>
              <div className="shortcut-row">
                <span>Pilih</span>
                <kbd>→</kbd>
              </div>
              <div className="shortcut-row">
                <span>Batal</span>
                <kbd>⌘Z</kbd>
              </div>
              <div className="shortcut-row">
                <span>Layar penuh</span>
                <kbd>F</kbd>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Selected tally — click it to see the photos picked so far. */}
      <div
        ref={trayRef}
        className={`selected-tray${trayBump ? " tray-bump" : ""}`}
      >
        <button
          type="button"
          className="tray-toggle"
          onClick={() => setTrayOpen((o) => !o)}
          disabled={selectedCount === 0}
          aria-expanded={trayOpen}
          aria-haspopup="true"
          title={
            selectedCount === 0
              ? "Belum ada foto terpilih"
              : "Lihat foto terpilih"
          }
        >
          <span className="tray-count mono">{selectedCount}</span>
          <span className="tray-label">Terpilih</span>
        </button>

        {trayOpen && selectedPhotos.length > 0 && (
          <div className="tray-dropdown">
            <div className="tray-dropdown-header">
              <span>Foto Terpilih</span>
              <button
                type="button"
                className="tray-dropdown-close"
                onClick={() => setTrayOpen(false)}
                aria-label="Tutup"
              >
                ×
              </button>
            </div>
            <div className="tray-dropdown-list">
              {selectedPhotos.map((p) => {
                const thumb = previewCache.current.get(p.path);
                return (
                  <div className="tray-dropdown-item" key={p.path}>
                    <button
                      type="button"
                      className="tray-dropdown-item-main"
                      onClick={() => setViewingPhoto(p)}
                    >
                      <div className="tray-thumb">
                        {p.kind === "pdf" ? (
                          <span className="tray-thumb-fallback mono">PDF</span>
                        ) : thumb ? (
                          <img src={thumb} alt={p.name} />
                        ) : (
                          <span className="tray-thumb-fallback mono">IMG</span>
                        )}
                      </div>
                      <span className="tray-dropdown-name mono">{p.name}</span>
                    </button>
                    <button
                      type="button"
                      className="tray-dropdown-item-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveSelected(p);
                      }}
                      disabled={isProcessing}
                      title="Hapus dari terpilih"
                      aria-label={`Hapus ${p.name} dari terpilih`}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* PDF full viewer — dibuka dari tombol "Lihat PDF" */}
      {fullViewPhoto && (
        <div
          className="photo-lightbox"
          onClick={() => {
            (document.activeElement as HTMLElement | null)?.blur();
            setFullViewPhoto(null);
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="photo-lightbox-card pdf-lightbox-card"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="photo-lightbox-close"
              onClick={() => {
                (document.activeElement as HTMLElement | null)?.blur();
                setFullViewPhoto(null);
              }}
              aria-label="Tutup"
            >
              ×
            </button>
            <div className="pdf-lightbox-viewer-wrap">
              {fullViewPhoto.kind === "pdf" ? (
                <PdfViewer path={fullViewPhoto.path} />
              ) : (
                <VideoViewer path={fullViewPhoto.path} />
              )}{" "}
            </div>
            <p className="photo-lightbox-caption mono">{fullViewPhoto.name}</p>
          </div>
        </div>
      )}

      {/* Lightbox: a larger look at a photo picked from the tray dropdown. */}
      {viewingPhoto && (
        <div
          className="photo-lightbox"
          onClick={() => setViewingPhoto(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="photo-lightbox-card"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="photo-lightbox-close"
              onClick={() => setViewingPhoto(null)}
              aria-label="Tutup"
            >
              ×
            </button>
            <div className="photo-lightbox-img-wrap">
              {previewCache.current.get(viewingPhoto.path) ? (
                <img
                  src={previewCache.current.get(viewingPhoto.path)}
                  alt={viewingPhoto.name}
                />
              ) : (
                <span className="mono photo-lightbox-fallback">
                  Preview tidak tersedia
                </span>
              )}
            </div>
            <p className="photo-lightbox-caption mono">{viewingPhoto.name}</p>
            <button
              type="button"
              className="photo-lightbox-remove"
              onClick={() => handleRemoveSelected(viewingPhoto)}
              disabled={isProcessing}
            >
              Hapus dari Terpilih
            </button>{" "}
          </div>
        </div>
      )}
    </div>
  );
}

// --- small inline glyphs, so the setup screen doesn't need an icon library ---
function FolderGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3a1.5 1.5 0 0 1 1.2.6l1 1.4h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H4.5A1.5 1.5 0 0 1 3 17.5v-11Z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function TrayGlyph({ large = false }: { large?: boolean }) {
  const s = large ? 34 : 18;
  return (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none">
      <path
        d="M4 13.5 6.2 5.8A1.5 1.5 0 0 1 7.65 4.7h8.7a1.5 1.5 0 0 1 1.45 1.1L20 13.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M4 13.5h4.2a1 1 0 0 1 .95.68l.4 1.2a1 1 0 0 0 .95.68h2.6a1 1 0 0 0 .95-.68l.4-1.2a1 1 0 0 1 .95-.68H20V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-4.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

// A dial-style progress ring for the done screen: an inner arc plus a bezel
// of tick marks (like a light-meter or a film-advance dial) that light up
// as the fill count goes up, so it reads as a physical instrument rather
// than a generic loading ring.
function RollDial({
  progress,
  size = 180,
}: {
  progress: number;
  size?: number;
}) {
  const clamped = Math.min(100, Math.max(0, progress));
  const cx = size / 2;
  const cy = size / 2;

  const ringStroke = 7;
  const ringR = size / 2 - 26;
  const c = 2 * Math.PI * ringR;
  const offset = c - (clamped / 100) * c;

  const tickCount = 48;
  const tickOuter = size / 2 - 3;
  const ticks = Array.from({ length: tickCount }).map((_, i) => {
    const major = i % 4 === 0;
    const tickInner = tickOuter - (major ? 11 : 6);
    const angleDeg = (i / tickCount) * 360 - 90;
    const rad = (angleDeg * Math.PI) / 180;
    const x1 = cx + tickInner * Math.cos(rad);
    const y1 = cy + tickInner * Math.sin(rad);
    const x2 = cx + tickOuter * Math.cos(rad);
    const y2 = cy + tickOuter * Math.sin(rad);
    const filled = (i / tickCount) * 100 <= clamped;
    return { key: i, x1, y1, x2, y2, filled, major };
  });

  return (
    <svg width={size} height={size} className="roll-dial">
      {ticks.map((t) => (
        <line
          key={t.key}
          x1={t.x1}
          y1={t.y1}
          x2={t.x2}
          y2={t.y2}
          stroke={t.filled ? "var(--accent)" : "var(--border-strong)"}
          strokeWidth={t.major ? 2 : 1.4}
          strokeLinecap="round"
          opacity={t.filled ? 1 : 0.6}
        />
      ))}
      <circle
        cx={cx}
        cy={cy}
        r={ringR}
        fill="none"
        stroke="var(--border)"
        strokeWidth={ringStroke}
      />
      <circle
        cx={cx}
        cy={cy}
        r={ringR}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={ringStroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${cx} ${cy})`}
        className="roll-dial-arc"
      />
    </svg>
  );
}

function ProgressRing({
  progress,
  size = 40,
  strokeWidth = 3.5,
}: {
  progress: number;
  size?: number;
  strokeWidth?: number;
}) {
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (Math.min(100, Math.max(0, progress)) / 100) * c;
  return (
    <svg width={size} height={size} className="progress-ring">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export default App;
