/** Masks bearer tokens, key=value secrets and URL credentials in text shown to a model or the person. */
export function redactEvidence(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s'"`]+)/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/[^\s:@]+:)[^\s@]+@/gi, "$1[REDACTED]@");
}
