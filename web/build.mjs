// Build-Skript fuer das EUL22-Portal.
//   1) esbuild bundelt src/main.ts -> minifed IIFE-JavaScript
//   2) das Bundle wird an der <!--SCRIPT--> Stelle in index.html eingebettet
//   3) das komplette Dokument wird als C-String nach ../main/portal_html.h
//      geschrieben (der ESP-IDF-Build embeddet das in die Firmware).
//
// Wird von PlatformIO ueber scripts/prebuild_web.py vor dem Firmware-Build
// aufgerufen. Fuer manuelle Iteration: "npm run build" im web/ Verzeichnis.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const res = await build({
    entryPoints: [path.join(__dirname, 'src', 'main.ts')],
    bundle: true,
    minify: true,
    target: 'es2020',
    format: 'iife',
    write: false,
    logLevel: 'warning',
});
const js = res.outputFiles[0].text;

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const finalHtml = html.replace('<!--SCRIPT-->', `<script>${js}</script>`);

// Als C-String literalisieren. Zeilenweise, damit git-diffs lesbar sind.
// CRLF/CR-robust splitten: bei einem Windows-Checkout (git autocrlf) hat
// index.html sonst \r\n; ein zurueckbleibendes \r landet im C-String und wird
// vom Compiler als Zeilenende gewertet -> "missing terminating character".
const cLines = finalHtml.split(/\r\n|\r|\n/).map((line) => {
    const esc = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${esc}\\n"`;
});

const header =
    '#pragma once\n' +
    '// AUTO-GENERATED from web/. Do NOT edit by hand - run "npm run build".\n' +
    '\n' +
    'static const char PORTAL_HTML[] =\n' +
    cLines.join('\n') +
    '\n;\n';

const outPath = path.join(__dirname, '..', 'main', 'portal_html.h');
fs.writeFileSync(outPath, header);
console.log(
    `[web] wrote ${path.relative(process.cwd(), outPath)} ` +
    `(${(header.length / 1024).toFixed(1)} KB, ${cLines.length} lines, ` +
    `js bundle ${(js.length / 1024).toFixed(1)} KB)`
);
