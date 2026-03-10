(function(){
  function normalize(v) {
    return String(v || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  function flowMatchesSearch(flow, term) {
    const q = normalize(term);
    if (!q) return true;
    const hay = [
      flow.flowId,
      flow.docName,
      flow.initName,
      flow.initEmail,
      flow.institutie,
      flow.compartiment,
      ...(flow.signers || []).flatMap(s => [s.name, s.email, s.rol, s.functie, s.compartiment])
    ].map(normalize).filter(Boolean);
    return hay.some(v => v.includes(q));
  }

  function getFlowDownloadState(flow) {
    const status = String(flow.status || '').toLowerCase();
    const signers = Array.isArray(flow.signers) ? flow.signers : [];
    const isRefused = signers.some(s => s.status === 'refused') || status === 'refused';
    const isCancelled = status === 'cancelled';
    const isReviewRequested = status === 'review_requested';
    const successFinal = !!flow.allSigned && !isRefused && !isCancelled && !isReviewRequested;
    const hasSignedPdf = !!(flow.canDownloadSignedPdf || flow.hasSignedPdf);
    return {
      successFinal,
      hasSignedPdf,
      canDownload: !!flow.canDownloadSignedPdf || (successFinal && hasSignedPdf),
      processing: !!flow.processingSignedPdf || (successFinal && !hasSignedPdf),
    };
  }

  function ensureFreshSearchInput(inputId, onInput) {
    const old = document.getElementById(inputId);
    if (!old || old.dataset.dfFresh === '1') return old;
    const parent = old.parentNode;
    if (!parent) return old;
    const clone = old.cloneNode(true);
    clone.value = '';
    clone.defaultValue = '';
    clone.setAttribute('value', '');
    clone.setAttribute('name', 'q_' + Math.random().toString(36).slice(2));
    clone.setAttribute('autocomplete', 'new-password');
    clone.setAttribute('data-form-type', 'other');
    clone.setAttribute('readonly', 'readonly');
    clone.dataset.dfFresh = '1';
    clone._userTyped = false;
    clone.removeAttribute('oninput');
    clone.removeAttribute('onfocus');
    clone.addEventListener('focus', () => clone.removeAttribute('readonly'));
    clone.addEventListener('input', () => {
      clone._userTyped = true;
      if (typeof onInput === 'function') onInput();
    });
    parent.replaceChild(clone, old);
    const reset = () => {
      if (!clone._userTyped) {
        clone.value = '';
        clone.defaultValue = '';
        clone.setAttribute('value', '');
      }
    };
    reset();
    setTimeout(reset, 0);
    setTimeout(reset, 50);
    setTimeout(reset, 250);
    window.addEventListener('pageshow', reset);
    window.addEventListener('focus', reset);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reset();
    });
    return clone;
  }

  window.DocFlowMyFlows = {
    normalize,
    flowMatchesSearch,
    getFlowDownloadState,
    ensureFreshSearchInput,
  };
})();
