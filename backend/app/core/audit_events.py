"""The audit event types this app emits.

audit_logs.event_type is a plain varchar, so the DB accepts anything -- this
tuple is the app's own record of which values are real, letting the read
endpoint offer a closed filter list instead of a live SELECT DISTINCT.

New AuditLog(event_type=...) call site? Add its value here too --
tests/test_audit.py greps the source for emitted literals and fails otherwise.
"""

AUDIT_EVENT_TYPES: tuple[str, ...] = (
    # authentication
    "login_success",
    "login_failure",
    "password_changed",
    # user administration
    "user_created",
    "user_deleted",
    "role_change",
    "status_change",
    "profile_updated",
    # patient records -- none of these carry PHI in event_detail, see routers/patients.py
    "patient_upload",
    "patient_view",
    "patient_edit",
    "patient_delete",
    "patient_analytics_view",
)
