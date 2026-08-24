// Root layout -- loads fonts and wraps every page in AuthProvider.
import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Public_Sans } from "next/font/google";
import "./globals.css";
import OverlayScrollbar from "@/components/OverlayScrollbar";
import RouteLoadingIndicator from "@/components/RouteLoadingIndicator";
import { AuthProvider } from "@/lib/auth-context";

// Serif font for headings.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

// Sans-serif font for body text.
const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Monospace font for ids, codes, and labels.
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Patient Records",
  description: "Role-based patient data management",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${publicSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body id="page-scroll-region" className="min-h-full flex flex-col">
        <OverlayScrollbar />
        <RouteLoadingIndicator />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
