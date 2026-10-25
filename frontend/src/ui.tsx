import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  compare,
  getDataset,
  getResult,
  searchDatasets,
  type Comparison,
  type Detail,
  type Search,
} from './api';
import { getToken, signIn, signOut } from './auth';

const sources = [
  ['datagovin', 'data.gov.in'],
  ['huggingface', 'Hugging Face'],
  ['openml', 'OpenML'],
  ['worldbank', 'World Bank'],
] as const;
const sampleQueries = [
  'Find crop yield data for Maharashtra with rainfall and temperature',
  'Monthly air quality data with PM2.5 readings',
];
const userStatus = (status: string) =>
  status === 'UNKNOWN' ? 'PARTIAL' : status;
const safeHttpUrl = (value: string | null) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null;
  } catch {
    return null;
  }
};
type CompareEntry = Comparison['datasets'][number];
const comparisonRows: {
  label: string;
  value: (entry: CompareEntry, index: number) => string;
}[] = [
  { label: 'Source', value: (entry) => entry.dataset.source },
  { label: 'Fit score', value: (entry) => `${entry.score} / 100` },
  {
    label: 'Verification',
    value: (entry) => entry.dataset.verification_level.replace('_', ' '),
  },
  {
    label: 'License',
    value: (entry) => entry.dataset.license || 'Not reported',
  },
  {
    label: 'Access',
    value: (entry) => entry.dataset.access_type || 'Not reported',
  },
  {
    label: 'Records',
    value: (entry) =>
      entry.dataset.record_count?.toLocaleString() ?? 'Not reported',
  },
  {
    label: 'Geography',
    value: (entry) => entry.dataset.geography || 'Not reported',
  },
  {
    label: 'Time coverage',
    value: (entry) => entry.dataset.time_coverage || 'Not reported',
  },
  {
    label: 'Fields',
    value: (entry) =>
      entry.dataset.columns.length
        ? entry.dataset.columns.join(', ')
        : 'Not reported',
  },
  {
    label: 'Requirement matches',
    value: (entry) =>
      entry.matches
        .map((match) => `${match.requirement_id}: ${userStatus(match.status)}`)
        .join(' · ') || 'No evidence',
  },
];

