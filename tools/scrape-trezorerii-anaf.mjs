#!/usr/bin/env node
// tools/scrape-trezorerii-anaf.mjs
//
// Scrape lista oficială de coduri trezorerii ANAF din pagina publică
// static.anaf.ro și generează fișierul de date autoritativ.
//
// Rulare:
//   node tools/scrape-trezorerii-anaf.mjs
//
// Output:
//   server/services/verify/data/trezorerii-anaf.json
//   tools/output/trezorerii-diff.md
//
// Re-rulabil oricând lista se actualizează pe ANAF.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const JUDETE = [
  { name: 'Alba',             url: 'Alba.htm' },
  { name: 'Arad',             url: 'Arad.htm' },
  { name: 'Argeș',            url: 'Arges.htm' },
  { name: 'Bacău',            url: 'Bacau.htm' },
  { name: 'Bihor',            url: 'Bihor.htm' },
  { name: 'Bistrița-Năsăud',  url: 'Bistrita_nasaud.htm' },
  { name: 'Botoșani',         url: 'Botosani.htm' },
  { name: 'Brăila',           url: 'Braila.htm' },
  { name: 'Brașov',           url: 'Brasov.htm' },
  { name: 'Buzău',            url: 'Buzau.htm' },
  { name: 'Călărași',         url: 'Calarasi.htm' },
  { name: 'Caraș-Severin',    url: 'Caras_Severin.htm' },
  { name: 'Cluj',             url: 'Cluj.htm' },
  { name: 'Constanța',        url: 'Constanta.htm' },
  { name: 'Covasna',          url: 'Covasna.htm' },
  { name: 'Dâmbovița',        url: 'Dambovita.htm' },
  { name: 'Dolj',             url: 'Dolj.htm' },
  { name: 'Galați',           url: 'Galati.htm' },
  { name: 'Giurgiu',          url: 'Giurgiu.htm' },
  { name: 'Gorj',             url: 'Gorj.htm' },
  { name: 'Harghita',         url: 'Harghita.htm' },
  { name: 'Hunedoara',        url: 'Hunedoara.htm' },
  { name: 'Ialomița',         url: 'Ialomita.htm' },
  { name: 'Iași',             url: 'Iasi.htm' },
  { name: 'Ilfov',            url: 'Ilfov.htm' },
  { name: 'Maramureș',        url: 'Maramures.htm' },
  { name: 'Mehedinți',        url: 'Mehedinti.htm' },
  { name: 'Mureș',            url: 'Mures.htm' },
  { name: 'Neamț',            url: 'Neamt.htm' },
  { name: 'Olt',              url: 'Olt.htm' },
  { name: 'Prahova',          url: 'Prahova.htm' },
  { name: 'Sălaj',            url: 'Salaj.htm' },
  { name: 'Satu Mare',        url: 'Satu_Mare.htm' },
  { name: 'Sibiu',            url: 'Sibiu.htm' },
  { name: 'Suceava',          url: 'Suceava.htm' },
  { name: 'Teleorman',        url: 'Teleorman.htm' },
  { name: 'Timiș',            url: 'Timis.htm' },
  { name: 'Tulcea',           url: 'Tulcea.htm' },
  { name: 'Vâlcea',           url: 'Valcea.htm' },
  { name: 'Vaslui',           url: 'Vaslui.htm' },
  { name: 'Vrancea',          url: 'Vrancea.htm' },
];

const BUCURESTI_ENTRIES = [
  { code: '700', city: 'București',          county: 'București',
    type: 'municipiu', fullName: 'Trezoreria operativă Municipiul București' },
  { code: '701', city: 'București Sector 1', county: 'București',
    type: 'sector',    fullName: 'Trezoreria operativă Sector 1' },
  { code: '702', city: 'București Sector 2', county: 'București',
    type: 'sector',    fullName: 'Trezoreria operativă Sector 2' },
  { code: '703', city: 'București Sector 3', county: 'București',
    type: 'sector',    fullName: 'Trezoreria operativă Sector 3' },
  { code: '704', city: 'București Sector 4', county: 'București',
    type: 'sector',    fullName: 'Trezoreria operativă Sector 4' },
  { code: '705', city: 'București Sector 5', county: 'București',
    type: 'sector',    fullName: 'Trezoreria operativă Sector 5' },
  { code: '706', city: 'București Sector 6', county: 'București',
    type: 'sector',    fullName: 'Trezoreria operativă Sector 6' },
];

