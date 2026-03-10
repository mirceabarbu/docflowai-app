export function normalizeSearchTerm(v) {
  return String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function escapeLike(v) {
  return String(v || '').replace(/[%_\\]/g, '\\$&');
}
