/**
 * #152 — zero text tăiat în Raportul de încredere.
 *
 * Cauza: nota lui L6 (§4) se construiește prin concatenarea tuturor
 * dovezilor QcStatements, deci lungimea ei crește cu numărul de atribute
 * din certificat. `page.drawText(..., { maxWidth })` din pdf-lib RUPE
 * textul (nu-l taie), dar cu `lineHeight` implicit 24 și fără ca noi să
 * mutăm `y` în funcție de câte linii au ieșit — liniile suplimentare se
 * desenau SUB poziția curentă, peste conținutul rândului următor.
 *
 * `wrapLines` e funcție pură (nu închide peste `page`/`y`), deci o
 * re-derivăm din sursă exact ca testul de diacritice (#150), nu o
 * reimplementare paralelă.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { verifyPdfSignatures } from '../../services/certificate-verify.mjs';
import { generateTrustReport } from '../../services/sign-trust-report.mjs';

const ROOT    = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC     = readFileSync(join(ROOT, 'server', 'services', 'sign-trust-report.mjs'), 'utf8');
const FIXTURE = join(ROOT, 'server', 'tests', 'fixtures', 'sts-signed-staging.pdf');

function loadWrapLines() {
  const m = SRC.match(/const wrapLines = \(text, font, size, maxW\) => \{[\s\S]*?\n  \};/);
  if (!m) throw new Error('nu am gasit wrapLines in sursa');
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${m[0]}\nreturn wrapLines;`);
  return fn();
}

// StandardFonts.Helvetica (WinAnsi) nu poate encoda ă/î/ș/ț — exact ca în
// codul real, care trece nota prin ro() ÎNAINTE de a o da lui wrapLines.
function loadRo() {
  const diacrMatch = SRC.match(/const diacr = \{[\s\S]*?\};/);
  const roMatch    = SRC.match(/const ro = t => [\s\S]*?;\n/);
  if (!diacrMatch || !roMatch) throw new Error('nu am gasit diacr/ro in sursa');
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${diacrMatch[0]}\n${roMatch[0]}\nreturn ro;`);
  return fn();
}

describe('#152 — wrapLines (helper de încadrare partajat)', () => {
  let wrapLines, ro, fontR;

  beforeAll(async () => {
    wrapLines = loadWrapLines();
    ro = loadRo();
    const pdf = await PDFDocument.create();
    fontR = await pdf.embedFont(StandardFonts.Helvetica);
  });

  it('⭐⭐ 1. nota REALĂ de L6 din fixtură ⇒ mai mult de o linie, fără caractere pierdute', async () => {
    const cryptoResult = await verifyPdfSignatures(readFileSync(FIXTURE));
    const note = cryptoResult.signatures[0]?.levels?.L6?.note;
    expect(typeof note).toBe('string');
    expect(note.length).toBeGreaterThan(100); // ancora — dacă fixtura se schimbă, verifică nota

    // ro() e aplicată de codul real ÎNAINTE de wrapLines (fontul standard nu
    // poate desena diacritice românești) — reproducem exact același lanț.
    const noteRo = ro(note);
    const MAX_W = 507 - 75; // COL_W - 75, ca în bucla nivelurilor
    const lines = wrapLines(noteRo, fontR, 7, MAX_W);
    expect(lines.length).toBeGreaterThan(1);

    // Concatenarea liniilor (cu un singur spațiu între ele) reproduce textul original (ro'd).
    const rebuilt = lines.join(' ').replace(/\s+/g, ' ').trim();
    const original = noteRo.replace(/\s+/g, ' ').trim();
    expect(rebuilt).toBe(original);
  });

  it('⭐⭐ 2. fiecare linie are lățimea măsurată <= maxW', () => {
    const text = 'Cei mai multi semnatari au utilizat certificate digitale calificate emise de STS Romania pentru semnatura electronica avansata QES conform eIDAS';
    const MAX_W = 200;
    const lines = wrapLines(text, fontR, 8, MAX_W);
    expect(lines.length).toBeGreaterThan(1);
    for (const ln of lines) {
      expect(fontR.widthOfTextAtSize(ln, 8)).toBeLessThanOrEqual(MAX_W);
    }
  });

  it('⭐ 3. un cuvânt de 200 de caractere fără spații ⇒ rupt pe caractere, nicio linie peste maxW', () => {
    const longWord = 'a'.repeat(200);
    const MAX_W = 150;
    const lines = wrapLines(longWord, fontR, 8, MAX_W);
    expect(lines.length).toBeGreaterThan(1);
    for (const ln of lines) {
      expect(fontR.widthOfTextAtSize(ln, 8)).toBeLessThanOrEqual(MAX_W);
    }
    expect(lines.join('')).toBe(longWord);
  });

  it('⭐ 4. text gol / doar spații ⇒ tablou gol', () => {
    expect(wrapLines('', fontR, 8, 200)).toEqual([]);
    expect(wrapLines('   ', fontR, 8, 200)).toEqual([]);
    expect(wrapLines(undefined, fontR, 8, 200)).toEqual([]);
  });

  it('⭐ 5. text scurt ⇒ exact o linie, identică cu intrarea', () => {
    const text = 'Semnat cu succes';
    const lines = wrapLines(text, fontR, 8, 500);
    expect(lines).toEqual([text]);
  });
});

describe('#152 — raportul generat pe fixtură nu se suprapune și nu aruncă', () => {
  it('⭐⭐ 6. generare fără excepție, cel putin o pagină, nicio poziție sub marginea de jos', async () => {
    const pdfBytes = readFileSync(FIXTURE);
    const flowData = {
      docName: 'Document test #152',
      flowType: 'tabel',
      institutie: 'Primaria Test',
      compartiment: 'Compartiment Test',
      initName: 'Ion Popescu',
      initEmail: 'ion@test.ro',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      completed: true,
      signers: [
        { order: 1, name: 'Ion Popescu', email: 'ion@test.ro', rol: 'INTOCMIT', status: 'signed', signedAt: new Date().toISOString(), signingProvider: 'sts-cloud' },
      ],
      events: [
        { type: 'FLOW_CREATED', at: new Date().toISOString(), by: 'ion@test.ro' },
        { type: 'SIGNED', at: new Date().toISOString(), by: 'ion@test.ro' },
        { type: 'FLOW_COMPLETED', at: new Date().toISOString(), by: 'ion@test.ro' },
      ],
    };

    let out;
    await expect((async () => {
      out = await generateTrustReport({ flowId: 'TEST_152_WRAP', flowData, pdfBytes, pool: null });
    })()).resolves.not.toThrow();

    const doc = await PDFDocument.load(out.pdfBytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      expect(width).toBe(595);
      expect(height).toBe(842);
    }

    // ── Verificare de poziție REALĂ, cu pdfjs-dist (pattern deja folosit în
    // formulare-pdf-wrap.test.mjs pentru exact acest tip de regresie) ──────
    const pdfDoc = await getDocument({ data: new Uint8Array(out.pdfBytes), useSystemFonts: true }).promise;
    const BOTTOM_MARGIN = 44; // MARGIN din sign-trust-report.mjs
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const content = await page.getTextContent();
      const items = content.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
          h: it.height || 8,
        }));

      // Nicio poziție desenată nu iese sub marginea de jos a paginii
      // (footer-ul, desenat separat la y=24, e cazul cunoscut exclus).
      for (const it of items) {
        if (it.y <= 26) continue; // banda footer-ului (desenat fix la y=24)
        expect(it.y).toBeGreaterThanOrEqual(BOTTOM_MARGIN - 4);
      }

      // Detector de suprapunere: două item-uri de text pe ACEEAȘI linie
      // (delta y sub jumătate din înălțimea fontului) NU au voie să aibă
      // intervale x care se intersectează — exact bug-ul #152 (linia a
      // doua a notei L6 se desena peste titlul secțiunii următoare).
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i], b = items[j];
          if (Math.abs(a.y - b.y) >= Math.min(a.h, b.h) / 2) continue;
          const aEnd = a.x + a.w, bEnd = b.x + b.w;
          const overlapsX = a.x < bEnd && b.x < aEnd;
          if (overlapsX) {
            throw new Error(
              `Suprapunere text pe pagina ${pageNum}: "${a.str}" @ (${a.x.toFixed(1)},${a.y.toFixed(1)}) ` +
              `vs "${b.str}" @ (${b.x.toFixed(1)},${b.y.toFixed(1)})`
            );
          }
        }
      }
    }
    await pdfDoc.destroy();
  });
});