export function App() {
  const [token, setToken] = useState(getToken());
  const [query, setQuery] = useState('');
  const [enabled, setEnabled] = useState<string[]>(sources.map(([id]) => id));
  const [data, setData] = useState<Search | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    sessionStorage.getItem('datascout.auth_error') || '',
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [copied, setCopied] = useState(false);
  const [compareData, setCompareData] = useState<Comparison | null>(null);
  const [compareBusy, setCompareBusy] = useState(false);
  const [historyId, setHistoryId] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onAuthError = (event: Event) =>
      setError((event as CustomEvent<string>).detail);
    window.addEventListener('datascout:auth-error', onAuthError);
    return () =>
      window.removeEventListener('datascout:auth-error', onAuthError);
  }, []);

  useEffect(() => {
    if (!detail) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button, a[href], input, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDetail(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
      previousFocus?.focus();
    };
  }, [detail]);

  const runSearch = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setDetail(null);
    setCompareData(null);
    setSelected([]);
    try {
      const response = await searchDatasets(query.trim(), enabled);
      setData(response);
      setHistoryId(response.request_id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Search failed.');
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (id: string) => {
    setError('');
    setDetail(null);
    setCopied(false);
    try {
      setDetail(await getDataset(id));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not load dataset details.',
      );
    }
  };
  const copyStarterCode = async () => {
    if (!detail?.starter_code) return;
    try {
      await navigator.clipboard.writeText(detail.starter_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Clipboard access is unavailable in this browser.');
    }
  };
  const loadHistory = async () => {
    setError('');
    try {
      const response = await getResult(historyId.trim());
      setData(response);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not retrieve this search.',
      );
    }
  };
  const runCompare = async () => {
    setCompareBusy(true);
    setError('');
    try {
      setCompareData(await compare(selected));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Comparison failed.');
    } finally {
      setCompareBusy(false);
    }
  };
  const toggleSource = (id: string) =>
    setEnabled((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  const allFailed =
    data?.source_statuses.length &&
    data.source_statuses.every((source) => source.status === 'failed');

  if (!token)
    return (
      <main className="welcome">
        <div className="welcome-card">
          <div className="brand-mark">D</div>
          <p className="eyebrow">PUBLIC DATA, MADE FINDABLE</p>
          <h1>
            Find the right dataset.
            <br />
            <em>Know why it fits.</em>
          </h1>
          <p className="welcome-copy">
            Describe your project and DataScout will search public catalogs,
            check evidence, and show where each recommendation came from.
          </p>
          <button
            className="primary"
            onClick={() => {
              void signIn().catch((reason: unknown) =>
                setError(
                  reason instanceof Error
                    ? reason.message
                    : 'Sign-in unavailable.',
                ),
              );
            }}
          >
            Sign in to DataScout <span aria-hidden="true">→</span>
          </button>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <p className="welcome-foot">
            Secure access via your organization's identity provider
          </p>
        </div>
      </main>
    );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar" id="top">
        <a className="brand" href="#top">
          <span className="brand-mark small">D</span> DataScout{' '}
          <span className="brand-beta">BETA</span>
        </a>
        <div className="top-actions">
          <span className="session">
            <i />
            Signed in
          </span>
          <button
            className="text-button"
            onClick={() => {
              signOut();
              setToken(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main id="main-content" className="content" tabIndex={-1}>
        <section className="hero">
          <div>
            <p className="eyebrow">DATA DISCOVERY WORKSPACE</p>
            <h1>What are you working on?</h1>
            <p>
              Tell us about your project. We’ll find datasets and show the
              evidence behind every match.
            </p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <span className="orbit orbit-one" />
            <span className="orbit orbit-two" />
            <span className="hero-dot">✳</span>
          </div>
        </section>
        <section className="search-panel" aria-label="Dataset search">
          <form onSubmit={(event) => void runSearch(event)}>
            <label htmlFor="query">Project requirements</label>
            <textarea
              id="query"
              maxLength={1000}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="e.g. Crop yield data for Maharashtra since 2015 with rainfall, temperature, and at least 1,000 records"
              required
            />
            <div className="form-foot">
              <span>{query.length}/1,000 characters</span>
              <button
                className="primary"
                disabled={busy || !query.trim() || enabled.length === 0}
              >
                {busy ? (
                  <>
                    <span className="spinner" /> Searching…
                  </>
                ) : (
                  <>
                    Find datasets <span aria-hidden="true">→</span>
                  </>
                )}
              </button>
            </div>
          </form>
          <div className="source-row">
            <span className="source-label">Search sources</span>
            {sources.map(([id, label]) => (
              <label className="source-choice" key={id}>
                <input
                  type="checkbox"
                  checked={enabled.includes(id)}
                  onChange={() => toggleSource(id)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="suggestions">
            <span>Try a sample:</span>
            {sampleQueries.map((item) => (
              <button key={item} onClick={() => setQuery(item)}>
                {item} <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </section>
        {error && (
          <div className="alert error" role="alert">
            <strong>Something needs attention</strong>
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              ×
            </button>
          </div>
        )}
        {data && (
          <section className="results-section" aria-live="polite">
            <form
              className="refine-search"
              onSubmit={(event) => void runSearch(event)}
              aria-label="Refine search requirements"
            >
              <label htmlFor="refine-query">Refine your request</label>
              <textarea
                id="refine-query"
                maxLength={1000}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button className="secondary" disabled={busy || !query.trim()}>
                {busy ? 'Updating…' : 'Update results'}
              </button>
            </form>
            <div className="section-heading">
              <div>
                <p className="eyebrow">SEARCH REPORT</p>
                <h2>
                  {data.outcome === 'results'
                    ? `${data.results.length} dataset${data.results.length === 1 ? '' : 's'} found`
                    : data.outcome === 'clarification'
                      ? 'A little more detail?'
                      : data.outcome === 'refused'
                        ? 'Search not available'
                        : 'No matching datasets'}
                </h2>
                <p>Results are ranked by verified fit and evidence coverage.</p>
              </div>
              <div className="history-load">
                <input
                  aria-label="Search request ID"
                  placeholder="Load a previous search ID"
                  value={historyId}
                  onChange={(event) => setHistoryId(event.target.value)}
                />
                <button
                  className="secondary"
                  onClick={() => void loadHistory()}
                  disabled={!historyId.trim()}
                >
                  Load
                </button>
              </div>
            </div>
            {data.clarification && (
              <div className="notice">
                <span className="notice-icon">?</span>
                <div>
                  <strong>Help us narrow the search</strong>
                  <p>{data.clarification.question}</p>
                </div>
              </div>
            )}
            {data.refusal && (
              <div className="notice">
                <span className="notice-icon">!</span>
                <div>
                  <strong>We couldn’t run this search</strong>
                  <p>{data.refusal.message}</p>
                </div>
              </div>
            )}
            {allFailed ? (
              <div className="empty-state">
                <span>⌁</span>
                <h3>Sources are temporarily unavailable</h3>
                <p>
                  We couldn’t reach the selected catalogs. Your search is safe
                  to retry in a moment.
                </p>
                <button
                  className="secondary"
                  onClick={(event) => {
                    const form = event.currentTarget.closest('section')
                      ?.previousElementSibling as HTMLElement | null;
                    form?.scrollIntoView({ behavior: 'smooth' });
                  }}
                >
                  Try again from your query
                </button>
              </div>
            ) : data.results.length === 0 &&
              !data.clarification &&
              !data.refusal ? (
              <div className="empty-state">
                <span>⌕</span>
                <h3>No results yet</h3>
                <p>
                  Try adding a topic, location, time range, or the columns you
                  need.
                </p>
              </div>
            ) : null}
            <div className="source-statuses">
              {data.source_statuses.map((item) => (
                <div
                  className={`source-status ${item.status}`}
                  key={item.source}
                >
                  <span className="status-dot" />
                  <strong>{item.source}</strong>
                  <span>
                    {item.status === 'success'
                      ? `${item.result_count} found`
                      : item.status}
                  </span>
                  {item.warning && (
                    <span className="status-warning">{item.warning}</span>
                  )}
                </div>
              ))}
            </div>
            {data.results.map((result, index) => (
              <article className="result-card" key={result.dataset_id}>
                <div className="result-main">
                  <div className="rank">
                    {String(index + 1).padStart(2, '0')}
                  </div>
                  <div className="result-copy">
                    <div className="result-title">
                      <h3>{result.dataset_id}</h3>
                      <span className={`depth ${result.verification_level}`}>
                        {result.verification_level.replace('_', ' ')}
                      </span>
                    </div>
                    <p>
                      {result.explanation ||
                        'Evidence-backed dataset candidate. Open details to review its metadata and provenance.'}
                    </p>
                    <div className="match-chips">
                      {result.matches.slice(0, 5).map((match) => (
                        <span
                          className={`match ${userStatus(match.status).toLowerCase()}`}
                          key={match.requirement_id}
                        >
                          <b>
                            {userStatus(match.status) === 'PASS'
                              ? '✓'
                              : userStatus(match.status) === 'FAIL'
                                ? '×'
                                : '·'}
                          </b>{' '}
                          {match.requirement_id}:{' '}
                          {userStatus(match.status).toLowerCase()}
                        </span>
                      ))}
                    </div>
                    {result.warnings.length > 0 && (
                      <p className="warning-text">
                        {result.warnings.join(' ')}
                      </p>
                    )}
                    <button
                      className="link-button"
                      onClick={() => void openDetail(result.dataset_id)}
                    >
                      View evidence and details{' '}
                      <span aria-hidden="true">→</span>
                    </button>
                  </div>
                  <div className="score">
                    <strong>{Math.round(result.score)}</strong>
                    <span>FIT SCORE</span>
                    <small>
                      {Math.round(
                        result.score_breakdown.evidence_coverage * 100,
                      )}
                      % evidence
                    </small>
                  </div>
                </div>
                <div className="result-actions">
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(result.dataset_id)}
                      onChange={() =>
                        setSelected((current) =>
                          current.includes(result.dataset_id)
                            ? current.filter((id) => id !== result.dataset_id)
                            : current.length < 4
                              ? [...current, result.dataset_id]
                              : current,
                        )
                      }
                      disabled={
                        !selected.includes(result.dataset_id) &&
                        selected.length >= 4
                      }
                    />{' '}
                    Add to comparison
                  </label>
                  <span>
                    {result.evidence.length} evidence item
                    {result.evidence.length === 1 ? '' : 's'}
                  </span>
                </div>
              </article>
            ))}
            {selected.length > 0 && (
              <div className="compare-bar">
                <span>
                  <b>{selected.length}</b> selected{' '}
                  <small>Choose 2–4 datasets</small>
                </span>
                <button
                  className="secondary"
                  disabled={
                    selected.length < 2 || selected.length > 4 || compareBusy
                  }
                  onClick={() => void runCompare()}
                >
                  {compareBusy
                    ? 'Comparing…'
                    : `Compare ${selected.length} datasets`}
                </button>
              </div>
            )}
            {compareData !== null && (
              <section className="compare-result">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">SIDE-BY-SIDE</p>
                    <h2>Dataset comparison</h2>
                    <p>
                      Compare verified fields and evidence across your selected
                      datasets.
                    </p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setCompareData(null)}
                  >
                    Close
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Dataset</th>
                        {compareData.datasets.map(({ dataset }) => (
                          <th scope="col" key={dataset.dataset_id}>
                            {dataset.title || dataset.dataset_id}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {comparisonRows.map((row) => (
                        <tr key={row.label}>
                          <th scope="row">{row.label}</th>
                          {compareData.datasets.map((entry, index) => (
                            <td key={entry.dataset.dataset_id}>
                              {row.value(entry, index)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </section>
        )}
        {detail && (
          <div
            className="overlay"
            ref={dialogRef}
            role="presentation"
            onClick={(event) => {
              if (event.target === event.currentTarget) setDetail(null);
            }}
          >
            <section
              className="detail-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="detail-title"
            >
              <div className="detail-head">
                <div>
                  <p className="eyebrow">DATASET DETAIL</p>
                  <h2 id="detail-title">
                    {detail.dataset.title || detail.dataset.dataset_id}
                  </h2>
                  <p className="muted">{detail.dataset.dataset_id}</p>
                </div>
                <button
                  className="close-button"
                  aria-label="Close dataset details"
                  onClick={() => setDetail(null)}
                >
                  ×
                </button>
              </div>
              <div className="detail-body">
                <p>
                  {detail.dataset.description ||
                    'No description is available from the source.'}
                </p>
                {safeHttpUrl(detail.dataset.source_url) && (
                  <a
                    className="external-link"
                    href={safeHttpUrl(detail.dataset.source_url)!}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open source record ↗
                  </a>
                )}
                <div className="detail-grid">
                  <div>
                    <span>License</span>
                    <strong>{detail.dataset.license || 'Not reported'}</strong>
                  </div>
                  <div>
                    <span>Access</span>
                    <strong>
                      {detail.dataset.access_type || 'Not reported'}
                    </strong>
                  </div>
                  <div>
                    <span>Geography</span>
                    <strong>
                      {detail.dataset.geography || 'Not reported'}
                    </strong>
                  </div>
                  <div>
                    <span>Time coverage</span>
                    <strong>
                      {detail.dataset.time_coverage || 'Not reported'}
                    </strong>
                  </div>
                </div>
                <h3>Fields</h3>
                <div className="field-list">
                  {detail.dataset.columns.length ? (
                    detail.dataset.columns.map((column) => (
                      <span key={column}>{column}</span>
                    ))
                  ) : (
                    <p>Column metadata is not available.</p>
                  )}
                </div>
                <h3>Requirement evidence</h3>
                {detail.matches.map((match) => (
                  <div className="evidence-row" key={match.requirement_id}>
                    <span
                      className={`status-pill ${userStatus(match.status).toLowerCase()}`}
                    >
                      {userStatus(match.status)}
                    </span>
                    <div>
                      <strong>{match.requirement_id}</strong>
                      <p>{match.reason}</p>
                    </div>
                  </div>
                ))}
                {detail.evidence.length > 0 && (
                  <>
                    <h3>Evidence records</h3>
                    {detail.evidence.map((item) => (
                      <div className="evidence-row" key={item.evidence_id}>
                        <div>
                          <strong>{item.field}</strong>
                          <p>{String(item.value)}</p>
                          <small>{item.provenance.source_field_path}</small>
                        </div>
                      </div>
                    ))}
                  </>
                )}
                {detail.quality_checks.length > 0 && (
                  <>
                    <h3>Quality checks</h3>
                    {detail.quality_checks.map((check) => (
                      <div className="evidence-row" key={check.check}>
                        <div>
                          <strong>{check.check}: {check.status}</strong>
                          <p>{check.summary}</p>
                        </div>
                      </div>
                    ))}
                  </>
                )}
                <h3>Access instructions</h3>
                <ul>
                  {detail.access_instructions.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {detail.starter_code && (
                  <>
                    <h3>
                      Starter code{' '}
                      <button
                        className="text-button"
                        onClick={() => void copyStarterCode()}
                      >
                        {copied ? 'Copied' : 'Copy code'}
                      </button>
                    </h3>
                    <pre>{detail.starter_code}</pre>
                  </>
                )}
                {detail.preprocessing.length > 0 && (
                  <>
                    <h3>Preprocessing</h3>
                    <ul>
                      {detail.preprocessing.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </>
                )}
                {detail.next_steps.length > 0 && (
                  <>
                    <h3>Next steps</h3>
                    <ul>
                      {detail.next_steps.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </>
                )}
                {detail.complementary_datasets.length > 0 && (
                  <>
                    <h3>Complementary datasets</h3>
                    {detail.complementary_datasets.map((suggestion) => (
                      <div className="evidence-row" key={suggestion.dataset_id}>
                        <div>
                          <strong>{suggestion.dataset_id}</strong>
                          <p>
                            {suggestion.reason} Join keys:{' '}
                            {suggestion.join_keys.join(', ') ||
                              'none specified'}
                            . Manual verification required.
                          </p>
                        </div>
                      </div>
                    ))}
                  </>
                )}
                <h3>Provenance</h3>
                <div className="provenance-list">
                  {Object.entries(detail.dataset.provenance).map(
                    ([field, provenance]) => (
                      <div key={field}>
                        <b>{field}</b>
                        <span>{provenance.source_field_path}</span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            </section>
          </div>
        )}
        {data && (
          <details className="requirements">
            <summary>Interpreted search requirements</summary>
            <pre>{JSON.stringify(data.requirements, null, 2)}</pre>
          </details>
        )}
        <footer>
          DataScout evaluates public metadata and bounded samples. Missing
          evidence stays visible as “not verified.”
        </footer>
      </main>
    </div>
  );
}
