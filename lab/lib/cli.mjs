export function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) out[key] = inlineValue;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) out[key] = argv[++index];
    else out[key] = true;
  }
  return out;
}

export function asList(value) {
  return value ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : [];
}

export function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
