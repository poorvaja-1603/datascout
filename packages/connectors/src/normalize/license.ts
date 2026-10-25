const EXACT_LICENSE_MAP: Record<string, string> = {
  // Inherently unversioned licenses
  mit: 'MIT',
  isc: 'ISC',
  'godl-india': 'GODL-India',
  'government open data license - india (godl)': 'GODL-India',
  'government open data license - india': 'GODL-India',
  'government open data license india': 'GODL-India',

  // Versioned Apache
  'apache-2.0': 'Apache-2.0',
  'apache 2.0': 'Apache-2.0',
  apache2: 'Apache-2.0',
  'apache-2': 'Apache-2.0',
  'apache 2': 'Apache-2.0',

  // Versioned CC0
  'cc0-1.0': 'CC0-1.0',
  'cc0 1.0': 'CC0-1.0',

  // Versioned Creative Commons
  'cc-by-4.0': 'CC-BY-4.0',
  'cc by 4.0': 'CC-BY-4.0',
  'cc-by-3.0': 'CC-BY-3.0',
  'cc by 3.0': 'CC-BY-3.0',

  'cc-by-sa-4.0': 'CC-BY-SA-4.0',
  'cc by sa 4.0': 'CC-BY-SA-4.0',

  'cc-by-nc-4.0': 'CC-BY-NC-4.0',
  'cc by nc 4.0': 'CC-BY-NC-4.0',

  'cc-by-nd-4.0': 'CC-BY-ND-4.0',
  'cc by nd 4.0': 'CC-BY-ND-4.0',

  'cc-by-nc-nd-4.0': 'CC-BY-NC-ND-4.0',
  'cc by nc nd 4.0': 'CC-BY-NC-ND-4.0',

  // Versioned ODbL
  'odbl-1.0': 'ODbL-1.0',
  'odbl 1.0': 'ODbL-1.0',

  // Versioned OGL
  'ogl-uk-3.0': 'OGL-UK-3.0',
  'ogl-3.0': 'OGL-UK-3.0',

  // Versioned/variant BSD
  'bsd-3-clause': 'BSD-3-Clause',
  'bsd 3-clause': 'BSD-3-Clause',
  'bsd-2-clause': 'BSD-2-Clause',
  'bsd 2-clause': 'BSD-2-Clause',

  // Versioned GPL
  'gpl-3.0': 'GPL-3.0',
  'gpl 3.0': 'GPL-3.0',
  gplv3: 'GPL-3.0',
  'gpl-2.0': 'GPL-2.0',
  'gpl 2.0': 'GPL-2.0',
  gplv2: 'GPL-2.0',
};

export function normalizeLicense(
  rawLicense: string | null | undefined,
): string {
  if (
    rawLicense === null ||
    rawLicense === undefined ||
    typeof rawLicense !== 'string'
  ) {
    return 'unknown';
  }

  const normalizedKey = rawLicense.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalizedKey.length === 0) {
    return 'unknown';
  }

  return EXACT_LICENSE_MAP[normalizedKey] ?? 'unknown';
}
