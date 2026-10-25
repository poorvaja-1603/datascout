import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './ui';
import type { Detail, Search } from './api';

vi.mock('./auth', () => ({
  getToken: () => 'test-token',
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('./api', () => ({
  compare: vi.fn(),
  getDataset: vi.fn(),
  getResult: vi.fn(),
  searchDatasets: vi.fn(),
}));
afterEach(cleanup);
import { getDataset, searchDatasets } from './api';

const xss = '<img src=x onerror=alert(1)>';
const searchResult: Search = {
  request_id: 'req-test',
  outcome: 'results',
  requirements: { topic: 'climate' },
  source_statuses: [
    {
      source: 'openml',
      status: 'partial',
      result_count: 1,
      warning: 'One endpoint timed out.',
    },
  ],
  warnings: [],
  results: [
    {
      dataset_id: 'openml:42',
      score: 60,
      score_breakdown: { evidence_coverage: 0.5 },
      matches: [
        {
          requirement_id: 'topic',
          status: 'UNKNOWN',
          reason: 'Topic was not verified.',
          evidence_ids: [],
          verification_level: 'metadata_only',
        },
      ],
      evidence: [],
      quality_checks: [],
      verification_level: 'metadata_only',
      warnings: [],
      explanation: xss,
    },
  ],
};
const detail: Detail = {
  dataset: {
    dataset_id: 'openml:42',
    title: xss,
    description: 'Source text',
    source_url: 'javascript:alert(1)',
    license: null,
    columns: [],
    access_type: 'open',
    geography: null,
    time_coverage: null,
    provenance: {},
  },
  evidence: [],
  matches: [],
  quality_checks: [],
  access_instructions: [],
  starter_code: 'print(1)',
  preprocessing: [],
  next_steps: [],
  complementary_datasets: [],
};

describe('DataScout frontend verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(searchDatasets).mockResolvedValue(searchResult);
    vi.mocked(getDataset).mockResolvedValue(detail);
  });

  it('renders partial-source warnings and never upgrades UNKNOWN to PASS or FAIL', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      screen.getByLabelText('Project requirements'),
      'climate data',
    );
    await user.click(screen.getByRole('button', { name: /Find datasets/ }));
    expect(await screen.findByText('One endpoint timed out.')).toBeTruthy();
    expect(screen.getByText('topic: partial')).toBeTruthy();
    expect(screen.getByText('50% evidence')).toBeTruthy();
  });

  it('renders source text as text and rejects javascript source links', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      screen.getByLabelText('Project requirements'),
      'climate data',
    );
    await user.click(screen.getByRole('button', { name: /Find datasets/ }));
    expect(await screen.findByText(xss)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    await user.click(
      screen.getByRole('button', { name: /View evidence and details/ }),
    );
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: xss })).toBeTruthy();
    expect(
      screen.queryByRole('link', { name: /Open source record/ }),
    ).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('traps focus inside dataset details and closes with Escape, restoring focus', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      screen.getByLabelText('Project requirements'),
      'climate data',
    );
    await user.click(screen.getByRole('button', { name: /Find datasets/ }));
    const openButton = await screen.findByRole('button', {
      name: /View evidence and details/,
    });
    openButton.focus();
    await user.click(openButton);
    const closeButton = await screen.findByRole('button', {
      name: /Close dataset details/,
    });
    const copyButton = screen.getByRole('button', { name: 'Copy code' });
    await waitFor(() => expect(document.activeElement).toBe(closeButton));
    fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(copyButton);
    fireEvent.keyDown(copyButton, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(openButton);
  });

  it('shows API authorization errors without hiding the search controls', async () => {
    vi.mocked(searchDatasets).mockRejectedValue(
      new Error('Your session has expired. Sign in again to continue.'),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      screen.getByLabelText('Project requirements'),
      'climate data',
    );
    await user.click(screen.getByRole('button', { name: /Find datasets/ }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Your session has expired.',
    );
    expect(screen.getByLabelText('Project requirements')).toBeTruthy();
  });
});
