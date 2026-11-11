create table if not exists public.event_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null check (device_id <> ''),
  event_id text not null check (event_id <> ''),
  at_ms bigint not null check (at_ms >= 0),
  type text not null check (type <> ''),
  message text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

alter table public.event_log enable row level security;

drop policy if exists "Users can read their events"
on public.event_log;

create policy "Users can read their events"
on public.event_log
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can write their events"
on public.event_log;

create policy "Users can write their events"
on public.event_log
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Saves a device's events, skipping ones already saved, and deletes the
-- user's events older than 30 days.
create or replace function public.save_events(p_device_id text, p_events jsonb)
returns integer
language plpgsql
security invoker
as $$
declare
  saved_count integer;
begin
  if auth.uid() is null then
    raise exception 'Signed-in user required.';
  end if;

  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'Events must be an array.';
  end if;

  insert into public.event_log (user_id, device_id, event_id, at_ms, type, message)
  select auth.uid(), p_device_id, event.id, event."atMs", event.type, event.message
  from jsonb_to_recordset(p_events) as event(id text, "atMs" bigint, type text, message text)
  on conflict on constraint event_log_pkey do nothing;

  get diagnostics saved_count = row_count;

  delete from public.event_log
  where user_id = auth.uid() and created_at < now() - interval '30 days';

  return saved_count;
end;
$$;

grant usage on schema public to authenticated;

grant select, insert, delete on public.event_log to authenticated;

revoke execute on function public.save_events(text, jsonb) from public;

grant execute on function public.save_events(text, jsonb) to authenticated;
