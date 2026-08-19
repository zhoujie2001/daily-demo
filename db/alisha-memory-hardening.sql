create table if not exists public.alisha_rate_limits (
  bucket_key varchar(160) not null,
  window_start timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (bucket_key, window_start)
);

create index if not exists alisha_rate_limits_window_idx
  on public.alisha_rate_limits(window_start);

alter table public.alisha_rate_limits enable row level security;
grant select, insert, update, delete on table public.alisha_rate_limits to service_role;
revoke all on table public.alisha_rate_limits from anon, authenticated;

create or replace function public.consume_alisha_rate_limit(
  p_bucket_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, remaining integer, retry_after integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  if length(p_bucket_key) < 4 or length(p_bucket_key) > 160 then
    raise exception 'invalid rate limit bucket';
  end if;
  if p_limit < 1 or p_limit > 10000 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit parameters';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into public.alisha_rate_limits(bucket_key, window_start, request_count, updated_at)
  values (p_bucket_key, v_window_start, 1, clock_timestamp())
  on conflict (bucket_key, window_start)
  do update set
    request_count = public.alisha_rate_limits.request_count + 1,
    updated_at = clock_timestamp()
  returning request_count into v_count;

  return query select
    v_count <= p_limit,
    greatest(p_limit - v_count, 0),
    greatest(
      ceil(extract(epoch from (v_window_start + make_interval(secs => p_window_seconds) - clock_timestamp())))::integer,
      1
    );
end;
$$;

revoke execute on function public.consume_alisha_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_alisha_rate_limit(text, integer, integer)
  to service_role;
