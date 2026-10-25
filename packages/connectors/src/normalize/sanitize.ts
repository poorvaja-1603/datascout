import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from './types.js';

// ASCII control chars except \t, \n, \r
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Zero-width and bidi override Unicode characters
const ZERO_WIDTH_AND_BIDI_REGEX =
  /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|#39);/gi,
    (match) => HTML_ENTITY_MAP[match.toLowerCase()] ?? match,
  );
}

export function sanitizeText(
  rawText: string | null | undefined,
  maxLength: number,
): string | null {
  if (rawText === null || rawText === undefined || typeof rawText !== 'string') {
    return null;
  }

  let text = rawText;

  // 1. Remove control characters & zero-width / bidi overrides
  text = text.replace(CONTROL_CHARS_REGEX, '');
  text = text.replace(ZERO_WIDTH_AND_BIDI_REGEX, '');

  // 2. Loop entity decoding & markup stripping until stable to eliminate
  // nested/broken tags (e.g. "<scr<script>ipt>") and entity-encoded tags (e.g. "&lt;script&gt;").
  let previous: string;
  let iterations = 0;
  const MAX_ITERATIONS = 20;

  do {
    previous = text;

    // Decode HTML entities first so encoded tags like &lt;script&gt; become real tags before stripping
    text = decodeHtmlEntities(text);

    // Strip <script> and <style> blocks and their content
    text = text.replace(
      /<\s*(?:script|style)\b[^<>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi,
      '',
    );
    // Strip markdown links [text](url) -> text
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Strip HTML/XML tags without crossing < boundaries (strips innermost tag first)
    text = text.replace(/<[^<>]+>/g, '');
    // Strip any trailing unclosed tag and remaining lone angle brackets
    text = text.replace(/<[^>]*$/g, '');
    text = text.replace(/[<>]/g, '');

    iterations++;
  } while (text !== previous && iterations < MAX_ITERATIONS);

  // 3. Normalize whitespace
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length === 0) {
    return null;
  }

  // 4. Bound the length
  if (text.length > maxLength) {
    text = text.slice(0, maxLength).trim();
  }

  return text.length > 0 ? text : null;
}

export function sanitizeTitle(
  title: string | null | undefined,
): string | null {
  return sanitizeText(title, MAX_TITLE_LENGTH);
}

export function sanitizeDescription(
  desc: string | null | undefined,
): string | null {
  return sanitizeText(desc, MAX_DESCRIPTION_LENGTH);
}
