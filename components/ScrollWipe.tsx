"use client";

import { useEffect, useRef } from "react";

/**
 * A panel that is wiped open from the left as the page scrolls past it.
 *
 * Scroll-linked rather than triggered: the clip edge tracks the scroll position
 * continuously, so scrolling back up closes it again. Everything inside is
 * clipped with the panel, which is the point — the heading is revealed *by* the
 * edge sweeping over it rather than fading in underneath it.
 *
 * The offset is written to a custom property inside a rAF rather than held in
 * state. This lives in the landing page, and a setState per scroll event would
 * re-render every section on the page to move one clip edge.
 *
 * Default `--wipe` is 0% (fully open) in globals.css, so with JavaScript off or
 * reduced motion on, the panel is simply there.
 */
export default function ScrollWipe({
  children,
  className = "",
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    const paint = () => {
      frame = 0;
      const vh = window.innerHeight;
      const top = el.getBoundingClientRect().top;
      // Opens across the last half-screen of approach: 0 when the panel's top
      // edge is at the bottom of the viewport, 1 once it has climbed 55% of a
      // screen. Finishing early leaves the section readable while it is still
      // arriving, instead of only at rest.
      const p = Math.min(1, Math.max(0, (vh - top) / (vh * 0.55)));
      el.style.setProperty("--wipe", `${((1 - p) * 100).toFixed(2)}%`);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };

    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section ref={ref} className={`scroll-wipe ${className}`} style={style}>
      {children}
    </section>
  );
}
