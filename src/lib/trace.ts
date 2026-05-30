// Shared types for the trace detail surface.
//
// Previously these lived inside DetailPanel.svelte's <script module> block
// because that's where the detail view first needed them. Every adapter
// and tab component then had to import from a Svelte module path
// (`'../../components/DetailPanel.svelte'`) which inverts the natural
// dependency direction — lib/ should be the trunk, components/ the leaves.
//
// Kept intentionally permissive (Record<string, any>, body?: any) because
// the JSON shape returned by `GET /api/traces/:id` is whatever the
// recorder captured. Each consumer narrows what it expects locally.

export type TraceRow = {
  id: string;
  method?: string;
  path?: string;
  status?: number | null;
  ts_start?: string | null;
  ts_end?: string | null;
  model?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  key_hash?: string | null;
  parent_id?: string | null;
  [k: string]: any;
};

export type TraceBlob = {
  req?: { headers?: Record<string, string>; body?: any; body_b64?: string };
  resp?: {
    headers?: Record<string, string>;
    body?: any;
    body_b64?: string;
    events?: Array<{ t_delta_ms?: number; event?: string; data?: any }>;
  };
};

export type TraceDetail = { row: TraceRow; trace?: TraceBlob };
