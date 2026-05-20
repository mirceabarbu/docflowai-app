# 🔬 Audit complet trezorerii ANAF — scraping, JSON, refactor, teste

```
═══════════════════════════════════════════════════════════════════
⚠️  AVERTISMENT BRANCH
═══════════════════════════════════════════════════════════════════
ȚINTĂ: branch `develop` EXCLUSIV.
NU face checkout/merge/push pe `main`.
═══════════════════════════════════════════════════════════════════
```

## CONTEXT

Lista `TREZ_LOCALITY_CODES` din `server/services/verify/ibanValidator.mjs`
are 156 din ~200 coduri marcate `// unverified` — date fabricate (probabil
de un AI fără sursă). Demonstrat eronat: cod 138 = „Victoria" în date vs
**„Trezoreria operativă Râşnov"** conform sursă oficială ANAF.

ANAF publică lista autoritativă la:
- Index: https://static.anaf.ro/static/10/Anaf/AsistentaContribuabili_r/Iban2014.htm
- Per județ: `http://static.anaf.ro/static/10/Anaf/AsistentaContribuabili_r/iban2014/<Județ>.htm`
- 41 fișiere HTML cu același pattern de tabel (verified pentru Alba și Brașov)
- București: 7 entries hardcoded (TREZ700..706)

Acest pachet **înlocuiește datele fabricate cu lista oficială**, refactorizează
codul să consume datele din JSON generat reproducibil, și adaugă teste cu
ancore din date reale.

## OBIECTIVE

1. **Tool scraper** (`tools/scrape-trezorerii-anaf.mjs`) — Node.js script
   care fetch-uiește toate 41 paginile HTML județene + adaugă București
   hardcoded, parsează codurile, generează:
   - `server/services/verify/data/trezorerii-anaf.json` (sursa nouă de date)
   - `tools/output/trezorerii-diff.md` (raport discrepanțe vs lista veche)

2. **Refactor `ibanValidator.mjs`** — citește din JSON, elimină
   `TREZ_LOCALITY_CODES` hardcoded și `TREZ_COUNTY_FALLBACK` (acum
   inutile — datele oficiale acoperă tot ce e public).

3. **Teste extinse** — ancore validate manual pentru cazuri cheie
   (cod 138 = Râșnov, cod 001 = Alba județeană, cod 700 = București,
   etc.).

4. **Commit datelor în git** — JSON-ul e versioned ca sursă de adevăr.
   Tool-ul rămâne re-rulabil pentru refresh anual.

## NO-TOUCH

- `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`,
  `java-pades-client.mjs`, `STSCloudProvider.mjs`
- Logica OPME (parser, matcher, gating) — neatinsă
- `checkMod97` din `ibanValidator.mjs` — corectă, neatinsă
- API-ul public al `validateIban()` rămâne **backward-compatible**:
  câmpurile `treasuryCity`, `treasuryCounty`, `treasuryBranchName`,
  `isTreasury` continuă să fie returnate. Adăugăm doar câmpuri noi.

## DELIVERABLES

### 1. CREEAZĂ `tools/scrape-trezorerii-anaf.mjs`

Script Node.js (ESM) re-rulabil. Folosește `fetch` global (Node 18+) și
parser regex (fără dependențe noi).

