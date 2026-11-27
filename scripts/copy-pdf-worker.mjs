#!/usr/bin/env node

// Keep the pdf.js worker served from public/ in sync with the installed pdfjs-dist.
// The chat file reader loads it at runtime; without this file PDF import fails.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs");
const target = resolve(root, "public/pdf.worker.min.mjs");

if (!existsSync(source)) {
  console.warn("[pdf-worker] pdfjs-dist is not installed; skipping worker copy.");
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
if (existsSync(target) && statSync(target).size === statSync(source).size) {
  console.log("[pdf-worker] public/pdf.worker.min.mjs is up to date.");
  process.exit(0);
}

copyFileSync(source, target);
console.log("[pdf-worker] copied pdf.worker.min.mjs to public/.");
