# Optional source connectors

The optional source connectors are off unless their constructor receives `enabled: true`. Do not enable one in a deployment until its API behavior, licensing, and fixture/failure coverage have been reviewed.

## UCI Machine Learning Repository

`UciConnector` searches the UCI list endpoint using the extracted topic, then fetches bounded metadata by numeric dataset ID. It maps reported variables to columns and keeps record count, area, license, and description at metadata-only confidence. It never downloads dataset files or runs dataset code. API shape follows the official `ucimlrepo` client endpoints; values stay source claims.

## Zenodo

`ZenodoConnector` queries published records using the dataset resource type, maps file names to advertised formats, and carries source-reported access and license values. It does not download file contents. The free-text topic is placed inside Zenodo's search syntax, so search behavior can vary for special query characters; request size is capped at 20.

## Harvard Dataverse

`DataverseConnector` only returns dataset search hits with numeric entity IDs, retrieves the latest published version and its file metadata, and skips a result if any listed file is restricted. File contents and tabular variable metadata are not downloaded. Its default installation is Harvard Dataverse; alternate instances can be configured through `baseUrl` and are still host-allowlisted by the safe-fetch SSRF check.

## Generic CKAN (stretch)

`CkanConnector` requires an explicit list of portal IDs and HTTPS base URLs, pins outbound requests to each configured host, and does not follow redirects. It searches with `package_search`, maps package metadata/resources, and retrieves details with `package_show`. It does not inspect files or infer row counts. Only configure public, reviewed portals; portal-specific licensing and metadata quality vary.

All four adapters default to disabled and return a visible `disabled` source status until enabled. Search, detail, and transport failures remain bounded. These connectors still need fixture-backed contract and graceful-failure checks before a production source flag is enabled.
