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
// PRIMARY forces the money hue to move. In Tape it moves to violet, and
// analytics takes teal.
//
// Measured role-to-role hue separation (the pairing that actually failed):
//
//   Luxe   83° dark / 89° light   ← the palette shipping today, the benchmark
//   Ice    95° / 93°
//   Tape   98° / 97°              ← the widest separation of the three
//
// Every colour in every skin clears WCAG AA on its own canvas (worst 4.81:1 on
// the light canvas #f4f6f9, worst 7.36:1 on dark #05080f).
//
// ── What a skin must never touch ──────────────────────────────────────────
//
// `--color-profit` / `--color-loss`. Those belong to the colourblind-safe mode,
// and a skin that redefined them would silently defeat it.

export const SKINS = ["luxe", "mono", "ice", "tape"] as const;
export type Skin = (typeof SKINS)[number];

export interface SkinMeta {
  id: Skin;
  label: string;
  /** One line for the picker: what the skin actually changes. */
  hint: string;
  /**
   * Which hue carries "money" in this skin. Shown in the picker because in
   * Tape it is NOT gold — and a user who learned "gold = money" from every
   * other screen deserves to be told, not left to work it out.
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
    swatch: { primary: "#2dd4bf", money: "#e5b13d", analytics: "#a78bfa" },
  },
  mono: {
    id: "mono",
    label: "Terminal",
    hint: "The same colours, flat — no panel gradients, no glow.",
    moneyLabel: "gold",
    swatch: { primary: "#2dd4bf", money: "#e5b13d", analytics: "#a78bfa" },
  },
  ice: {
    id: "ice",
    label: "Ice",
    hint: "Blue-led. Analytics moves to orchid so it stays clear of the blue.",
    moneyLabel: "gold",
    swatch: { primary: "#4cc2f1", money: "#e5b13d", analytics: "#e879f9" },
  },
  tape: {
    id: "tape",
    label: "Tape",
    hint: "Amber-led. Money moves to violet — amber is 4° from gold, so gold cannot stay the money colour here.",
    moneyLabel: "violet",
    swatch: { primary: "#e8b006", money: "#c084fc", analytics: "#2dd4bf" },
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
 * `"tape"` and `"ice"` DO map to the new Tape and Ice: a user who once chose
 * amber chose amber, and giving it back is the point of this feature.
 */
export function asSkin(v: unknown): Skin {
  if (v === "terminal") return "luxe";
  return SKINS.includes(v as Skin) ? (v as Skin) : "luxe";
}

/** The `<html>` class for a skin, or null for the default (which needs none). */
export function skinClass(skin: Skin): string | null {
  return skin === "luxe" ? null : `skin-${skin}`;
}
