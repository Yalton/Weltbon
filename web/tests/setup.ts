import '@testing-library/jest-dom';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy*/waitFor give up after 1s by default, which a lazily loaded route or a
// re-render can exceed when the machine is busy. Tests that need a tighter
// bound pass their own { timeout }.
configure({ asyncUtilTimeout: 5_000 });

// jsdom doesn't ship ResizeObserver, but Radix UI primitives (Popover, Select,
// Dialog) call into @radix-ui/react-use-size which assumes it exists. Provide
// a no-op polyfill so component tests that mount these primitives don't crash.
if (typeof globalThis.ResizeObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class ResizeObserverShim {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverShim }).ResizeObserver = ResizeObserverShim;
}

// jsdom doesn't implement PointerEvent capture APIs that Radix uses for its
// trigger/dismissable-layer logic. Stub them on Element.prototype.
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

// jsdom 25 doesn't ship a constructable PointerEvent global. d3-drag listens
// for pointerdown/move/up; tests need to dispatch real PointerEvent objects
// (with clientX/clientY) for the drag-source / drop-target flow to work.
// Polyfill on top of MouseEvent, copying the pointer-specific properties.
if (typeof (globalThis as { PointerEvent?: typeof PointerEvent }).PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {
    public pointerId: number;
    public pointerType: string;
    public isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  (globalThis as unknown as { PointerEvent: typeof PointerEventShim }).PointerEvent =
    PointerEventShim;
}

// jsdom's Document.prototype lacks `elementFromPoint` entirely (it implements
// `elementsFromPoint` but not the singular). The drag-handler hit-test calls
// `document.elementFromPoint(...)`; we install a no-op default so the call
// path doesn't throw, and individual tests `vi.spyOn(document, ...)` to
// inject a deterministic return value.
if (typeof Document !== 'undefined') {
  const proto = Document.prototype as Document & {
    elementFromPoint?: (x: number, y: number) => Element | null;
  };
  if (typeof proto.elementFromPoint !== 'function') {
    proto.elementFromPoint = () => null;
  }
}

afterEach(() => {
  cleanup();
});
