-- Development fixtures. Applied by `supabase db reset` and by the integration tests.
-- Contains one complete, traceable chain: sources -> research -> candidate -> revision -> approval -> dry-run publication.
-- Fixed UUIDs (prefix 00000000-0000-4000-8000-...) so tests can reference rows directly.

insert into smb.post_types (id, name, description) values
  ('1.1', 'World Championship', 'Weekly and per-game World Championship coverage');

insert into smb.post_configs (id, post_type_id, version, config_json, content_hash, file_hash, origin, is_active) values
  ('00000000-0000-4000-8000-000000000101', '1.1', 1,
   '{"id":"1.1","name":"World Championship","enabled":true,"approvalRequired":true}',
   encode(sha256('seed-config-1.1-v1'::bytea), 'hex'), encode(sha256('seed-config-1.1-v1'::bytea), 'hex'), 'file', true);

insert into smb.data_sources (id, kind, name) values
  ('D1', 'data', 'FIDE'),
  ('D2', 'data', 'Chess.com News'),
  ('D3', 'data', 'Lichess Broadcasts'),
  ('D4', 'data', 'The Week in Chess (TWIC)'),
  ('D5', 'data', 'ChessBase'),
  ('I1', 'image', 'Wikimedia Commons'),
  ('I2', 'image', 'Flickr Creative Commons'),
  ('I3', 'image', 'Unsplash'),
  ('I4', 'image', 'Pexels');

insert into smb.source_records (id, source_id, url, retrieved_at, event_time, raw_payload, payload_hash, normalised) values
  ('00000000-0000-4000-8000-000000000201', 'D1', 'https://example.org/wcc/game-7', '2026-11-03 10:00+00', '2026-11-03 09:30+00',
   '{"result":"1-0"}', encode(sha256('seed-source-d1'::bytea), 'hex'), '{"game":7,"result":"1-0"}'),
  ('00000000-0000-4000-8000-000000000202', 'D2', 'https://example.org/standings', '2026-11-03 10:01+00', '2026-11-03 09:30+00',
   '{"score":"4-3"}', encode(sha256('seed-source-d2'::bytea), 'hex'), '{"score":"4-3"}');

insert into smb.jobs (id, lane, kind, status, payload, finished_at, started_at) values
  ('00000000-0000-4000-8000-000000000301', 'gpu', 'candidates_generate', 'succeeded', '{"seed":true}', now(), now());

insert into smb.post_opportunities (id, post_type_id, post_config_id, dedupe_key, trigger_kind, phase, status) values
  ('00000000-0000-4000-8000-000000000401', '1.1', '00000000-0000-4000-8000-000000000101',
   '1.1:wcc-2026:game-7', 'event', 'tournament', 'pending');
-- Walk the status history through the trigger.
update smb.post_opportunities set status = 'researching'     where id = '00000000-0000-4000-8000-000000000401';
update smb.post_opportunities set status = 'generating'      where id = '00000000-0000-4000-8000-000000000401';
update smb.post_opportunities set status = 'awaiting_review' where id = '00000000-0000-4000-8000-000000000401';

insert into smb.research_packages (id, opportunity_id, version, status, content_hash) values
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000401', 1, 'complete',
   encode(sha256('seed-package'::bytea), 'hex'));

insert into smb.research_claims (id, package_id, claim_key, description, value, computed, computation, verification, confidence, event_time) values
  ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000501', 'game7.result',
   'Result of game 7', '"1-0"', false, null, 'verified', 0.99, '2026-11-03 09:30+00'),
  ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000501', 'match.score_diff',
   'Score difference after game 7', '1', true, 'player_a_score - player_b_score', 'verified', 0.99, '2026-11-03 09:30+00');

insert into smb.research_claim_sources (claim_id, source_record_id) values
  ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000201'),
  ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000202'),
  ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000202');

