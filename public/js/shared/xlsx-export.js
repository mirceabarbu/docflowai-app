/**
 * public/js/shared/xlsx-export.js
 *
 * DFXlsx — modul partajat de export XLSX real (SheetJS încărcat leneș de pe cdnjs),
 * pe tiparul deja folosit de Clasa 8 (public/js/formular/clasa8.js:165-244).
 *
 * Script CLASIC (fără `type="module"`) — expune window.DFXlsx.
 * #133a: fundație fără consumatori încă — primul consumator e list.js (Etapa 4).
 */
(function () {
  'use strict';

  const SHEETJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  let _loading = null;

  function load() {
    if (typeof window.XLSX !== 'undefined') return Promise.resolve();
    if (_loading) return _loading;
    _loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SHEETJS_CDN;
      s.async = true;
      s.onload  = () => resolve();
      s.onerror = () => { _loading = null; reject(new Error('SheetJS load failed (CDN inaccesibil?)')); };
      document.head.appendChild(s);
    });
    return _loading;
  }

  function _withDateSuffix(filename) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const suffix = '_' + dateStr;
    if (filename.includes(suffix)) return filename;
    const dot = filename.lastIndexOf('.');
    if (dot === -1) return filename + suffix;
    return filename.slice(0, dot) + suffix + filename.slice(dot);
  }

  async function save(aoa, opts) {
    opts = opts || {};
    await load();
    if (typeof window.XLSX === 'undefined') throw new Error('XLSX indisponibil după load');

    const numericCols = Array.isArray(opts.numericCols) ? opts.numericCols : [];
    const ws = window.XLSX.utils.aoa_to_sheet(aoa);

    if (numericCols.length && aoa.length > 1) {
      const range = window.XLSX.utils.decode_range(ws['!ref']);
      for (let R = 1; R <= range.e.r; R++) {
        for (const C of numericCols) {
          const ref = window.XLSX.utils.encode_cell({ r: R, c: C });
          const cell = ws[ref];
          if (!cell) continue;
          const n = Number(cell.v);
          if (Number.isFinite(n)) {
            cell.v = n;
            cell.t = 'n';
            cell.z = '#,##0.00';
          }
          // valoare non-numerică: celula rămâne TEXT, fără NaN și fără 0 inventat
        }
      }
    }

    if (Array.isArray(opts.cols)) ws['!cols'] = opts.cols;

    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, opts.sheet || 'Sheet1');

    const filename = _withDateSuffix(opts.filename || 'export.xlsx');
    window.XLSX.writeFile(wb, filename);
  }

  window.DFXlsx = { load, save };
})();
