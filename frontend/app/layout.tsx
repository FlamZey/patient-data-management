// Root layout -- loads fonts and wraps every page in AuthProvider.
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";
import OverlayScrollbar from "@/components/OverlayScrollbar";
import RouteLoadingIndicator from "@/components/RouteLoadingIndicator";
import { AuthProvider } from "@/lib/auth-context";

// Single sans font for both headings and body text.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
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

export const viewport: Viewport = {
  themeColor: "#161826",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable} h-full antialiased`}>
      <body id="page-scroll-region" className="min-h-full flex flex-col">
        <OverlayScrollbar />
        <RouteLoadingIndicator />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
