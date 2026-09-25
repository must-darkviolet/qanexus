-- The comment a review produced, so it can be read back without GitHub.
ALTER TABLE pr_reviews ADD COLUMN comment_markdown TEXT;
