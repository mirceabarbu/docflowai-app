-- 013_forms_engine: allow document_revisions without a parent flow
-- (form-generated PDFs are stored before a flow is created)
ALTER TABLE document_revisions ALTER COLUMN flow_id DROP NOT NULL;
