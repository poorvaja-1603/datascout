import type {
  Dataset,
  Evidence,
  Requirement,
  RequirementMatch,
} from '../../../contracts/src/index.js';

const evidenceFields: Record<Requirement['type'], readonly string[]> = {
  topic: ['topic', 'tags'],
  geography: ['geography'],
  time_coverage: ['time_coverage'],
  minimum_records: ['record_count'],
  feature: ['columns'],
  target: ['columns'],
  constraint: ['constraints'],
  preference: ['preferences'],
};

const stopWords = new Set(['a', 'an', 'and', 'level', 'of', 'or', 'the', 'to']);
const positiveVerificationLevels = new Set(['sample_checked', 'full_dataset']);

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter((token) => token.length > 0 && !stopWords.has(token))
    .map((token) =>
      token.length > 3 && token.endsWith('s') && !token.endsWith('ss')
        ? token.slice(0, -1)
        : token,
    );
}

function asStrings(value: Evidence['value']): string[] {
  if (typeof value === 'string' || typeof value === 'number') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value
      .filter(
        (item): item is string | number =>
          typeof item === 'string' || typeof item === 'number',
      )
      .map(String);
  }
  return [];
}

function splitRequirement(value: string): string[] {
  return value
    .split(/\s+(?:and|&)\s+|[,;]/iu)
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchesText(requirement: Requirement, candidate: string): boolean {
  const candidateNormalized = normalize(candidate);
  const exactValues = [String(requirement.value), ...requirement.aliases].map(
    normalize,
  );

  if (
    requirement.type === 'topic' ||
    requirement.type === 'geography' ||
    requirement.type === 'target' ||
    requirement.type === 'time_coverage'
  ) {
    return exactValues.includes(candidateNormalized);
  }

  return exactValues.some((value) => {
    if (value === candidateNormalized) return true;
    const candidateTokens = new Set(tokens(candidate));
    return splitRequirement(value).some((part) => {
      const requiredTokens = tokens(part);
      return (
        requiredTokens.length > 0 &&
        requiredTokens.every((token) => candidateTokens.has(token))
      );
    });
  });
}

function matchedParts(
  requirement: Requirement,
  parts: readonly string[],
  candidates: readonly string[],
): Set<string> {
  const matched = new Set<string>();
  for (const part of parts) {
    const requiredTokens = tokens(part);
    const hasEvidenceForPart = candidates.some((candidate) =>
      matchesText({ ...requirement, value: part, aliases: [] }, candidate),
    );
    const hasEvidenceForEveryTerm =
      requiredTokens.length > 0 &&
      requiredTokens.every((token) =>
        candidates.some((candidate) => tokens(candidate).includes(token)),
      );
    if (hasEvidenceForPart || hasEvidenceForEveryTerm) {
      matched.add(normalize(part));
    }
  }
  return matched;
}

function makeVerdict(
  requirement: Requirement,
  dataset: Dataset,
  status: RequirementMatch['status'],
  reason: string,
  evidence: readonly Evidence[],
  measuredValue?: RequirementMatch['measured_value'],
): RequirementMatch {
  const verdict: RequirementMatch = {
    requirement_id: requirement.requirement_id,
    status,
    reason,
    evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
    verification_level: dataset.verification_level,
  };
  if (measuredValue !== undefined) verdict.measured_value = measuredValue;
  return verdict;
}

/**
 * Match one requirement using only source-backed evidence for this dataset.
 * Metadata can support PARTIAL but never PASS; an absent sample is UNKNOWN.
 */
export function matchRequirement(
  requirement: Requirement,
  dataset: Dataset,
  evidence: readonly Evidence[],
): RequirementMatch {
  const fields = new Set(evidenceFields[requirement.type]);
  const supportingEvidence = evidence.filter(
    (item) => item.dataset_id === dataset.dataset_id && fields.has(item.field),
  );
  if (supportingEvidence.length === 0) {
    return makeVerdict(
      requirement,
      dataset,
      'UNKNOWN',
      'No matching source evidence establishes this requirement.',
      [],
    );
  }

  if (requirement.type === 'minimum_records') {
    const expected = requirement.value;
    const measured = supportingEvidence
      .map(({ value }) => value)
      .find((value): value is number => typeof value === 'number');
    if (typeof expected !== 'number' || measured === undefined) {
      return makeVerdict(
        requirement,
        dataset,
        'UNKNOWN',
        'Source evidence does not provide an exact numeric record count.',
        supportingEvidence,
      );
    }
    const verified = positiveVerificationLevels.has(dataset.verification_level);
    if (measured < expected) {
      return makeVerdict(
        requirement,
        dataset,
        verified ? 'FAIL' : 'UNKNOWN',
        verified
          ? 'The inspected record count is below the requested minimum.'
          : 'The metadata count is below the requested minimum, but has not been verified by inspection.',
        supportingEvidence,
        measured,
      );
    }
    return makeVerdict(
      requirement,
      dataset,
      verified ? 'PASS' : 'PARTIAL',
      verified
        ? 'The inspected record count meets the requested minimum.'
        : 'Metadata reports at least the requested record count, but the dataset was not inspected.',
      supportingEvidence,
      measured,
    );
  }

  const candidates = supportingEvidence.flatMap(({ value }) =>
    asStrings(value),
  );
  const isCompound =
    requirement.type === 'feature' ||
    requirement.type === 'constraint' ||
    requirement.type === 'preference';
  const primaryParts = isCompound
    ? splitRequirement(String(requirement.value)).map(normalize)
    : [normalize(String(requirement.value))];
  const matched = matchedParts(requirement, primaryParts, candidates);
  const aliasMatches = requirement.aliases.some((alias) =>
    candidates.some((candidate) =>
      matchesText({ ...requirement, value: alias, aliases: [] }, candidate),
    ),
  );
  const allMatched =
    primaryParts.length > 0 &&
    (primaryParts.every((part) => matched.has(part)) || aliasMatches);
  const anyMatched = matched.size > 0;

  if (allMatched) {
    const verified = positiveVerificationLevels.has(dataset.verification_level);
    return makeVerdict(
      requirement,
      dataset,
      verified ? 'PASS' : 'PARTIAL',
      verified
        ? 'Inspected source evidence establishes the requested value.'
        : 'Metadata supports the requested value, but the dataset was not inspected.',
      supportingEvidence,
    );
  }

  if (anyMatched) {
    return makeVerdict(
      requirement,
      dataset,
      'PARTIAL',
      'Source evidence supports only part of the requested value.',
      supportingEvidence,
    );
  }

  const definitive = positiveVerificationLevels.has(dataset.verification_level);
  return makeVerdict(
    requirement,
    dataset,
    definitive ? 'FAIL' : 'UNKNOWN',
    definitive
      ? 'The inspected source evidence does not contain the requested value.'
      : 'Metadata absence does not establish that the requested value is unavailable.',
    supportingEvidence,
  );
}

export function matchRequirements(
  requirements: readonly Requirement[],
  dataset: Dataset,
  evidence: readonly Evidence[],
): RequirementMatch[] {
  return requirements.map((requirement) =>
    matchRequirement(requirement, dataset, evidence),
  );
}

export {
  createScorer,
  rankScoredDatasets,
  scoreDataset,
  SCORING_VERSION,
} from './scoring.js';
export type { RankedDataset, ScoringOptions } from './scoring.js';
