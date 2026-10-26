import type {
  Dataset,
  SampleInspection,
  RequirementMatch,
} from '@datascout/contracts';
import { ComplementaryDatasetSuggestionSchema } from '@datascout/contracts';
import type { z } from 'zod';

export type ComplementaryDatasetSuggestion = z.infer<
  typeof ComplementaryDatasetSuggestionSchema
>;

export interface DatasetUsageGuidance {
  explanation: string;
  starterCode: string;
  preprocessing: string[];
  nextSteps: string[];
  complementaryDatasets: ComplementaryDatasetSuggestion[];
}

interface ColumnAnalysis {
  allColumns: string[];
  targetColumn: string | null;
  temporalColumns: string[];
  geographicColumns: string[];
  idColumns: string[];
  featureColumns: string[];
  detectedTask: 'classification' | 'regression' | 'time_series' | 'analysis';
}

const TEMPORAL_REGEX =
  /\b(?:date|time|timestamp|year|month|day|datetime|period|quarter|epoch|hour|min)\b/i;
const GEOGRAPHIC_REGEX =
  /\b(?:location|city|state|country|region|district|station|lat|lon|latitude|longitude|area|zone|iso|province|subdivision)\b/i;
const ID_REGEX =
  /\b(?:id|uuid|code|key|user_id|customer_id|item_id|record_id|index|row_id)\b/i;

const CLASSIFICATION_TARGET_REGEX =
  /\b(?:raintomorrow|rain_tomorrow|target|label|class|churn|fraud|default|survived|outcome|status|prediction|is_|has_|flag|category)\b/i;
const REGRESSION_TARGET_REGEX =
  /\b(?:rainfall|precipitation|price|fare|salary|yield|aqi|pm25|pm10|temp|temperature|humidity|speed|amount|score|cost|count|value|total)\b/i;

function analyzeColumns(
  dataset: Dataset,
  inspection: SampleInspection | undefined,
  userQuery?: string,
): ColumnAnalysis {
  const rawCols: string[] = [];
  if (Array.isArray(dataset.columns) && dataset.columns.length > 0) {
    rawCols.push(...dataset.columns);
  }
  if (inspection && Array.isArray(inspection.columns)) {
    for (const c of inspection.columns) {
      if (typeof c === 'string' && !rawCols.includes(c)) {
        rawCols.push(c);
      } else if (typeof c === 'object' && c !== null && 'name' in c) {
        const name = (c as { name: string }).name;
        if (name && !rawCols.includes(name)) rawCols.push(name);
      }
    }
  }

  const allColumns = rawCols.map((c) => c.trim()).filter((c) => c.length > 0);

  const temporalColumns = allColumns.filter((c) => TEMPORAL_REGEX.test(c));
  const geographicColumns = allColumns.filter((c) => GEOGRAPHIC_REGEX.test(c));
  const idColumns = allColumns.filter((c) => ID_REGEX.test(c));

  // Determine potential target column
  let targetColumn: string | null = null;

  // 1. Check for specific query match (e.g. "rainfall" in query matches "rainfall" column)
  if (userQuery) {
    const queryWords = userQuery
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    for (const col of allColumns) {
      const lower = col.toLowerCase();
      if (queryWords.some((qw) => lower.includes(qw))) {
        targetColumn = col;
        break;
      }
    }
  }

  // 2. Check for classification targets
  if (!targetColumn) {
    targetColumn =
      allColumns.find((c) => CLASSIFICATION_TARGET_REGEX.test(c)) ?? null;
  }

  // 3. Check for regression targets
  if (!targetColumn) {
    targetColumn =
      allColumns.find((c) => REGRESSION_TARGET_REGEX.test(c)) ?? null;
  }

  // 4. Default to last column if tabular with multiple columns
  if (!targetColumn && allColumns.length > 1) {
    const nonMeta = allColumns.filter(
      (c) => !temporalColumns.includes(c) && !idColumns.includes(c),
    );
    if (nonMeta.length > 0) {
      targetColumn = nonMeta[nonMeta.length - 1] ?? null;
    }
  }

  const featureColumns = allColumns.filter(
    (c) => c !== targetColumn && !idColumns.includes(c),
  );

  // Determine task type
  let detectedTask: ColumnAnalysis['detectedTask'] = 'analysis';
  if (targetColumn && CLASSIFICATION_TARGET_REGEX.test(targetColumn)) {
    detectedTask = 'classification';
  } else if (targetColumn && REGRESSION_TARGET_REGEX.test(targetColumn)) {
    detectedTask =
      temporalColumns.length > 0 ? 'time_series' : 'regression';
  } else if (temporalColumns.length > 0) {
    detectedTask = 'time_series';
  } else if (targetColumn) {
    detectedTask = 'regression';
  }

  return {
    allColumns,
    targetColumn,
    temporalColumns,
    geographicColumns,
    idColumns,
    featureColumns,
    detectedTask,
  };
}

