"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

// Shared button used everywhere instead of a raw <button>, so color/size
// stay consistent across the app.
type ButtonVariant = "primary" | "secondary" | "danger" | "accent-outline" | "danger-outline";
type ButtonSize = "xs" | "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant; // color/emphasis, defaults to "primary"
  size?: ButtonSize; // padding/text size, defaults to "md"
  fullWidth?: boolean; // stretches to fill its container
}

// Color, weight, and emphasis live on the variant; padding and text size
// live on the size -- kept independent so e.g. a "secondary" button can be
// xs (table chip) or md (dialog action) without duplicating the palette.
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground hover:bg-accent-hover font-semibold",
  secondary: "border border-border text-foreground hover:bg-surface-hover font-medium",
  danger: "bg-danger text-foreground hover:opacity-90 font-semibold",
  "accent-outline": "border border-accent/40 text-accent hover:bg-accent/10 font-medium",
  "danger-outline": "border border-danger/40 text-danger hover:bg-danger/10 font-medium",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: "px-2.5 py-1 text-xs",
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-3 text-base",
};

// forwardRef so callers (e.g. autoFocus-style DOM access) can still reach
// the underlying <button>.
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", fullWidth = false, className = "", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        fullWidth ? "w-full" : "",
        className, // caller-supplied overrides, applied last so they win
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
});

export default Button;
