-- ==============================================================================
-- Migration: 024_submitted_applications_bucket.sql
-- Description:
--   1. Ensures the 'submitted-applications' storage bucket exists in Supabase.
--   2. Grants public read access and service_role / anon upload policies.
-- ==============================================================================

-- 1. Insert bucket if not already present
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'submitted-applications',
    'submitted-applications',
    true,
    52428800, -- 50 MB
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    public = true;

-- 2. Storage RLS Policies
DROP POLICY IF EXISTS "Public Access Submitted Applications" ON storage.objects;
CREATE POLICY "Public Access Submitted Applications"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'submitted-applications');

DROP POLICY IF EXISTS "Allow All Uploads to Submitted Applications" ON storage.objects;
CREATE POLICY "Allow All Uploads to Submitted Applications"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'submitted-applications');

DROP POLICY IF EXISTS "Allow All Updates to Submitted Applications" ON storage.objects;
CREATE POLICY "Allow All Updates to Submitted Applications"
    ON storage.objects FOR UPDATE
    USING (bucket_id = 'submitted-applications')
    WITH CHECK (bucket_id = 'submitted-applications');
