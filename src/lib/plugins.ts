// Plugin configuration API client.
//
// Thin wrapper over the four backend endpoints that expose runtime
// plugin overrides:
//
//   GET    /api/plugins/types        — discovery; what types exist
//   GET    /api/config/plugins       — current instances + source
//   PUT    /api/config/plugins       — replace the whole list (atomic)
//   PUT    /api/config/plugins/{id}  — patch one instance (enabled/config)
//   DELETE /api/config/plugins       — clear runtime override, revert to YAML
//
// All five take an authFetch matching the signature exported by
// lib/api.ts so callers can inject the same Bearer-token-aware fetch
// the rest of the viewer uses. Paths are passed without a leading
// slash because authFetch -> api() expects them that way.
//
// Backend response shapes are mirrored here as TypeScript types; the
// viewer treats config_schema.fields as opaque (null today, possibly
// populated by Phase 2 for typed form generation) and falls back to a
// raw JSON textarea when no hardcoded form covers a given type.
//
// Errors propagate. authFetch already pops the auth modal on 401 and
// throws 'unauthorized'; transport errors throw whatever fetch throws.
// The caller is responsible for showing a user-facing error message —
// see plugins.error.* keys in the i18n dictionaries.
//
// Backend error envelope (internal/api/server.go writeError) is a flat
// object `{error: "<code>", detail?: "<message>", ...extras}`. The
// plugin helpers below throw PluginAPIError on any non-2xx response so
// callers can surface the `error` code (i18n key) plus the `detail`
// message together — operators need to see WHY a reload failed, not a
// generic "Save failed" string.

// ---------- types ----------

export type PluginType = {
  type: string;
  description: string;
  // Opaque today; backend returns {fields: null} for every type in v1.
  // Reserved for future per-field metadata (label, kind, helper text).
  config_schema: any;
};

export type PluginInstance = {
  type: string;
  id: string;
  enabled: boolean;
  // Opaque bag — schema varies per type. text-replace expects
  // {routes, up:[{match,replace}], down:[...]}; text-append expects
  // {routes, target, suffix, probability}. Unknown types are edited
  // as raw JSON.
  config: any;
};

// authFetch signature matches lib/api.ts exactly. Pulled into its own
// type so callers can inject mocks in tests without dragging the
// whole api.ts module in.
export type AuthFetch = (path: string, opts?: RequestInit) => Promise<Response>;

// ---------- errors ----------

// PluginAPIError carries the backend's structured error envelope
// (`{error, detail, ...}`) so callers can surface both the code (for
// i18n lookup) and the human-readable detail. `error` is the machine
// code (e.g. "reload_failed", "bad_instance"); `detail` is the
// upstream message when present, else an empty string.
export class PluginAPIError extends Error {
  readonly error: string;
  readonly detail: string;
  readonly status: number;
  constructor(status: number, error: string, detail: string) {
    super(detail ? `${error}: ${detail}` : error);
    this.name = 'PluginAPIError';
    this.error = error;
    this.detail = detail;
    this.status = status;
  }
}

// readPluginError reads a non-2xx response body and produces a
// PluginAPIError. Tolerates non-JSON bodies (transport errors mid-
// stream, reverse-proxy 502 HTML) by falling back to the status code
// as the error string and the raw text as the detail.
async function readPluginError(r: Response): Promise<PluginAPIError> {
  let code = `http_${r.status}`;
  let detail = '';
  try {
    const body: unknown = await r.json();
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      if (typeof b.error === 'string' && b.error.length > 0) code = b.error;
      if (typeof b.detail === 'string') detail = b.detail;
    }
  } catch {
    // Non-JSON body — leave code at http_<status>, detail empty.
  }
  return new PluginAPIError(r.status, code, detail);
}

// ---------- discovery ----------

// listTypes asks the backend which plugin types are registered. The
// viewer uses this to populate the "Add plugin" type picker.
export async function listTypes(authFetch: AuthFetch): Promise<PluginType[]> {
  const r = await authFetch('api/plugins/types');
  if (!r.ok) throw await readPluginError(r);
  const body = await r.json();
  return (body && body.types) || [];
}

// ---------- read ----------

// listInstances returns the currently active instances together with
// where they came from. source === 'yaml' means no runtime override
// is in place; 'override' means PUT /api/config/plugins has been
// called at least once since startup.
export async function listInstances(
  authFetch: AuthFetch,
): Promise<{ instances: PluginInstance[]; source: string }> {
  const r = await authFetch('api/config/plugins');
  if (!r.ok) throw await readPluginError(r);
  const body = await r.json();
  return {
    instances: (body && body.instances) || [],
    source: (body && body.source) || 'yaml',
  };
}

// ---------- write ----------

// replaceAll PUTs the full instance list. Backend validates the whole
// batch atomically — either every instance applies or none do. On a
// non-2xx response (including `reload_failed` after a successful
// persist) this throws PluginAPIError so callers can surface the
// backend's `detail` field; the in-memory rollback already restored
// the previous registry by the time the error reaches us.
export async function replaceAll(
  authFetch: AuthFetch,
  instances: PluginInstance[],
): Promise<{ ok: boolean; instances?: PluginInstance[]; errors?: string[] }> {
  const r = await authFetch('api/config/plugins', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances }),
  });
  if (!r.ok) throw await readPluginError(r);
  return await r.json();
}

// patchInstance PUTs a partial update to a single instance by id.
// Both `enabled` and `config` are optional; omit either to leave it
// untouched. Backend returns the merged instance on success and a
// PluginAPIError on non-2xx (e.g. `not_found`, `bad_body`,
// `reload_failed`).
export async function patchInstance(
  authFetch: AuthFetch,
  id: string,
  patch: { enabled?: boolean; config?: any },
): Promise<{ ok: boolean; instance?: PluginInstance }> {
  const r = await authFetch(`api/config/plugins/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw await readPluginError(r);
  return await r.json();
}

// deleteAll clears the runtime override and reverts to whatever YAML
// declared at startup. Response source is always 'yaml' after this
// returns successfully; non-2xx throws PluginAPIError.
export async function deleteAll(
  authFetch: AuthFetch,
): Promise<{ ok: boolean; source: string }> {
  const r = await authFetch('api/config/plugins', { method: 'DELETE' });
  if (!r.ok) throw await readPluginError(r);
  return await r.json();
}
