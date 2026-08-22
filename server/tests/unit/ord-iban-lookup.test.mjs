// #141 — teste structurale pentru verificarea IBAN în ORD (frontend, list.js + core.js).
// Pe tiparul lui alop-header-df-actual.test.mjs — readFileSync + verificări de formă.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('ORD — verificare IBAN beneficiar (#141)', () => {
  it('list.js definește _lookupByIban și îl exportă pe window', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    expect(src).toMatch(/async function _lookupByIban\(target\)/);
    expect(src).toMatch(/window\._lookupByIban\s*=\s*_lookupByIban;/);
  });

  it('delegarea focusout acoperă [data-fld="iban_beneficiar"]', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    expect(src).toMatch(/matches\('\[data-fld="iban_beneficiar"\]'\)\)_lookupByIban\(t\)/);
  });

  it('⭐⭐ data-role="ibanb-spin" și data-role="iban-status" există în AMBELE fișiere', () => {
    const html = readFileSync(path.join(REPO, 'public/formular.html'), 'utf8');
    const core = readFileSync(path.join(REPO, 'public/js/formular/core.js'), 'utf8');
    expect(html).toMatch(/data-role="ibanb-spin"/);
    expect(html).toMatch(/data-role="iban-status"/);
    expect(core).toMatch(/data-role="ibanb-spin"/);
    expect(core).toMatch(/data-role="iban-status"/);
  });

  it('_lookupByIban conține garda de cursă (recitire câmp înainte de aplicare)', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    const m = src.match(/async function _lookupByIban\(target\)[\s\S]*?\nwindow\._lookupByIban/);
    expect(m, 'corpul _lookupByIban nu a fost găsit').toBeTruthy();
    const body = m[0];
    expect(body).toMatch(/Garda de cursă/);
    expect(body).toMatch(/const cur=_bFld\(bloc,'iban_beneficiar'\);/);
  });

  it('list.js folosește esc( în randarea badge-ului de IBAN', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    const m = src.match(/async function _lookupByIban\(target\)[\s\S]*?\nwindow\._lookupByIban/);
    expect(m).toBeTruthy();
    expect(m[0]).toMatch(/esc\(/);
  });

  it('câmpul "Bancă beneficiar" nu se suprascrie niciodată când e deja completat', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    const m = src.match(/async function _lookupByIban\(target\)[\s\S]*?\nwindow\._lookupByIban/);
    expect(m).toBeTruthy();
    expect(m[0]).toMatch(/if\(!declared\)\{/);
  });
});
