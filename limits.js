export function getLimits(env = process.env) {
  const setting = env.MAX_UPLOAD_MB;
  const raw = setting === undefined ? '10' : String(setting).trim();
  const megabytes = Number(raw);
  if (!/^\d+$/.test(raw) || megabytes <= 0 || !Number.isSafeInteger(megabytes * 1_000_000)) {
    throw new Error('MAX_UPLOAD_MB must be a positive whole number of MB with a safe byte size.');
  }
  return { maxUploadBytes: megabytes * 1_000_000, maxModelBytes: 2_000_000, maxFiles: 10 };
}
