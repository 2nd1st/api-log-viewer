// Display helpers for the (client_kind, client_version) pair surfaced
// by parser.ExtractClient. The version field is sometimes a protocol /
// runtime artifact rather than app identity — Go's net/http stdlib UA,
// for example, reports the HTTP protocol version (Go-http-client/2.0,
// Go-http-client/1.1) regardless of the calling app. Showing "2.0"
// next to "go-http-client" implies the operator knows which app is
// hitting them when the parser only knows the protocol.
//
// Per the v0.1.1 deploy audit (api-log workflow we0wvgjhv): sub2api's
// 27/200 go-http-client rows all report version "2.0"; if the parser
// is correct, two adjacent apps with different go-http-client behavior
// would still report 2.0. The viewer hides the noisy versions to keep
// the column honest.
//
// When future taxonomies have the same shape (the audit flagged
// browser as a likely candidate — generic Chrome UA carries no
// per-deployment signal, but the parser already drops browser version
// at parse time, so it's already nil here), add the kind name to
// NOISY_VERSION_KINDS. Keep the set small and motivated.

const NOISY_VERSION_KINDS: ReadonlySet<string> = new Set([
  'go-http-client',
]);

// displayClientVersion returns the version string to render to the
// operator. Returns '—' when (a) version is empty/null/undefined, or
// (b) kind is in the noisy-version allowlist.
export function displayClientVersion(
  kind: string | null | undefined,
  version: string | null | undefined,
): string {
  if (!version) return '—';
  if (kind && NOISY_VERSION_KINDS.has(kind)) return '—';
  return version;
}

// clientLabel formats "kind version" for tooltip / label display,
// honoring the noisy-version filter. Empty kind yields empty string
// (caller decides what to substitute).
export function clientLabel(
  kind: string | null | undefined,
  version: string | null | undefined,
): string {
  if (!kind) return '';
  const v = displayClientVersion(kind, version);
  if (v === '—') return kind;
  return kind + ' ' + v;
}
