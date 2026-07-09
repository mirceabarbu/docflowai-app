(function(){
  const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // opts: { filename, sizeBytes, mimeType, canPreview, previewUrl, previewOnclick, downloadHref, downloadName }
  window.renderFileItem = function(opts){
    const o = opts || {};
    const name = esc(o.filename || '');
    const kb   = (o.sizeBytes != null) ? `<span class="df-file-item__size">· ${(o.sizeBytes/1024).toFixed(0)} KB</span>` : '';
    let preview = '';
    if (o.canPreview && o.previewUrl) {
      preview = `<button type="button" class="df-file-item__btn" data-att-action="preview" data-preview-url="${esc(o.previewUrl)}" data-filename="${name}" data-mime="${esc(o.mimeType||'')}"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-search"/></svg>Previzualizează</button>`;
    } else if (o.canPreview && o.previewOnclick) {
      preview = `<a href="#" class="df-file-item__btn" onclick="${o.previewOnclick}"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-search"/></svg>Previzualizează</a>`;
    } else if (o.canPreview && o.previewAttId) {
      preview = `<button type="button" class="df-file-item__btn" data-att-action="preview" data-att-id="${esc(o.previewAttId)}"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-search"/></svg>Previzualizează</button>`;
    }
    const download = o.downloadHref
      ? `<a class="df-file-item__btn" href="${esc(o.downloadHref)}" download="${esc((o.downloadName||o.filename||'').replace(/"/g,''))}"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-download"/></svg>Descarcă</a>`
      : '';
    const del = (o.canDelete && o.deleteOnclick)
      ? `<button type="button" class="df-file-item__btn df-file-item__btn--danger" onclick="${o.deleteOnclick}"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-x"/></svg>Șterge</button>`
      : '';
    const wrapCls = 'df-file-item' + (o.isError ? ' df-file-item--err' : '');
    const wrapTitle = (o.isError && o.errorTitle) ? ` title="${esc(o.errorTitle)}"` : '';
    return `<div class="${wrapCls}"${wrapTitle}>
      <svg class="df-file-item__ico df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-paperclip"/></svg>
      <span class="df-file-item__name" title="${name}">${name}</span>
      ${kb}
      <span class="df-file-item__actions">${preview}${download}${del}</span>
    </div>`;
  };
})();
