/**
 * The decay chart's height, in a module of its own: the server-rendered card reserves
 * this much room (`LazyMount minHeight`) and the client chart draws at it. It cannot
 * live in `decay-chart.tsx` — a VALUE imported from a "use client" module into a server
 * component becomes a throwing client reference (`tests/client-value-imports.test.ts`).
 */
export const DECAY_CHART_HEIGHT = 64;
