// @vitest-environment happy-dom
//
// Regresie SECURITATE — stored XSS în toast-ul de notificări (v3.9.677).
//
// docName e text liber (crud.mjs), interpolat în mesajul notificării, împins prin
// WebSocket. Înainte de fix, showToast() îl randa prin `innerHTML` → un payload de
// tip `<img src=x onerror=...>` executa cod în browserul victimei.
//
// Fixul: showToast() construiește DOM-ul cu createElement + textContent (imun prin
// construcție). Acest test importă showToast DIRECT din producție (public/notif-widget.js),
// NU o copie — expusă pe window.docflow.showToast. notif-widget.js e script clasic (IIFE):
// importul îl execută în contextul global happy-dom și publică funcția. init() e gardat pe
// localStorage (gol în test) și push-ul pe serviceWorker (absent în happy-dom), deci
// importul nu are efecte secundare de rețea.

import { describe, it, expect, beforeAll } from 'vitest';

let showToast;

beforeAll(async () => {
  await import('../../../public/notif-widget.js');
  showToast = window.docflow.showToast;
});

// Payload-uri EXECUTABILE — dacă vreunul e interpretat ca HTML, testul trebuie să pice.
const PAYLOADS = [
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned=1</script>',
  '<svg/onload=window.__pwned=1>',
];

function renderToast(message) {
  // showToast are nevoie de zona de toast în DOM, altfel iese devreme.
  let area = document.getElementById('nw-toast-area');
  if (!area) {
    area = document.createElement('div');
    area.id = 'nw-toast-area';
    document.body.appendChild(area);
  }
  area.replaceChildren();
  showToast({ type: 'INFO', title: 'Notificare', message });
  return area.querySelector('.nw-toast');
}

describe('showToast — regresie stored XSS (v3.9.677)', () => {
  it('importă funcția reală din producție (nu o copie)', () => {
    expect(typeof showToast).toBe('function');
  });

  for (const payload of PAYLOADS) {
    it(`neutralizează payload executabil: ${payload}`, () => {
      delete window.__pwned;

      const toast = renderToast(payload);
      expect(toast).toBeTruthy();

      // Structura DOM rămâne intactă (aceleași două div-uri, aceleași clase).
      const titleEl = toast.querySelector('.nw-toast-title');
      const msgEl = toast.querySelector('.nw-toast-msg');
      expect(titleEl).toBeTruthy();
      expect(msgEl).toBeTruthy();

      // (a) OBLIGATORIU: niciun element periculos creat din payload.
      expect(toast.querySelector('img, script, svg')).toBeNull();

      // (b) OBLIGATORIU: payload-ul apare ca TEXT literal în mesaj.
      expect(msgEl.textContent).toContain(payload);

      // (c) OBLIGATORIU: payload-ul NU a fost interpretat ca HTML.
      expect(msgEl.innerHTML).not.toContain('<img');
      expect(msgEl.innerHTML).not.toContain('<script');
      expect(msgEl.innerHTML).not.toContain('<svg');

      // Bonus (mediile DOM nu execută fiabil onerror/inline scripts, deci
      // rămâne undefined și pe cod vulnerabil — nu e aserția principală).
      expect(window.__pwned).toBeUndefined();
    });
  }
});
