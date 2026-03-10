window.DocFlowFormat = {
  date(v) { try { return v ? new Date(v).toLocaleDateString('ro-RO') : ''; } catch { return ''; } },
  sizeMB(bytes) { return Math.round((Number(bytes)||0)/1024/1024*100)/100; }
};
