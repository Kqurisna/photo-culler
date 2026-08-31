// Deklarasi tipe untuk custom element <l-tail-spin> dari library "ldrs".
// ldrs pakai Web Components (registered via tailSpin.register() di
// main.tsx), bukan komponen React biasa — TypeScript/JSX perlu tahu
// tag ini valid supaya tidak error saat dipakai di JSX.
declare namespace JSX {
  interface IntrinsicElements {
    "l-tail-spin": {
      size?: string | number;
      stroke?: string | number;
      speed?: string | number;
      color?: string;
    };
  }
}
