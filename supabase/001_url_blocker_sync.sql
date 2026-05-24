create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  updated_at_ms bigint not null check (updated_at_ms >= 0),
  revision_id text not null check (revision_id <> ''),
  device_id text not null check (device_id <> ''),
  updated_at timestamptz not null default now()
);

create table if not exists public.screen_time_buckets (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null check (device_id <> ''),
  domain text not null check (domain <> ''),
  hour_number bigint not null check (hour_number >= 0),
  total_ms bigint not null check (total_ms >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id, domain, hour_number)
);

alter table public.user_settings enable row level security;
alter table public.screen_time_buckets enable row level security;

drop policy if exists "Users can read their settings"
on public.user_settings;

create policy "Users can read their settings"
on public.user_settings
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can write their settings"
on public.user_settings;

create policy "Users can write their settings"
on public.user_settings
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can read their screen time"
on public.screen_time_buckets;

create policy "Users can read their screen time"
on public.screen_time_buckets
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can write their screen time"
on public.screen_time_buckets;

create policy "Users can write their screen time"
on public.screen_time_buckets
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create or replace function public.save_user_settings(
  p_state jsonb,
  p_updated_at_ms bigint,
  p_revision_id text,
  p_device_id text
)
returns public.user_settings
language plpgsql
security invoker
as $$
declare
  saved public.user_settings;
begin
  if auth.uid() is null then
    raise exception 'Signed-in user required.';
  end if;

  insert into public.user_settings (
    user_id,
    state,
    updated_at_ms,
    revision_id,
    device_id
  )
  values (
    auth.uid(),
    p_state,
    p_updated_at_ms,
    p_revision_id,
    p_device_id
  )
  on conflict (user_id) do update
  set
    state = excluded.state,
    updated_at_ms = excluded.updated_at_ms,
    revision_id = excluded.revision_id,
    device_id = excluded.device_id,
    updated_at = now()
  where
    excluded.updated_at_ms > public.user_settings.updated_at_ms
    or (
      excluded.updated_at_ms = public.user_settings.updated_at_ms
      and excluded.revision_id > public.user_settings.revision_id
    )
  returning * into saved;

  if saved.user_id is null then
    select * into saved
    from public.user_settings
    where user_id = auth.uid();
  end if;

  return saved;
end;
$$;

create or replace function public.sync_screen_time_buckets(p_buckets jsonb)
returns table (
  device_id text,
  domain text,
  hour_number integer,
  total_ms integer
)
language plpgsql
security invoker
as $$
begin
  if auth.uid() is null then
    raise exception 'Signed-in user required.';
  end if;

  if jsonb_typeof(p_buckets) <> 'array' then
    raise exception 'Screen time buckets must be an array.';
  end if;

  return query
  with incoming as (
    select *
    from jsonb_to_recordset(p_buckets) as bucket(
      device_id text,
      domain text,
      hour_number integer,
      total_ms integer
    )
  ),
  saved as (
    insert into public.screen_time_buckets (
      user_id,
      device_id,
      domain,
      hour_number,
      total_ms
    )
    select
      auth.uid(),
      incoming.device_id,
      incoming.domain,
      incoming.hour_number,
      incoming.total_ms
    from incoming
    where
      incoming.device_id <> ''
      and incoming.domain <> ''
      and incoming.hour_number >= 0
      and incoming.total_ms >= 0
    on conflict on constraint screen_time_buckets_pkey do update
    set
      total_ms = greatest(public.screen_time_buckets.total_ms, excluded.total_ms),
      updated_at = now()
    returning
      public.screen_time_buckets.device_id,
      public.screen_time_buckets.domain,
      public.screen_time_buckets.hour_number::integer,
      public.screen_time_buckets.total_ms::integer
  )
  select * from saved;
end;
$$;

grant usage on schema public to authenticated;

grant select, insert, update on public.user_settings to authenticated;
grant select, insert, update on public.screen_time_buckets to authenticated;

revoke execute on function public.save_user_settings(jsonb, bigint, text, text) from public;
revoke execute on function public.sync_screen_time_buckets(jsonb) from public;

grant execute on function public.save_user_settings(jsonb, bigint, text, text) to authenticated;
grant execute on function public.sync_screen_time_buckets(jsonb) to authenticated;
