/**
 * The hero backdrop.
 *
 * Drawn rather than photographed: every mark is a price series, so the art is
 * the product's own subject matter instead of decoration bought in. Three
 * depths of candle field rise from the bottom-right and hang from the top-right
 * the way a canopy does, a price path rides the crest of the front field, and
 * a few tick marks drift off into the clear space where the headline sits.
 *
 * Deterministic on purpose. A seeded generator means the server and the client
 * draw the identical figure, so there is no hydration mismatch and no flash of
 * a different skyline — and the composition can be tuned like a fixed drawing
 * rather than re-rolled on every reload.
 */

const W = 1440;
const H = 900;

/** Seeded LCG. Same constants as Numerical Recipes; any stable source would do. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** A bounded random walk — a price series, which is what every field here is. */
function walk(seed: number, n: number, start: number, vol: number, lo: number, hi: number) {
  const r = rng(seed);
  let v = start;
  return Array.from({ length: n }, () => {
    v = Math.min(hi, Math.max(lo, v + (r() - 0.5) * vol));
    return v;
  });
}

type FieldProps = {
  seed: number;
  /** Bars across the field. More bars, finer engraving. */
  count: number;
  x0: number;
  barW: number;
  gap: number;
  /** Tallest a bar may reach, in user units. */
  span: number;
  /** Where the bars stand — the floor they grow up from, or hang down from. */
  base: number;
  hanging?: boolean;
  opacity: number;
  vol: number;
  start: number;
};

/**
 * One depth of the candle field, as a single path.
 *
 * Every bar is a subpath rather than its own `<rect>`: 150 elements per field
 * would be 600 nodes in the document for a backdrop nobody clicks. It also
 * makes the ink gradient behave — one element means one fade across the whole
 * field, instead of each bar fading over its own height and short bars ending
 * up as pale as tall ones.
 */
function Field({ seed, count, x0, barW, gap, span, base, hanging, opacity, vol, start }: FieldProps) {
  const d = walk(seed, count, start, vol, 0.06, 1)
    .map((v, i) => {
      const h = (v * span).toFixed(1);
      const x = (x0 + i * (barW + gap)).toFixed(1);
      const top = hanging ? base : base - v * span;
      return `M${x},${top.toFixed(1)}h${barW}v${h}h-${barW}z`;
    })
    .join("");
  return <path d={d} opacity={opacity} fill={hanging ? "url(#heroInkTop)" : "url(#heroInk)"} />;
}

/**
 * The line riding the crest of the front field. Drawn from the same walk that
 * sets those bar heights, so it reads as the series they belong to rather than
 * as a second unrelated shape laid over them.
 */
function Crest({ seed, count, x0, step, span, base, vol, start }: {
  seed: number; count: number; x0: number; step: number; span: number; base: number; vol: number; start: number;
}) {
  const series = walk(seed, count, start, vol, 0.06, 1);
  const d = series
    .map((v, i) => `${i === 0 ? "M" : "L"}${(x0 + i * step).toFixed(1)},${(base - v * span).toFixed(1)}`)
    .join(" ");
  return <path d={d} fill="none" stroke="#1e4fd8" strokeWidth="2" strokeOpacity=".34" strokeLinejoin="round" />;
}

/**
 * The marks drifting out over the empty left half.
 *
 * Small open chevrons — a tick up, a tick down — scattered where the field has
 * thinned to nothing, so the clear space beside the headline is not dead space.
 */
function Drift() {
  const r = rng(80531);
  return (
    <g stroke="#1e4fd8" strokeOpacity=".3" strokeWidth="1.6" fill="none" strokeLinecap="round">
      {Array.from({ length: 22 }, (_, i) => {
        const x = 40 + r() * 720;
        const y = 90 + r() * 640;
        const s = 5 + r() * 7;
        const down = r() > 0.55;
        return (
          <path
            key={i}
            d={down ? `M${x},${y} l${s},${s * 0.62} l${s},${-s * 0.62}` : `M${x},${y} l${s},${-s * 0.62} l${s},${s * 0.62}`}
            opacity={0.35 + r() * 0.5}
          />
        );
      })}
    </g>
  );
}

export default function HeroArt() {
  return (
    <svg
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMaxYMax slice"
      aria-hidden
      focusable="false"
    >
      <defs>
        {/* Ink for the bars: saturated at the floor, dissolving toward the
            crest, so a field ends in haze rather than on a hard edge. Measured
            in user space, not per-element, so every field fades on the same
            slope regardless of how tall its own bars happen to be. */}
        <linearGradient id="heroInk" gradientUnits="userSpaceOnUse" x1="0" y1={H} x2="0" y2={H - 620}>
          <stop offset="0%" stopColor="#1e4fd8" stopOpacity=".85" />
          <stop offset="55%" stopColor="#3b6ae8" stopOpacity=".42" />
          <stop offset="100%" stopColor="#6f93f0" stopOpacity="0" />
        </linearGradient>
        {/* The same ink, inverted, for the canopy hanging off the top edge. */}
        <linearGradient id="heroInkTop" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="320">
          <stop offset="0%" stopColor="#1e4fd8" stopOpacity=".7" />
          <stop offset="55%" stopColor="#3b6ae8" stopOpacity=".34" />
          <stop offset="100%" stopColor="#6f93f0" stopOpacity="0" />
        </linearGradient>

        {/* The composition mask. Dense at the bottom-right corner, gone by the
            centre — this is what leaves the headline on clean paper. */}
        <radialGradient id="heroFalloff" cx="1" cy="1" r="1.15">
          <stop offset="0%" stopColor="#fff" stopOpacity="1" />
          <stop offset="46%" stopColor="#fff" stopOpacity=".72" />
          <stop offset="78%" stopColor="#fff" stopOpacity=".16" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id="heroMask">
          <rect width={W} height={H} fill="url(#heroFalloff)" />
        </mask>

        {/* The drift gets the opposite falloff: it lives only where the field
            has already faded, which is the whole point of it. */}
        <linearGradient id="driftFalloff" x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0%" stopColor="#fff" stopOpacity=".9" />
          <stop offset="62%" stopColor="#fff" stopOpacity=".25" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="driftMask">
          <rect width={W} height={H} fill="url(#driftFalloff)" />
        </mask>
      </defs>

      <g mask="url(#heroMask)">
        {/* Back: broad and faint, the horizon. */}
        <Field seed={9311} count={64} x0={300} barW={9} gap={9} span={430} base={H} opacity={0.3} vol={0.16} start={0.3} />
        {/* The canopy, hanging from the top-right corner. */}
        <Field seed={4517} count={52} x0={620} barW={7} gap={8.5} span={300} base={0} hanging opacity={0.24} vol={0.2} start={0.35} />
        {/* Middle. */}
        <Field seed={2207} count={112} x0={420} barW={5} gap={4.6} span={520} base={H} opacity={0.42} vol={0.13} start={0.32} />
        {/* Front: finest bars, densest ink, only the bottom-right corner. */}
        <Field seed={7717} count={168} x0={560} barW={2.6} gap={2.6} span={610} base={H} opacity={0.6} vol={0.1} start={0.28} />
        <Crest seed={7717} count={168} x0={561} step={5.2} span={610} base={H} vol={0.1} start={0.28} />
      </g>

      <g mask="url(#driftMask)">
        <Drift />
      </g>
    </svg>
  );
}
