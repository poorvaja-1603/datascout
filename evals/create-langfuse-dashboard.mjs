const {
  LANGFUSE_PUBLIC_KEY: publicKey,
  LANGFUSE_SECRET_KEY: secretKey,
  LANGFUSE_BASE_URL: baseUrl,
} = process.env;

if (!publicKey?.trim() || !secretKey?.trim() || !baseUrl?.trim()) {
  throw new Error('Configure Langfuse keys using the approved local/team secret store.');
}
const host = new URL(baseUrl.trim());
if (!['http:', 'https:'].includes(host.protocol) || host.username || host.password || host.search || host.hash) {
  throw new Error('Langfuse base URL is invalid.');
}

const endpoint = new URL('/api/public/unstable', host).toString().replace(/\/$/u, '');
const auth = `Basic ${Buffer.from(`${publicKey.trim()}:${secretKey.trim()}`).toString('base64')}`;
const scoreNames = [
  'extraction_all_fields_exact',
  'extraction_topic_exact',
  'extraction_geography_exact',
  'extraction_time_coverage_exact',
  'extraction_minimum_records_exact',
  'extraction_required_features_exact',
  'extraction_target_exact',
  'extraction_preferences_exact',
  'extraction_constraints_exact',
];

async function request(path, method = 'GET', body) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: {
      Authorization: auth,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Langfuse dashboard API returned HTTP ${response.status} for ${method} ${path}.`);
  return response.json();
}

const dashboardName = 'DataScout Development Quality';
const widgetName = 'Development extraction exact-match rates';
const dashboards = await request('/dashboards?limit=100');
let dashboard = dashboards.data?.find((item) => item.name === dashboardName);
if (!dashboard) {
  dashboard = await request('/dashboards', 'POST', {
    name: dashboardName,
    description: 'Development-split extraction quality scores only. Not a production quality or latency SLO dashboard.',
    definition: { widgets: [] },
    filters: [],
  });
}

const widgets = await request('/dashboard-widgets?limit=100');
let widget = widgets.data?.find((item) => item.name === widgetName);
if (!widget) {
  widget = await request('/dashboard-widgets', 'POST', {
    name: widgetName,
    description: 'Average exact-match scores from imported development-only model experiments.',
    view: 'scores-boolean',
    chartType: 'HORIZONTAL_BAR',
    dimensions: [{ field: 'name' }],
    metrics: [{ measure: 'value', agg: 'avg' }],
    filters: [{
      column: 'name',
      operator: 'any of',
      type: 'stringOptions',
      value: scoreNames,
    }],
  });
}

const freshDashboard = await request(`/dashboards/${encodeURIComponent(dashboard.id)}`);
const placements = freshDashboard.definition?.widgets ?? [];
if (!placements.some((item) => item.widgetId === widget.id)) {
  await request(`/dashboards/${encodeURIComponent(dashboard.id)}/placements`, 'POST', {
    type: 'widget',
    widgetId: widget.id,
    x: 0,
    y: 0,
    width: 12,
    height: 6,
  });
}

const verified = await request(`/dashboards/${encodeURIComponent(dashboard.id)}`);
if (!(verified.definition?.widgets ?? []).some((item) => item.widgetId === widget.id)) {
  throw new Error('Langfuse dashboard placement was not present after creation.');
}
console.log(JSON.stringify({
  dashboard: verified.name,
  widget: widget.name,
  placements: verified.definition.widgets.length,
  projectHomeChanged: false,
  dataset: 'datascout/requirements-v0.1-development',
}));