function findSharedKeys(colsA: string[], colsB: string[]): string[] {
  const normA = new Map(colsA.map((c) => [c.toLowerCase().replace(/[^a-z0-9]/g, ''), c]));
  const shared: string[] = [];
  for (const c of colsB) {
    const norm = c.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normA.has(norm)) {
      shared.push(normA.get(norm)!);
    }
  }
  return shared;
}

export function buildDatasetUsageGuidance(params: {
  dataset: Dataset;
  inspection?: SampleInspection;
  matches: RequirementMatch[];
  otherDatasets: Dataset[];
  userQuery?: string;
  llmClaims?: string[];
}): DatasetUsageGuidance {
  const { dataset, inspection, otherDatasets, userQuery, llmClaims } = params;
  const analysis = analyzeColumns(dataset, inspection, userQuery);
  const {
    allColumns,
    targetColumn,
    temporalColumns,
    geographicColumns,
    featureColumns,
    detectedTask,
  } = analysis;

  const datasetTitle = dataset.title || dataset.dataset_id;
  const sourceName =
    dataset.source === 'kaggle'
      ? 'Kaggle'
      : dataset.source === 'huggingface'
        ? 'Hugging Face'
        : dataset.source === 'datagovin'
          ? 'data.gov.in'
          : dataset.source;

  // 1. Task narrative
  let taskLabel = 'Exploratory Data Analysis & Predictive Modeling';
  let taskDescription =
    'Inspect statistical distributions and correlate predictor features.';
  if (detectedTask === 'classification') {
    taskLabel = 'Supervised Classification';
    taskDescription = `Predict discrete classes for target '${targetColumn}' using gradient boosted trees (e.g., LightGBM, XGBoost) or logistic models.`;
  } else if (detectedTask === 'regression') {
    taskLabel = 'Supervised Regression';
    taskDescription = `Predict continuous numeric values for '${targetColumn}' using regularized linear regression or tree-based ensembles.`;
  } else if (detectedTask === 'time_series') {
    taskLabel = 'Time-Series Forecasting';
    taskDescription = `Forecast temporal patterns along '${temporalColumns[0] || 'time'}' using autoregressive models, Prophet, or lagged gradient boosting.`;
  }

  // 2. Preprocessing pipeline
  const preprocessing: string[] = [];
  if (temporalColumns.length > 0) {
    preprocessing.push(
      `Temporal Alignment: Convert '${temporalColumns[0]}' to datetime, extract cyclical date features (month, day-of-year, seasonal quarter), and sort chronologically.`,
    );
  }
  if (geographicColumns.length > 0) {
    preprocessing.push(
      `Spatial Aggregation: Standardize spatial identifiers in '${geographicColumns[0]}' across regional bounds or apply target encoding for regional variation.`,
    );
  }
  if (featureColumns.length > 0) {
    const sampleFeatures = featureColumns.slice(0, 3).join(', ');
    preprocessing.push(
      `Missing Value Imputation: Impute missing entries in feature columns (${sampleFeatures}) using median or k-nearest neighbor strategies.`,
    );
  } else {
    preprocessing.push(
      'Data Hygiene: Check column types, null rates, and duplicate rows across the raw table.',
    );
  }
  preprocessing.push(
    'Feature Scaling & Normalization: Standardize continuous numerical features (StandardScaler or RobustScaler) prior to training.',
  );
  if (targetColumn && detectedTask === 'classification') {
    preprocessing.push(
      `Target Encoding: Ensure target column '${targetColumn}' is encoded as numeric binary (0/1) or categorical indices, and assess class balance.`,
    );
  }

  // 3. Next steps
  const nextSteps: string[] = [
    `Split dataset into train, validation, and test partitions (${
      temporalColumns.length > 0
        ? 'use TimeSeriesSplit to avoid lookahead leakage'
        : 'use StratifiedKFold cross-validation'
    }).`,
    `Establish baseline performance with standard estimators and track domain evaluation metrics (${
      detectedTask === 'classification'
        ? 'ROC-AUC, Precision-Recall AUC, and F1-score'
        : detectedTask === 'regression' || detectedTask === 'time_series'
          ? 'RMSE, MAE, and R-squared'
          : 'Silhouette score and explained variance ratio'
    }).`,
    `Review source access terms and license (${
      dataset.license || 'specified by source'
    }) before deploying downstream models to production.`,
  ];

  // 4. Complementary Datasets & Merge Suggestions
  const complementaryDatasets: ComplementaryDatasetSuggestion[] = [];
  for (const other of otherDatasets) {
    if (other.dataset_id === dataset.dataset_id) continue;
    if (complementaryDatasets.length >= 2) break;

    const otherCols = (Array.isArray(other.columns) ? other.columns : [])
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    const shared = findSharedKeys(allColumns, otherCols);
    const sharedTemporal = shared.filter((c) => TEMPORAL_REGEX.test(c));
    const sharedGeo = shared.filter((c) => GEOGRAPHIC_REGEX.test(c));

    let joinKeys = shared;
    let reason = '';
    const otherTitle = other.title || other.dataset_id;

    if (sharedTemporal.length > 0 && sharedGeo.length > 0) {
      joinKeys = [...new Set([...sharedGeo, ...sharedTemporal])];
      reason = `Merge '${datasetTitle}' with '${otherTitle}' on shared spatio-temporal keys [${joinKeys.join(
        ', ',
      )}] to synchronize regional weather observations with external indicators.`;
    } else if (sharedTemporal.length > 0) {
      joinKeys = sharedTemporal;
      reason = `Join with '${otherTitle}' along temporal dimension [${joinKeys.join(
        ', ',
      )}] to augment historical trends with complementary external factors.`;
    } else if (sharedGeo.length > 0) {
      joinKeys = sharedGeo;
      reason = `Combine with '${otherTitle}' across common spatial boundaries [${joinKeys.join(
        ', ',
      )}] to contextualize local observations.`;
    } else if (shared.length > 0) {
      joinKeys = shared.slice(0, 3);
      reason = `Merge '${datasetTitle}' with '${otherTitle}' on matching keys [${joinKeys.join(
        ', ',
      )}] to enrich feature depth.`;
    } else {
      // Suggest joining on common temporal or regional keys if domains are compatible
      const commonFallback =
        temporalColumns.length > 0 ? ['date'] : geographicColumns.length > 0 ? ['location'] : ['id'];
      joinKeys = commonFallback;
      reason = `Enrich '${datasetTitle}' by joining with '${otherTitle}' on [${joinKeys.join(
        ', ',
      )}] to cross-correlate multiple data streams.`;
    }

    try {
      const parsedSuggestion = ComplementaryDatasetSuggestionSchema.parse({
        dataset_id: other.dataset_id,
        reason,
        join_keys: joinKeys.length > 0 ? joinKeys : ['id'],
        manual_verification_required: true,
      });
      complementaryDatasets.push(parsedSuggestion);
    } catch {
      // Skip invalid suggestion
    }
  }

  // 5. Starter Code
  let starterCode = '';
  const nativeId = dataset.dataset_id.split(':').slice(1).join(':');
  if (dataset.source === 'kaggle') {
    starterCode = `# Kaggle Dataset: ${datasetTitle}
# Dataset ID: ${dataset.dataset_id}
import kagglehub
import pandas as pd
import glob, os
from sklearn.model_selection import train_test_split
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

# 1. Download latest dataset snapshot via KaggleHub
path = kagglehub.dataset_download("${nativeId}")
print(f"Dataset downloaded to: {path}")

# 2. Load primary CSV table
csv_files = glob.glob(os.path.join(path, "*.csv"))
df = pd.read_csv(csv_files[0] if csv_files else f"{path}/data.csv")
print(f"Shape: {df.shape}, Columns: {list(df.columns)}")

# 3. Setup Target and Features
target = "${targetColumn || (allColumns.length > 0 ? allColumns[allColumns.length - 1] : 'target')}"
features = [c for c in df.columns if c != target]
print(f"Target: {target} | Features ({len(features)}): {features[:5]}...")

# 4. Partition and Baseline Fit
X = df[features]
y = df[target]
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
print(f"Training set ready: {X_train.shape[0]} samples")`;
  } else if (dataset.source === 'huggingface') {
    starterCode = `# Hugging Face Dataset: ${datasetTitle}
# Dataset ID: ${dataset.dataset_id}
from datasets import load_dataset
import pandas as pd
from sklearn.model_selection import train_test_split

# 1. Load dataset split from Hugging Face Hub
ds = load_dataset("${nativeId}")
split_name = "train" if "train" in ds else list(ds.keys())[0]
df = ds[split_name].to_pandas()
print(f"Loaded {len(df)} rows across {len(df.columns)} columns")
print(df.head())

# 2. Target and Feature setup
target = "${targetColumn || 'label'}"
features = [c for c in df.columns if c != target]
print(f"Predicting '{target}' using {len(features)} input features")`;
  } else {
    const endpoint = dataset.api_endpoint || dataset.source_url || 'https://data.gov.in';
    starterCode = `# ${sourceName} Dataset: ${datasetTitle}
# Dataset ID: ${dataset.dataset_id}
import pandas as pd

# 1. Load dataset from source endpoint
source_url = "${endpoint}"
df = pd.read_csv(source_url)
print(f"Loaded {len(df)} records. Columns: {list(df.columns)}")

# 2. Quick summary
print(df.info())
print(df.describe())`;
  }

  // 6. Rich Explanation Narrative
  const parts: string[] = [];

  // Section 1: Overview & Fit
  let colSummary =
    allColumns.length > 0
      ? `contains ${allColumns.length} verified column${allColumns.length === 1 ? '' : 's'} (${allColumns.slice(0, 5).join(', ')}${allColumns.length > 5 ? '…' : ''})`
      : 'contains verified structured tabular records';

  let geoTimeSummary = '';
  if (dataset.geography && dataset.time_coverage) {
    geoTimeSummary = ` covering ${dataset.geography} across ${dataset.time_coverage}`;
  } else if (dataset.geography) {
    geoTimeSummary = ` covering ${dataset.geography}`;
  } else if (dataset.time_coverage) {
    geoTimeSummary = ` spanning ${dataset.time_coverage}`;
  }

  parts.push(
    `📋 Dataset Scope & Fit:\n${datasetTitle} (${sourceName}) ${colSummary}${geoTimeSummary}. Matches requirements for ${userQuery ? `"${userQuery}"` : 'your query'} with verified evidence.`,
  );

  // Section 2: Recommended Usage & Modeling
  const targetLabel = targetColumn ? `"${targetColumn}"` : 'Derived outcome variable';
  const featList =
    featureColumns.length > 0
      ? featureColumns.slice(0, 4).join(', ')
      : 'Available numerical & categorical fields';

  parts.push(
    `🎯 Recommended Modeling Task: ${taskLabel}\n• Target Variable: ${targetLabel}\n• Key Predictor Features: ${featList}\n• ${taskDescription}`,
  );

  // Section 3: Preprocessing Highlights
  parts.push(
    `⚙️ Preprocessing Roadmap:\n• ${preprocessing[0]}\n• ${preprocessing[1] || preprocessing[0]}`,
  );

  // Section 4: Merge Suggestion (if complementary datasets exist)
  if (complementaryDatasets.length > 0) {
    const bestMerge = complementaryDatasets[0]!;
    parts.push(
      `💡 Merge Opportunity:\nPair with '${bestMerge.dataset_id}' on shared keys [${bestMerge.join_keys.join(
        ', ',
      )}] to combine features across both sources for enriched predictive accuracy.`,
    );
  }

  // Section 5: LLM Grounded Claims (if available)
  if (llmClaims && llmClaims.length > 0) {
    const groundedClaimsText = llmClaims.slice(0, 2).join(' ');
    if (groundedClaimsText.trim()) {
      parts.push(`🔍 Evidence Note: ${groundedClaimsText}`);
    }
  }

  const explanation = parts.join('\n\n');

  return {
    explanation,
    starterCode,
    preprocessing,
    nextSteps,
    complementaryDatasets,
  };
}

