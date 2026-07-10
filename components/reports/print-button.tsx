"use client";

import { Button } from "@/components/ui/button";
import { Printer } from "lucide-react";

/** Opens the browser print dialog — "Save as PDF" produces the shareable report. */
export function PrintButton() {
  return (
    <Button size="sm" onClick={() => window.print()} className="print:hidden">
      <Printer className="size-4" /> Print / Save as PDF
    </Button>
  );
}
