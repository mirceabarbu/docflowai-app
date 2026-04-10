/**
 * server/modules/flows/transitions.mjs — Flow state machine
 */

import { AppError } from '../../core/errors.mjs';

export const FLOW_STATUS = {
  DRAFT:       'draft',
  ACTIVE:      'active',
  IN_PROGRESS: 'in_progress',
  COMPLETED:   'completed',
  REFUSED:     'refused',
  CANCELLED:   'cancelled',
};

export const SIGNER_STATUS = {
  PENDING:   'pending',
  CURRENT:   'current',
  COMPLETED: 'completed',
  REFUSED:   'refused',
  SKIPPED:   'skipped',
};

// Valid from → [to...] transitions
const VALID = {
  [FLOW_STATUS.DRAFT]:       [FLOW_STATUS.ACTIVE, FLOW_STATUS.CANCELLED],
  [FLOW_STATUS.ACTIVE]:      [FLOW_STATUS.IN_PROGRESS, FLOW_STATUS.CANCELLED],
  [FLOW_STATUS.IN_PROGRESS]: [FLOW_STATUS.IN_PROGRESS, FLOW_STATUS.COMPLETED, FLOW_STATUS.REFUSED, FLOW_STATUS.CANCELLED],
};

export function canTransition(from, to) {
  return VALID[from]?.includes(to) ?? false;
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new AppError(
      `Tranziție invalidă: ${from} → ${to}`,
      409,
      'INVALID_TRANSITION'
    );
  }
}
