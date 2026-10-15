-- 0003_hx_api_keys.sql
--
-- Project-scoped API keys for telemetry ingestion, plus the atomic ingest
-- function used by POST /api/v1/traces.
--
-- SECURITY MODEL (same as 0002):
--   Custom auth, no Supabase Auth. auth.uid() is always NULL, so RLS stays
--   default-deny with ZERO policies. Only the server (service_role) can read
--   or write these tables.
--
-- KEY HANDLING:
--   The raw key is shown to the user exactly once at creation time and is
--   never stored. The database stores only a SHA-256 hash of the key. A
--   database leak therefore does not hand over usable credentials.
--
-- Safe to run more than once (idempotent).

-- ---------------------------------------------------------------------------
-- API keys
-- ---------------------------------------------------------------------------
create table if not exists public.hx_api_keys (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.hx_projects(id) on delete cascade,
  name         text not null default 'default',
  -- SHA-256 hex of the full key. Never store the raw value.
  key_hash     text not null,
  -- First 12 chars of the key (e.g. "hx_live_ab12"), safe to display in a UI.
  key_prefix   text not null,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint hx_api_keys_hash_key    unique (key_hash),
  constraint hx_api_keys_hash_len    check (char_length(key_hash) = 64),
  constraint hx_api_keys_prefix_len  check (char_length(key_prefix) between 8 and 16),
  constraint hx_api_keys_name_len    check (char_length(name) between 1 and 100)
);

-- Lookup path for authentication: hash -> row.
create index if not exists hx_api_keys_project_idx
  on public.hx_api_keys (project_id, created_at desc);

-- Partial index: only live keys are ever looked up during authentication.
create index if not exists hx_api_keys_active_idx
  on public.hx_api_keys (key_hash)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Atomic trace ingestion
-- ---------------------------------------------------------------------------
-- Inserts one trace and all of its spans in a single transaction, so a failure
-- part-way through never leaves a trace with missing spans.
--
-- Idempotency: re-sending the same (project_id, external_trace_id) is a no-op.
-- Returns the resolved trace id and whether this call created the row.
--
-- SECURITY DEFINER is deliberate: this function is callable only by the server
-- (service_role), and RLS on the target tables is default-deny. search_path is
-- pinned to defeat search_path hijacking.
create or replace function public.hx_ingest_trace(
  p_project_id        uuid,
  p_external_trace_id text,
  p_name              text,
  p_status            text,
  p_started_at        timestamptz,
  p_ended_at          timestamptz,
  p_environment       text,
  p_metadata          jsonb,
  p_spans             jsonb
)
returns table (trace_id uuid, inserted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trace_id uuid;
  v_inserted boolean := false;
begin
  -- Idempotent insert. on conflict do nothing means a duplicate submission
  -- leaves the original row (and its spans) untouched.
  insert into public.hx_traces (
    project_id, external_trace_id, name, status,
    started_at, ended_at, environment, metadata
  )
  values (
    p_project_id, p_external_trace_id, p_name, p_status,
    p_started_at, p_ended_at, p_environment, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (project_id, external_trace_id) do nothing
  returning id into v_trace_id;

  if v_trace_id is not null then
    v_inserted := true;

    if p_spans is not null and jsonb_array_length(p_spans) > 0 then
      insert into public.hx_spans (
        trace_id, external_span_id, parent_external_span_id, name, kind,
        status, started_at, ended_at, attributes, error
      )
      select
        v_trace_id,
        s->>'externalSpanId',
        nullif(s->>'parentExternalSpanId', ''),
        s->>'name',
        s->>'kind',
        s->>'status',
        (s->>'startedAt')::timestamptz,
        nullif(s->>'endedAt', '')::timestamptz,
        coalesce(s->'attributes', '{}'::jsonb),
        case when s ? 'error' then s->'error' else null end
      from jsonb_array_elements(p_spans) as s;
    end if;
  else
    -- Row already existed: return the stored id so the caller can respond
    -- 200 instead of 201.
    select t.id into v_trace_id
    from public.hx_traces t
    where t.project_id = p_project_id
      and t.external_trace_id = p_external_trace_id;
  end if;

  return query select v_trace_id, v_inserted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lockdown: default deny
-- ---------------------------------------------------------------------------
alter table public.hx_api_keys enable row level security;

revoke all on public.hx_api_keys from anon, authenticated;
revoke all on function public.hx_ingest_trace(
  uuid, text, text, text, timestamptz, timestamptz, text, jsonb, jsonb
) from anon, authenticated;
