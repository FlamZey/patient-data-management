"""The audit event types this application emits.

The `audit_logs.event_type` column is a plain varchar, not an enum, so the
database will accept anything -- this tuple is the application's own record of
which values are real. It exists so the read endpoint (and the UI's event
filter) can offer a closed option set instead of either hardcoding a list that
silently rots or running a `SELECT DISTINCT event_type` over an ever-growing
table on every request.

Adding a new `AuditLog(event_type=...)` call site means adding its value here:
tests/test_audit.py::test_every_emitted_event_type_is_catalogued greps the
application source for emitted literals and fails otherwise, the same way the
permission catalog is kept honest in tests/test_authorization.py.
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
    # patient records -- note that none of these carry PHI in event_detail:
    # patient_edit records changed field *names*, patient_analytics_view
    # records row counts. See app/routers/patients.py.
    "patient_upload",
    "patient_view",
    "patient_edit",
    "patient_delete",
    "patient_analytics_view",
)
