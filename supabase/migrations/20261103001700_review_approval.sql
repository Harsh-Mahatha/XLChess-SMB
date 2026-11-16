-- Module 1.11: reviewer interface and approval.
--
--  * smb.candidate_renders.revision_id: the revision whose text the graphic was made for. Approval refuses a
--    graphic that was drawn for a different headline than the revision being approved (the graphic would say
--    something the reviewer never read). Renders made before 1.11 have no revision and count as made for
--    revision 1 of their candidate.
--  * An index for the review queue.

alter table smb.candidate_renders
  add column revision_id uuid references smb.post_revisions(id);
create index candidate_renders_revision on smb.candidate_renders (revision_id);

create index review_actions_reviewer on smb.review_actions (reviewer_id, created_at desc);
