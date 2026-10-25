# World Bank Indicators connector

The adapter searches the first five pages of the World Bank indicator catalog (100 indicators per page), filters indicator names and topics locally, and caps results at 20. This bounded lookup is an initial source path; the planned periodic indicator index should replace the live page scan for broader recall and lower per-search latency.

Each candidate is a country-year indicator series, not a row-level ML dataset. The adapter says so in its description, exposes `country`, `year`, and `value` as the API's series fields, and marks the result `metadata_only`. It does not infer record counts, data coverage, or country coverage. A caller may configure country codes; the default is all countries. Source metadata and API access instructions remain subject to upstream availability and terms.
