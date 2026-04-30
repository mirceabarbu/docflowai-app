// DocFlowAI — helper email pentru semdoc-initiator.html.
// Funcțiile change-password sunt acum gestionate global de df-user-modals.js
// (modalul partajat cu toate paginile aplicației).

window._openEmailForFlow = function(flowId) {
  const f = (window._flowsEmailData || {})[flowId] || {};
  DFEmailModal.open(flowId, {
    docName: f.docName, institutie: f.institutie, compartiment: f.compartiment,
    onSuccess: () => { if (typeof loadMyFlows === 'function') loadMyFlows(_fluxPage); },
  });
};
