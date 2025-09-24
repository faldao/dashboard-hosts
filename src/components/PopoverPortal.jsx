//   (o arriba del mismo archivo)
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export default function PopoverPortal({ anchorRef, open, onClose, children, placement = "top-right", gap = 8, maxWidth = 320 }) {
  const popRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0, visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open || !anchorRef?.current) return;
    const btn = anchorRef.current;
    const rect = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // tamaño estimado (mejor medir tras render con ref, pero sirve para primera pasada)
    const w = Math.min(maxWidth, 280);
    const h = 220;

    let top = rect.top;
    let left = rect.left;

    const wantTop = placement.includes("top");
    const wantRight = placement.includes("right");

    top = wantTop ? rect.top - gap - h : rect.bottom + gap;
    left = wantRight ? rect.right - w : rect.left;

    // clamping a viewport
    if (top < 8) top = Math.min(rect.bottom + gap, vh - h - 8);
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    if (left < 8) left = 8;
    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);

    setPos({ top, left, visibility: "visible" });
  }, [open, anchorRef, placement, gap, maxWidth]);

  // Cerrar por click afuera y Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    const onDown = (e) => {
      const el = popRef.current;
      if (!el) return;
      if (!el.contains(e.target)) onClose?.();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={popRef}
      className="mini-popover"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        maxWidth,
        visibility: pos.visibility,
        zIndex: 1000
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
}