-- Assets: original photo -> cropped derivative -> rendered graphic, plus saved licence evidence.
insert into smb.media_assets (id, kind, bucket, path, sha256, mime, size_bytes, width, height, source_url, source_page_url, image_source_id, parent_asset_id, transform, template_version, opportunity_id) values
  ('00000000-0000-4000-8000-000000000701', 'evidence', 'evidence', 'licences/seed-photo.html', encode(sha256('seed-evidence'::bytea), 'hex'),
   'text/html', 1200, null, null, null, null, null, null, null, null, '00000000-0000-4000-8000-000000000401'),
  ('00000000-0000-4000-8000-000000000702', 'original', 'originals', 'seed/photo.jpg', encode(sha256('seed-original'::bytea), 'hex'),
   'image/jpeg', 500000, 4000, 3000, 'https://example.org/photo.jpg', 'https://example.org/photo-page', 'I1', null, null, null, '00000000-0000-4000-8000-000000000401'),
  ('00000000-0000-4000-8000-000000000703', 'derived', 'derived', 'seed/photo-crop.jpg', encode(sha256('seed-derived'::bytea), 'hex'),
   'image/jpeg', 120000, 1200, 675, null, null, null, '00000000-0000-4000-8000-000000000702',
   '{"spec":1,"crop":{"left":100,"top":200,"width":3200,"height":1800},"resize":{"width":1200,"height":675,"fit":"inside"},"encode":{"format":"jpeg","quality":90}}', null, '00000000-0000-4000-8000-000000000401'),
  ('00000000-0000-4000-8000-000000000704', 'render', 'renders', 'seed/game7.png', encode(sha256('seed-render'::bytea), 'hex'),
   'image/png', 300000, 1200, 675, null, null, null, '00000000-0000-4000-8000-000000000703', null, 'game-result@1', '00000000-0000-4000-8000-000000000401');

insert into smb.media_licenses (id, asset_id, original_url, source_page_url, photographer, copyright_holder, licence_type, licence_version, licence_url,
  commercial_use_allowed, modifications_allowed, attribution_required, attribution_text, evidence_asset_id, decision, verified_at, verified_by) values
  ('00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000702', 'https://example.org/photo.jpg', 'https://example.org/photo-page',
   'Seed Photographer', 'Seed Photographer', 'CC BY', '4.0', 'https://creativecommons.org/licenses/by/4.0/',
   true, true, true, 'Photo: Seed Photographer / CC BY 4.0', '00000000-0000-4000-8000-000000000701', 'accepted', '2026-11-03 10:05+00', 'system');

insert into smb.post_candidates (id, opportunity_id, research_package_id, generation_cycle, slot, angle, provider, model, prompt_version, job_id) values
  ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000501', 1, 'A', 'result', 'stub', null, 'game-result-prompt@1', '00000000-0000-4000-8000-000000000301'),
  ('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000501', 1, 'B', 'standings', 'stub', null, 'game-result-prompt@1', '00000000-0000-4000-8000-000000000301'),
  ('00000000-0000-4000-8000-000000000903', '00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000501', 1, 'C', 'moment', 'stub', null, 'game-result-prompt@1', '00000000-0000-4000-8000-000000000301');

insert into smb.post_revisions (id, candidate_id, revision_no, parent_revision_id, caption, channel_texts, template_version, content_hash, author_kind, author_id) values
  ('00000000-0000-4000-8000-000000000a01', '00000000-0000-4000-8000-000000000902', 1, null, 'Game 7 goes to White.', '{"x":"Game 7 goes to White."}',
   'game-result@1', encode(sha256('seed-revision-1'::bytea), 'hex'), 'ai', null),
  ('00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000902', 2, '00000000-0000-4000-8000-000000000a01',
   'Game 7 goes to White. A one-point lead.', '{"x":"Game 7 goes to White. A one-point lead."}',
   'game-result@1', encode(sha256('seed-revision-2'::bytea), 'hex'), 'human', 'xlchess-user-1');

insert into smb.revision_claims (revision_id, claim_id) values
  ('00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000601'),
  ('00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000602');

insert into smb.revision_assets (revision_id, asset_id, role) values
  ('00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000704', 'graphic');

update smb.post_opportunities set status = 'approved' where id = '00000000-0000-4000-8000-000000000401';

insert into smb.review_actions (id, opportunity_id, candidate_id, revision_id, action, content_hash, reviewer_id, channels) values
  ('00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000902',
   '00000000-0000-4000-8000-000000000a02', 'approve', encode(sha256('seed-revision-2'::bytea), 'hex'), 'xlchess-user-2', '{x}');

insert into smb.publications (id, approval_id, revision_id, channel, mode, status, content_hash, idempotency_key, external_id, url, published_at) values
  ('00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-000000000a02',
   'x', 'dry_run', 'dry_run_recorded', encode(sha256('seed-revision-2'::bytea), 'hex'), 'seed:1.1:wcc-2026:game-7:x', null, null, null);

insert into smb.publication_attempts (publication_id, attempt_no, outcome, request_summary) values
  ('00000000-0000-4000-8000-000000000c01', 1, 'dry_run', '{"text":"Game 7 goes to White. A one-point lead."}');

insert into smb.audit_log (actor, action, target_type, target_id, details) values
  ('xlchess-user-2', 'approve', 'revision', '00000000-0000-4000-8000-000000000a02', '{"channels":["x"]}');
