"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Reveals its children when they scroll into view.
 *
 * The displaced state is written into the markup as `data-reveal`, not added
 * after mount, so the very first paint already has it — an element that starts
 * visible and is hidden on hydration flashes, which is worse than no animation
 * at all. `layout.tsx` carries a `<noscript>` rule that unhides everything, and
 * the reduced-motion block in globals.css short-circuits the whole effect.
 *
 * One observer per element rather than one shared registry: there are a few
 * dozen of these on the page, each fires exactly once, and a shared observer
 * would be indirection for no measurable gain.
 */
export default function Reveal({
  children,
  /** Milliseconds behind its neighbours. Stagger a row by passing `i * 80`. */
  delay = 0,
  /** How far it travels, in px. Smaller for text, larger for whole blocks. */
  y = 20,
  className,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;

    // Anything already on screen at mount — the hero, or a deep link's target —
    // should settle immediately rather than wait for a scroll that never comes.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      // Fires a little before the element is fully in view, so the motion
      // finishes around the moment it reaches a comfortable reading position.
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  return (
    <div
      ref={ref}
      data-reveal={shown ? "in" : ""}
      className={className}
      style={{ "--d": `${delay}ms`, "--reveal-y": `${y}px`, ...style } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
