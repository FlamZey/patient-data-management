// Shared circular loading spinner -- used inline on busy buttons (see
// LoginForm) and by RouteLoadingIndicator for route transitions, so the
// same "spinning ring" visual means "busy" everywhere in the app.
type SpinnerSize = "xs" | "sm" | "md";

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  xs: "h-3.5 w-3.5",
  sm: "h-4 w-4",
  md: "h-5 w-5",
};

interface SpinnerProps {
  size?: SpinnerSize; // defaults to "sm"
  className?: string; // e.g. text-color utilities, since the spinner draws in currentColor
}

export default function Spinner({ size = "sm", className = "" }: SpinnerProps) {
  return (
    <svg
      className={`animate-spin ${SIZE_CLASSES[size]} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
