import type {
  Dataset,
  Evidence,
  Requirement,
  RequirementMatch,
  ScoreBreakdown,
} from '../../../contracts/src/index.js';
import type {
  SampleInspection,
  ScoredDataset,
  Scorer,
} from '../../../contracts/src/ports.js';
import { matchRequirements } from './index.js';

export const SCORING_VERSION = 'score-v1';

const scoreComponentNames = [
  'requirement_satisfaction',
  'validation_access',
  'metadata_completeness',
  'license_source_clarity',
  'freshness',
] as const;

const inspectionSupportedFormats = new Set(['csv', 'json', 'parquet']);
const placeholderValues = new Set([
  '-',
  '—',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  'unknown',
  'not available',
  'not provided',
]);

const defaultSourceHosts: Readonly<Record<string, readonly string[]>> = {
  datagovin: ['data.gov.in'],
  huggingface: ['huggingface.co'],
  openml: ['openml.org'],
  worldbank: ['worldbank.org'],
  uci: ['uci.edu'],
  zenodo: ['zenodo.org'],
};

const metadataFields = [
  'description',
  'license',
  'file_formats',
  'record_count',
  'columns',
  'geography',
  'time_coverage',
  'last_updated',
  'tags',
  'access',
] as const;

const metadataProvenanceFields: Readonly<
  Record<(typeof metadataFields)[number], readonly string[]>
> = {
  description: ['description'],
  license: ['license'],
  file_formats: ['file_formats'],
  record_count: ['record_count'],
  columns: ['columns'],
  geography: ['geography'],
  time_coverage: ['time_coverage'],
  last_updated: ['last_updated'],
  tags: ['tags'],
  access: ['api_endpoint', 'source_url'],
};

export interface ScoringOptions {
  sourceHosts?: Readonly<Record<string, readonly string[]>>;
}

export interface RankedDataset {
  rank: number;
  item: ScoredDataset;
}

function asHundredths(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.floor((numerator * 200 + denominator) / (denominator * 2));
}

function roundRationalToHundredths(
  scale: number,
  numerator: number,
  denominator: number,
): number {
  if (denominator <= 0) return 0;
  return Math.floor((scale * numerator * 2 + denominator) / (denominator * 2));
}

function requirementWeight(requirement: Requirement): number {
  return requirement.type === 'preference' ? 1 : 3;
}

function requirementCredit(status: RequirementMatch['status']): number {
  switch (status) {
    case 'PASS':
      return 2;
    case 'PARTIAL':
      return 1;
    case 'FAIL':
    case 'UNKNOWN':
      return 0;
  }
}

function requirementPointsHundredths(
  requirements: readonly Requirement[],
  matches: readonly RequirementMatch[],
): number {
  const matchById = new Map(
    matches.map((match) => [match.requirement_id, match]),
  );
  let weightedCredits = 0;
  let maximumWeightedCredits = 0;

  for (const requirement of requirements) {
    const weight = requirementWeight(requirement);
    const match = matchById.get(requirement.requirement_id);
    weightedCredits += weight * requirementCredit(match?.status ?? 'UNKNOWN');
    maximumWeightedCredits += weight * 2;
  }
  return roundRationalToHundredths(
    5000,
    weightedCredits,
    maximumWeightedCredits,
  );
}

function validEvidenceCoverage(
  requirement: Requirement,
  matchById: ReadonlyMap<string, RequirementMatch>,
  evidenceById: ReadonlyMap<string, Evidence>,
  datasetId: string,
): boolean {
  const match = matchById.get(requirement.requirement_id);
  if (!match || match.status === 'UNKNOWN') return false;

  return match.evidence_ids.some((evidenceId) => {
    const evidence = evidenceById.get(evidenceId);
    return (
      evidence?.dataset_id === datasetId &&
      evidence.provenance.source_field_path.trim().length > 0 &&
      evidence.provenance.retrieved_at.trim().length > 0
    );
  });
}

