import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { CommandPalette } from "@/components/system/command-palette";
import { Toaster } from "@/components/ui/toaster";
import { getSettings } from "@/lib/queries/settings";
import { cn } from "@/lib/utils";

// C1 typography — self-hosted at build time (next/font), so the shipped app
// stays fully offline. Inter carries the UI; JetBrains Mono carries every
// number (wired to .tabular-nums/tables in globals.css) for the terminal look.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jbMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jb", display: "swap" });

export const metadata: Metadata = {
  title: "Vyuha — Trade Journal",
  description: "Local-first trade journal & analytics cockpit for Indian markets.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  let colorblind = false;
  let theme = "dark";
  let skin = "terminal";
  try {
    const s = getSettings();
    colorblind = s?.colorblindSafe ?? false;
    theme = s?.theme ?? "dark";
    skin = s?.accentSkin ?? "terminal";
  } catch {
    // DB not migrated yet — render with defaults.
  }

  return (
    <html
      lang="en"
      className={cn(
        "h-full",
        inter.variable,
        jbMono.variable,
        theme === "light" && "theme-light",
        colorblind && "cb-safe",
        skin !== "terminal" && `skin-${skin}`,
      )}
    >
      <body className="min-h-full font-sans antialiased">
        <div className="flex h-screen overflow-hidden print:block print:h-auto print:overflow-visible">
          <div className="contents print:hidden">
            <Sidebar />
          </div>
          <main className="flex-1 overflow-y-auto print:overflow-visible">{children}</main>
        </div>
        <CommandPalette />
        <Toaster />
      </body>
    </html>
  );
}
