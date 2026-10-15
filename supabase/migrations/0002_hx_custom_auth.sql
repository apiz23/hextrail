-- 0002_hx_custom_auth.sql
--
-- Custom authentication schema for Hextrail.
-- All application tables use the hx_ prefix.
--
-- SECURITY MODEL (read before using):
--   This project does NOT use Supabase Auth. There is no JWT that Postgres
--   trusts, so auth.uid() is always NULL. Row Level Security therefore cannot
--   identify the caller and is used here as a DEFAULT-DENY backstop only:
--   RLS is enabled on every table with ZERO policies, and access is revoked
--   from the anon and authenticated roles.
--
--   The effective security boundary is the Next.js server: only the server
--   (using the service-role key) can touch these tables, and it performs its
--   own session checks before any query. The service-role key MUST stay
--   server-side and must never reach the browser.
--
-- Safe to run more than once (idempotent).

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
-- pgcrypto provides crypt()/gen_salt() for bcrypt password hashing.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
create table if not exists public.hx_users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  password_hash  text not null,
  display_name   text,
  avatar_url     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint hx_users_email_len    check (char_length(email) between 3 and 254),
  constraint hx_users_email_format check (email like '%_@_%._%'),
  -- bcrypt hashes produced by crypt() are 60 chars with the $2a$/$2b$ prefix.
  constraint hx_users_hash_len     check (char_length(password_hash) >= 20)
);

-- Case-insensitive uniqueness: store email lowercased and enforce it.
create unique index if not exists hx_users_email_key
  on public.hx_users (lower(email));

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
-- Opaque sessions. The raw token lives only in the user's cookie; the database
-- stores a SHA-256 hash, so a database leak does not expose live sessions.
create table if not exists public.hx_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.hx_users(id) on delete cascade,
  token_hash  text not null,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint hx_sessions_token_hash_key unique (token_hash),
  constraint hx_sessions_expiry_check check (expires_at > created_at)
);

create index if not exists hx_sessions_user_idx
  on public.hx_sessions (user_id, expires_at desc);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
create table if not exists public.hx_projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.hx_users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists hx_projects_owner_idx
  on public.hx_projects (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Traces
-- ---------------------------------------------------------------------------
create table if not exists public.hx_traces (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.hx_projects(id) on delete cascade,
  external_trace_id  text not null,
  name               text not null,
  status             text not null check (status in ('ok', 'error', 'running')),
  started_at         timestamptz not null,
  ended_at           timestamptz,
  environment        text,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  constraint hx_traces_external_key unique (project_id, external_trace_id),
  constraint hx_traces_time_check   check (ended_at is null or ended_at >= started_at)
);

create index if not exists hx_traces_project_started_idx
  on public.hx_traces (project_id, started_at desc);
create index if not exists hx_traces_project_status_idx
  on public.hx_traces (project_id, status);

-- ---------------------------------------------------------------------------
-- Spans
-- ---------------------------------------------------------------------------
create table if not exists public.hx_spans (
  id                       uuid primary key default gen_random_uuid(),
  trace_id                 uuid not null references public.hx_traces(id) on delete cascade,
  external_span_id         text not null,
  parent_external_span_id  text,
  name                     text not null,
  kind                     text not null check (
    kind in ('agent', 'llm', 'tool', 'retriever', 'chain', 'custom')
  ),
  status                   text not null check (status in ('ok', 'error', 'running')),
  started_at               timestamptz not null,
  ended_at                 timestamptz,
  attributes               jsonb not null default '{}'::jsonb,
  error                    jsonb,
  created_at               timestamptz not null default now(),
  constraint hx_spans_external_key unique (trace_id, external_span_id),
  constraint hx_spans_time_check   check (ended_at is null or ended_at >= started_at)
);

create index if not exists hx_spans_trace_started_idx
  on public.hx_spans (trace_id, started_at);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.hx_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists hx_users_set_updated_at on public.hx_users;
create trigger hx_users_set_updated_at
  before update on public.hx_users
  for each row execute function public.hx_set_updated_at();

drop trigger if exists hx_projects_set_updated_at on public.hx_projects;
create trigger hx_projects_set_updated_at
  before update on public.hx_projects
  for each row execute function public.hx_set_updated_at();

-- ---------------------------------------------------------------------------
-- Lockdown: default deny
-- ---------------------------------------------------------------------------
-- RLS is enabled with no policies on purpose. With custom auth there is no
-- auth.uid(), so a policy cannot identify the caller. Default-deny means the
-- browser-facing roles get nothing; the server uses service_role.
alter table public.hx_users    enable row level security;
alter table public.hx_sessions enable row level security;
alter table public.hx_projects enable row level security;
alter table public.hx_traces   enable row level security;
alter table public.hx_spans    enable row level security;

revoke all on public.hx_users    from anon, authenticated;
revoke all on public.hx_sessions from anon, authenticated;
revoke all on public.hx_projects from anon, authenticated;
revoke all on public.hx_traces   from anon, authenticated;
revoke all on public.hx_spans    from anon, authenticated;

revoke all on function public.hx_set_updated_at() from anon, authenticated;
