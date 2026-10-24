# `score-v1`

`score-v1` is deterministic and independent of language-model output. Its five
component point totals are rounded individually to integer hundredths using
round-half-up integer arithmetic, then summed. The maximum is 100. Missing or
unknown dimensions are not redistributed.

## Components

| Component                  | Maximum | Rule                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirement satisfaction   |      50 | All derived requirements count. Topic, geography, time coverage, minimum records, each required feature, target, and each constraint weigh 3. Each preference weighs 1. PASS/PARTIAL/FAIL/UNKNOWN earn 2/1/0/0 credits. Points in hundredths are `floor((5000 * N + D / 2) / D)`, where `N = Σ(weight * credit)` and `D = Σ(weight * 2)`.                                                 |
| Validation and access      |      20 | Access: open 8, key/registration required 5, gated 2, unknown 0. Supported format or API endpoint: 4. Successful inspection with at least one row: 4. Only for successful inspection: mean column missingness ≤5%: 2, ≤20%: 1; duplicate rate ≤1%: 1; at least 90% of columns with a nonempty inferred type: 1.                                                                           |
| Metadata completeness      |      15 | Ten equal fields: description, license, formats, record count, columns, geography, time coverage, last updated, tags, and access (API endpoint or source URL). Description must have at least 40 non-placeholder characters; record count must be a nonnegative integer. Other fields must be present and non-placeholder. Score is `15 * present applicable fields / applicable fields`. |
| License and source clarity |      10 | License: recognized open license 6; NC/ND restricted Creative Commons license 4; other non-placeholder text 2; absent/placeholder 0. Provenance: allowlisted source URL host 2; provenance for ≥80% of populated metadata fields 2, or ≥50% 1.                                                                                                                                            |
| Freshness                  |       5 | Age from `last_updated` to `retrieved_at`: ≤365 days 5; ≤730 days 3; ≤1,825 days 1; older, missing, invalid, or future-dated 0. This component is never exempt.                                                                                                                                                                                                                           |

The score uses the same rule for every source except the stated metadata
applicability exemptions: Hugging Face, OpenML, and UCI exclude geography and
time coverage; World Bank excludes formats, record count, and columns; Zenodo
excludes columns and record count. data.gov.in, Dataverse, CKAN, and unlisted
sources have no exemptions.

The implementation treats `csv`, `json`, and `parquet` as inspector-supported
formats, following the plan's safe-parser list. Access values are normalized
case-insensitively and mapped from `open`, `public`, `open access`,
`open_access`, `download`, or `api` to open; `key_required`, `key required`,
`api_key`, `api key`, `registration`, `registration_required`, or
`registration required` to key/registration; `gated`, `restricted`,
`embargoed`, or `approval_required` to gated. Other values are unknown.

Recognized open-license identifiers are CC0, CC-BY, ODbL, MIT, Apache-2.0,
GODL-India, and OGL. NC or ND identifiers take precedence as restricted.
Placeholder values are the case-insensitive exact strings `-`, `—`, `n/a`,
`na`, `none`, `null`, `undefined`, `unknown`, `not available`, and
`not provided`. `createScorer` accepts an explicit `sourceHosts` map for
source-specific allowlisted hosts. Its built-in host entries cover data.gov.in,
Hugging Face, OpenML, World Bank, UCI, and Zenodo; configure Dataverse and CKAN
hosts explicitly.

Evidence coverage is separate from the total. Its denominator is every
requirement, including preferences. A requirement is covered only when its
non-UNKNOWN match cites at least one evidence ID present in the supplied
evidence list, with the same dataset ID and nonempty source-field path and
retrieval timestamp. Coverage is rounded to integer hundredths using
round-half-up. An empty requirement list is rejected because the extraction
contract requires a topic.

Ranking uses integer hundredths: total descending, evidence coverage
descending, then `dataset_id` ascending with JavaScript's plain string
comparison (ASCII/code-point order; no locale comparison). Duplicate IDs are
rejected. The ranked result assigns consecutive ranks starting at 1; source,
retrieval order, explanation, and model output are not tie-breakers.

## Contract/data caveats

- The shared Dataset contract does not distinguish a landing-page `source_url`
  from a direct download URL. For the metadata `access` field, this version
  counts a non-null `api_endpoint` or `source_url`; source adapters should
  provide a true download URL in a future contract if that distinction matters.
- `access_type` is an unrestricted string in the shared contract. The aliases
  and placeholder values above are this package's explicit mapping; unlisted
  access values earn zero, and placeholder policy changes require a deliberate
  package update.
- `Dataset.provenance` has field-level source paths and timestamps, but no
  common source-host registry. Known canonical hosts are supplied by this
  package; Dataverse/CKAN deployments must pass their configured host allowlist.
- `SampleInspection` carries one inferred-type string per column, but no
  row-level type consistency metrics. The 90% check therefore counts columns
  with a nonempty inferred-type string; stronger within-column consistency
  cannot be calculated from the current contract.
- A null missing-rate value makes the mean missingness unavailable; this
  implementation awards neither missingness threshold in that case.
