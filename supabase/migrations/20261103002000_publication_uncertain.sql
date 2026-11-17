-- Module 1.13 (1/2): a publication whose create request may have reached the channel but whose outcome is not
-- known. It is never retried until a lookup (or an administrator) decides what happened.
alter type smb.publication_status add value if not exists 'uncertain' after 'publishing';
