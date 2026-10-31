-- Public bucket serving the packed Chromium extension and its update
-- manifest, which Vivaldi on Android force-installs through managed config.
-- Safe to rerun.
insert into storage.buckets (id, name, public)
values ('chromium-extension', 'chromium-extension', true)
on conflict (id) do update set public = true;
