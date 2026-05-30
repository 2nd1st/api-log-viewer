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

// ---------- discovery ----------

// listTypes asks the backend which plugin types are registered. The
// viewer uses this to populate the "Add plugin" type picker.
export async function listTypes(authFetch: AuthFetch): Promise<PluginType[]> {
  const r = await authFetch('api/plugins/types');
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
  const body = await r.json();
  return {
    instances: (body && body.instances) || [],
    source: (body && body.source) || 'yaml',
  };
}

// ---------- write ----------

// replaceAll PUTs the full instance list. Backend validates the whole
// batch atomically — either every instance applies or none do. The
// response either has ok:true with the normalized instances, or
// ok:false with a list of per-instance errors.
export async function replaceAll(
  authFetch: AuthFetch,
  instances: PluginInstance[],
): Promise<{ ok: boolean; instances?: PluginInstance[]; errors?: any[] }> {
  const r = await authFetch('api/config/plugins', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances }),
  });
  return await r.json();
}

// patchInstance PUTs a partial update to a single instance by id.
// Both `enabled` and `config` are optional; omit either to leave it
// untouched. Backend returns the merged instance on success.
export async function patchInstance(
  authFetch: AuthFetch,
  id: string,
  patch: { enabled?: boolean; config?: any },
): Promise<{ ok: boolean; instance?: PluginInstance; errors?: any[] }> {
  const r = await authFetch(`api/config/plugins/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return await r.json();
}

// deleteAll clears the runtime override and reverts to whatever YAML
// declared at startup. Response source is always 'yaml' after this
// returns successfully.
export async function deleteAll(
  authFetch: AuthFetch,
): Promise<{ ok: boolean; source: string }> {
  const r = await authFetch('api/config/plugins', { method: 'DELETE' });
  return await r.json();
}
