"use client";

import { useEffect, useRef } from "react";

/**
 * Moves its children slower than the page scrolls.
 *
 * Writes the transform straight onto the node inside a rAF, rather than holding
 * the scroll offset in state: this sits inside the landing page, so a setState
 * per scroll event would re-render every section on the page sixty times a
 * second to move one backdrop.
 *
 * The element needs slack above and below whatever it fills, or the translation
 * drags its edge into view — see the sizing on the hero's wrapper.
 */
export default function Parallax({
  children,
  /** Fraction of the scroll distance to travel. 0 is pinned, 1 is normal flow. */
  speed = 0.12,
  className,
}: {
  children: React.ReactNode;
  speed?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    const paint = () => {
      frame = 0;
      // Only worth moving while the hero is still on screen.
      const y = window.scrollY;
      if (y > window.innerHeight * 1.2) return;
      el.style.transform = `translate3d(0, ${(y * speed).toFixed(1)}px, 0)`;
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };

    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [speed]);

  return (
    <div ref={ref} className={className} style={{ willChange: "transform" }}>
      {children}
    </div>
  );
}
