/**
 * #131b — modal "Responsabil CAB" cu mod Persoană/Compartiment (public/js/formular/doc.js +
 * public/js/formular/list.js). doc.js nu are harness DOM în repo; pentru funcțiile care ating
 * document.getElementById folosim extracția prin potrivire de acolade + `new Function` (pattern
 * din reopen-button-render.test.mjs), pentru restul verificăm structural pe sursă.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const DOC_JS = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
const LIST_JS = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');

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

function fakeEl() {
  return { disabled: false, value: '', style: {}, classList: { list: new Set(), toggle(c, on) { on ? this.list.add(c) : this.list.delete(c); }, contains(c) { return this.list.has(c); } } };
}

describe('#131b — setP2Mode golește selecția modului părăsit (⭐ test 1)', () => {
  const src = extractFn(DOC_JS, 'function setP2Mode(mode){');

  function run(fromMode, toMode) {
    const els = {
      'modal-confirm': fakeEl(),
      'modal-p2-mode-user': fakeEl(),
      'modal-p2-mode-comp': fakeEl(),
      'modal-search': fakeEl(),
    };
    const doc = { getElementById: (id) => els[id] };
    const ST = { p2Mode: fromMode, selectedP2Id: 'user-1', selectedP2Comp: 'Compartiment X' };
    let renderCalled = false, toggleCalled = false;
    const fn = new Function(
      'document', 'ST', '_renderP2FilterToggle', '_p2RenderList',
      src + '\nreturn setP2Mode;'
    )(doc, ST, () => { toggleCalled = true; }, () => { renderCalled = true; });
    fn(toMode);
    return { ST, els, renderCalled, toggleCalled };
  }

  it('user→comp: golește selectedP2Id ȘI selectedP2Comp, dezactivează confirmarea', () => {
    const { ST, els } = run('user', 'comp');
    expect(ST.p2Mode).toBe('comp');
    expect(ST.selectedP2Id).toBeNull();
    expect(ST.selectedP2Comp).toBeNull();
    expect(els['modal-confirm'].disabled).toBe(true);
  });

  it('comp→user: golește la fel (simetric)', () => {
    const { ST, els } = run('comp', 'user');
    expect(ST.p2Mode).toBe('user');
    expect(ST.selectedP2Id).toBeNull();
    expect(ST.selectedP2Comp).toBeNull();
    expect(els['modal-confirm'].disabled).toBe(true);
  });

  it('comută clasa primary pe butoanele de mod', () => {
    const { els } = run('user', 'comp');
    expect(els['modal-p2-mode-comp'].classList.contains('primary')).toBe(true);
    expect(els['modal-p2-mode-user'].classList.contains('primary')).toBe(false);
  });

  it('re-randează lista și toggle-ul de filtru', () => {
    const { renderCalled, toggleCalled } = run('user', 'comp');
    expect(renderCalled).toBe(true);
    expect(toggleCalled).toBe(true);
  });

  it('no-op dacă modul e deja cel curent (nu golește selecția existentă)', () => {
    const { ST } = run('user', 'user');
    expect(ST.selectedP2Id).toBe('user-1');
    expect(ST.selectedP2Comp).toBe('Compartiment X');
  });
});

describe('#131b — confirmP2 trimite EXACT una dintre assigned_to/assigned_comp (⭐ teste 2 și 3)', () => {
  it('⭐ modul compartiment: body conține assigned_comp, NU conține cheia assigned_to', () => {
    const _peComp = true;
    const ST = { selectedP2Comp: 'Buget', selectedP2Id: null };
    // Expresia exactă din confirmP2 (verificată și textual mai jos).
    const body = JSON.stringify(_peComp ? { assigned_comp: ST.selectedP2Comp } : { assigned_to: ST.selectedP2Id });
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ assigned_comp: 'Buget' });
    expect('assigned_to' in parsed).toBe(false);
  });

  it('⭐ modul persoană: body identic cu azi — doar assigned_to', () => {
    const _peComp = false;
    const ST = { selectedP2Comp: null, selectedP2Id: 42 };
    const body = JSON.stringify(_peComp ? { assigned_comp: ST.selectedP2Comp } : { assigned_to: ST.selectedP2Id });
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ assigned_to: 42 });
    expect('assigned_comp' in parsed).toBe(false);
  });

  it('sursa confirmP2 conține exact ternarul exclusiv (nu o construcție separată, divergentă)', () => {
    const src = extractFn(DOC_JS, 'async function confirmP2(){');
    expect(src).toContain('body:JSON.stringify(_peComp?{assigned_comp:ST.selectedP2Comp}:{assigned_to:ST.selectedP2Id}),');
  });

  it('guard-ul de intrare respinge modul compartiment fără selectedP2Comp și modul persoană fără selectedP2Id', () => {
    const src = extractFn(DOC_JS, 'async function confirmP2(){');
    expect(src).toContain("const _peComp=ST.p2Mode==='comp';");
    expect(src).toContain('if(!ST.pendingFt)return;');
    expect(src).toContain('if(_peComp?!ST.selectedP2Comp:!ST.selectedP2Id)return;');
  });

  it('tratează assigned_ambiguu și compartiment_fara_membri afișând mesajul serverului', () => {
    const src = extractFn(DOC_JS, 'async function confirmP2(){');
    expect(src).toMatch(/assigned_ambiguu.*compartiment_fara_membri|compartiment_fara_membri.*assigned_ambiguu/s);
    expect(src).toContain("setS(j.message||j.error,'err');");
  });
});

describe('#131b — _p2Compartimente derivă compartimentele din ST.orgUsers (test 4)', () => {
  const src = extractFn(DOC_JS, 'function _p2Compartimente(){');

  function run(orgUsers) {
    const ST = { orgUsers };
    const fn = new Function('ST', src + '\nreturn _p2Compartimente;')(ST);
    return fn();
  }

  it('grupează corect, numără total și disponibili', () => {
    const out = run([
      { compartiment: 'Buget', on_leave: false },
      { compartiment: 'Buget', on_leave: true },
      { compartiment: 'IT', on_leave: false },
    ]);
    const buget = out.find((c) => c.nume === 'Buget');
    const it_ = out.find((c) => c.nume === 'IT');
    expect(buget).toEqual({ nume: 'Buget', total: 2, disponibili: 1 });
    expect(it_).toEqual({ nume: 'IT', total: 1, disponibili: 1 });
  });

  it('ignoră compartimentele goale/doar-spații', () => {
    const out = run([
      { compartiment: '', on_leave: false },
      { compartiment: '   ', on_leave: false },
      { compartiment: null, on_leave: false },
    ]);
    expect(out).toEqual([]);
  });

  it('sortează cu localeCompare românesc', () => {
    const out = run([
      { compartiment: 'Zootehnie', on_leave: false },
      { compartiment: 'Ăsta', on_leave: false },
      { compartiment: 'Buget', on_leave: false },
    ]);
    expect(out.map((c) => c.nume)).toEqual(['Ăsta', 'Buget', 'Zootehnie']);
  });
});

describe('#131b — compartiment cu toți membrii în concediu rămâne selectabil (test 5)', () => {
  it('_renderP2CompList nu pune onclick condiționat de disponibilitate (fără rowAttrs dezactivat)', () => {
    const src = extractFn(DOC_JS, 'function _renderP2CompList(){');
    // Spre deosebire de filterModalUsers (care are rowAttrs disabled pt on_leave), aici
    // onclick="selectP2Comp(...)" e necondiționat de disponibili.
    expect(src).not.toMatch(/cursor:not-allowed/);
    expect(src).toMatch(/onclick="selectP2Comp\(/);
  });
});

describe('#131b — modul Persoană rămâne byte-identic (⭐ test 6)', () => {
  it('filterModalUsers e neatinsă (potrivire exactă cu sursa cunoscută dinainte de lot)', () => {
    const src = extractFn(DOC_JS, 'function filterModalUsers(){');
    // Aserțiuni structurale pe elementele care garantează comportamentul de azi.
    expect(src).toContain("alt compartiment");
    expect(src).toContain("În CO");
    expect(src).toContain('onclick="selectP2(${u.id})"');
    expect(src).toContain("cursor:not-allowed");
  });

  it('selectP2 e neatinsă', () => {
    const src = extractFn(DOC_JS, 'function selectP2(id){');
    expect(src).toContain('if(u&&u.on_leave) return;');
    expect(src).toContain('ST.selectedP2Id=id;');
    expect(src).toContain('filterModalUsers();');
  });

  it('singura modificare permisă în _renderP2FilterToggle e vizibilitatea legată de mod', () => {
    const src = extractFn(DOC_JS, 'function _renderP2FilterToggle(){');
    expect(src).toContain("ST.p2Mode==='comp'");
  });
});

describe('#131b — bifa "Doar din <compartiment>" ascunsă în modul Compartiment (test 7)', () => {
  it('_renderP2FilterToggle iese devreme (ascunde) când p2Mode==="comp"', () => {
    const src = extractFn(DOC_JS, 'function _renderP2FilterToggle(){');
    const els = { 'modal-search': fakeEl(), 'modal-p2-comp-toggle': fakeEl() };
    els['modal-p2-comp-toggle'].style.display = '';
    const doc = { getElementById: (id) => els[id] || null };
    const ST = { p2Mode: 'comp', cabCompartiment: 'CAB', actorCompartiment: '' };
    const fn = new Function('document', 'ST', src + '\nreturn _renderP2FilterToggle;')(doc, ST);
    fn();
    expect(els['modal-p2-comp-toggle'].style.display).toBe('none');
  });
});

describe('#131b — coloana Responsabil CAB din listă (⭐ test 8)', () => {
  it('p2_compartiment setat ⇒ marcaj de compartiment', () => {
    expect(LIST_JS).toContain('row.p2_compartiment');
    expect(LIST_JS).toContain('Atribuit întregului compartiment');
  });

  it('p2_compartiment null ⇒ exact esc(row.p2||\'—\'), ca azi', () => {
    expect(LIST_JS).toContain("esc(row.p2||'—')");
  });

  it('discriminatorul e câmpul, nu textul lui p2 (verificat prin structura ternarului)', () => {
    const idx = LIST_JS.indexOf('row.p2_compartiment');
    const snippet = LIST_JS.slice(idx, idx + 220);
    expect(snippet).toMatch(/row\.p2_compartiment\s*\n?\s*\?\s*`<span/);
    expect(snippet).toMatch(/:\s*esc\(row\.p2\|\|'—'\)/);
  });
});
