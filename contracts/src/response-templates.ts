import type {
  Clarification,
  ClarificationReasonCode,
  Refusal,
  RefusalReasonCode,
} from './schemas.js';

export const CLARIFICATION_QUESTION_TEMPLATES = {
  missing_topic: 'What kind of dataset are you looking for?',
  too_vague: 'What kind of dataset does your project need?',
} as const satisfies Record<ClarificationReasonCode, string>;

export const GENERIC_REFUSAL_MESSAGE =
  'This request cannot be handled. Please try a different public dataset search.';

export function createClarification(
  reasonCode: ClarificationReasonCode,
): Clarification {
  return {
    reason_code: reasonCode,
    question: CLARIFICATION_QUESTION_TEMPLATES[reasonCode],
  };
}

export function createRefusal(reasonCode: RefusalReasonCode): Refusal {
  return {
    reason_code: reasonCode,
    message: GENERIC_REFUSAL_MESSAGE,
  };
}
