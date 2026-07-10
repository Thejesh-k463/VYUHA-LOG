// P2.4 — Behavioral journaling analytics (PURE, no DB/React). Playbook-level
// expectancy and the mistake-cost rollup: the numbers that change behaviour.
//
// "Cost of mistakes" is framed honestly: we report the NET P&L of mistake-tagged
// trades and the EXPECTANCY GAP vs clean trades — we do not claim the loss would
// have been zero without the mistake (counterfactuals aren't observable).

export const MISTAKE_TAGS = [
  "chased_entry",
  "no_stop",
  "moved_stop",
  "oversized",
  "revenge_trade",
  "early_exit",
  "late_exit",
  "against_plan",
  "boredom_trade",
  "averaged_loser",
] as const;
export type MistakeTag = (typeof MISTAKE_TAGS)[number];

export const MISTAKE_LABELS: Record<MistakeTag, string> = {
  chased_entry: "Chased the entry",
  no_stop: "No stop-loss",
  moved_stop: "Moved the stop",
  oversized: "Oversized position",
  revenge_trade: "Revenge trade",
  early_exit: "Exited too early",
  late_exit: "Exited too late",
  against_plan: "Against the plan",
  boredom_trade: "Boredom trade",
  averaged_loser: "Averaged a loser",
};

export const EMOTION_TAGS = [
  "calm",
  "confident",
  "fearful",
  "greedy",
  "fomo",
  "anxious",
  "impatient",
  "tilted",
] as const;
export type EmotionTag = (typeof EMOTION_TAGS)[number];

export const EMOTION_LABELS: Record<EmotionTag, string> = {
  calm: "Calm",
  confident: "Confident",
  fearful: "Fearful",
  greedy: "Greedy",
  fomo: "FOMO",
  anxious: "Anxious",
  impatient: "Impatient",
  tilted: "Tilted",
};

export interface BehaviorTrade {
  id: number;
  isOpen: boolean;
  netPnl: number;
  rMultiple: number | null;
  playbookId: number | null;
  emotionTag: string | null;
  mistakeTags: string[] | null;
}

export interface PlaybookInfo {
  id: number;
  name: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Per-playbook expectancy
// ---------------------------------------------------------------------------

export interface PlaybookStat {
  playbookId: number | null; // null = the "untagged" bucket
  name: string;
  trades: number;
  wins: number;
  winRatePct: number;
  net: number;
  expectancy: number; // avg net ₹ per trade
  avgR: number | null; // mean R-multiple where recorded
}

/** Closed-trade expectancy per playbook, plus an "Untagged" bucket. Sorted by net desc. */
export function playbookStats(trades: BehaviorTrade[], playbooks: PlaybookInfo[]): PlaybookStat[] {
  const closed = trades.filter((t) => !t.isOpen);
  const nameById = new Map(playbooks.map((p) => [p.id, p.name]));
  const groups = new Map<number | null, BehaviorTrade[]>();
  for (const t of closed) {
    const key = t.playbookId != null && nameById.has(t.playbookId) ? t.playbookId : null;
    const g = groups.get(key) ?? [];
    g.push(t);
    groups.set(key, g);
  }
  const stats: PlaybookStat[] = [];
  for (const [id, g] of groups) {
    const wins = g.filter((t) => t.netPnl > 0).length;
    const net = g.reduce((s, t) => s + t.netPnl, 0);
    const rs = g.filter((t) => t.rMultiple != null).map((t) => t.rMultiple!);
    stats.push({
      playbookId: id,
      name: id == null ? "Untagged" : nameById.get(id)!,
      trades: g.length,
      wins,
      winRatePct: r2((wins / g.length) * 100),
      net: r2(net),
      expectancy: r2(net / g.length),
      avgR: rs.length ? r2(rs.reduce((s, x) => s + x, 0) / rs.length) : null,
    });
  }
  return stats.sort((a, b) => b.net - a.net);
}

// ---------------------------------------------------------------------------
// Mistake economics
// ---------------------------------------------------------------------------

export interface MistakeStat {
  tag: string;
  label: string;
  trades: number;
  net: number; // Σ net P&L of trades carrying this tag
  avgNet: number;
}

export interface MistakeReport {
  perTag: MistakeStat[]; // sorted worst (most negative net) first
  mistakeTrades: number; // closed trades with ≥1 mistake tag
  cleanTrades: number;
  mistakeNet: number; // Σ net over mistake-tagged trades
  cleanNet: number;
  mistakeExpectancy: number; // avg net per mistake-tagged trade
  cleanExpectancy: number;
  expectancyGap: number; // clean − mistake (₹/trade you give up when you break rules)
}

/** Roll up mistake tags over CLOSED trades. A trade with 2 tags counts once in the
 *  headline (mistakeTrades/mistakeNet) but appears under both tags in perTag. */
export function mistakeReport(trades: BehaviorTrade[]): MistakeReport {
  const closed = trades.filter((t) => !t.isOpen);
  const tagged = closed.filter((t) => (t.mistakeTags?.length ?? 0) > 0);
  const clean = closed.filter((t) => (t.mistakeTags?.length ?? 0) === 0);

  const byTag = new Map<string, BehaviorTrade[]>();
  for (const t of tagged) {
    for (const tag of new Set(t.mistakeTags!)) {
      const g = byTag.get(tag) ?? [];
      g.push(t);
      byTag.set(tag, g);
    }
  }
  const perTag: MistakeStat[] = [...byTag.entries()]
    .map(([tag, g]) => {
      const net = g.reduce((s, t) => s + t.netPnl, 0);
      return {
        tag,
        label: MISTAKE_LABELS[tag as MistakeTag] ?? tag,
        trades: g.length,
        net: r2(net),
        avgNet: r2(net / g.length),
      };
    })
    .sort((a, b) => a.net - b.net);

  const mistakeNet = tagged.reduce((s, t) => s + t.netPnl, 0);
  const cleanNet = clean.reduce((s, t) => s + t.netPnl, 0);
  const mistakeExpectancy = tagged.length ? mistakeNet / tagged.length : 0;
  const cleanExpectancy = clean.length ? cleanNet / clean.length : 0;
  return {
    perTag,
    mistakeTrades: tagged.length,
    cleanTrades: clean.length,
    mistakeNet: r2(mistakeNet),
    cleanNet: r2(cleanNet),
    mistakeExpectancy: r2(mistakeExpectancy),
    cleanExpectancy: r2(cleanExpectancy),
    expectancyGap: r2(cleanExpectancy - mistakeExpectancy),
  };
}

// ---------------------------------------------------------------------------
// Emotion breakdown (same shape as mistakes, single tag per trade)
// ---------------------------------------------------------------------------

export interface EmotionStat {
  tag: string;
  label: string;
  trades: number;
  net: number;
  winRatePct: number;
}

export function emotionReport(trades: BehaviorTrade[]): EmotionStat[] {
  const closed = trades.filter((t) => !t.isOpen && t.emotionTag);
  const byTag = new Map<string, BehaviorTrade[]>();
  for (const t of closed) {
    const g = byTag.get(t.emotionTag!) ?? [];
    g.push(t);
    byTag.set(t.emotionTag!, g);
  }
  return [...byTag.entries()]
    .map(([tag, g]) => ({
      tag,
      label: EMOTION_LABELS[tag as EmotionTag] ?? tag,
      trades: g.length,
      net: r2(g.reduce((s, t) => s + t.netPnl, 0)),
      winRatePct: r2((g.filter((t) => t.netPnl > 0).length / g.length) * 100),
    }))
    .sort((a, b) => b.trades - a.trades);
}
