# OpenML connector

The adapter searches the OpenML dataset list by the extracted topic, then requests description, feature, and quality metadata for each bounded candidate. It caps results at 20, maps feature names to `columns`, and records `NumberOfInstances` as the source-reported record count. License and quality values remain source claims. File samples are not downloaded, so the adapter reports `metadata_only`.

The connector uses HTTPS to `www.openml.org`, respects cancellation, applies safe-fetch byte and timeout limits, and returns a failed source status on upstream errors. OpenML's current API behavior should be checked against a live catalog during integration; the adapter is fixture-friendly through its configurable base URL.
