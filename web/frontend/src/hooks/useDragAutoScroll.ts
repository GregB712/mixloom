import { useEffect, type RefObject } from "react";

const EDGE = 80; // px from the top/bottom edge where scrolling starts
const MAX_STEP = 18; // px per frame at the very edge

// Signed scroll step for a pointer at `y` inside a visible area spanning
// [top, bottom]: negative near the top, positive near the bottom, 0 elsewhere.
// Speed grows linearly as the pointer approaches (or passes) the edge.
export function edgeScrollStep(y: number, top: number, bottom: number): number {
  const zone = Math.min(EDGE, (bottom - top) / 2);
  if (y < top + zone) return -Math.ceil((MAX_STEP * Math.min(top + zone - y, zone)) / zone);
  if (y > bottom - zone) return Math.ceil((MAX_STEP * Math.min(y - (bottom - zone), zone)) / zone);
  return 0;
}

function scrollParent(el: HTMLElement): HTMLElement {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return document.scrollingElement as HTMLElement;
}

// While `active` (a drag is in progress), scroll the element's nearest
// scrollable ancestor when the pointer nears its top or bottom edge. Browsers'
// own drag auto-scroll doesn't reliably reach nested scroll containers.
export function useDragAutoScroll(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const scroller = scrollParent(el);
    let y: number | null = null;
    let frame = 0;

    const onDragOver = (e: DragEvent) => { y = e.clientY; };
    // Pointer left the window: stop scrolling until it comes back.
    const onDragLeave = (e: DragEvent) => { if (!e.relatedTarget) y = null; };
    const tick = () => {
      if (y !== null) {
        const rect = scroller === document.scrollingElement
          ? { top: 0, bottom: window.innerHeight }
          : scroller.getBoundingClientRect();
        const step = edgeScrollStep(y, Math.max(rect.top, 0), Math.min(rect.bottom, window.innerHeight));
        if (step) scroller.scrollBy(0, step);
      }
      frame = requestAnimationFrame(tick);
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      cancelAnimationFrame(frame);
    };
  }, [ref, active]);
}
