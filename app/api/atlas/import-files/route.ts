import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { applyBhavcopyMtm } from "@/lib/import/mtm-bhavcopy";
import { guardReadable } from "@/lib/import/parse-guard";
import { unzipSingleCsv } from "@/lib/jobs/auto-mtm";
import { CROSS_ORIGIN_MESSAGE, isSameOrigin } from "../origin";

/**
 * `POST /api/atlas/import-files` — the one-time FILE DROP (research answer Q43).
 *
 * ZERO NETWORK. This is the other half of the backfill: the owner (and anyone
 * who already keeps an archive) drops bhavcopy files straight off disk and
 * they land in `price_history` through the SAME applier the daily download
 * uses, so a backfilled bar and a dropped bar are byte-identical facts. It
 * therefore needs no consent flag — nothing leaves the machine — and it works
 * on a laptop that has never been online.
 *
 * Accepts the two shapes NSE publishes: the UDiFF `.csv.zip` and a plain
 * `.csv` (either UDiFF or the legacy `sec_bhavdata_full`). `parseBhavcopy`
 * auto-detects which, so the user does not have to say.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per FILE, matching the import route's practical ceiling. A UDiFF zip is
 *  ~200 KB and its CSV ~600 KB, so this is three orders of magnitude of head
 *  room and still refuses a dropped video. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** One drop at a time. 252 files is the whole year; more is a mistake. */
export const MAX_FILES = 300;

/** ZIP local-file-header signature. An `.xlsx` is also a zip, which is exactly
 *  why `guardReadable` cannot be the check for this branch: its probe opens
 *  the bytes as a workbook, and the answer for a bhavcopy archive would be
 *  right or wrong for the wrong reason. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export interface ImportFileOutcome {
  name: string;
  ok: boolean;
  date: string | null;
  format: string | null;
  rows: number;
  message: string;
}

function textFrom(name: string, bytes: Buffer): { text: string } | { error: string } {
  if (bytes.subarray(0, 4).equals(ZIP_MAGIC)) {
    const csv = unzipSingleCsv(bytes);
    if (!csv) return { error: "This .zip is not a single plain bhavcopy CSV Vyuha can read." };
    return { text: csv };
  }
  // Not a zip: hand the bytes to the shared byte-level guard, which turns an
  // image or an encrypted workbook into copy the user can act on.
  const guard = guardReadable(name, bytes);
  if (!guard.ok) return { error: guard.error };
  return { text: bytes.toString("utf8") };
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: CROSS_ORIGIN_MESSAGE }, { status: 403 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Too many files at once (max ${MAX_FILES}).` }, { status: 413 });
  }

  const results: ImportFileOutcome[] = [];
  let rows = 0;
  let applied = 0;

  for (const file of files) {
    const empty = { name: file.name, date: null, format: null, rows: 0 };
    if (file.size > MAX_FILE_BYTES) {
      results.push({ ...empty, ok: false, message: `Larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB — skipped.` });
      continue;
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const decoded = textFrom(file.name, bytes);
    if ("error" in decoded) {
      results.push({ ...empty, ok: false, message: decoded.error });
      continue;
    }
    const result = applyBhavcopyMtm(decoded.text);
    rows += result.historyRows;
    if (result.ok) applied++;
    results.push({
      name: file.name,
      ok: result.ok,
      date: result.date,
      format: result.format,
      rows: result.historyRows,
      message: result.ok ? `${result.historyRows} bars saved.` : result.message,
    });
  }

  if (rows > 0) {
    for (const p of ["/atlas", "/risk", "/equity", "/active"]) revalidatePath(p);
  }

  return NextResponse.json({
    ok: true,
    files: files.length,
    applied,
    rows,
    results,
  });
}
