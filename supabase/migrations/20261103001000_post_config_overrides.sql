-- Module 1.3: record which file config a row was built from, and the runtime override applied on top.
--   origin = 'file'     -> config_json is the file config, override is null
--   origin = 'override' -> config_json is the merged result, override is the patch, file_hash is the file it patches
-- config_json always holds the effective config, so consumers never merge anything themselves.

alter table smb.post_configs
  add column file_hash text,
  add column override  jsonb;

update smb.post_configs set file_hash = content_hash where file_hash is null;

alter table smb.post_configs
  alter column file_hash set not null,
  add constraint post_configs_file_hash_check check (file_hash ~ '^[0-9a-f]{64}$'),
  add constraint post_configs_override_check check ((origin = 'override') = (override is not null));
