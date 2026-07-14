import { describe, expect, it } from "vitest";
import { PRESET_PLAYBOOKS, presetCategories } from "../lib/domain/preset-playbooks";

describe("PRESET_PLAYBOOKS data shape", () => {
  it("has a substantial, unique-named library", () => {
    expect(PRESET_PLAYBOOKS.length).toBeGreaterThanOrEqual(20);
    const names = PRESET_PLAYBOOKS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every preset is a complete, usable form pre-fill", () => {
    for (const p of PRESET_PLAYBOOKS) {
      expect(p.name.trim().length, p.name).toBeGreaterThan(0);
      expect(p.category.trim().length, p.name).toBeGreaterThan(0);
      expect(p.description.trim().length, p.name).toBeGreaterThan(0);
      // The playbook form's rules textarea is one rule per line — presets must
      // arrive as clean single-line rules, at least 3 per setup.
      expect(p.rules.length, p.name).toBeGreaterThanOrEqual(3);
      for (const r of p.rules) {
        expect(r.trim().length, `${p.name}: empty rule`).toBeGreaterThan(0);
        expect(r.includes("\n"), `${p.name}: multi-line rule`).toBe(false);
      }
    }
  });

  it("covers multiple distinct trading ecosystems", () => {
    const cats = presetCategories();
    expect(cats.length).toBeGreaterThanOrEqual(5);
    // Every preset's category appears in the ordered category list
    for (const p of PRESET_PLAYBOOKS) expect(cats).toContain(p.category);
  });
});
