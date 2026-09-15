/**
 * #212 — plasă statică: orice handler chemat dintr-un `onclick=`/`onchange=`/... trebuie
 * să existe pe `window` la runtime.
 *
 * Motivația (#212): `alopReiaPlata` era definită în IIFE-ul `alop.js`, dar butonul o cheamă
 * din `onclick="alopReiaPlata(...)"`, adică din scope-ul global — unde nu exista. Clic ⇒
 * `ReferenceError` tăcut ⇒ nimic vizibil. Blocul de export global din `alop.js` avea toate
 * celelalte handlere, mai puțin acesta — un rând uitat.
 *
 * Testul e STATIC: citește sursa din `public/js/**` și `public/*.html`, NU pornește browser,
 * NU execută JS. Pentru fiecare nume chemat dintr-un handler inline, verifică una din:
 *   1) există `window.NAME =` în vreun fișier din `public/js/`;
 *   2) NAME e declarat la nivelul de bază (`function`/`const`/`let`/`var`/`class`) într-un
 *      script CARE NU E înfășurat într-un singur IIFE de nivel superior — acolo devine global
 *      "natural" (comportament standard de browser pentru scripturi clasice, non-modul), fără
 *      nevoie de `window.NAME =`. Verificat empiric pe fișiere ca `admin/reports.js`,
 *      `templates/templates.js`, `bulk-signer.js`, `verifica.js`, `semdoc-initiator/main.js`
 *      și pe al doilea `<script>` din `refnec-form.html` — niciunul din ele nu e IIFE.
 *   3) e un API nativ de browser/JS chemat direct (`fetch(...)`, `localStorage.x(...)`) —
 *      ține de platformă, nu de codul nostru.
 *
 * Extracția folosește un tokenizer JS propriu (mai jos) care reconstruiește textul "literal"
 * al fiecărui script — codul real din interiorul `${...}` (substituții de template literal)
 * e înlocuit cu spații — ca să nu confunde cod JS de generare (ex. `${v.replace(/'/g,"\\'")}`)
 * cu sintaxă de `onclick` propriu-zisă. Fără asta, `v.replace(...)` din `verif.js` apărea ca
 * un fals-pozitiv „handler v neexpus".
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, '../../../');
const PUBLIC = path.join(ROOT, 'public');

// ── Tokenizer JS: cod / string / template / comentariu / regex ────────────────────────────
// Produce: topLevelNames (declarații la depth 0) + literalText (cod real → spații, ca să
// rămână doar ce va ajunge text literal în HTML-ul generat).
function tokenizeJs(src) {
  const names = [];
  const buf = new Array(src.length);
  let i = 0;
  const n = src.length;
  let codeDepth = 0;
  const templateStack = [];
  let mode = 'code';
  let prevEndsExpr = false;
  const NON_EXPR_END_WORDS = new Set(['function','const','let','var','class','typeof','new','delete','void','return','case','do','else','throw','in','of','instanceof','yield','await']);

  const isIdentStart = (ch) => /[A-Za-z_$]/.test(ch);
  const isIdentPart = (ch) => /[A-Za-z0-9_$]/.test(ch);

  while (i < n) {
    const ch = src[i];

    if (mode === 'lineComment') {
      buf[i] = ch === '\n' ? '\n' : ' ';
      if (ch === '\n') mode = 'code';
      i++; continue;
    }
    if (mode === 'blockComment') {
      buf[i] = ch === '\n' ? '\n' : ' ';
      if (ch === '*' && src[i + 1] === '/') { buf[i + 1] = ' '; mode = 'code'; i += 2; continue; }
      i++; continue;
    }
    if (mode === 'sq' || mode === 'dq') {
      if (ch === '\\') { buf[i] = ' '; buf[i + 1] = src[i + 1]; i += 2; continue; }
      if ((mode === 'sq' && ch === "'") || (mode === 'dq' && ch === '"')) { buf[i] = ch; mode = 'code'; prevEndsExpr = true; i++; continue; }
      buf[i] = ch; i++; continue;
    }
    if (mode === 'regex') {
      buf[i] = ' ';
      if (ch === '\\') { buf[i + 1] = ' '; i += 2; continue; }
      if (ch === '[') { mode = 'regexClass'; i++; continue; }
      if (ch === '/') {
        i++;
        while (i < n && /[a-z]/i.test(src[i])) { buf[i] = ' '; i++; }
        mode = 'code'; prevEndsExpr = true; continue;
      }
      i++; continue;
    }
    if (mode === 'regexClass') {
      buf[i] = ' ';
      if (ch === '\\') { buf[i + 1] = ' '; i += 2; continue; }
      if (ch === ']') { mode = 'regex'; i++; continue; }
      i++; continue;
    }
    if (mode === 'template') {
      if (ch === '\\') { buf[i] = ' '; buf[i + 1] = src[i + 1]; i += 2; continue; }
      if (ch === '`') { buf[i] = ' '; mode = 'code'; prevEndsExpr = true; i++; continue; }
      if (ch === '$' && src[i + 1] === '{') {
        buf[i] = ' '; buf[i + 1] = ' ';
        templateStack.push({ baseDepth: codeDepth });
        mode = 'code'; prevEndsExpr = false;
        i += 2; continue;
      }
      buf[i] = ch; i++; continue;
    }

    // mode === 'code'
    if (ch === '/' && src[i + 1] === '/') { buf[i] = ' '; buf[i + 1] = ' '; mode = 'lineComment'; i += 2; continue; }
    if (ch === '/' && src[i + 1] === '*') { buf[i] = ' '; buf[i + 1] = ' '; mode = 'blockComment'; i += 2; continue; }
    if (ch === '/') {
      buf[i] = ' ';
      if (prevEndsExpr) { prevEndsExpr = false; i++; continue; }
      mode = 'regex'; i++; continue;
    }
    if (ch === "'") { buf[i] = ' '; mode = 'sq'; i++; continue; }
    if (ch === '"') { buf[i] = ' '; mode = 'dq'; i++; continue; }
    if (ch === '`') { buf[i] = ' '; mode = 'template'; i++; continue; }
    if (ch === '{') { buf[i] = ' '; codeDepth++; prevEndsExpr = false; i++; continue; }
    if (ch === '}') {
      if (templateStack.length && templateStack[templateStack.length - 1].baseDepth === codeDepth) {
        templateStack.pop();
        buf[i] = ' '; mode = 'template'; i++; continue;
      }
      buf[i] = ' '; codeDepth = Math.max(0, codeDepth - 1); prevEndsExpr = true; i++; continue;
    }
    if (ch === ')' || ch === ']') { buf[i] = ' '; prevEndsExpr = true; i++; continue; }
    if (/\s/.test(ch)) { buf[i] = ch; i++; continue; }

    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      for (let k = i; k < j; k++) buf[k] = ' ';

      if ((word === 'function' || word === 'const' || word === 'let' || word === 'var' || word === 'class') && codeDepth === 0) {
        let k = j;
        while (k < n && /\s/.test(src[k])) k++;
        if (word === 'function' && src[k] === '*') { k++; while (k < n && /\s/.test(src[k])) k++; }
        if (isIdentStart(src[k])) {
          let m = k + 1;
          while (m < n && isIdentPart(src[m])) m++;
          names.push(src.slice(k, m));
        }
      }

      prevEndsExpr = !NON_EXPR_END_WORDS.has(word);
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-Fx.]/.test(src[j])) j++;
      for (let k = i; k < j; k++) buf[k] = ' ';
      prevEndsExpr = true;
      i = j;
      continue;
    }

    buf[i] = ' ';
    prevEndsExpr = false;
    i++;
  }

  return { topLevelNames: names, literalText: buf.join('') };
}

function isWrapped(content) {
  const trimmed = content.trim();
  return /^\(\s*(async\s+)?function\b/.test(trimmed) || /^\(\s*(async\s*)?\(\s*\)\s*=>/.test(trimmed);
}

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const HANDLER_ATTR_RE = /\bon(?:click|change|input|submit|keyup|keydown|blur|focus)\s*=\s*(["'])((?:\\.|(?!\1)[\s\S])*)\1/gi;
const DOTTED_CALL_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/g;
const PLAIN_CALL_RE = /(?<![.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
const IGNORED_KEYWORDS = new Set(['return','this','event','window','document','alert','confirm','console','true','false','null','undefined','typeof','new','delete','if','for','while','function','in','of','instanceof','void','yield','await','async','catch','try','throw','switch','case','break','continue','do','else','extends','super','class','const','let','var','import','export','default','finally','static']);

function extractHandlerNames(text, file, nameToFiles) {
  let m;
  HANDLER_ATTR_RE.lastIndex = 0;
  while ((m = HANDLER_ATTR_RE.exec(text))) {
    const attr = m[2];
    DOTTED_CALL_RE.lastIndex = 0;
    const dottedRoots = new Set();
    let d;
    while ((d = DOTTED_CALL_RE.exec(attr))) dottedRoots.add(d[1]);
    PLAIN_CALL_RE.lastIndex = 0;
    let p;
    while ((p = PLAIN_CALL_RE.exec(attr))) {
      const name = p[1];
      if (IGNORED_KEYWORDS.has(name)) continue;
      if (!nameToFiles.has(name)) nameToFiles.set(name, new Set());
      nameToFiles.get(name).add(file);
    }
    for (const root of dottedRoots) {
      if (IGNORED_KEYWORDS.has(root)) continue;
      if (!nameToFiles.has(root)) nameToFiles.set(root, new Set());
      nameToFiles.get(root).add(file);
    }
  }
}

const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

// API-uri native de browser/JS chemate direct dintr-un onclick (`fetch(...)`,
// `localStorage.removeItem(...)`) — verificate în sursă, nu țin de codul nostru.
const BUILTIN_ALLOW = new Set(['fetch', 'localStorage']);

// ⚠️ Excepție UNICĂ, documentată — NU adăuga altele fără discuție (vezi #212).
// `anrefSync` e definită în `core.js` (IIFE), chemată din `onchange="anrefSync()"` în
// formular.html și din apeluri interne gardate în doc.js — toate silențios no-op, la fel ca
// `alopReiaPlata` înainte de #212. Bug real, separat, netratat în acest lot (vezi raportul #212).
const KNOWN_EXCEPTIONS = new Set(['anrefSync']);

describe('#212 — handlere onclick/onchange/... expuse la window (plasă statică)', () => {
  const jsFiles = walk(path.join(PUBLIC, 'js'), ['.js']);
  const htmlFiles = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')).map((f) => path.join(PUBLIC, f));

  const nameToFiles = new Map();
  const exposed = new Set();
  const nativeGlobals = new Set();

  const winAssignRe = /window\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;

  for (const file of jsFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const { topLevelNames, literalText } = tokenizeJs(content);
    extractHandlerNames(literalText, file, nameToFiles);
    winAssignRe.lastIndex = 0;
    let w;
    while ((w = winAssignRe.exec(content))) exposed.add(w[1]);
    if (!isWrapped(content)) for (const nm of topLevelNames) nativeGlobals.add(nm);
  }

  for (const file of htmlFiles) {
    const content = fs.readFileSync(file, 'utf8');
    let combined = '';
    let lastEnd = 0;
    INLINE_SCRIPT_RE.lastIndex = 0;
    let s;
    while ((s = INLINE_SCRIPT_RE.exec(content))) {
      const blockContent = s[1];
      const blockStartIdx = content.indexOf(blockContent, s.index);
      combined += content.slice(lastEnd, blockStartIdx);
      const { topLevelNames, literalText } = tokenizeJs(blockContent);
      combined += literalText;
      if (!isWrapped(blockContent)) for (const nm of topLevelNames) nativeGlobals.add(nm);
      lastEnd = blockStartIdx + blockContent.length;
    }
    combined += content.slice(lastEnd);
    extractHandlerNames(combined, file, nameToFiles);
  }

  function isSatisfied(name) {
    return exposed.has(name) || nativeGlobals.has(name) || BUILTIN_ALLOW.has(name);
  }

  it('fiecare handler chemat dintr-un atribut inline există pe window (sau e global natural)', () => {
    const missing = [];
    for (const [name, files] of nameToFiles) {
      if (KNOWN_EXCEPTIONS.has(name)) continue;
      if (!isSatisfied(name)) missing.push({ name, files: [...files].map((f) => path.relative(ROOT, f)) });
    }
    missing.sort((a, b) => a.name.localeCompare(b.name));

    if (missing.length) {
      const lines = missing.map((m) => `  - ${m.name} (chemat din: ${m.files.join(', ')})`);
      throw new Error(
        `Handler chemat din onclick/onchange/... dar neexpus la window. În module IIFE, funcțiile ` +
        `rămân în scopul modulului; clicul dă ReferenceError tăcut. Vezi #212.\n${lines.join('\n')}`
      );
    }
    expect(missing).toEqual([]);
  });

  it('excepțiile cunoscute chiar sunt încă neexpuse (nu ține gărzi moarte)', () => {
    for (const name of KNOWN_EXCEPTIONS) {
      const stillMissing = nameToFiles.has(name) && !isSatisfied(name);
      expect(stillMissing, `${name} pare acum expusă — scoate-o din KNOWN_EXCEPTIONS`).toBe(true);
    }
  });
});
