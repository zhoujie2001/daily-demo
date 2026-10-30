-- ISOLATED MINIMAL FIXTURE, not a production baseline migration.
create role anon;
create role authenticated;
create role service_role bypassrls;
create table public.bess_dispatch_pending_forms(
  form_message_id text primary key, request_context jsonb not null
);
create table public.bess_dispatch_daily_state(
  day_key date not null, scope text not null, roster jsonb not null, off_duty jsonb not null default '[]',
  version bigint not null default 1, forward_cursor bigint not null default 0,
  reverse_cursor bigint not null default 0, forward_version bigint not null default 1,
  reverse_version bigint not null default 1, assignment_seq bigint not null default 0,
  expires_at timestamptz not null, updated_at timestamptz, primary key(day_key,scope)
);
create table public.bess_dispatch_assignments(
  id bigint generated always as identity primary key,
  day_key date not null, scope text not null, request_id text not null, assignee text not null,
  direction text not null, assignment_seq bigint not null, request_context jsonb not null,
  unique(day_key,scope,request_id), foreign key(day_key,scope) references public.bess_dispatch_daily_state(day_key,scope)
);
