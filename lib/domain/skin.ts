// ACCENT SKINS (PURE, no DB/React).
//
// A skin swaps a whole TRIPLE — the interactive colour, the money colour and
// the analytics colour — never just the primary. That is the difference
// between this and the C8 skins retired in v3, and it is the entire reason
// skins can exist again.
//
// ── Why the triple, measured ──────────────────────────────────────────────
//
// v3 gave gold a fixed meaning (money) and violet a fixed meaning (analytics).
// The old Tape skin recoloured only the primary, to amber — and amber sits at
// hue 45° while gold sits at 41°. Four degrees apart: the colour you click and
// the colour that means "this cost you money" became the same colour. That is
// why skins were pulled.
//
// It is not a fixable mapping. Gold owns 41°, loss red owns 352°, profit green
// owns 157°; sweeping every warm hue from 10° to 75° shows none of them clears
// all three by a readable margin (best case 34°, a yellow-green). So a warm
// PRIMARY forces the money hue to move. In Tape, Lime and Ember it moves to
// violet, and analytics takes teal.
//
// ── The roster, and why Ice and Royal were retired ────────────────────────
//
// Ice (#4cc2f1 + orchid analytics) and Sapphire (#7196ff + orchid analytics)
// differed by one hex, and Royal (#a78bfa primary) reused Luxe's analytics
// violet as its primary and Aurora's cyan/teal family as its analytics — so
// with only ~9 accent tokens recoloured, three of seven skins were near-
// duplicates. Both were removed; `asSkin` maps a stored "ice"/"royal" to
// Sapphire (the closest survivor) so a restored backup never 400s or falls
// back to Luxe by surprise. Lime, Rose and Ember replaced them, and every
// coloured skin now also tints the surfaces (canvas, card-top, border) so two
// skins can no longer share a screen by hex.
//
// Role-to-role hue separation and the WCAG floor, per skin (dark / light):
//
//   Luxe      83° / 89°    primary #2dd4bf   money gold    analytics violet
//   Tape      98° / 97°    primary #e8b006   money VIOLET  analytics teal
//   Sapphire  68° / 70°    primary #7196ff   money gold    analytics orchid
//   Aurora   109° / 105°   primary #e879f9   money gold    analytics teal
//   Lime      —            primary #a3e635   money VIOLET  analytics teal
//   Rose      —            primary #f472b6   money gold    analytics violet
//   Ember     —            primary #fb923c   money VIOLET  analytics teal
//
// Every colour in every skin clears WCAG AA on its own canvas (worst 4.81:1 on
// the light canvas #f4f6f9, worst 7.16:1 on dark #05080f). Measured for the
// v2.99.96 additions and retunes: light primaries Lime #46700f 5.41:1, Rose
// #be185d 5.58:1, Ember #b93e0c 5.16:1; light teal #0d7269 5.35:1, light
// orchid #b31fc4 4.96:1; dark primaries Lime 13.29:1, Rose 7.57:1, Ember 8.85:1.
//
// tests/skin.test.ts asserts DISTINCTNESS: no two coloured skins share a
// --color-primary, and no skin's primary equals another skin's analytics hue,
// in either theme.
//
// ── What a skin must never touch ──────────────────────────────────────────
//
// `--color-profit` / `--color-loss`. Those belong to the colourblind-safe mode,
// and a skin that redefined them would silently defeat it.

// "custom" (last) has NO CSS block: its tokens are the user's own hexes, derived
// in lib/domain/appearance.ts and applied inline on <html>. tests/skin.test.ts
// exempts it from the CSS-block assertions for that reason.
export const SKINS = ["luxe", "mono", "tape", "sapphire", "aurora", "lime", "rose", "ember", "custom"] as const;
export type Skin = (typeof SKINS)[number];

export interface SkinMeta {
  id: Skin;
  label: string;
  /** One line for the picker: what the skin actually changes. */
  hint: string;
  /**
   * Which hue carries "money" in this skin. Shown in the picker because in
   * Tape, Lime and Ember it is NOT gold — and a user who learned "gold = money"
   * from every other screen deserves to be told, not left to work it out.
   */
  moneyLabel: string;
  /** Swatch colours for the picker, dark-theme values. */
  swatch: { primary: string; money: string; analytics: string };
}