function evidenceCoverageHundredths(
  requirements: readonly Requirement[],
  matches: readonly RequirementMatch[],
  evidence: readonly Evidence[],
  datasetId: string,
): number {
  if (requirements.length === 0) {
    throw new Error('score-v1 requires the always-present topic requirement.');
  }
  const matchById = new Map(
    matches.map((match) => [match.requirement_id, match]),
  );
  const evidenceById = new Map(
    evidence.map((item) => [item.evidence_id, item]),
  );
  const covered = requirements.reduce(
    (count, requirement) =>
      count +
      Number(
        validEvidenceCoverage(requirement, matchById, evidenceById, datasetId),
      ),
    0,
  );
  return asHundredths(covered, requirements.length);
}

function accessPoints(dataset: Dataset): number {
  const value = dataset.access_type?.trim().toLocaleLowerCase('en-US');
  if (!value) return 0;
  if (
    [
      'open',
      'public',
      'open access',
      'open_access',
      'download',
      'api',
    ].includes(value)
  ) {
    return 8;
  }
  if (
    [
      'key_required',
      'key required',
      'api_key',
      'api key',
      'registration',
      'registration_required',
      'registration required',
    ].includes(value)
  ) {
    return 5;
  }
  if (
    ['gated', 'restricted', 'embargoed', 'approval_required'].includes(value)
  ) {
    return 2;
  }
  return 0;
}

function inspectionPointsHundredths(
  dataset: Dataset,
  inspection?: SampleInspection,
): number {
  let points = accessPoints(dataset) * 100;
  const hasSupportedFormat = dataset.file_formats.some((format) =>
    inspectionSupportedFormats.has(format.trim().toLocaleLowerCase('en-US')),
  );
  if (hasSupportedFormat || dataset.api_endpoint !== null) points += 400;

  if (inspection?.status !== 'ok') return points;
  if (inspection.rowsExamined > 0) points += 400;
  const missingRates = inspection.columns.map(({ missingRate }) => missingRate);
  if (
    missingRates.length > 0 &&
    missingRates.every(
      (rate): rate is number =>
        rate !== null && Number.isFinite(rate) && rate >= 0 && rate <= 1,
    )
  ) {
    const meanMissingRate =
      missingRates.reduce((total, rate) => total + rate, 0) /
      missingRates.length;
    if (meanMissingRate <= 0.05) points += 200;
    else if (meanMissingRate <= 0.2) points += 100;
  }

  if (
    inspection.duplicateRate !== null &&
    Number.isFinite(inspection.duplicateRate) &&
    inspection.duplicateRate >= 0 &&
    inspection.duplicateRate <= 0.01
  ) {
    points += 100;
  }

  if (
    inspection.columns.length > 0 &&
    inspection.columns.filter(
      ({ inferredType }) => inferredType.trim().length > 0,
    ).length /
      inspection.columns.length >=
      0.9
  ) {
    points += 100;
  }
  return points;
}

function isPlaceholder(value: string): boolean {
  return placeholderValues.has(value.trim().toLocaleLowerCase('en-US'));
}

function hasText(value: string | null): boolean {
  return value !== null && value.trim().length > 0 && !isPlaceholder(value);
}

function isPresent(field: (typeof metadataFields)[number], dataset: Dataset) {
  switch (field) {
    case 'description':
      return (
        hasText(dataset.description) &&
        (dataset.description?.trim().length ?? 0) >= 40
      );
    case 'license':
      return hasText(dataset.license);
    case 'file_formats':
      return dataset.file_formats.some((format) => !isPlaceholder(format));
    case 'record_count':
      return (
        dataset.record_count !== null &&
        Number.isInteger(dataset.record_count) &&
        dataset.record_count >= 0
      );
    case 'columns':
      return dataset.columns.some((column) => !isPlaceholder(column));
    case 'geography':
      return hasText(dataset.geography);
    case 'time_coverage':
      return hasText(dataset.time_coverage);
    case 'last_updated':
      return dataset.last_updated !== null;
    case 'tags':
      return dataset.tags.some((tag) => !isPlaceholder(tag));
    case 'access':
      return dataset.api_endpoint !== null || dataset.source_url !== null;
  }
}

