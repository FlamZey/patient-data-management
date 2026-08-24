"use client";

import { useEffect } from "react";

// Reference-counted so two dialogs opening in quick succession (or one
// replacing another) don't have the first one's unmount re-enable scrolling
// while the second is still up. Mirrors navigation-loading.ts's external
// store shape -- OverlayScrollbar is the one subscriber, hiding its thumb
// for as long as any dialog holds the lock.
let lockCount = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function isPageScrollLocked(): boolean {
  return lockCount > 0;
}

export function subscribePageScrollLock(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Call from a full-viewport dialog while it's mounted -- blocks wheel/touch/
// keyboard scrolling of the page behind it (the dialog's own backdrop can
// still scroll internally via its own overflow-y-auto) and hides
// OverlayScrollbar's thumb, which otherwise floats above the backdrop.
export function useLockPageScroll() {
  useEffect(() => {
    lockCount += 1;
    if (lockCount === 1) {
      document.documentElement.style.overflow = "hidden";
    }
    emit();

    return () => {
      lockCount -= 1;
      if (lockCount === 0) {
        document.documentElement.style.overflow = "";
      }
      emit();
    };
  }, []);
}
