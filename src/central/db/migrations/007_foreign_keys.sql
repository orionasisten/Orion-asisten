-- only: postgres
-- 007_foreign_keys.sql — constraint referensial di level database.
--
-- Hanya untuk PostgreSQL (target produksi). SQLite tidak mendukung
-- "ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY" (butuh rebuild tabel);
-- pada driver SQLite referential integrity ditegakkan di level aplikasi
-- (owner scoping di src/central/policy/scope.js) — hal ini didokumentasikan.
--
-- Idempotent: setiap constraint DITOLAK bila sudah ada (DROP IF EXISTS + ADD).
ALTER TABLE devices            DROP CONSTRAINT IF EXISTS fk_devices_owner;
ALTER TABLE devices            ADD CONSTRAINT fk_devices_owner   FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE auth_tokens        DROP CONSTRAINT IF EXISTS fk_tokens_owner;
ALTER TABLE auth_tokens        ADD CONSTRAINT fk_tokens_owner   FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;
ALTER TABLE auth_tokens        DROP CONSTRAINT IF EXISTS fk_tokens_device;
ALTER TABLE auth_tokens        ADD CONSTRAINT fk_tokens_device  FOREIGN KEY (device_id)  REFERENCES devices(id) ON DELETE CASCADE;

ALTER TABLE audit_log          DROP CONSTRAINT IF EXISTS fk_audit_owner;
ALTER TABLE audit_log          ADD CONSTRAINT fk_audit_owner    FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE missions           DROP CONSTRAINT IF EXISTS fk_missions_owner;
ALTER TABLE missions           ADD CONSTRAINT fk_missions_owner  FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE mission_tasks      DROP CONSTRAINT IF EXISTS fk_tasks_mission;
ALTER TABLE mission_tasks      ADD CONSTRAINT fk_tasks_mission  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE;
ALTER TABLE mission_tasks      DROP CONSTRAINT IF EXISTS fk_tasks_owner;
ALTER TABLE mission_tasks      ADD CONSTRAINT fk_tasks_owner    FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE approvals          DROP CONSTRAINT IF EXISTS fk_approvals_owner;
ALTER TABLE approvals          ADD CONSTRAINT fk_approvals_owner FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE budget_ledger      DROP CONSTRAINT IF EXISTS fk_ledger_mission;
ALTER TABLE budget_ledger      ADD CONSTRAINT fk_ledger_mission FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE;

ALTER TABLE events              DROP CONSTRAINT IF EXISTS fk_events_owner;
ALTER TABLE events              ADD CONSTRAINT fk_events_owner   FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE event_conflicts    DROP CONSTRAINT IF EXISTS fk_conflicts_owner;
ALTER TABLE event_conflicts    ADD CONSTRAINT fk_conflicts_owner FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE sync_cursors       DROP CONSTRAINT IF EXISTS fk_cursors_owner;
ALTER TABLE sync_cursors       ADD CONSTRAINT fk_cursors_owner  FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE memory_records     DROP CONSTRAINT IF EXISTS fk_memory_owner;
ALTER TABLE memory_records     ADD CONSTRAINT fk_memory_owner   FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE memory_versions    DROP CONSTRAINT IF EXISTS fk_memver_record;
ALTER TABLE memory_versions    ADD CONSTRAINT fk_memver_record FOREIGN KEY (record_id)  REFERENCES memory_records(id) ON DELETE CASCADE;
ALTER TABLE memory_versions    DROP CONSTRAINT IF EXISTS fk_memver_owner;
ALTER TABLE memory_versions    ADD CONSTRAINT fk_memver_owner  FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE skill_versions     DROP CONSTRAINT IF EXISTS fk_skillver_owner;
ALTER TABLE skill_versions     ADD CONSTRAINT fk_skillver_owner  FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE skill_evaluations   DROP CONSTRAINT IF EXISTS fk_skilleval_version;
ALTER TABLE skill_evaluations   ADD CONSTRAINT fk_skilleval_version FOREIGN KEY (version_id) REFERENCES skill_versions(version_id) ON DELETE CASCADE;
ALTER TABLE skill_evaluations   DROP CONSTRAINT IF EXISTS fk_skilleval_owner;
ALTER TABLE skill_evaluations   ADD CONSTRAINT fk_skilleval_owner FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE skill_active_pointer DROP CONSTRAINT IF EXISTS fk_skillptr_owner;
ALTER TABLE skill_active_pointer ADD CONSTRAINT fk_skillptr_owner FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;
ALTER TABLE skill_active_pointer DROP CONSTRAINT IF EXISTS fk_skillptr_version;
ALTER TABLE skill_active_pointer ADD CONSTRAINT fk_skillptr_version FOREIGN KEY (version_id) REFERENCES skill_versions(version_id) ON DELETE CASCADE;

ALTER TABLE skill_lifecycle_audit DROP CONSTRAINT IF EXISTS fk_skillaudit_version;
ALTER TABLE skill_lifecycle_audit ADD CONSTRAINT fk_skillaudit_version FOREIGN KEY (version_id) REFERENCES skill_versions(version_id) ON DELETE CASCADE;
ALTER TABLE skill_lifecycle_audit DROP CONSTRAINT IF EXISTS fk_skillaudit_owner;
ALTER TABLE skill_lifecycle_audit ADD CONSTRAINT fk_skillaudit_owner FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE jobs                DROP CONSTRAINT IF EXISTS fk_jobs_owner;
ALTER TABLE jobs                ADD CONSTRAINT fk_jobs_owner     FOREIGN KEY (owner_id)   REFERENCES owners(id) ON DELETE CASCADE;

ALTER TABLE job_attempts        DROP CONSTRAINT IF EXISTS fk_jobattempts_job;
ALTER TABLE job_attempts        ADD CONSTRAINT fk_jobattempts_job FOREIGN KEY (job_id)     REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE job_attempts        DROP CONSTRAINT IF EXISTS fk_jobattempts_owner;
ALTER TABLE job_attempts        ADD CONSTRAINT fk_jobattempts_owner FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE;
