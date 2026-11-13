-- Module 1.9 (1/2): a new asset kind for AI-made decorative images (backgrounds, textures).
-- Added on its own because a new enum value cannot be used in the transaction that adds it.
alter type smb.asset_kind add value if not exists 'generated';
