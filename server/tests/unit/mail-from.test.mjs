import { describe, it, expect } from 'vitest';
import { expeditorExtern, adresaDin, curataNumeExpeditor } from '../../services/mail-from.mjs';

describe('mail-from #180 — expeditorExtern', () => {
  it('1. compune Nume <adresa> din numele instituției + MAIL_FROM standard', () => {
    expect(expeditorExtern('Primaria Zarnesti', 'DocFlowAI <noreply@docflowai.ro>'))
      .toBe('Primaria Zarnesti <noreply@docflowai.ro>');
  });

  it('2. MAIL_FROM fără paranteze unghiulare tot se compune corect', () => {
    expect(expeditorExtern('Primaria Zarnesti', 'noreply@docflowai.ro'))
      .toBe('Primaria Zarnesti <noreply@docflowai.ro>');
  });

  it('3. injecție de antet — CRLF + antet Bcc fals sunt neutralizate', () => {
    const nume = 'Primaria\r\nBcc: atacator@rau.com';
    const out = expeditorExtern(nume, 'DocFlowAI <noreply@docflowai.ro>');
    expect(out).not.toMatch(/\r|\n/);
    expect(out).not.toMatch(/Bcc:/);
    expect(out.split('\n').length).toBe(1);
  });

  it('4. caractere speciale ("<>,;) sunt eliminate, antetul rămâne valid', () => {
    const nume = 'Primaria "Zarnesti", <Test>; Info';
    const out = expeditorExtern(nume, 'DocFlowAI <noreply@docflowai.ro>');
    expect(out).toBe('Primaria Zarnesti Test Info <noreply@docflowai.ro>');
  });

  it('5. nume gol/null/doar spații ⇒ MAIL_FROM neschimbat', () => {
    expect(expeditorExtern('', 'DocFlowAI <noreply@docflowai.ro>')).toBe('DocFlowAI <noreply@docflowai.ro>');
    expect(expeditorExtern(null, 'DocFlowAI <noreply@docflowai.ro>')).toBe('DocFlowAI <noreply@docflowai.ro>');
    expect(expeditorExtern('   ', 'DocFlowAI <noreply@docflowai.ro>')).toBe('DocFlowAI <noreply@docflowai.ro>');
  });

  it('6. MAIL_FROM invalid (fără @) ⇒ întoarce ce a primit, fără să arunce', () => {
    expect(() => expeditorExtern('Primaria Zarnesti', 'nu-e-un-email')).not.toThrow();
    expect(expeditorExtern('Primaria Zarnesti', 'nu-e-un-email')).toBe('nu-e-un-email');
  });

  it('7. nume peste 78 de caractere e tăiat la 78', () => {
    const numeLung = 'A'.repeat(100);
    const out = expeditorExtern(numeLung, 'DocFlowAI <noreply@docflowai.ro>');
    const numePartea = out.replace(/ <.*>$/, '');
    expect(numePartea.length).toBe(78);
  });

  it('8. diacritice sunt păstrate intacte', () => {
    expect(expeditorExtern('Primăria Orașului Zărnești', 'DocFlowAI <noreply@docflowai.ro>'))
      .toBe('Primăria Orașului Zărnești <noreply@docflowai.ro>');
  });
});

describe('mail-from #180 — helpers', () => {
  it('adresaDin extrage adresa din forma Nume <a@b.c>', () => {
    expect(adresaDin('DocFlowAI <noreply@docflowai.ro>')).toBe('noreply@docflowai.ro');
  });

  it('adresaDin acceptă adresa simplă fără paranteze', () => {
    expect(adresaDin('noreply@docflowai.ro')).toBe('noreply@docflowai.ro');
  });

  it('adresaDin întoarce "" pentru valoare invalidă', () => {
    expect(adresaDin('nu-e-un-email')).toBe('');
  });

  it('curataNumeExpeditor elimină CRLF și caractere de antet', () => {
    expect(curataNumeExpeditor('A\r\nB "C" <D>,E;F')).toBe('A B C DEF');
  });
});
