import type { Dataset } from '@datascout/contracts';

const VERIFICATION_LEVEL_WEIGHT: Record<Dataset['verification_level'], number> =
  {
    full_dataset: 3,
    sample_checked: 2,
    metadata_only: 1,
  };

function countPopulatedFields(dataset: Dataset): number {
  let count = 0;
  if (dataset.source_url !== null) count++;
  if (dataset.title !== null) count++;
  if (dataset.description !== null) count++;
  if (dataset.license !== null && dataset.license !== 'unknown') count++;
  if (dataset.access_type !== null) count++;
  if (dataset.api_endpoint !== null) count++;
  if (dataset.file_formats.length > 0) count++;
  if (dataset.record_count !== null) count++;
  if (dataset.columns.length > 0) count++;
  if (dataset.geography !== null) count++;
  if (dataset.time_coverage !== null) count++;
  if (dataset.tags.length > 0) count++;
  if (dataset.last_updated !== null) count++;
  if (dataset.raw_snapshot_key !== null) count++;
  count += Object.keys(dataset.provenance).length;
  return count;
}

function compareDatasets(a: Dataset, b: Dataset): number {
  // 1. More non-null / populated fields wins
  const aFields = countPopulatedFields(a);
  const bFields = countPopulatedFields(b);
  if (aFields !== bFields) {
    return bFields - aFields; // descending
  }

  // 2. verification_level order: full_dataset > sample_checked > metadata_only
  const aLevel = VERIFICATION_LEVEL_WEIGHT[a.verification_level] ?? 0;
  const bLevel = VERIFICATION_LEVEL_WEIGHT[b.verification_level] ?? 0;
  if (aLevel !== bLevel) {
    return bLevel - aLevel; // descending
  }

  // 3. More columns examined wins
  if (a.columns.length !== b.columns.length) {
    return b.columns.length - a.columns.length;
  }

  // 4. Newer last_updated wins
  const aLastUpdated = a.last_updated ?? '';
  const bLastUpdated = b.last_updated ?? '';
  if (aLastUpdated !== bLastUpdated) {
    return bLastUpdated.localeCompare(aLastUpdated);
  }

  // 5. Newer retrieved_at wins
  if (a.retrieved_at !== b.retrieved_at) {
    return b.retrieved_at.localeCompare(a.retrieved_at);
  }

  // 6. Fully deterministic tie-break independent of array order (JSON content comparison)
  const aJson = JSON.stringify(a);
  const bJson = JSON.stringify(b);
  return aJson.localeCompare(bJson);
}

export function dedupeDatasets(datasets: readonly Dataset[]): Dataset[] {
  if (datasets.length <= 1) {
    return [...datasets];
  }

  // Group datasets by canonical dataset_id while recording first-seen appearance
  const groups = new Map<string, Dataset[]>();
  const idOrder: string[] = [];

  for (const ds of datasets) {
    const existing = groups.get(ds.dataset_id);
    if (existing) {
      existing.push(ds);
    } else {
      groups.set(ds.dataset_id, [ds]);
      idOrder.push(ds.dataset_id);
    }
  }

  const result: Dataset[] = [];

  for (const id of idOrder) {
    const items = groups.get(id)!;
    if (items.length === 1) {
      result.push(items[0]!);
    } else {
      // Sort copies deterministically and take the single best candidate; NEVER merge fields across duplicates
      const sorted = [...items].sort(compareDatasets);
      result.push(sorted[0]!);
    }
  }

  return result;
}