const BASE_URL = 'http://static.anaf.ro/static/10/Anaf/AsistentaContribuabili_r/iban2014/';

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"');
}

function normalizeRoDiacritics(s) {
  return String(s)
    .replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț')
    .replace(/ş/g, 'ș').replace(/Ş/g, 'Ș');
}

function cleanCell(html) {
  let s = decodeEntities(html);
  s = s.replace(/<[^>]+>/g, ' ');
  s = normalizeRoDiacritics(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Parsează HTML-ul unei pagini județene. Strategie robustă:
 *  1. Caută toate aparițiile TREZxxx care NU sunt în interiorul unui link
 *     `.pdf` (acelea sunt referințe către PDF-uri, nu coduri de rând).
 *  2. Pentru fiecare cod, găsește următorul `<TD ...>` deschis (sare peste
 *     cell-ul propriu) și captează conținutul până la `</TD>` corespunzător.
 *  3. Curăță tag-urile + entitățile + normalizează diacriticele.
 */
function parseJudetHtml(html, judetName) {
  const entries = [];
  const codeRe = /TREZ(\d{3})(?![^<]*\.pdf)/gi;
  let m;
  while ((m = codeRe.exec(html)) !== null) {
    const code = m[1];
    const after = m.index + m[0].length;
    const closeTd = html.indexOf('</TD>', after);
    if (closeTd === -1) continue;
    const nextTdOpen = html.indexOf('<TD', closeTd);
    if (nextTdOpen === -1) continue;
    const nextTdStart = html.indexOf('>', nextTdOpen);
    if (nextTdStart === -1) continue;
    const nextTdClose = html.indexOf('</TD>', nextTdStart);
    if (nextTdClose === -1) continue;
    const cell = html.slice(nextTdStart + 1, nextTdClose);
    let denumire = cleanCell(cell);
    denumire = denumire.replace(/[\s.,;:]+$/, '').trim();
    if (!denumire) continue;
    entries.push({ code, denumire, judet: judetName });
  }
  return entries;
}

function parseDenumire(denumire) {
  // ANAF source are inconsistențe: "judeţeană" vs "judeţeana", "operativă" vs
  // "operativa", typo-uri ("Tezoreria"), prefixe diferite ("Oraș", "Orașul",
  // "Municipiu"). Tolerăm variațiile.
  const norm = normalizeRoDiacritics(denumire);
  const TREZ = /^T[er]ezoreria\s+/i;       // tolerează typo "Tezoreria"
  if (!TREZ.test(norm)) return { type: 'unknown', city: norm };
  const body = norm.replace(TREZ, '');
  let m;
  if ((m = body.match(/^județean[ăa]\s+(.+)$/i))) {
    return { type: 'judeteana', city: m[1].trim() };
  }
  if ((m = body.match(/^operativ[ăa]\s+Municipiul?\s+(.+)$/i))) {
    return { type: 'municipiu', city: m[1].trim() };
  }
  if ((m = body.match(/^operativ[ăa]\s+Oraș(?:ul)?\s+(.+)$/i))) {
    return { type: 'oras', city: m[1].trim() };
  }
  if ((m = body.match(/^operativ[ăa]\s+Comunal[ăa]\s+(.+)$/i))) {
    return { type: 'comuna', city: m[1].trim() };
  }
  if ((m = body.match(/^operativ[ăa]\s+(?:a\s+)?Sector(?:ului)?\s+(\d+)$/i))) {
    return { type: 'sector', city: `Sector ${m[1]}` };
  }
  if ((m = body.match(/^operativ[ăa]\s+(.+)$/i))) {
    return { type: 'operativa', city: m[1].trim() };
  }
  return { type: 'unknown', city: norm };
}

async function fetchJudet(judet) {
  const url = BASE_URL + judet.url;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DocFlowAI/scrape-trezorerii-anaf' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} la ${url}`);
  // Paginile sunt declarate windows-1252 în <META>; HTTP header nu trimite
  // charset explicit, deci fetch implicit decodează UTF-8 și produce U+FFFD
  // pentru bytes ne-ASCII (ex. 'â' = 0xE2). Decodăm explicit windows-1252.
  const buf = await res.arrayBuffer();
  const html = new TextDecoder('windows-1252').decode(new Uint8Array(buf));
  const entries = parseJudetHtml(html, judet.name);
  for (const e of entries) e.denumire = normalizeRoDiacritics(e.denumire);
  return entries;
}

async function main() {
  const fetchedAt = new Date().toISOString();
  const out = {};
  const failures = [];

  console.log(`📥 Scraping ANAF — ${JUDETE.length} județe + București...`);

  for (const judet of JUDETE) {
    try {
      const entries = await fetchJudet(judet);
      if (entries.length === 0) {
        failures.push({ judet: judet.name, reason: 'no entries parsed' });
        console.warn(`  ✗ ${judet.name.padEnd(20)} 0 entries (parser miss?)`);
        continue;
      }
      for (const e of entries) {
        const parsed = parseDenumire(e.denumire);
        out[e.code] = {
          code: e.code,
          city: parsed.city,
          county: judet.name,
          type: parsed.type,
          fullName: e.denumire,
          verified: true,
          source: 'ANAF',
        };
      }
      console.log(`  ✓ ${judet.name.padEnd(20)} ${entries.length} entries`);
    } catch (err) {
      console.error(`  ✗ ${judet.name.padEnd(20)} ${err.message}`);
      failures.push({ judet: judet.name, reason: err.message });
    }
    await new Promise(r => setTimeout(r, 100));
  }

  for (const e of BUCURESTI_ENTRIES) {
    out[e.code] = {
      code: e.code,
      city: e.city,
      county: e.county,
      type: e.type,
      fullName: e.fullName,
      verified: true,
      source: 'ANAF (hardcoded)',
    };
  }
  console.log(`  ✓ București (hardcoded)  ${BUCURESTI_ENTRIES.length} entries`);

  const sortedEntries = {};
  for (const code of Object.keys(out).sort()) sortedEntries[code] = out[code];

  const payload = {
    _meta: {
      fetchedAt,
      source: 'static.anaf.ro/Iban2014',
      totalEntries: Object.keys(sortedEntries).length,
      failures,
    },
    entries: sortedEntries,
  };

  const dataDir = path.join(REPO, 'server/services/verify/data');
  await fs.mkdir(dataDir, { recursive: true });
  const jsonPath = path.join(dataDir, 'trezorerii-anaf.json');
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`\n📝 Scris ${jsonPath} (${payload._meta.totalEntries} entries)`);

  await writeDiffReport(sortedEntries, payload._meta);

  if (failures.length > 0) {
    console.warn(`\n⚠️  ${failures.length} județe au eșuat — verifică log-ul.`);
    process.exitCode = 1;
  }
}

async function writeDiffReport(newData, meta) {
  let oldData = {};
  try {
    const ibanMjs = await fs.readFile(
      path.join(REPO, 'server/services/verify/ibanValidator.mjs'),
      'utf8',
    );
    const mm = ibanMjs.match(/TREZ_LOCALITY_CODES\s*=\s*({[\s\S]+?^};)/m);
    if (mm) {
      const re = /'(\d{3})':\s*\{\s*city:\s*'([^']+)'/g;
      let r;
      while ((r = re.exec(mm[1])) !== null) oldData[r[1]] = r[2];
    }
  } catch { /* ok */ }

  const lines = [
    `# Raport diff — trezorerii ANAF`,
    ``,
    `Generat: ${meta.fetchedAt}`,
    `Sursă: ${meta.source}`,
    `Total entries noi: ${meta.totalEntries}`,
    `Total entries vechi (ibanValidator.mjs): ${Object.keys(oldData).length}`,
    ``,
    `## Discrepanțe city (vechi → nou ANAF)`,
    ``,
  ];

  let changed = 0, added = 0, removed = 0;
  for (const code of Object.keys(newData).sort()) {
    const newCity = newData[code].city;
    const newFull = newData[code].fullName;
    const oldCity = oldData[code];
    if (oldCity === undefined) {
      lines.push(`+ \`${code}\` → **${newCity}** (${newData[code].county}) — \`${newFull}\` [nou]`);
      added++;
    } else if (oldCity !== newCity) {
      lines.push(`~ \`${code}\` ${oldCity} → **${newCity}** (${newData[code].county}) — \`${newFull}\``);
      changed++;
    }
  }
  for (const code of Object.keys(oldData).sort()) {
    if (newData[code] === undefined) {
      lines.push(`- \`${code}\` ${oldData[code]} [eliminat — nu există în ANAF]`);
      removed++;
    }
  }

  lines.push(``, `**Sumar:** ${changed} schimbate, ${added} adăugate, ${removed} eliminate.`);

  const outDir = path.join(REPO, 'tools/output');
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'trezorerii-diff.md');
  await fs.writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
  console.log(`📝 Scris ${reportPath} — ${changed} schimbate, ${added} adăugate, ${removed} eliminate`);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
