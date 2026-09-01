// Deklarasi tipe untuk custom element <l-tail-spin> dari library "ldrs".
// ldrs pakai Web Components (registered via tailSpin.register() di
// main.tsx), bukan komponen React biasa — TypeScript/JSX perlu tahu
// tag ini valid supaya tidak error saat dipakai di JSX.
//
// React 19 memindahkan JSX.IntrinsicElements ke dalam namespace
// React.JSX, jadi augmentasi harus lewat module augmentation "react",
// bukan cuma `declare namespace JSX` di global scope (yang sudah tidak
// lagi otomatis ke-pickup oleh @types/react versi 19).
import "react";

type TailSpinProps = {
  size?: string | number;
  stroke?: string | number;
  speed?: string | number;
  color?: string;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "l-tail-spin": TailSpinProps;
    }
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "l-tail-spin": TailSpinProps;
    }
  }
}

export {};
