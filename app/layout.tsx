import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { CommandPalette } from "@/components/system/command-palette";
import { SearchPanel } from "@/components/system/search-panel";
import { NavHistoryTracker } from "@/components/layout/nav-history-tracker";
import { OnboardingWizard, type OnboardingWizardProps } from "@/components/system/onboarding-wizard";
import { TelegramFailureNote } from "@/components/system/telegram-failure-note";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getSettings } from "@/lib/queries/settings";
import { cn } from "@/lib/utils";
import { getAccounts, getSelectedAccountId } from "@/lib/queries/accounts";
import { asWorkspace, type Workspace } from "@/lib/domain/workspace";
import { asSkin, skinClass, type Skin } from "@/lib/domain/skin";
import {
  appearanceClasses,
  appearanceVars,
  asPanelStyle,
  clampIntensity,
  parseCustomTheme,
  DEFAULT_TINT_INTENSITY,
  DEFAULT_WALLPAPER_OPACITY,
  type CustomTheme,
  type PanelStyle,
} from "@/lib/domain/appearance";

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
  description: "Trade journal & analytics cockpit for Indian markets.",
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
  let skin: Skin = "luxe";
  let intensity = DEFAULT_TINT_INTENSITY;
  let panelStyle: PanelStyle = "luxe";
  let customTheme: CustomTheme | null = null;
  let wallpaper: { storedName: string | null; opacity: number } = { storedName: null, opacity: DEFAULT_WALLPAPER_OPACITY };
  // First-run wizard (v3.7 WS3). `show` is the only field that costs anything
  // when the flag is already stamped — the account read below runs ONLY on an
  // install that has never finished a first run, so the steady state pays for
  // nothing. Inside the same try/catch: an unmigrated DB has no column to read.
  let onboarding: OnboardingWizardProps = { show: false, accountId: null, accountName: "", equityCapital: null, activeCapital: null };
  try {
    const s = getSettings();
    colorblind = s?.colorblindSafe ?? false;
    theme = s?.theme ?? "dark";
    density = s?.density ?? "compact";
    workspace = asWorkspace(s?.workspace);
    skin = asSkin(s?.accentSkin);
    intensity = clampIntensity(s?.tintIntensity);
    panelStyle = asPanelStyle(s?.panelStyle);
    customTheme = parseCustomTheme(s?.customTheme);
    wallpaper = { storedName: s?.wallpaperStoredName ?? null, opacity: clampIntensity(s?.wallpaperOpacity ?? DEFAULT_WALLPAPER_OPACITY) };
    if (s && s.onboardingCompletedAt == null) {
      // The book the wizard names in step 1: the selected account, falling back
      // to the default one. Capital is passed through so "Run setup again" on a
      // configured install prefills instead of blanking it (invariant 6 — a
      // wizard must never overwrite a real capital base with a NULL).
      const all = getAccounts();
      const selected = getSelectedAccountId();
      const a = all.find((x) => x.id === selected) ?? all.find((x) => x.isDefault) ?? all[0];
      onboarding = {
        show: true,
        accountId: a?.id ?? null,
        accountName: a?.name ?? "",
        equityCapital: a?.equityCapital ?? null,
        activeCapital: a?.activeCapital ?? null,
      };
    }
  } catch {
    // DB not migrated yet — render with defaults.
  }
  // Read ONCE, server-side: the sidebar renders it and the command palette is
  // KEYED on it (below), so both halves of the page agree on which book is
  // open even across a switch that only calls router.refresh().
  const selectedAccountId = getSelectedAccountId();
  const themeSide = theme === "light" ? "light" : "dark";
  // Literal --color-* tokens (chrome tint / custom theme / wallpaper) applied
  // inline so they win over every class-level token — and so the chart canvas,
  // which reads them via getComputedStyle, gets parseable colours.
  // See lib/domain/appearance.ts.
  const appearanceStyle = appearanceVars({ skin, theme: themeSide, intensity, panelStyle, customTheme, wallpaper }) as CSSProperties;

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
        // Accent skin (restored in v4 as a coordinated TRIPLE — see
        // lib/domain/skin.ts). Luxe emits no class; it IS the default.
        skinClass(skin),
        // Panel style (panel-flat / panel-soft / panel-glow; luxe = none) and
        // the "wallpaper" flag when a wallpaper file is stored.
        ...appearanceClasses({ panelStyle, wallpaper }),
        density === "comfortable" && "density-comfortable",
      )}
      style={appearanceStyle}
    >
      <body className="min-h-full font-sans antialiased">
        {/* One tooltip provider for the whole app — this is what makes moving
            between adjacent icons show the next tip instantly. */}
        <TooltipProvider>
          <div className="flex h-screen overflow-hidden print:block print:h-auto print:overflow-visible">
            <div className="contents print:hidden">
              <Sidebar accounts={getAccounts().map((a)=>({id:a.id,name:a.name,archived:a.archived}))} selectedAccountId={selectedAccountId} workspace={workspace} />
            </div>
            <main className="flex-1 overflow-y-auto print:overflow-visible">{children}</main>
          </div>
          {/* KEYED ON THE ACCOUNT. The palette is mounted once for the whole
              app, so its search results and session stack would otherwise
              outlive an account switch (the switcher POSTs, then
              router.refresh() — client state is never torn down) and show one
              book's trades under another's name. The key remounts it; the
              accountId prop also stamps the cache key and the session frames,
              so neither half depends on the other. */}
          <CommandPalette key={selectedAccountId} accountId={selectedAccountId} workspace={workspace} />
          {/* The floating search assistant — the SAME engine as the palette,
              on a surface that survives navigation. Keyed and stamped on the
              account for the same reason (invariant 8). */}
          <SearchPanel key={selectedAccountId} accountId={selectedAccountId} />
          {/* Mounted once, so each navigation is recorded exactly once. */}
          <NavHistoryTracker />
          {/* First-run wizard (opens over the dashboard only — it gates on the
              pathname itself) and the durable Telegram-digest failure strip.
              Both live here rather than on a page because both have to survive
              navigation: the wizard so a mid-wizard trip to /import resumes,
              the strip so a failed send is visible from any route. */}
          <OnboardingWizard {...onboarding} />
          <TelegramFailureNote />
        </TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
