const SENSITIVE_VALUE_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?<!\d)(?:\+?91[-.\s]?)?[6-9]\d{9}\b/g,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  /\b[A-Z]{5}\d{4}[A-Z]\b/gi,
  /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:hf_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:pk|sk)-lf-[A-Za-z0-9_-]+\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:aws_secret_access_key|secret_access_key)\s*[:=]\s*[A-Za-z0-9/+=]+\b/gi,
];

export function redactSensitiveText(value: string): string {
  const queryRedacted = value.replace(
    /([?&](?:api[_-]?key|token|access[_-]?token|key)=)[^&#\s]+/gi,
    '$1[REDACTED]',
  );
  return SENSITIVE_VALUE_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, '[REDACTED]'),
    queryRedacted,
  );
}