function applicableMetadataFields(
  dataset: Dataset,
): (typeof metadataFields)[number][] {
  return metadataFields.filter((field) => {
    if (
      (dataset.source === 'huggingface' ||
        dataset.source === 'openml' ||
        dataset.source === 'uci') &&
      (field === 'geography' || field === 'time_coverage')
    ) {
      return false;
    }
    if (
      dataset.source === 'worldbank' &&
      ['file_formats', 'record_count', 'columns'].includes(field)
    ) {
      return false;
    }
    if (
      dataset.source === 'zenodo' &&
      ['columns', 'record_count'].includes(field)
    ) {
      return false;
    }
    return true;
  });
}

function metadataCompletenessHundredths(dataset: Dataset): number {
  const applicable = applicableMetadataFields(dataset);
  const present = applicable.filter((field) =>
    isPresent(field, dataset),
  ).length;
  return roundRationalToHundredths(1500, present, applicable.length);
}

function licensePointsHundredths(dataset: Dataset): number {
  const license = dataset.license?.trim();
  if (!license || isPlaceholder(license)) return 0;
  const normalized = license.toLocaleLowerCase('en-US');
  if (/\bcc(?:[-\s.]?by)?[-\s.]?(?:nc|nd)\b/u.test(normalized)) return 400;
  if (
    /\bcc0\b/u.test(normalized) ||
    /\bcc[-\s]?by\b/u.test(normalized) ||
    /\bodbl\b/u.test(normalized) ||
    /\bmit\b/u.test(normalized) ||
    /\bapache[-\s]?2(?:\.0)?\b/u.test(normalized) ||
    /\bgodl[-\s]?india\b/u.test(normalized) ||
    /\bogl\b/u.test(normalized)
  ) {
    return 600;
  }
  return 200;
}

function matchesAllowedHost(hostname: string, allowedHost: string): boolean {
  const host = hostname.toLocaleLowerCase('en-US').replace(/\.$/u, '');
  const allowed = allowedHost.toLocaleLowerCase('en-US').replace(/^\.+/u, '');
  return host === allowed || host.endsWith(`.${allowed}`);
}

function provenancePointsHundredths(
  dataset: Dataset,
  options: ScoringOptions,
): number {
  let points = 0;
  if (dataset.source_url) {
    try {
      const hostname = new URL(dataset.source_url).hostname;
      const sourceHosts =
        options.sourceHosts?.[dataset.source] ??
        defaultSourceHosts[dataset.source] ??
        [];
      if (sourceHosts.some((host) => matchesAllowedHost(hostname, host))) {
        points += 200;
      }
    } catch {
      // An invalid source URL receives no allowlisted-host credit.
    }
  }

  const populated = applicableMetadataFields(dataset).filter((field) =>
    isPresent(field, dataset),
  );
  const sourced = populated.filter((field) =>
    metadataProvenanceFields[field].some((provenanceField) => {
      const provenance = dataset.provenance[provenanceField];
      return (
        provenance !== undefined &&
        provenance.source_field_path.trim().length > 0 &&
        provenance.retrieved_at.trim().length > 0
      );
    }),
  ).length;
  if (populated.length > 0) {
    const ratio = sourced / populated.length;
    if (ratio >= 0.8) points += 200;
    else if (ratio >= 0.5) points += 100;
  }
  return points;
}

