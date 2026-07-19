/**
 * public/js/shared/pagin.js
 *
 * Componentă partajată de paginare — consolidează cele șase implementări
 * separate din frontend (formular/list.js, formular/alop.js, admin/flows.js,
 * admin/users.js, admin/audit.js, admin/primarii.js), câte una din fiecare
 * din cele două familii vizuale legitime: 'simple' (prev/next) și
 * 'numbered' (prev/next + butoane numerotate cu „…").
 *
 * Script CLASIC (fără `type="module"`), la fel ca restul fișierelor din
 * public/js/ — încărcat explicit de fiecare pagină consumatoare, ÎNAINTE
 * de scripturile care apelează DFPagin.render(...). Expune window.DFPagin.
 */
(function () {
  'use strict';

  function pageWindow(page, totalPages, maxVisible) {
    maxVisible = maxVisible || 7;
    totalPages = Math.floor(Number(totalPages)) || 0;
    if (totalPages <= 0) return [];

    page = Math.floor(Number(page));
    if (!Number.isFinite(page)) page = 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    if (totalPages <= maxVisible) {
      var all = [];
      for (var p = 1; p <= totalPages; p++) all.push(p);
      return all;
    }

    var windowStart = Math.max(1, page - 2);
    var windowEnd = Math.min(totalPages, page + 2);

    var set = {};
    set[1] = true;
    set[totalPages] = true;
    for (var w = windowStart; w <= windowEnd; w++) set[w] = true;

    var sorted = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });

    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      if (i === 0) { out.push(sorted[i]); continue; }
      var prev = sorted[i - 1];
      var cur = sorted[i];
      var gap = cur - prev;
      if (gap === 1) {
        out.push(cur);
      } else if (gap === 2) {
        // gol de exact o pagină — se umple, nu se pune „…"
        out.push(prev + 1, cur);
      } else {
        out.push('…', cur);
      }
    }
    return out;
  }

  function resolveContainer(container) {
    if (typeof container === 'string') return document.getElementById(container);
    return container || null;
  }

  function mkButton(text, className, disabled, onClick) {
    var btn = document.createElement('button');
    btn.className = className;
    btn.textContent = text;
    btn.disabled = !!disabled;
    if (!disabled && onClick) btn.addEventListener('click', onClick);
    return btn;
  }

  function render(opts) {
    opts = opts || {};
    var container = resolveContainer(opts.container);
    if (!container) return;

    container.replaceChildren();

    var total = Number(opts.total);
    if (!Number.isFinite(total) || total < 0) total = 0;

    var limit = Number(opts.limit);
    var totalPages;
    if (!Number.isFinite(limit) || limit <= 0) {
      totalPages = 1;
    } else {
      totalPages = Math.ceil(total / limit) || 1;
    }

    var page = Math.floor(Number(opts.page));
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    var mode = opts.mode || 'simple';
    var onChange = opts.onChange;

    if (totalPages <= 1) {
      container.style.display = 'none';
      return;
    }

    if (mode === 'numbered') {
      container.style.display = '';
      container.className = 'pagination';

      container.appendChild(mkButton('◀', 'pg-btn', page <= 1, function () { onChange(page - 1); }));

      var from = (page - 1) * limit + 1;
      var to = Math.min(page * limit, total);
      var info = document.createElement('span');
      info.className = 'pg-info';
      info.textContent = from + '–' + to + ' din ' + total;
      container.appendChild(info);

      var maxVisible = opts.maxVisible || 7;
      var win = pageWindow(page, totalPages, maxVisible);
      win.forEach(function (p) {
        if (p === '…') {
          var dots = document.createElement('span');
          dots.className = 'pg-info';
          dots.textContent = '…';
          container.appendChild(dots);
          return;
        }
        var isActive = p === page;
        var btn = document.createElement('button');
        btn.className = 'pg-btn' + (isActive ? ' active' : '');
        btn.textContent = String(p);
        if (!isActive) {
          btn.addEventListener('click', (function (pp) {
            return function () { onChange(pp); };
          })(p));
        }
        container.appendChild(btn);
      });

      container.appendChild(mkButton('▶', 'pg-btn', page >= totalPages, function () { onChange(page + 1); }));
      return;
    }

    // mode 'simple'
    container.style.display = 'flex';
    container.className = 'lst-pagination';

    container.appendChild(mkButton('← Anterior', 'df-action-btn sm', page <= 1, function () { onChange(page - 1); }));

    var infoS = document.createElement('span');
    infoS.className = 'lst-page-info';
    infoS.textContent = 'Pagina ' + page + ' din ' + totalPages + ' (' + total + ' total)';
    container.appendChild(infoS);

    container.appendChild(mkButton('Următor →', 'df-action-btn sm', page >= totalPages, function () { onChange(page + 1); }));
  }

  window.DFPagin = {
    pageWindow: pageWindow,
    render: render,
  };
})();
