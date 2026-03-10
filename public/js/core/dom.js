window.DocFlowDom = {
  qs: (sel, root=document) => root.querySelector(sel),
  qsa: (sel, root=document) => Array.from(root.querySelectorAll(sel)),
  setText(el, value) { if (el) el.textContent = value ?? ''; },
  show(el, display='block') { if (el) el.style.display = display; },
  hide(el) { if (el) el.style.display = 'none'; },
};
