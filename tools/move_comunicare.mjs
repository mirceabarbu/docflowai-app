/**
 * move_comunicare.mjs
 * Mută blocul "Comunicare" din sidebar din poziția actuală (ultima)
 * în poziția 2 (imediat după "Navigare app", înaintea "Administrare").
 */
import { readFileSync, writeFileSync } from 'fs';

const FILES = [
  'public/admin.html',
  'public/bulk-signer.html',
  'public/flow.html',
  'public/formular.html',
  'public/notifications.html',
  'public/semdoc-initiator.html',
  'public/semdoc-signer.html',
  'public/templates.html',
];

const BLOCK_LABEL_RE = /^(\s*)<div class="df-nav-label">Comunicare<\/div>\s*$/;
const GROUP_OPEN_RE  = /^(\s*)<div class="df-nav-group">\s*$/;
const LABEL_ADM_RE   = /^(\s*)<div class="df-nav-label">Administrare<\/div>\s*$/;

function extractComunicareBlock(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = BLOCK_LABEL_RE.exec(lines[i]);
    if (!m) continue;
    const labelIndent = m[1];

    // Găsim linia df-nav-group (sărim eventualele linii goale)
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j >= lines.length) return null;

    const gm = GROUP_OPEN_RE.exec(lines[j]);
    if (!gm || gm[1] !== labelIndent) continue;

    // Numărăm <div>/<div> pentru a găsi </div> care închide df-nav-group
    let depth = 0;
    let k = j;
    while (k < lines.length) {
      const divOpen  = (lines[k].match(/<div\b/g)  || []).length;
      const divClose = (lines[k].match(/<\/div>/g) || []).length;
      depth += divOpen - divClose;
      if (depth === 0) {
        return { start: i, end: k, block: lines.slice(i, k + 1) };
      }
      k++;
    }
    return null;
  }
  return null;
}

function findAdministrareIdx(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (LABEL_ADM_RE.test(lines[i])) return i;
  }
  return -1;
}

const modified = [];
const errors   = [];

for (const path of FILES) {
  const src   = readFileSync(path, 'utf-8');
  const lines = src.split('\n');

  const extract = extractComunicareBlock(lines);
  if (!extract) { errors.push(`${path}: bloc Comunicare negăsit`); continue; }

  const admIdx = findAdministrareIdx(lines);
  if (admIdx === -1) { errors.push(`${path}: bloc Administrare negăsit`); continue; }

  if (extract.start < admIdx) {
    modified.push(`${path}: deja în ordinea corectă — sărit`);
    continue;
  }

  const { start, end, block } = extract;

  // Eliminăm blocul vechi + orice linie goală imediat după
  let removeEnd = end + 1;
  if (removeEnd < lines.length && lines[removeEnd].trim() === '') removeEnd++;

  const newLines = [...lines.slice(0, start), ...lines.slice(removeEnd)];

  // Găsim noul index al Administrare (acum că am eliminat liniile de dinaintea lui)
  const newAdmIdx = findAdministrareIdx(newLines);
  if (newAdmIdx === -1) { errors.push(`${path}: Administrare dispărut după eliminare`); continue; }

  // Inserăm blocul + linie goală separator ÎNAINTE de Administrare
  const insertion = [...block, ''];
  newLines.splice(newAdmIdx, 0, ...insertion);

  const newSrc = newLines.join('\n');
  if (newSrc === src) {
    modified.push(`${path}: FĂRĂ MODIFICARE (pattern mismatch)`);
  } else {
    writeFileSync(path, newSrc, 'utf-8');
    modified.push(`${path}: OK`);
  }
}

console.log('=== MODIFIED ===');
modified.forEach(m => console.log(m));
if (errors.length) {
  console.log('=== ERRORS ===');
  errors.forEach(e => console.log(e));
  process.exit(1);
}
