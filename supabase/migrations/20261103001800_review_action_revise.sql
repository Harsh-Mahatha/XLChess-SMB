-- Module 1.12 (1/2): a reviewer can ask the model to rewrite one candidate from their feedback.
-- The new value is not used in this file: Postgres only allows that after the enum change has committed.
alter type smb.review_action_type add value 'revise';