```js
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

// 41 județe + identificator URL ANAF
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

// București — entries hardcoded (din index Iban2014.htm, link-uri PDF
// fiecare; nu mai facem scraping separat — datele sunt stabile și
// publice).
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

/**
 * Parsează HTML-ul unei pagini județene. Caută rânduri din tabela
 * `<tr><td>TREZxxx</td><td>...denumire...</td></tr>`. Robust la
 * variații minore (link-uri către PDF în coloana denumire).
 */
function parseJudetHtml(html, judetName) {
  const entries = [];
  // Pattern: TREZ urmat de 3 cifre, apoi orice până la următoarea
  // celulă cu denumirea. Folosim DOTALL flag (`s`) ca să prindă
  // newline-urile dintre <td>-uri.
  const re = /TREZ(\d{3})\s*<\/td>\s*<td[^>]*>(.*?)<\/td>/gs;
  let m;
  while ((m = re.exec(html)) !== null) {
    const code = m[1];
    let denumire = m[2];
    // Curăță tag-uri HTML din denumire (mai ales <a href="...">)
    denumire = denumire.replace(/<[^>]+>/g, '').trim();
    // Normalizează spațiile multiple
    denumire = denumire.replace(/\s+/g, ' ');
    if (!denumire) continue;
    entries.push({ code, denumire, judet: judetName });
  }
  return entries;
}

/**
 * Din denumirea ANAF (ex. "Trezoreria operativă Municipiul Alba Iulia"),
 * extrage city + type.
 *   - "Trezoreria judeţeană <Județ>"        → type=judeteana, city=Județ
 *   - "Trezoreria operativă Municipiul <X>" → type=municipiu, city=X
 *   - "Trezoreria operativă <X>"            → type=operativa, city=X
 */
function parseDenumire(denumire) {
  // ANAF folosește atât "judeţeană" (cu ț cedilă) cât și "județeană".
  // Normalizăm.
  const norm = denumire
    .replace(/judeţeană/gi, 'județeană')
    .replace(/operativă/gi, 'operativă');

  let m;
  if ((m = norm.match(/^Trezoreria\s+județeană\s+(.+)$/i))) {
    return { type: 'judeteana', city: m[1].trim() };
  }
  if ((m = norm.match(/^Trezoreria\s+operativă\s+Municipiul\s+(.+)$/i))) {
    return { type: 'municipiu', city: m[1].trim() };
  }
  if ((m = norm.match(/^Trezoreria\s+operativă\s+(.+)$/i))) {
    return { type: 'operativa', city: m[1].trim() };
  }
  // Fallback — păstrăm denumirea brută
  return { type: 'unknown', city: denumire };
}

async function fetchJudet(judet) {
  const url = BASE_URL + judet.url;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DocFlowAI/scrape-trezorerii-anaf' },
  });
  if (!res.ok) {
    throw new Error(`${judet.name}: HTTP ${res.status} la ${url}`);
  }
  const html = await res.text();
  return parseJudetHtml(html, judet.name);
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
    // Pauză minimă politicoasă între request-uri
    await new Promise(r => setTimeout(r, 100));
  }

  // Adaugă București hardcoded
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

  // Adaugă metadata
  const payload = {
    _meta: {
      fetchedAt,
      source: 'static.anaf.ro/Iban2014',
      totalEntries: Object.keys(out).length,
      failures,
    },
    entries: out,
  };

  // Scrie JSON-ul
  const dataDir = path.join(REPO, 'server/services/verify/data');
  await fs.mkdir(dataDir, { recursive: true });
  const jsonPath = path.join(dataDir, 'trezorerii-anaf.json');
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n📝 Scris ${jsonPath}`);

  // Generează raport diff cu vechea listă
  await writeDiffReport(out, payload._meta);

  if (failures.length > 0) {
    console.warn(`\n⚠️  ${failures.length} județe au eșuat — verifică log-ul.`);
    process.exitCode = 1;
  }
}