export const SKIN_META: Record<Skin, SkinMeta> = {
  luxe: {
    id: "luxe",
    label: "Luxe",
    hint: "Teal, gold and violet on gradient panels. The default.",
    moneyLabel: "gold",
    swatch: { primary: "#2dd4bf", money: "#f0b429", analytics: "#a78bfa" },
  },
  mono: {
    id: "mono",
    label: "Terminal",
    hint: "The same colours, flat — no panel gradients, no glow.",
    moneyLabel: "gold",
    swatch: { primary: "#2dd4bf", money: "#f0b429", analytics: "#a78bfa" },
  },
  tape: {
    id: "tape",
    label: "Tape",
    hint: "Amber-led. Money moves to violet — amber is 4° from gold, so gold cannot stay the money colour here.",
    moneyLabel: "violet",
    swatch: { primary: "#e8b006", money: "#c084fc", analytics: "#5eead4" },
  },
  sapphire: {
    id: "sapphire",
    label: "Sapphire",
    hint: "Electric indigo-blue with orchid analytics, on a cool navy canvas.",
    moneyLabel: "gold",
    swatch: { primary: "#7196ff", money: "#f0b429", analytics: "#f0abfc" },
  },
  aurora: {
    id: "aurora",
    label: "Aurora",
    hint: "Fuchsia-led, the most vibrant of the set. Analytics returns to teal.",
    moneyLabel: "gold",
    swatch: { primary: "#e879f9", money: "#f0b429", analytics: "#5eead4" },
  },
  lime: {
    id: "lime",
    label: "Lime",
    hint: "Lime-led. Money moves to violet — lime sits too close to gold to keep it — and analytics goes teal.",
    moneyLabel: "violet",
    swatch: { primary: "#a3e635", money: "#c084fc", analytics: "#5eead4" },
  },
  rose: {
    id: "rose",
    label: "Rose",
    hint: "Hot-pink-led with violet analytics. Gold stays the money colour.",
    moneyLabel: "gold",
    swatch: { primary: "#f472b6", money: "#f0b429", analytics: "#a78bfa" },
  },
  ember: {
    id: "ember",
    label: "Ember",
    hint: "Orange-led. Like Tape, money moves to violet and analytics goes teal — orange cannot share a screen with gold.",
    moneyLabel: "violet",
    swatch: { primary: "#fb923c", money: "#c084fc", analytics: "#5eead4" },
  },
  custom: {
    id: "custom",
    label: "Custom",
    hint: "Your own colours — build it below.",
    moneyLabel: "gold",
    // Luxe-derived, the same values as DEFAULT_CUSTOM_THEME.dark in
    // lib/domain/appearance.ts (kept literal here so skin.ts stays leaf-level).
    swatch: { primary: "#2dd4bf", money: "#f0b429", analytics: "#a78bfa" },
  },
};

/**
 * Narrow an untrusted value (DB column, restored backup, query param) to a Skin.
 *
 * `"terminal"` maps to LUXE, not to the new flat `"mono"`. That string is the
 * column default on every install ever made, and it has rendered as the
 * gradient look since v3 — so treating it as "the flat skin" would silently
 * restyle every existing user, including anyone restoring a pre-v3 backup.
 * The flat skin therefore got a new id rather than reusing the old word.
 *
 * `"ice"` and `"royal"` (retired — see header) map to SAPPHIRE, the nearest
 * surviving blue/violet skin, so a stored preference degrades to the closest
 * look rather than snapping back to the default.
 *
 * `"tape"` DOES map to Tape: a user who once chose amber chose amber, and
 * giving it back is the point of this feature.
 */
export function asSkin(v: unknown): Skin {
  if (v === "terminal") return "luxe";
  if (v === "ice" || v === "royal") return "sapphire";
  return SKINS.includes(v as Skin) ? (v as Skin) : "luxe";
}

/** The `<html>` class for a skin, or null for the default (which needs none). */
export function skinClass(skin: Skin): string | null {
  return skin === "luxe" ? null : `skin-${skin}`;
}
