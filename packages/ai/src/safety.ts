import { Buffer } from 'node:buffer';
import type { RefusalReasonCode } from '@datascout/contracts';
import type { SafetyCheck } from './extraction.js';

const injectionPatterns = [
  /\b(?:ignore|disregard|override|forget)\b[^.!?\n]{0,120}\b(?:instructions?|rules?|prompts?|the\s+user|user\s+request|system|developer)\b/iu,
  /\b(?:reveal|show|print|repeat|disclose|dump|exfiltrate)\b[^.!?\n]{0,100}\b(?:system\s+prompt|developer\s+message|api\s+key|access\s+token|credentials?|secrets?)\b/iu,
  /\b(?:bypass|disable|turn\s+off)\b[^.!?\n]{0,100}\b(?:safety|content|security)\b[^.!?\n]{0,40}\b(?:filter|rules?|checks?|guardrails?)\b/iu,
  /\b(?:act|pretend|role\s*play)\s+as\s+(?:an?\s+)?(?:unrestricted|developer|system|admin|administrator)\b/iu,
  /\bclaim\b[^.!?\n]{0,100}\b(?:verified|suitable|passed?)\b[^.!?\n]{0,50}\b(?:even\s+if|regardless|without)\b/iu,
];

function normalizeText(value: string): { text: string; originalOffsets: number[] } {
  let text = '';
  const originalOffsets: number[] = [];
  let sourceOffset = 0;
  for (const character of value) {
    const normalized = character.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/gu, '');
    text += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      originalOffsets.push(sourceOffset);
    }
    sourceOffset += character.length;
  }
  return { text, originalOffsets };
}

function injectionIndex(value: string): number {
  return injectionPatterns
    .map((pattern) => pattern.exec(value)?.index ?? -1)
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
}

function decodedInjectionIndex(value: string): number {
  const base64Tokens = /\b[A-Za-z0-9+/]{20,}={0,2}/gu;
  for (const match of value.matchAll(base64Tokens)) {
    const token = match[0];
    if (!token) continue;
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const isPrintable = [...decoded].every((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
    });
    if (!isPrintable) continue;
    if (injectionIndex(decoded) >= 0) return match.index ?? -1;
  }
  return -1;
}

function trimLabeledUntrustedTail(prefix: string): string {
  const marker = /\b(?:dataset\s+note|dataset\s+card|source\s+text|quoted\s+text)\s*:/iu.exec(prefix);
  return marker?.index !== undefined ? prefix.slice(0, marker.index).trim() : prefix.trim();
}

function isClearSearchPrefix(prefix: string): boolean {
  const clean = prefix.trim();
  return clean.length >= 20 &&
    /^\s*(?:please\s+)?(?:find|search|look\s+for|get|recommend|i\s+need)\b/iu.test(clean);
}

/**
 * Remove an appended hostile instruction from a clear dataset query while
 * retaining the original prefix (so source spans still point into the query).
 * A standalone jailbreak or prompt-exfiltration request is refused.
 */
export function createRequestSafetyCheck(): SafetyCheck {
  return (query) => {
    const normalized = normalizeText(query);
    const directIndex = injectionIndex(normalized.text);
    const encodedIndex = decodedInjectionIndex(normalized.text);
    const matchIndex = [directIndex, encodedIndex].filter((value) => value >= 0)
      .sort((left, right) => left - right)[0] ?? -1;
    if (matchIndex < 0) return null;

    const sourceIndex = normalized.originalOffsets[matchIndex] ?? query.length;
    const sourcePrefix = query.slice(0, sourceIndex);
    const marker = /\b(?:dataset\s+note|dataset\s+card|source\s+text|quoted\s+text)\s*:/iu.exec(sourcePrefix);
    const safePrefix = marker?.index !== undefined
      ? sourcePrefix.slice(0, marker.index).trim()
      : sourcePrefix.trim();
    const normalizedPrefix = trimLabeledUntrustedTail(normalized.text.slice(0, matchIndex));
    if (isClearSearchPrefix(normalizedPrefix) && isClearSearchPrefix(safePrefix)) {
      return { sanitizedQuery: safePrefix };
    }
    return 'unsafe_request' satisfies RefusalReasonCode;
  };
}
