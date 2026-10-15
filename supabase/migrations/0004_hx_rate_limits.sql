-- 0004_hx_rate_limits.sql
--
-- Distributed rate limiting for ingestion.
--
-- WHY POSTGRES
--   Serverless instances do not share memory, so a process-local counter is not
--   a real limit. Postgres is already present and shared, so a fixed-window
--   counter here is genuinely enforced across every instance.
--
-- ATOMICITY
--   hx_rate_limit_consume performs the read and the increment in one statement.
--   Two concurrent requests cannot both observe the same count, which is what
--   makes the limit hold under a burst. A read-then-write implementation in
--   application code would not.
--
-- SCOPE
--   Fixed window, not sliding. A client can send up to 2x the limit across a
--   window boundary. This is a deliberate simplicity trade-off; move to a
--   Redis-backed sliding window if boundary bursts matter.
--
-- CLEANUP
--   Expired rows are deleted opportunistically (1 in 100 calls) so no separate
--   cron job is required. Fine at low volume; add a scheduled job at scale.
--
-- Safe to run more than once (idempotent).

create table if not exists public.hx_rate_limits (
  key          text primary key,
  window_start timestamptz not null default now(),
  count        integer not null default 0 check (count >= 0),
  expires_at   timestamptz not null
);

-- Supports the opportunistic cleanup sweep.
create index if not exists hx_rate_limits_expires_idx
  on public.hx_rate_limits (expires_at);

-- ---------------------------------------------------------------------------
-- Atomic consume
-- ---------------------------------------------------------------------------
-- Fixed window. If the stored window has expired, the counter restarts;
-- otherwise it increments in place. Returns whether the caller is allowed and
-- how long until the window resets.
create or replace function public.hx_rate_limit_consume(
  p_key            text,
  p_limit          integer,
  p_window_seconds integer
)
returns table (allowed boolean, remaining integer, reset_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now    timestamptz := now();
  v_count  integer;
  v_expires timestamptz;
begin
  if p_limit <= 0 or p_window_seconds <= 0 then
    raise exception 'p_limit and p_window_seconds must be positive';
  end if;

  -- Single-statement atomic upsert. The WHERE on the DO UPDATE means an
  -- expired window resets instead of incrementing.
  insert into public.hx_rate_limits as rl (key, window_start, count, expires_at)
  values (
    p_key,
    v_now,
    1,
    v_now + make_interval(secs => p_window_seconds)
  )
  on conflict (key) do update
    set count        = case
                         when rl.expires_at <= v_now then 1
                         else rl.count + 1
                       end,
        window_start = case
                         when rl.expires_at <= v_now then v_now
                         else rl.window_start
                       end,
        expires_at   = case
                         when rl.expires_at <= v_now
                           then v_now + make_interval(secs => p_window_seconds)
                         else rl.expires_at
                       end
  returning count, expires_at into v_count, v_expires;

  -- Opportunistic cleanup of long-expired rows (roughly 1% of calls).
  if random() < 0.01 then
    delete from public.hx_rate_limits
    where expires_at < v_now - interval '1 hour';
  end if;

  return query
    select
      v_count <= p_limit,
      greatest(p_limit - v_count, 0),
      greatest(ceil(extract(epoch from (v_expires - v_now)))::integer, 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lockdown: default deny
-- ---------------------------------------------------------------------------
alter table public.hx_rate_limits enable row level security;

revoke all on public.hx_rate_limits from anon, authenticated;
revoke all on function public.hx_rate_limit_consume(text, integer, integer)
  from anon, authenticated;
