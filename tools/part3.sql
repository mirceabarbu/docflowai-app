-- === PARTEA 3: Indici + constraints pentru tabele noi ===
-- Generat: 2026-04-20T06:57:35.790Z

-- Indexes for: alop_instances
CREATE INDEX IF NOT EXISTS idx_alop_created_by ON public.alop_instances USING btree (created_by);
CREATE INDEX IF NOT EXISTS idx_alop_df ON public.alop_instances USING btree (df_id) WHERE (df_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_alop_ord ON public.alop_instances USING btree (ord_id) WHERE (ord_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_alop_org ON public.alop_instances USING btree (org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_alop_status ON public.alop_instances USING btree (status) WHERE (cancelled_at IS NULL);

-- Indexes for: alop_ord_cicluri
CREATE INDEX IF NOT EXISTS idx_alop_ord_cicluri_alop ON public.alop_ord_cicluri USING btree (alop_id);

-- Indexes for: alop_sabloane
CREATE INDEX IF NOT EXISTS idx_alop_sablon_org ON public.alop_sabloane USING btree (org_id);

-- Indexes for: api_rate_limits
CREATE INDEX IF NOT EXISTS idx_api_rl_blocked ON public.api_rate_limits USING btree (blocked_until) WHERE (blocked_until IS NOT NULL);

-- Indexes for: audit_events

-- Indexes for: certificate_records

-- Indexes for: document_revisions
CREATE INDEX IF NOT EXISTS idx_doc_rev_flow ON public.document_revisions USING btree (flow_id, revision_no DESC);

-- Indexes for: flow_signatures
CREATE INDEX IF NOT EXISTS idx_flow_signatures_certificate_id ON public.flow_signatures USING btree (certificate_id);
CREATE INDEX IF NOT EXISTS idx_flow_signatures_flow_id ON public.flow_signatures USING btree (flow_id);

-- Indexes for: flow_signers
CREATE INDEX IF NOT EXISTS idx_flow_signers_email ON public.flow_signers USING btree (email) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_flow_signers_flow ON public.flow_signers USING btree (flow_id, step_order);
CREATE INDEX IF NOT EXISTS idx_flow_signers_token ON public.flow_signers USING btree (token) WHERE (token IS NOT NULL);

-- Indexes for: form_instances
CREATE INDEX IF NOT EXISTS idx_form_inst_flow ON public.form_instances USING btree (flow_id) WHERE (flow_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_form_inst_org ON public.form_instances USING btree (org_id, updated_at DESC);

-- Indexes for: form_templates

-- Indexes for: form_versions

-- Indexes for: inapp_notifications
CREATE INDEX IF NOT EXISTS idx_notif_user ON public.inapp_notifications USING btree (user_id, read, created_at DESC);

-- Indexes for: notification_events

-- Indexes for: policy_rules
CREATE INDEX IF NOT EXISTS idx_policy_rules_org ON public.policy_rules USING btree (org_id, is_active, priority DESC);
CREATE INDEX IF NOT EXISTS idx_policy_rules_scope ON public.policy_rules USING btree (scope, is_active);

-- Indexes for: signature_certificates
CREATE INDEX IF NOT EXISTS idx_signature_certificates_flow_id ON public.signature_certificates USING btree (flow_id);

-- Indexes for: signature_sessions
CREATE INDEX IF NOT EXISTS idx_sig_sess_flow ON public.signature_sessions USING btree (flow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sig_sess_provider ON public.signature_sessions USING btree (provider_code, status);

-- Indexes for: webhook_deliveries
CREATE INDEX IF NOT EXISTS idx_wh_del_org ON public.webhook_deliveries USING btree (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wh_del_pending ON public.webhook_deliveries USING btree (next_retry) WHERE (status = 'pending'::text);

-- FK + UNIQUE constraints (each in own DO block)

-- Phase A: PRIMARY KEY constraints

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_instances
      ADD CONSTRAINT alop_instances_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_ord_cicluri
      ADD CONSTRAINT alop_ord_cicluri_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_sabloane
      ADD CONSTRAINT alop_sabloane_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.api_rate_limits
      ADD CONSTRAINT api_rate_limits_pkey PRIMARY KEY (key);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.audit_events
      ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.certificate_records
      ADD CONSTRAINT certificate_records_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.document_revisions
      ADD CONSTRAINT document_revisions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.flow_signatures
      ADD CONSTRAINT flow_signatures_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.flow_signers
      ADD CONSTRAINT flow_signers_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_instances
      ADD CONSTRAINT form_instances_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_templates
      ADD CONSTRAINT form_templates_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_versions
      ADD CONSTRAINT form_versions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.inapp_notifications
      ADD CONSTRAINT inapp_notifications_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.notification_events
      ADD CONSTRAINT notification_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.policy_rules
      ADD CONSTRAINT policy_rules_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.signature_certificates
      ADD CONSTRAINT signature_certificates_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.signature_sessions
      ADD CONSTRAINT signature_sessions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.webhook_deliveries
      ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

-- Phase B: UNIQUE constraints

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_sabloane
      ADD CONSTRAINT alop_sabloane_org_id_key UNIQUE (org_id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.flow_signers
      ADD CONSTRAINT flow_signers_token_key UNIQUE (token);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_versions
      ADD CONSTRAINT form_versions_template_id_version_no_key UNIQUE (template_id, version_no);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

-- Phase C: FOREIGN KEY constraints

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_instances
      ADD CONSTRAINT alop_instances_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_instances
      ADD CONSTRAINT alop_instances_df_flow_id_fkey FOREIGN KEY (df_flow_id) REFERENCES public.flows(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_instances
      ADD CONSTRAINT alop_instances_df_id_fkey FOREIGN KEY (df_id) REFERENCES public.formulare_df(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_instances
      ADD CONSTRAINT alop_instances_ord_flow_id_fkey FOREIGN KEY (ord_flow_id) REFERENCES public.flows(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_instances
      ADD CONSTRAINT alop_instances_ord_id_fkey FOREIGN KEY (ord_id) REFERENCES public.formulare_ord(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_instances
      ADD CONSTRAINT alop_instances_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_instances
      ADD CONSTRAINT alop_lichidare_confirmed_by_fk FOREIGN KEY (lichidare_confirmed_by) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_ord_cicluri
      ADD CONSTRAINT alop_ord_cicluri_alop_id_fkey FOREIGN KEY (alop_id) REFERENCES public.alop_instances(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_ord_cicluri
      ADD CONSTRAINT alop_ord_cicluri_lichidare_confirmed_by_fkey FOREIGN KEY (lichidare_confirmed_by) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_ord_cicluri
      ADD CONSTRAINT alop_ord_cicluri_ord_id_fkey FOREIGN KEY (ord_id) REFERENCES public.formulare_ord(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_ord_cicluri
      ADD CONSTRAINT alop_ord_cicluri_plata_confirmed_by_fkey FOREIGN KEY (plata_confirmed_by) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.alop_sabloane
      ADD CONSTRAINT alop_sabloane_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.audit_events
      ADD CONSTRAINT audit_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.audit_events
      ADD CONSTRAINT audit_events_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.flows(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.audit_events
      ADD CONSTRAINT audit_events_form_instance_id_fkey FOREIGN KEY (form_instance_id) REFERENCES public.form_instances(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.audit_events
      ADD CONSTRAINT audit_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.certificate_records
      ADD CONSTRAINT certificate_records_signature_session_id_fkey FOREIGN KEY (signature_session_id) REFERENCES public.signature_sessions(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.certificate_records
      ADD CONSTRAINT certificate_records_trust_report_id_fkey FOREIGN KEY (trust_report_id) REFERENCES public.trust_reports(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.document_revisions
      ADD CONSTRAINT document_revisions_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.document_revisions
      ADD CONSTRAINT document_revisions_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.flows(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.flow_signers
      ADD CONSTRAINT flow_signers_delegated_from_fkey FOREIGN KEY (delegated_from) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.flow_signers
      ADD CONSTRAINT flow_signers_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.flows(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.flow_signers
      ADD CONSTRAINT flow_signers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_instances
      ADD CONSTRAINT form_instances_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_instances
      ADD CONSTRAINT form_instances_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.flows(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_instances
      ADD CONSTRAINT form_instances_generated_revision_id_fkey FOREIGN KEY (generated_revision_id) REFERENCES public.document_revisions(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_instances
      ADD CONSTRAINT form_instances_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_instances
      ADD CONSTRAINT form_instances_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.form_templates(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_instances
      ADD CONSTRAINT form_instances_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.form_versions(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_templates
      ADD CONSTRAINT form_templates_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.form_versions
      ADD CONSTRAINT form_versions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.form_templates(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.inapp_notifications
      ADD CONSTRAINT inapp_notifications_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.flows(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.inapp_notifications
      ADD CONSTRAINT inapp_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.notification_events
      ADD CONSTRAINT notification_events_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.flows(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.notification_events
      ADD CONSTRAINT notification_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.notification_events
      ADD CONSTRAINT notification_events_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.policy_rules
      ADD CONSTRAINT policy_rules_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.signature_sessions
      ADD CONSTRAINT signature_sessions_document_revision_id_fkey FOREIGN KEY (document_revision_id) REFERENCES public.document_revisions(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.signature_sessions
      ADD CONSTRAINT signature_sessions_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.flows(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;

DO $d$ BEGIN
  ALTER TABLE ONLY public.signature_sessions
      ADD CONSTRAINT signature_sessions_signer_id_fkey FOREIGN KEY (signer_id) REFERENCES public.flow_signers(id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $d$;
