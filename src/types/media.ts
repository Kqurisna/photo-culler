// Tipe pusat untuk Media (Image | PDF | nanti Video).
// App.tsx saat ini masih punya `PhotoEntry` lokal dengan shape yang sama
// persis (path, name, kind) — sengaja dibuat kompatibel supaya migrasi
// bisa bertahap tanpa refactor besar sekaligus.

export type MediaKind = "image" | "pdf";

export interface MediaItem {
  path: string;
  name: string;
  kind: MediaKind;
}
