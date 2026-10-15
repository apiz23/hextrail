-- Initial schema proposal. Review and test before applying to a live database.
--
-- ============================================================================
-- DO NOT RUN THIS FILE.
--
-- Superseded by 0002_hx_custom_auth.sql.
--
-- This file depends on Supabase Auth: owner_id references auth.users(id) and
-- every policy calls auth.uid(). Hextrail uses custom authentication
-- (see 0002), so auth.uid() is always NULL here and the policies below would
-- match nothing. Applying both migrations would also create two competing sets
-- of tables (projects/traces/spans vs hx_projects/hx_traces/hx_spans).
--
-- Kept only as a record of the original design. Use 0002 instead.
-- ============================================================================
create extension if not exists pgcrypto;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table if not exists public.traces (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  external_trace_id text not null,
  name text not null,
  status text not null check (status in ('ok', 'error')),
  started_at timestamptz not null,
  ended_at timestamptz,
  environment text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, external_trace_id),
  check (ended_at is null or ended_at >= started_at)
);

create table if not exists public.spans (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null references public.traces(id) on delete cascade,
  external_span_id text not null,
  parent_external_span_id text,
  name text not null,
  kind text not null check (kind in ('agent', 'llm', 'tool', 'retriever', 'chain', 'custom')),
  status text not null check (status in ('ok', 'error')),
  started_at timestamptz not null,
  ended_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  unique (trace_id, external_span_id),
  check (ended_at is null or ended_at >= started_at)
);

create index if not exists traces_project_started_idx on public.traces(project_id, started_at desc);
create index if not exists traces_project_status_idx on public.traces(project_id, status);
create index if not exists spans_trace_started_idx on public.spans(trace_id, started_at);

alter table public.projects enable row level security;
alter table public.traces enable row level security;
alter table public.spans enable row level security;

create policy "Owners can read their projects"
  on public.projects for select
  using (owner_id = (select auth.uid()));

create policy "Owners can create their projects"
  on public.projects for insert
  with check (owner_id = (select auth.uid()));

create policy "Owners can update their projects"
  on public.projects for update
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "Owners can delete their projects"
  on public.projects for delete
  using (owner_id = (select auth.uid()));

create policy "Owners can read traces"
  on public.traces for select
  using (exists (
    select 1 from public.projects p
    where p.id = traces.project_id and p.owner_id = (select auth.uid())
  ));

create policy "Owners can read spans"
  on public.spans for select
  using (exists (
    select 1 from public.traces t
    join public.projects p on p.id = t.project_id
    where t.id = spans.trace_id and p.owner_id = (select auth.uid())
  ));

-- No browser insert/update/delete policies for traces or spans. Ingestion must
-- go through a separately authenticated server-side endpoint.
