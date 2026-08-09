import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { CommandPalette } from "@/components/system/command-palette";
import { Toaster } from "@/components/ui/toaster";
import { getSettings } from "@/lib/queries/settings";
import { cn } from "@/lib/utils";
import { getAccounts, getSelectedAccountId } from "@/lib/queries/accounts";
import { asWorkspace, type Workspace } from "@/lib/domain/workspace";

// C1 typography — self-hosted at build time (next/font), so the shipped app
// stays fully offline. Inter carries the UI; JetBrains Mono carries every
// number (wired to .tabular-nums/tables in globals.css) for the terminal look;
// Space Grotesk (v3) carries page/panel titles and the wordmark via
// --font-display. Only 600/700 are pulled — the display face is never used for
// body copy, so the lighter weights would be dead bytes in the bundle.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jbMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jb", display: "swap" });
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Vyuha — Trade Journal",
  description: "Local-first trade journal & analytics cockpit for Indian markets.",
  // app/favicon.ico is picked up by convention; these add the retina PNG and
  // the iOS home-screen icon. All local files — the app must run offline.
  icons: {
    icon: [{ url: "/brand/vyuha-512.png", type: "image/png", sizes: "512x512" }],
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  let colorblind = false;
  let theme = "dark";
  let density = "compact";
  let workspace: Workspace = "both";
  try {
    const s = getSettings();
    colorblind = s?.colorblindSafe ?? false;
    theme = s?.theme ?? "dark";
    density = s?.density ?? "compact";
    workspace = asWorkspace(s?.workspace);
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
        spaceGrotesk.variable,
        theme === "light" && "theme-light",
        colorblind && "cb-safe",
        // settings.accentSkin is deliberately NOT read here any more. The Tape
        // and Ice skins were retired in v3 (see app/globals.css); the column
        // still holds 'tape'/'ice' for anyone who set them, and those rows now
        // simply render as Terminal rather than erroring or being migrated.
        density === "comfortable" && "density-comfortable",
      )}
    >
      <body className="min-h-full font-sans antialiased">
        <div className="flex h-screen overflow-hidden print:block print:h-auto print:overflow-visible">
          <div className="contents print:hidden">
            <Sidebar accounts={getAccounts().map((a)=>({id:a.id,name:a.name,archived:a.archived}))} selectedAccountId={getSelectedAccountId()} workspace={workspace} />
          </div>
          <main className="flex-1 overflow-y-auto print:overflow-visible">{children}</main>
        </div>
        <CommandPalette workspace={workspace} />
        <Toaster />
      </body>
    </html>
  );
}
