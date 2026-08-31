// Two-square mark, shared by the login hero and the dashboard sidebar --
// same shape as app/icon.svg (the browser tab favicon), inlined here so it
// picks up the current theme's --accent instead of a fixed color.
export default function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="5" fill="var(--accent)" opacity="0.42" />
      <rect x="12" y="12" width="16" height="16" rx="5" fill="var(--accent)" />
    </svg>
  );
}