async function writeDiffReport(newData, meta) {
  // Importă vechea listă (dacă încă există în ibanValidator.mjs)
  // pentru a genera diff. La a doua rulare (după refactor), vechea
  // listă nu mai există → diff e gol, e ok.
  let oldData = {};
  try {
    const ibanMjs = await fs.readFile(
      path.join(REPO, 'server/services/verify/ibanValidator.mjs'),
      'utf8',
    );
    const m = ibanMjs.match(/TREZ_LOCALITY_CODES\s*=\s*({[\s\S]+?});/);
    if (m) {
      // Parser foarte naive pe obiectul JS — extrage doar cod + city
      const re = /'(\d{3})':\s*{\s*city:\s*'([^']+)'/g;
      let mm;
      while ((mm = re.exec(m[1])) !== null) {
        oldData[mm[1]] = mm[2];
      }
    }
  } catch { /* ok dacă fișierul a fost deja refactorizat */ }

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
    const oldCity = oldData[code];
    if (oldCity === undefined) {
      lines.push(`+ \`${code}\` → **${newCity}** (${newData[code].county}) [nou]`);
      added++;
    } else if (oldCity !== newCity) {
      lines.push(`~ \`${code}\` ${oldCity} → **${newCity}** (${newData[code].county})`);
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
  await fs.writeFile(reportPath, lines.join('\n'), 'utf8');
  console.log(`📝 Scris ${reportPath} — ${changed} schimbate, ${added} adăugate, ${removed} eliminate`);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
```

### 2. RULEAZĂ tool-ul o singură dată

```bash
node tools/scrape-trezorerii-anaf.mjs
```

Verifică output-urile:
- `server/services/verify/data/trezorerii-anaf.json` (~200 entries)
- `tools/output/trezorerii-diff.md` (verifică OCHIUL — câteva discrepanțe
  importante: cod 138 trebuie să apară ca `Victoria → Râșnov`)

Adaugă `tools/output/` în `.gitignore` (rapoartele sunt locale). JSON-ul
**rămâne în git** ca sursă de adevăr.

### 3. REFACTOR `server/services/verify/ibanValidator.mjs`

**A. La începutul fișierului, importă datele:**

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TREZ_DATA = JSON.parse(
  readFileSync(path.join(__dirname, 'data/trezorerii-anaf.json'), 'utf8')
);
const TREZ_ENTRIES = TREZ_DATA.entries;
```

**B. ELIMINĂ constanta `TREZ_LOCALITY_CODES` complet** (toate ~200 linii cu
`'XYZ': { city: ..., county: ... }` hardcoded).

**C. ELIMINĂ constanta `TREZ_COUNTY_FALLBACK`** — datele oficiale ANAF
acoperă tot. Codurile rămase necunoscute primesc fallback generic
„Trezoreria Statului (cod ...)".

**D. Înlocuiește logica de lookup din `validateIban`:**

```js
// ÎNAINTE
const localityEntry = TREZ_LOCALITY_CODES[localityCode];
if (localityEntry) {
  treasuryCity = localityEntry.city;
  treasuryCounty = localityEntry.county;
  treasuryBranchName = `Trezoreria ${localityEntry.city}`;
} else if (TREZ_COUNTY_FALLBACK[countyCode]) {
  treasuryCounty = TREZ_COUNTY_FALLBACK[countyCode];
  treasuryBranchName = `Trezoreria jud. ${treasuryCounty} (cod ${localityCode})`;
} else {
  treasuryBranchName = `Trezoreria Statului (cod ${localityCode})`;
}

// DUPĂ
const entry = TREZ_ENTRIES[localityCode];
let treasuryVerified = false;
let treasuryType = null;
if (entry) {
  treasuryCity = entry.city;
  treasuryCounty = entry.county;
  treasuryBranchName = entry.fullName;       // exact denumire ANAF
  treasuryVerified = !!entry.verified;
  treasuryType = entry.type;
} else {
  treasuryBranchName = `Trezoreria (cod ${localityCode} — necunoscut)`;
  treasuryVerified = false;
}
```

**E. În return-ul `data`, adaugă câmpurile noi:**

```js
return {
  ok: true,
  data: {
    iban, valid, country, bankCode, bankName: bank?.name || null,
    isTreasury,
    treasuryCity, treasuryCounty, treasuryBranchName,
    treasuryType,           // NOU: 'judeteana' | 'municipiu' | 'operativa' | 'sector' | null
    treasuryVerified,       // NOU: bool
    accountType: isTreasury ? 'treasury' : (bank?.type || 'commercial'),
  },
};
```

Pentru IBAN non-RO sau non-trezorerie: `treasuryType=null`, `treasuryVerified=null`
(nu se aplică). Asigură-te că forma răspunsului rămâne consistentă pentru
toate cazurile.

### 4. ACTUALIZEAZĂ `public/js/formular/verif.js`

Dacă există deja logica de afișare a numelui trezoreriei, schimbă să
folosească `data.treasuryBranchName` (denumire exactă ANAF). Dacă este
util, afișează și tipul:

```js
// pseudo-cod, adaptează la stilul fișierului
if (data.isTreasury) {
  html += `<div>${data.treasuryBranchName}</div>`;
  if (data.treasuryType === 'judeteana') {
    html += `<span class="df-badge">Județeană</span>`;
  }
}
```

NU mai e nevoie de badge ⚠ „Cod neverificat" — toate codurile din JSON
sunt `verified: true`. Codurile necunoscute (rare) primesc fallback
„Trezoreria (cod XYZ — necunoscut)" care comunică limpede situația.

### 5. ACTUALIZEAZĂ teste `server/services/verify/__tests__/ibanValidator.test.mjs`

Adaugă cazuri cu **date reale validate cu ANAF**:

```js
describe('trezorerii — date reale ANAF', () => {
  // Brașov — verificat manual contra static.anaf.ro/.../Brasov.htm
  const BRASOV_TESTS = [
    { code: '130', city: 'Brașov',     type: 'judeteana', fullName: 'Trezoreria judeţeană Braşov' },
    { code: '131', city: 'Brașov',     type: 'municipiu', containsCity: 'Brașov' },
    { code: '132', city: 'Făgăraș',    type: 'municipiu' },
    { code: '133', city: 'Rupea',      type: 'operativa' },
    { code: '136', city: 'Săcele',     type: 'operativa' },
    { code: '137', city: 'Codlea',     type: 'operativa' },
    { code: '138', city: 'Râșnov',     type: 'operativa' },  // bug-ul original
  ];
  for (const t of BRASOV_TESTS) {
    it(`cod ${t.code} → ${t.city}`, () => {
      const iban = buildTrezIban(t.code);
      const r = validateIban(iban);
      expect(r.data.isTreasury).toBe(true);
      expect(r.data.treasuryCounty).toBe('Brașov');
      if (t.containsCity) {
        expect(r.data.treasuryCity).toContain(t.containsCity);
      } else {
        expect(r.data.treasuryCity).toBe(t.city);
      }
      expect(r.data.treasuryType).toBe(t.type);
      expect(r.data.treasuryVerified).toBe(true);
    });
  }

  // București — entries hardcoded
  it('cod 700 → București (Municipiul)', () => {
    const r = validateIban(buildTrezIban('700'));
    expect(r.data.treasuryCity).toBe('București');
    expect(r.data.treasuryType).toBe('municipiu');
    expect(r.data.treasuryVerified).toBe(true);
  });
  it('cod 703 → Sector 3', () => {
    const r = validateIban(buildTrezIban('703'));
    expect(r.data.treasuryCity).toContain('Sector 3');
    expect(r.data.treasuryType).toBe('sector');
  });

  // Alba — verificare cap de listă
  it('cod 001 → Trezoreria judeţeană Alba', () => {
    const r = validateIban(buildTrezIban('001'));
    expect(r.data.treasuryCity).toBe('Alba');
    expect(r.data.treasuryCounty).toBe('Alba');
    expect(r.data.treasuryType).toBe('judeteana');
  });

  // Cod necunoscut → fallback elegant
  it('cod neexistent → necunoscut, verified=false', () => {
    const r = validateIban(buildTrezIban('999'));  // imposibil în ANAF
    expect(r.data.treasuryVerified).toBe(false);
    expect(r.data.treasuryBranchName).toContain('necunoscut');
  });
});
```

`buildTrezIban(code)` e o utility helper care construiește un IBAN valid
mod-97 cu codul de localitate dat. Caută în testele existente dacă există
deja un helper similar; dacă nu, creează:

```js
function buildTrezIban(localityCode) {
  // RO + 2 cifre check + TREZ + 3 cifre cod + 13 caractere oarecare cont
  const cont = 'AB123456789012';  // 13 char, arbitrar
  const partial = `TREZ${localityCode}${cont}`;
  // Calculează 2 cifre check pentru mod-97
  // ... (implementare standard mod-97; sau folosește un IBAN cunoscut
  //      pentru fiecare cod, calculat manual și hardcoded)
  return computeIbanWithCheck('RO', partial);
}
```

Dacă implementarea check digit e complexă, hardcodează un IBAN cunoscut
per cod testat (mai puțin cazuri necesită calcul live).

### 6. ACTUALIZEAZĂ `.gitignore`

Adaugă:
```
# Output rapoarte tool-uri (regenerate la fiecare rulare)
tools/output/
```

JSON-ul (`server/services/verify/data/trezorerii-anaf.json`) **rămâne**
în git.

### 7. ACTUALIZEAZĂ `CLAUDE.md`

Adaugă o secțiune scurtă (~15 linii):

```markdown
## Date trezorerii ANAF

Sursa de adevăr: `server/services/verify/data/trezorerii-anaf.json`.
Generat de `tools/scrape-trezorerii-anaf.mjs` din pagina oficială ANAF
(static.anaf.ro/.../Iban2014.htm). 41 județe + București.

Pentru refresh (anual recomandat, sau când apar trezorerii noi):
1. `node tools/scrape-trezorerii-anaf.mjs`
2. Verifică `tools/output/trezorerii-diff.md` pentru schimbări
3. Dacă diff-ul arată schimbări așteptate, commit JSON-ul actualizat
4. `npm test` verde
5. PR + merge

NU mai există listă hardcoded în `ibanValidator.mjs` — singura sursă
e fișierul JSON. Tool-ul e idempotent.
```

### 8. PACKAGE.JSON

Bump patch version. Sw cache bump.

(Opțional, dacă vrei să faci comanda mai descoperibilă):
```json
"scripts": {
  ...
  "scrape:trezorerii": "node tools/scrape-trezorerii-anaf.mjs",
  ...
}
```

## ACCEPTANCE

- `node tools/scrape-trezorerii-anaf.mjs` rulează fără erori, generează
  ~200 entries în JSON, raport diff în `tools/output/trezorerii-diff.md`
- `tools/output/trezorerii-diff.md` arată **cod 138: Victoria → Râșnov**
  în lista de schimbări (dovedește că auditul a corectat bug-ul original)
- `npm test` verde — toate testele anterioare trec + cele noi cu date
  reale ANAF
- Manual pe staging cu `RO06TREZ1382116020201XXX`:
  - Răspuns API: `treasuryCity: "Râșnov"`, `treasuryBranchName:
    "Trezoreria operativă Raşnov"` (sau echivalent denumire ANAF),
    `treasuryType: "operativa"`, `treasuryVerified: true`
  - UI afișează corect numele trezoreriei

## COMMIT

Pe `develop` (UN SINGUR commit, nu împărțit — schimbarea e logică unitară):

```
feat(verify): refactor trezorerii — sursa ANAF oficială + tool re-rulabil

- tools/scrape-trezorerii-anaf.mjs — scraper Node.js (zero deps noi)
  pentru paginile oficiale static.anaf.ro/.../Iban2014.htm
- server/services/verify/data/trezorerii-anaf.json — ~200 entries
  generate din 41 județe + 7 entries București hardcoded
- ibanValidator.mjs: REFACTOR major — eliminate constante
  TREZ_LOCALITY_CODES (156/200 entries fabricate "unverified") și
  TREZ_COUNTY_FALLBACK; lookup din JSON cu fallback elegant pentru
  coduri necunoscute
- Răspuns API extins cu treasuryType + treasuryVerified
- Frontend verif.js: afișează denumire exactă ANAF (treasuryBranchName)
- Teste noi cu ancore reale validate (Brașov 130-138, Alba 001, București
  700/703, cod necunoscut)
- CLAUDE.md: secțiune procedură refresh date (anual)
- .gitignore: tools/output/

Bug-ul demonstrativ: cod 138 era "Victoria" (fabricat); acum corect
"Trezoreria operativă Râşnov" conform ANAF.

Datele se regenerează cu `node tools/scrape-trezorerii-anaf.mjs`
(idempotent, auditabil prin diff în git).
```

Bump version + sw cache.

---

## 📌 Note pentru execuție

**Dacă ANAF e down sau pagini lipsesc:** scraper-ul colectează failure-uri
în `_meta.failures` din JSON. Verifică acel array înainte de commit. Dacă
sunt >0 failures, **nu commit-a JSON-ul incomplet** — rulează manual paginile
lipsă mai târziu.

**Variații HTML:** Am verificat manual pattern-ul pentru Alba și Brașov.
Dacă alte județe au markup ușor diferit (ex. table nested), regex-ul poate
pierde entries — verifică `_meta.totalEntries` să fie ~200, nu 150.

**Encoding:** Paginile ANAF sunt UTF-8 cu diacritice (`ţ`, `Ş` vechiul stil
ISO 8859-2 versus `ț`, `Ș` Unicode). Normalizează la commit — `replace
/ţ/g, 'ț'` și `/ş/g, 'ș'` etc. pentru afișare consistentă în UI.
