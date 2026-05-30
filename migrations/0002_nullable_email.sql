-- Email is populated by the Clerk webhook on signup; allow NULL for
-- rows bootstrapped via the auth middleware in local dev.
ALTER TABLE users DROP COLUMN email;
ALTER TABLE users ADD COLUMN email TEXT;