function freshnessPointsHundredths(dataset: Dataset): number {
  if (!dataset.last_updated) return 0;
  const scoringTime = Date.parse(dataset.retrieved_at);
  const lastUpdated = Date.parse(dataset.last_updated);
  if (
    !Number.isFinite(scoringTime) ||
    !Number.isFinite(lastUpdated) ||
    lastUpdated > scoringTime
  ) {
    return 0;
  }
  const ageDays = (scoringTime - lastUpdated) / 86_400_000;
  if (ageDays <= 365) return 500;
  if (ageDays <= 730) return 300;
  if (ageDays <= 1825) return 100;
  return 0;
}

function toBreakdown(
  requirements: readonly Requirement[],
  matches: readonly RequirementMatch[],
  dataset: Dataset,
  evidence: readonly Evidence[],
  inspection: SampleInspection | undefined,
  options: ScoringOptions,
): ScoreBreakdown {
  const componentPoints = [
    requirementPointsHundredths(requirements, matches),
    inspectionPointsHundredths(dataset, inspection),
    metadataCompletenessHundredths(dataset),
    licensePointsHundredths(dataset) +
      provenancePointsHundredths(dataset, options),
    freshnessPointsHundredths(dataset),
  ];
  const totalHundredths = componentPoints.reduce(
    (sum, points) => sum + points,
    0,
  );
  return {
    scoring_version: SCORING_VERSION,
    total: totalHundredths / 100,
    components: scoreComponentNames.map((name, index) => ({
      name,
      weight: [50, 20, 15, 10, 5][index]!,
      points: componentPoints[index]! / 100,
    })),
    evidence_coverage:
      evidenceCoverageHundredths(
        requirements,
        matches,
        evidence,
        dataset.dataset_id,
      ) / 100,
  };
}

export function createScorer(options: ScoringOptions = {}): Scorer {
  return {
    scoringVersion: SCORING_VERSION,
    evaluate({ requirements, dataset, inspection }) {
      const evidence =
        inspection?.datasetId === dataset.dataset_id ? inspection.evidence : [];
      const matches = matchRequirements(requirements, dataset, evidence);
      return {
        dataset,
        matches,
        score: toBreakdown(
          requirements,
          matches,
          dataset,
          evidence,
          inspection?.datasetId === dataset.dataset_id ? inspection : undefined,
          options,
        ),
        evidence,
      };
    },
    rank(items) {
      return rankScoredDatasets(items).map(({ item }) => item);
    },
  };
}

export function scoreDataset(input: {
  requirements: readonly Requirement[];
  matches: readonly RequirementMatch[];
  dataset: Dataset;
  evidence: readonly Evidence[];
  inspection?: SampleInspection;
  options?: ScoringOptions;
}): ScoreBreakdown {
  return toBreakdown(
    input.requirements,
    input.matches,
    input.dataset,
    input.evidence,
    input.inspection,
    input.options ?? {},
  );
}

export function rankScoredDatasets(
  items: readonly ScoredDataset[],
): RankedDataset[] {
  const datasetIds = new Set<string>();
  for (const { dataset } of items) {
    if (datasetIds.has(dataset.dataset_id)) {
      throw new Error(
        `score-v1 ranking requires unique dataset IDs: ${dataset.dataset_id}`,
      );
    }
    datasetIds.add(dataset.dataset_id);
  }
  return items
    .map((item) => ({ item }))
    .sort((left, right) => {
      const scoreDifference =
        Math.round(right.item.score.total * 100) -
        Math.round(left.item.score.total * 100);
      if (scoreDifference !== 0) return scoreDifference;
      const coverageDifference =
        Math.round(right.item.score.evidence_coverage * 100) -
        Math.round(left.item.score.evidence_coverage * 100);
      if (coverageDifference !== 0) return coverageDifference;
      if (left.item.dataset.dataset_id < right.item.dataset.dataset_id)
        return -1;
      if (left.item.dataset.dataset_id > right.item.dataset.dataset_id)
        return 1;
      return 0;
    })
    .map(({ item }, index) => ({ rank: index + 1, item }));
}
