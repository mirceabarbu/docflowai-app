// public/js/shared/att-preview.js
// DocFlowAI — Preview inline (modal) pentru atașamente, shared între DF/ORD
// (formular.html) și semnare/flux (semdoc-signer.html). Read-only: doar
// randare, NU schimbă stocarea. Reutilizează pdf.js deja încărcat de
// pagina-gazdă (același CDN/versiune ca formular.html și semdoc-signer.html).
//
// Self-contained: dacă markup-ul modalului (#att-preview-modal) NU există deja
// în DOM (cazul DF/ORD — injectat static în formular.html), componenta îl
// creează idempotent la primul apel. Stilul (.df-modal/.df-modal-bg) vine din
// public/css/df/components.css, încărcat pe ambele pagini — nicio regulă CSS
// proprie aici (CSP-safe, fără <style> inline).
//
// API public: window.openAttPreview(url, filename, mimeType), window.closeAttPreview()

(function() {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) { return (window.df && window.df.esc) ? window.df.esc(s) : String(s == null ? '' : s); }

  let _lastPreviewBlob = null;

  function isPdf(mime, name) {
    if (mime === 'application/pdf') return true;
    return /\.pdf$/i.test(name || '');
  }
  function isImage(mime, name) {
    if (mime && mime.indexOf('image/') === 0) return true;
    return /\.(png|jpe?g|webp|gif|bmp)$/i.test(name || '');
  }

  // Creează markup-ul modalului dacă pagina-gazdă nu îl are deja static
  // (DF/ORD îl are din formular.html — atunci doar îl reutilizează).
  function ensureModal() {
    let modal = $('att-preview-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'att-preview-modal';
    modal.className = 'df-modal-bg';
    modal.innerHTML =
      '<div class="df-modal" style="max-width:860px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px">' +
          '<h3 id="att-preview-title" style="margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Previzualizare atașament</h3>' +
          '<button type="button" class="df-action-btn sm icon-only" onclick="closeAttPreview()" title="Închide">' +
            '<svg class="df-ico"><use href="/icons.svg#ico-x"/></svg>' +
          '</button>' +
        '</div>' +
        '<div id="att-preview-body" style="min-height:160px"></div>' +
        '<div class="df-modal-footer">' +
          '<a id="att-preview-download" class="df-action-btn" href="#" target="_blank" download>' +
            '<svg class="df-ico"><use href="/icons.svg#ico-download"/></svg> Descarcă' +
          '</a>' +
          '<button type="button" id="att-preview-print" class="df-action-btn" onclick="printAttPreview()" title="Printează">' +
            '<svg class="df-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print' +
          '</button>' +
          '<button type="button" class="df-action-btn primary" onclick="closeAttPreview()">Închide</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeAttPreview(); });
    return modal;
  }

  function waitForPdfJs() {
    return new Promise((resolve, reject) => {
      if (window.pdfjsLib) return resolve();
      let waited = 0;
      const iv = setInterval(() => {
        waited += 150;
        if (window.pdfjsLib) { clearInterval(iv); resolve(); }
        else if (waited > 6000) { clearInterval(iv); reject(new Error('PDF.js indisponibil')); }
      }, 150);
    });
  }

  async function renderPdfInto(container, arrayBuffer) {
    await waitForPdfJs();
    const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    container.innerHTML = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1.4 });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.style.cssText = 'display:block;width:100%;margin-bottom:8px;border-radius:6px;';
      container.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    }
  }

  async function openAttPreview(url, filename, mimeType) {
    const modal = ensureModal();
    const body = $('att-preview-body');
    const title = $('att-preview-title');
    const dl = $('att-preview-download');
    if (!modal || !body) return;

    _lastPreviewBlob = null;
    title.textContent = filename || 'Previzualizare atașament';
    if (dl) { dl.href = url; dl.setAttribute('download', filename || ''); }
    body.innerHTML = '<p style="color:var(--df-text-3);text-align:center;padding:40px 0">Se încarcă documentul...</p>';
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';

    try {
      if (isPdf(mimeType, filename)) {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const buf = await resp.arrayBuffer();
        _lastPreviewBlob = new Blob([buf], { type: 'application/pdf' });
        const container = document.createElement('div');
        container.style.cssText = 'max-height:70vh;overflow-y:auto;background:rgba(0,0,0,.15);border:1px solid var(--df-border-2);border-radius:10px;padding:8px;';
        body.innerHTML = '';
        body.appendChild(container);
        await renderPdfInto(container, buf);
      } else if (isImage(mimeType, filename)) {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        _lastPreviewBlob = blob;
        const objUrl = URL.createObjectURL(blob);
        const img = document.createElement('img');
        img.src = objUrl;
        img.style.cssText = 'max-width:100%;max-height:70vh;display:block;margin:0 auto;border-radius:8px;';
        img.onload = () => URL.revokeObjectURL(objUrl);
        body.innerHTML = '';
        body.appendChild(img);
      } else {
        body.innerHTML = '<p style="text-align:center;padding:40px 0;color:var(--df-text-3)">Previzualizare indisponibilă pentru acest tip de fișier — folosiți butonul de descărcare.</p>';
      }
    } catch (e) {
      body.innerHTML = '<p style="text-align:center;padding:40px 0;color:var(--df-danger)">Eroare la încărcarea previzualizării: ' + esc(e.message) + '</p>';
    }
  }

  function closeAttPreview() {
    const modal = $('att-preview-modal');
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
    const body = $('att-preview-body');
    if (body) body.innerHTML = '';
    _lastPreviewBlob = null;
    const printFrame = $('att-preview-print-frame');
    if (printFrame) printFrame.remove();
  }

  function printAttPreview() {
    if (!_lastPreviewBlob) {
      const dl = $('att-preview-download');
      const url = dl && dl.getAttribute('href');
      if (url && url !== '#') window.open(url, '_blank');
      return;
    }
    const blobUrl = URL.createObjectURL(_lastPreviewBlob);
    const old = $('att-preview-print-frame');
    if (old) old.remove();
    const frame = document.createElement('iframe');
    frame.id = 'att-preview-print-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    frame.src = blobUrl;
    frame.onload = () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      catch (e) { window.open(blobUrl, '_blank'); }
      setTimeout(() => { try { URL.revokeObjectURL(blobUrl); frame.remove(); } catch (_) {} }, 60000);
    };
    document.body.appendChild(frame);
  }

  // Caz DF/ORD: markup-ul există deja static în formular.html la parse time
  // — atașăm handler-ul de close-on-backdrop direct pe el (byte-identic cu
  // comportamentul de azi). Caz signer: markup-ul nu există încă aici —
  // ensureModal() îl creează + atașează handler-ul la primul openAttPreview().
  document.addEventListener('DOMContentLoaded', () => {
    const modal = $('att-preview-modal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeAttPreview(); });
  });
  document.addEventListener('keydown', (e) => {
    const modal = $('att-preview-modal');
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) closeAttPreview();
  });

  window.openAttPreview = openAttPreview;
  window.closeAttPreview = closeAttPreview;
  window.printAttPreview = printAttPreview;
})();
