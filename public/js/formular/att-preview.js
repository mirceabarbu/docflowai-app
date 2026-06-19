// public/js/formular/att-preview.js
// DocFlowAI — Preview inline (modal) pentru atașamentele DF/ORD deja uploadate.
// Read-only: doar randare, NU schimbă stocarea. Reutilizează pdf.js (aceeași
// sursă CDN + worker ca semdoc-signer.html — vezi formular.html <head>).
//
// API public: window.openAttPreview(url, filename, mimeType), window.closeAttPreview()

(function() {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) { return (window.df && window.df.esc) ? window.df.esc(s) : String(s == null ? '' : s); }

  function isPdf(mime, name) {
    if (mime === 'application/pdf') return true;
    return /\.pdf$/i.test(name || '');
  }
  function isImage(mime, name) {
    if (mime && mime.indexOf('image/') === 0) return true;
    return /\.(png|jpe?g|webp|gif|bmp)$/i.test(name || '');
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
    const modal = $('att-preview-modal');
    const body = $('att-preview-body');
    const title = $('att-preview-title');
    const dl = $('att-preview-download');
    if (!modal || !body) return;

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
        const container = document.createElement('div');
        container.style.cssText = 'max-height:70vh;overflow-y:auto;background:rgba(0,0,0,.15);border:1px solid var(--df-border-2);border-radius:10px;padding:8px;';
        body.innerHTML = '';
        body.appendChild(container);
        await renderPdfInto(container, buf);
      } else if (isImage(mimeType, filename)) {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
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
  }

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
})();
