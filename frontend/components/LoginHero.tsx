import BrandMark from "@/components/BrandMark";

// Marketing panel shown beside the sign-in form on large screens -- brand
// mark, pitch copy, and two capabilities the system actually has (one
// record per patient, every access logged -- see AuditLog on the backend).
// Purely decorative below the fold: a wireframe globe built from a sphere
// cross-section formula (width at ring offset z = 2*sqrt(r^2 - z^2)) rather
// than hand-placed rings.
const GLOBE_RADIUS = 230;
const RING_COUNT = 9;
const MERIDIAN_STEP_DEG = 180 / RING_COUNT;

function Globe() {
  const parallels = Array.from({ length: RING_COUNT }, (_, i) => {
    const z = (i - (RING_COUNT - 1) / 2) * (GLOBE_RADIUS * 2) / RING_COUNT;
    const size = 2 * Math.sqrt(GLOBE_RADIUS ** 2 - z ** 2);
    return { z, size };
  });

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -right-24 top-35 h-115 w-115 opacity-60"
      style={{ perspective: "1000px" }}
    >
      <div
        className="absolute inset-[-18%] rounded-full"
        style={{
          background:
            "radial-gradient(circle at 38% 32%, color-mix(in srgb, var(--accent) 25%, transparent) 0%, transparent 62%)",
        }}
      />
      <style>{`
        @keyframes login-globe-spin {
          from { transform: rotateX(-16deg) rotateZ(-8deg) rotateY(0deg); }
          to { transform: rotateX(-16deg) rotateZ(-8deg) rotateY(360deg); }
        }
      `}</style>
      <div
        className="absolute inset-0"
        style={{ transformStyle: "preserve-3d", animation: "login-globe-spin 34s linear infinite" }}
      >
        {Array.from({ length: RING_COUNT }, (_, i) => (
          <div
            key={`meridian-${i}`}
            className="absolute inset-0 rounded-full border"
            style={{ borderColor: "var(--border)", transform: `rotateY(${i * MERIDIAN_STEP_DEG}deg)` }}
          />
        ))}
        {parallels.map(({ z, size }) => (
          <div
            key={`parallel-${z}`}
            className="absolute left-1/2 top-1/2 rounded-full border"
            style={{
              width: size,
              height: size,
              marginLeft: -size / 2,
              marginTop: -size / 2,
              borderColor: "var(--border)",
              transform: `rotateX(90deg) translateZ(${z}px)`,
            }}
          />
        ))}
      </div>
      <div
        className="absolute inset-0 rounded-full border-[1.5px]"
        style={{
          borderColor: "var(--accent)",
          boxShadow: "inset 0 0 60px -10px color-mix(in srgb, var(--accent) 60%, transparent)",
        }}
      />
    </div>
  );
}

export default function LoginHero() {
  return (
    <div className="relative hidden h-full flex-col overflow-hidden px-16 py-14 lg:flex">
      <Globe />

      <div className="animate-rise-in relative flex items-center gap-2.5">
        <BrandMark />
        <span className="font-serif text-lg text-foreground">Records</span>
      </div>

      <div className="animate-rise-in relative flex max-w-2xl flex-1 flex-col justify-center gap-7">
        <h1 className="font-serif text-6xl font-semibold leading-[1.05] tracking-tight text-foreground">
          Every patient record, one workspace.
        </h1>
        <p className="max-w-lg text-lg leading-relaxed text-muted text-pretty">
          Demographics, contact details, insurance, and clinical history live in one governed
          record per patient. Uploads and edits reconcile into a single chart, and every view or
          edit is logged and attributable.
        </p>
        <div className="flex gap-9 pt-1.5">
          <div className="flex flex-col gap-1.5">
            <span className="font-serif text-3xl text-foreground">Unified</span>
            <span className="text-sm text-muted">Patient records</span>
          </div>
          <div className="w-px bg-linear-to-b from-transparent via-border to-transparent" />
          <div className="flex flex-col gap-1.5">
            <span className="font-serif text-3xl text-foreground">Logged</span>
            <span className="text-sm text-muted">Every access audited</span>
          </div>
        </div>
      </div>
    </div>
  );
}
