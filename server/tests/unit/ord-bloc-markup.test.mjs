// @vitest-environment happy-dom
/**
 * #128h — structura de markup a blocurilor ORD din public/formular.html.
 * Garanția centrală (§2.a din prompt): `data-bloc` NU mai stă pe #form-ordnt, ci pe un
 * container `.ord-bloc` care înfășoară EXACT BLOC P1 + BLOC P2. Dacă cineva îl mută înapoi,
 * rândurile blocurilor 2+ s-ar scurge în colectarea/totalurile blocului 0 — bug tăcut pe bani.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
let doc;

beforeAll(() => {
  const html = readFileSync(join(__dir, '../../../public/formular.html'), 'utf8')
    // fără <link>/<script>: happy-dom ar încerca fetch-uri reale către localhost (zgomot în output)
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '');
  document.documentElement.innerHTML = html;
  doc = document;
});

describe('#128h — markup blocuri ORD', () => {
  it('#form-ordnt NU mai poartă data-bloc; există EXACT un container .ord-bloc[data-bloc="0"]', () => {
    const form = doc.getElementById('form-ordnt');
    expect(form).toBeTruthy();
    expect(form.hasAttribute('data-bloc')).toBe(false);

    const blocuri = doc.querySelectorAll('[data-bloc]');
    expect(blocuri.length).toBe(1);
    expect(blocuri[0].classList.contains('ord-bloc')).toBe(true);
    expect(blocuri[0].getAttribute('data-bloc')).toBe('0');
  });

  it('containerul blocului 0 înfășoară BLOC P1 + BLOC P2 (și tabelul lor), dar NU antetul și nici zona de rezultat/flux', () => {
    const b0 = doc.querySelector('.ord-bloc[data-bloc="0"]');
    expect(b0.querySelector('#bloc-ord-p1')).toBeTruthy();
    expect(b0.querySelector('#bloc-ord-p2')).toBeTruthy();
    expect(b0.querySelector('#o-tbody')).toBeTruthy();
    // nr_unic_inreg e UNIC PE DOCUMENT ⇒ rămâne în BLOC ANTET, în afara blocului
    expect(b0.querySelector('#o-nrUnic')).toBeNull();
    expect(doc.getElementById('o-nrUnic')).toBeTruthy();
    // rezultat PDF / flux rămân în afara blocului
    expect(b0.querySelector('#result-ordnt')).toBeNull();
    expect(b0.querySelector('#ff-ordnt')).toBeNull();
  });

  it('blocul 0 stă în gazda #ord-blocuri, iar butonul de adăugare e în AFARA ei (frații se adaugă în gazdă)', () => {
    const host = doc.getElementById('ord-blocuri');
    expect(host).toBeTruthy();
    expect(host.querySelector('.ord-bloc[data-bloc="0"]').parentElement).toBe(host);
    const btn = doc.getElementById('btn-add-bloc');
    expect(btn).toBeTruthy();
    expect(btn.closest('#ord-blocuri')).toBeNull();
    expect(btn.getAttribute('onclick')).toContain('addBlocOrd');
  });

  it('celulele de total ale blocului 0 poartă AMBELE — id="o-t-*" și data-tot', () => {
    [['o-t-rec', 'rec'], ['o-t-plati', 'plati'], ['o-t-suma', 'suma'], ['o-t-neplat', 'neplat']]
      .forEach(([id, tot]) => {
        const el = doc.getElementById(id);
        expect(el, id).toBeTruthy();
        expect(el.getAttribute('data-tot')).toBe(tot);
      });
    expect(doc.querySelectorAll('[data-tot]').length).toBe(4);
  });
});
