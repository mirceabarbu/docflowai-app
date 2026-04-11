/**
 * server/core/pagination.mjs — pagination helpers.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Parse page/limit from Express query params.
 * @returns {{ page: number, limit: number, offset: number }}
 */
export function parsePagination(query = {}) {
  let page = parseInt(query.page, 10) || 1;
  let limit = parseInt(query.limit, 10) || DEFAULT_LIMIT;

  if (page < 1) page = 1;
  if (limit < 1) limit = 1;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  return { page, limit, offset: (page - 1) * limit };
}

/**
 * Build pagination metadata for API responses.
 * @returns {{ total: number, page: number, limit: number, pages: number }}
 */
export function buildPaginationMeta(total, page, limit) {
  return {
    total,
    page,
    limit,
    pages: Math.ceil(total / limit) || 1,
  };
}
