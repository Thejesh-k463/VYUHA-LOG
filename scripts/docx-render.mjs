#!/usr/bin/env node
/**
 * The shared OOXML renderer behind the client-package Word guides
 * (scripts/build-openalgo-docx.mjs and scripts/build-broker-api-docx.mjs).
 *
 * Pure Node, zero dependencies: the OOXML parts are emitted as strings and
 * zipped with the same store/deflate writer as scripts/build-client-package.mjs.
 * Extracted from build-openalgo-docx.mjs on 2026-09-21 when the second guide
 * arrived — one renderer, two CONTENT arrays, rather than 150 duplicated lines
 * of zip and OOXML that would drift.
 *
 * Block types: title, sub, h1, h2, p, li (bullet), step (numbered look),
 * code (monospace block, array of lines), note (emphasised paragraph),
 * table ({ header: [..], rows: [[..], ..] }).
 * Inline text is a string or an array of runs: "plain", { b: "bold" },
 * { c: "code/mono" }.
 */
import { deflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One run. props: { b, mono, size (half-points), color } */
function run(text, { b = false, mono = false, size = null, color = null } = {}) {
  const pr = [
    mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : "",
    b ? "<w:b/>" : "",
    color ? `<w:color w:val="${color}"/>` : "",
    size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : "",
  ].join("");
  return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** Inline content (string | array of runs) → run XML, with base props. */
function runs(x, base = {}) {
  const parts = Array.isArray(x) ? x : [x];
  return parts
    .map((part) => {
      if (typeof part === "string") return run(part, base);
      if (part.b !== undefined) return run(part.b, { ...base, b: true });
      if (part.c !== undefined) return run(part.c, { ...base, mono: true, color: "0E7569" });
      throw new Error(`Unknown inline run: ${JSON.stringify(part)}`);
    })
    .join("");
}

/** One paragraph. pPr fragments passed raw. */
const para = (pPr, runXml) => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runXml}</w:p>`;
const spacing = (before, after) => `<w:spacing w:before="${before}" w:after="${after}"/>`;

let stepCounter = 0;
function blockToXml(block) {
  switch (block.t) {
    case "title":
      return para(spacing(0, 120), runs(block.x, { b: true, size: 56, color: "0E7569" }));
    case "sub":
      return para(spacing(0, 360), runs(block.x, { size: 20, color: "667788" }));
    case "h1":
      stepCounter = 0;
      return para(spacing(420, 160), runs(block.x, { b: true, size: 32, color: "0E7569" }));
    case "h2":
      stepCounter = 0;
      return para(spacing(280, 120), runs(block.x, { b: true, size: 26 }));
    case "p":
      return para(spacing(60, 120), runs(block.x));
    case "li":
      return para(`${spacing(40, 40)}<w:ind w:left="360"/>`, run("•  ", { b: true, color: "0E7569" }) + runs(block.x));
    case "step":
      stepCounter += 1;
      return para(`${spacing(60, 60)}<w:ind w:left="360"/>`, run(`${stepCounter}.  `, { b: true, color: "0E7569" }) + runs(block.x));
    case "code":
      return block.x
        .map((line, i) =>
          para(
            `${spacing(i === 0 ? 120 : 0, i === block.x.length - 1 ? 120 : 0)}<w:ind w:left="360"/><w:shd w:val="clear" w:color="auto" w:fill="F2F5F7"/>`,
            run(line, { mono: true, size: 19 }),
          ),
        )
        .join("");
    case "note":
      return para(
        `${spacing(120, 160)}<w:ind w:left="240"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D99A1D"/></w:pBdr>`,
        runs(block.x),
      );
    case "table": {
      const cell = (x, isHeader) =>
        `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF2"/>' : ""}</w:tcPr>${para(
          spacing(40, 40),
          runs(x, isHeader ? { b: true } : {}),
        )}</w:tc>`;
      const border = (edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="AABBC4"/>`;
      const rowsXml = [
        `<w:tr>${block.header.map((h) => cell(h, true)).join("")}</w:tr>`,
        ...block.rows.map((r) => `<w:tr>${r.map((c) => cell(c, false)).join("")}</w:tr>`),
      ].join("");
      return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders></w:tblPr>${rowsXml}</w:tbl>${para(spacing(0, 120), "")}`;
    }
    default:
      throw new Error(`Unknown block type: ${block.t}`);
  }
}

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

// ── zip writer (same approach as scripts/build-client-package.mjs) ──────────
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const local = [];
  const central = [];
  const now = new Date();
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const deflated = deflateRawSync(raw, { level: 9 });
    const method = deflated.length < raw.length ? 8 : 0;
    const body = method === 8 ? deflated : raw;
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(method, 8);
    header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, body);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(method, 10); directory.writeUInt16LE(dosTime, 12); directory.writeUInt16LE(dosDate, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(raw.length, 24); directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralData, end]);
}

/** CONTENT blocks → a .docx buffer. */
export function renderDocx(content) {
  stepCounter = 0;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content
    .map(blockToXml)
    .join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
  return createZip([
    { name: "[Content_Types].xml", data: contentTypesXml },
    { name: "_rels/.rels", data: relsXml },
    { name: "word/document.xml", data: documentXml },
  ]);
}

/** Render CONTENT and write it, creating the folder if needed. Returns the byte length. */
export function writeDocx(outPath, content) {
  const docx = renderDocx(content);
  mkdirSync(outPath.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
  writeFileSync(outPath, docx);
  return docx.length;
}
