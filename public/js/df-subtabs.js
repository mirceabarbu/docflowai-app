/* df-subtabs.js — generic sub-tab switcher with sessionStorage persistence */
(function () {
  'use strict';

  function initGroup(groupEl) {
    const group = groupEl.dataset.subtabsGroup;
    if (!group) return;

    const tabs = groupEl.querySelectorAll('.df-subtab[data-subtab]');
    const container = groupEl.closest('[id]') || document.body;
    const views = container.querySelectorAll('.df-subview[data-subview]');

    function activate(name) {
      tabs.forEach(t => t.classList.toggle('active', t.dataset.subtab === name));
      views.forEach(v => v.classList.toggle('active', v.dataset.subview === name));
      try { sessionStorage.setItem('df-subtab-' + group, name); } catch (_) {}
    }

    tabs.forEach(tab => {
      tab.addEventListener('click', () => activate(tab.dataset.subtab));
    });

    // Restore from sessionStorage or default to first tab
    const saved = (() => { try { return sessionStorage.getItem('df-subtab-' + group); } catch (_) { return null; } })();
    const first = tabs[0] && tabs[0].dataset.subtab;
    const initial = saved && [...tabs].some(t => t.dataset.subtab === saved) ? saved : first;
    if (initial) activate(initial);
  }

  function init() {
    document.querySelectorAll('.df-subtabs[data-subtabs-group]').forEach(initGroup);
  }

  // Programmatic API
  window.showSubtab = function (group, name) {
    const groupEl = document.querySelector('.df-subtabs[data-subtabs-group="' + group + '"]');
    if (!groupEl) return;
    const tab = groupEl.querySelector('.df-subtab[data-subtab="' + name + '"]');
    if (tab) tab.click();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
