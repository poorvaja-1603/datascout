import { getValidToken } from './auth';
const env = import.meta.env;
export type Match = {
  requirement_id: string;
  status: 'PASS' | 'PARTIAL' | 'FAIL' | 'UNKNOWN';
  reason: string;
  evidence_ids: string[];
  verification_level: string;
};
export type Result = {
  dataset_id: string;
  score: number;
  score_breakdown: { evidence_coverage: number };
  matches: Match[];
  quality_checks: {
    check: string;
    status: string;
    summary: string;
    evidence_ids: string[];
  }[];
  verification_level: string;
  warnings: string[];
  explanation: string | null;
  evidence: {
    evidence_id: string;
    field: string;
    value: unknown;
    provenance: { source_field_path: string };
  }[];
};
export type Search = {
  request_id: string;
  outcome: string;
  requirements: Record<string, unknown> | null;
  clarification?: { question: string };
  refusal?: { message: string };
  source_statuses: {
    source: string;
    status: string;
    result_count: number;
    warning: string | null;
  }[];
  results: Result[];
  warnings: string[];
};
export type Detail = {
  dataset: {
    dataset_id: string;
    title: string | null;
    description: string | null;
    source_url: string | null;
    license: string | null;
    columns: string[];
    access_type: string | null;
    time_coverage: string | null;
    geography: string | null;
    provenance: Record<string, { source_field_path: string }>;
  };
  evidence: Result['evidence'];
  matches: Match[];
  quality_checks: { check: string; status: string; summary: string }[];
  access_instructions: string[];
  starter_code: string | null;
  preprocessing: string[];
  next_steps: string[];
  complementary_datasets: {
    dataset_id: string;
    reason: string;
    join_keys: string[];
    manual_verification_required: true;
  }[];
};
export type Comparison = {
  datasets: {
    dataset: {
      dataset_id: string;
      title: string | null;
      source: string;
      license: string | null;
      access_type: string | null;
      record_count: number | null;
      columns: string[];
      geography: string | null;
      time_coverage: string | null;
      verification_level: string;
    };
    score: number;
    matches: Match[];
    evidence: Result['evidence'];
  }[];
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getValidToken();
  if (!token)
    throw new Error('Your session has expired. Sign in again to continue.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(
    `${env.VITE_API_BASE_URL || 'http://localhost:4010'}${path}`,
    { ...init, headers },
  );
  if (!response.ok) {
    if (response.status === 401)
      throw new Error('Your session has expired. Sign in again to continue.');
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(payload?.message || `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}
export const searchDatasets = (query: string, sources: string[]) =>
  request<Search>('/search', {
    method: 'POST',
    body: JSON.stringify({ query, options: { sources } }),
  });
export const getResult = (id: string) =>
  request<Search>(`/results/${encodeURIComponent(id)}`);
export const getDataset = (id: string) =>
  request<Detail>(`/dataset/${encodeURIComponent(id)}`);
export const compare = (ids: string[]) =>
  request<Comparison>('/compare', {
    method: 'POST',
    body: JSON.stringify({ dataset_ids: ids }),
  });
