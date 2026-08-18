/**
 * #129 — butonul „🔓 Redeschide document" în renderActions (public/js/formular/doc.js).
 *
 * doc.js nu are harness DOM în repo, dar `renderActions` nu apelează nimic din afară în afară
 * de `document.getElementById` → extragem funcția din sursă (potrivire de acolade) și o rulăm
 * cu un `document` + `ST` de test. Astfel aserțiunea „byte-identic când can_reopen=false" e
 * REALĂ (comparație cu HTML-ul de dinainte de lot, hardcodat aici), nu o intenție.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const SRC = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');

/** Extrage sursa unei funcții top-level prin potrivirea acoladelor. */
function extractFn(src, header) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error('funcție negăsită: ' + header);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('acolade nepotrivite pentru ' + header);
}

const renderActionsSrc = extractFn(SRC, 'function renderActions(ft){');

function render(ft, caps, extra = {}) {
  const target = { innerHTML: null };
  const doc = {
    getElementById: (id) => id === 'actions-' + ft ? target : { style: {} },
  };
  const ST = {
    docStatus: { [ft]: extra.status || 'completed' },
    docRole: { [ft]: extra.role || 'p1' },
    docId: { [ft]: 'doc-1' },
    docCapabilities: { [ft]: caps },
    docRevizieNr: {}, docLatestRevizieNr: {}, docRevizieAnUrmator: {}, docFlowId: {},
    [ft]: { pdf: extra.pdf || null },
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'ST', renderActionsSrc + '\nreturn renderActions;')(doc, ST);
  fn(ft);
  return target.innerHTML;
}

const GEN = (ft) => `<button id="bgen-${ft}" class="df-action-btn primary" onclick="genPdf('${ft}')">⚙ Generează PDF</button>`;
const XML = (t) => `<button class="df-action-btn sm" onclick="exportFormularXml('${t}','doc-1')">📑 Export XML</button>`;
const P2MSG = `<span style="color:var(--df-text-3);font-size:.82rem">✅ Secțiunea ta este completată.</span>`;
const REOPEN = (ft) => `<button class="df-action-btn " onclick="resetDocToP1('${ft}')">🔓 Redeschide document</button>`;

describe('#129 renderActions — butonul Redeschide document', () => {
  it('8 ⭐ can_reopen:true pe ramura can_generate_or_launch → resetDocToP1 pe AMBELE tipuri', () => {
    const ord = render('ordnt', { can_generate_or_launch: true, can_reopen: true, can_export_xml: true });
    const df = render('notafd', { can_generate_or_launch: true, can_reopen: true, can_export_xml: true });
    expect(ord).toContain("resetDocToP1('ordnt')");
    expect(df).toContain("resetDocToP1('notafd')");
    // poziția cerută: după butonul principal, înainte de xmlBtn
    expect(df).toBe(GEN('notafd') + REOPEN('notafd') + XML('df'));
    expect(ord).toBe(GEN('ordnt') + REOPEN('ordnt') + XML('ord'));
  });

  it('8b can_reopen:true pe ramura is_completed_p2 → buton după mesaj, înainte de XML', () => {
    const df = render('notafd', { is_completed_p2: true, can_reopen: true, can_export_xml: true },
      { role: 'p2' });
    expect(df).toBe(P2MSG + REOPEN('notafd') + XML('df'));
    expect(df).toContain("resetDocToP1('notafd')");
  });

  it('9 ⭐ can_reopen:false → randare BYTE-IDENTICĂ cu cea de dinainte de lot (ambele ramuri)', () => {
    // referințe hardcodate = HTML-ul produs de codul de dinainte de #129
    expect(render('notafd', { can_generate_or_launch: true, can_reopen: false, can_export_xml: true }))
      .toBe(GEN('notafd') + XML('df'));
    expect(render('ordnt', { can_generate_or_launch: true, can_reopen: false, can_export_xml: true }))
      .toBe(GEN('ordnt') + XML('ord'));
    expect(render('notafd', { can_generate_or_launch: true, can_reopen: false, can_export_xml: false }))
      .toBe(GEN('notafd'));
    expect(render('notafd', { is_completed_p2: true, can_reopen: false, can_export_xml: true }, { role: 'p2' }))
      .toBe(P2MSG + XML('df'));
    expect(render('notafd', { is_completed_p2: true, can_reopen: false, can_export_xml: false }, { role: 'p2' }))
      .toBe(P2MSG);
    // caps fără cheia can_reopen deloc (răspuns vechi din cache) → identic
    expect(render('notafd', { can_generate_or_launch: true, can_export_xml: false })).toBe(GEN('notafd'));
  });

  it('9b ramurile care NU trebuie să primească butonul rămân neatinse', () => {
    const onFlow = render('notafd', { is_on_flow: true, can_reopen: true, can_export_xml: false });
    expect(onFlow).not.toContain('resetDocToP1');
    const aprobat = render('notafd', { aprobat: true, can_reopen: true });
    expect(aprobat).not.toContain('resetDocToP1');
  });
});

describe('#129 resetDocToP1 — corp PUT și mesaje', () => {
  const fnSrc = extractFn(SRC, 'async function resetDocToP1(ft){');

  it('10 nu mai conține fallback-ul care scria un spațiu peste cif', () => {
    expect(fnSrc).not.toContain("|| ' '");
    expect(fnSrc).toMatch(/const body=\{\};/);
  });

  it('tratează refuzul nou document_pe_flux cu mesajul serverului', () => {
    expect(fnSrc).toContain("j.error==='document_pe_flux'");
    expect(fnSrc).toContain('j.message');
  });

  it('textul confirmării menționează versiunea și păstrarea datelor', () => {
    expect(fnSrc).toMatch(/versiunea se incrementează/);
    expect(fnSrc).toMatch(/Datele completate se păstrează/);
  });
});
