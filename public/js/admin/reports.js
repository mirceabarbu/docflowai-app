async function downloadTrustReport(flowId, btnEl) {
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳'; }
  try {
    const r = await fetch(`/api/flows/${encodeURIComponent(flowId)}/report?force=1`, {
      credentials: 'include',
      headers: { 'Accept': 'application/pdf, application/json' },
    });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || ct.includes('json')) {
      let msg = `Eroare ${r.status}`;
      try { const j = await r.json(); msg = j?.message || j?.error || msg; } catch {}
      throw new Error(msg);
    }
    const blob = await r.blob();
    if (!blob || blob.size < 200) throw new Error(`PDF invalid (${blob?.size || 0} bytes)`);
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = `TrustReport_${flowId}.pdf`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch(e) {
    alert('❌ Eroare raport: ' + e.message);
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '📜'; }
  }
}
