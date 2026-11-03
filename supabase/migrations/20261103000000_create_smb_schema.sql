-- Baseline: dedicated schema for all SMB tables (module 1.2 adds the tables).
-- The API connects with a server-only role; the schema is intentionally NOT exposed to PostgREST
-- (see [api].schemas in supabase/config.toml) and is closed to anon/authenticated clients.
create schema if not exists smb;

revoke all on schema smb from anon, authenticated;
alter default privileges in schema smb revoke all on tables from anon, authenticated;
alter default privileges in schema smb revoke all on sequences from anon, authenticated;
alter default privileges in schema smb revoke all on functions from anon, authenticated;
