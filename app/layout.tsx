import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { CommandPalette } from "@/components/system/command-palette";
import { getSettings } from "@/lib/queries/settings";
import { cn } from "@/lib/utils";

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
  try {
    const s = getSettings();
    colorblind = s?.colorblindSafe ?? false;
    theme = s?.theme ?? "dark";
  } catch {
    // DB not migrated yet — render with defaults.
  }

  return (
    <html
      lang="en"
      className={cn("h-full", theme === "light" && "theme-light", colorblind && "cb-safe")}
    >
      <body
        className="min-h-full font-sans antialiased"
        style={{
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <div className="flex h-screen overflow-hidden print:block print:h-auto print:overflow-visible">
          <div className="contents print:hidden">
            <Sidebar />
          </div>
          <main className="flex-1 overflow-y-auto print:overflow-visible">{children}</main>
        </div>
        <CommandPalette />
      </body>
    </html>
  );
}
