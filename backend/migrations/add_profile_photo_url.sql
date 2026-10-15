-- Migration: Add profile_photo_url to users table
-- Non-destructive, nullable column addition for student profile photos.
-- Compatible with all existing records (existing users will have NULL, falling back to default avatar).

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;

COMMENT ON COLUMN users.profile_photo_url IS 'Secure URL reference for student profile photo (e.g., hosted on Cloudinary)';

