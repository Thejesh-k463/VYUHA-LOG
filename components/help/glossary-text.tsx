"use client";

import * as React from "react";
import { GLOSSARY } from "@/lib/domain/glossary";
import { splitGlossary, type GlossaryTerm as Term } from "@/lib/domain/glossary-split";
import { GlossaryTerm } from "./glossary-term";

/**
 * A paragraph with its glossary words linked: the FIRST whole-word,
 * case-insensitive occurrence of each term (or alias) becomes a <GlossaryTerm>,
 * every other character renders as it was. The cutting is the pure
 * `splitGlossary` (lib/domain/glossary-split.ts, unit-tested); this only maps
 * its pieces to elements.
 */
export function GlossaryText({ text, terms = GLOSSARY }: { text: string; terms?: readonly Term[] }) {
  const pieces = React.useMemo(() => splitGlossary(text, terms), [text, terms]);
  return (
    <>
      {pieces.map((p, i) =>
        typeof p === "string" ? (
          <React.Fragment key={i}>{p}</React.Fragment>
        ) : (
          <GlossaryTerm key={i} text={p.text} term={p.term} />
        ),
      )}
    </>
  );
}
