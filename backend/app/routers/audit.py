"""Read-only access to the security/compliance audit log.

The whole router is gated on a single permission (audit.view), the way
lookups.py is gated on user.view -- there is nothing here but reads, and every
one of them exposes the same thing: who did what, when, and from which IP.
That is deliberately administrator-only; see DEFAULT_ROLE_PERMISSIONS.

There is no POST/PATCH/DELETE here on purpose. Audit rows are written only by
the code paths being audited (app/routers/{auth,users,patients}.py), so the
log cannot be edited or pruned through the API by anyone, at any permission
level.

PHI: audit_logs never contains it. `event_detail` records identifiers, field
*names* and counts -- never patient values (see the comments at each write
site). This endpoint passes `event_detail` through verbatim rather than
interpreting it, so it neither adds nor reveals anything the write sites
didn't already store, and the UI renders it generically for the same reason.
"""

from datetime import date, datetime, time, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import asc, desc, func, or_
from sqlalchemy.orm import Session, contains_eager

from app.core.audit_events import AUDIT_EVENT_TYPES
from app.core.deps import require_permission
from app.core.permissions import Permission
from app.database import get_db
from app.models import AuditLog, User
from app.schemas import AuditLogActor, AuditLogListResponse, AuditLogRead

router = APIRouter(
    prefix="/audit-logs",
    tags=["audit"],
    dependencies=[Depends(require_permission(Permission.AUDIT_VIEW))],
)

# Volume control. This table only grows -- every patient view writes a row --
# so the cap is on the page size rather than on the queryable date range: a
# range cap would silently hide old events from the one view whose entire job
# is to show them, whereas a page cap only limits how much of the (indexed,
# ORDER BY + LIMIT served) result a single request may pull back. 200 matches
# GET /users so the two tables' footers offer the same page-size options.
MAX_PAGE_SIZE = 200

# Which column(s) to ORDER BY per sort_by value. Text columns are lowered so
# sorting matches the case-insensitive ordering the rest of the API uses;
# created_at is a timestamp and is ordered as-is.
_SORT_COLUMNS: dict[str, tuple] = {
    "created_at": (AuditLog.created_at,),
    "event_type": (func.lower(AuditLog.event_type),),
    "actor": (func.lower(User.last_name), func.lower(User.first_name)),
}


@router.get("", response_model=AuditLogListResponse)
def list_audit_logs(
    event_type: list[str] | None = Query(None, description=f"Repeatable. Known values: {', '.join(AUDIT_EVENT_TYPES)}"),
    actor: str | None = Query(None, description="Prefix match on the acting user's first/last name, email or username."),
    date_from: date | None = Query(None, description="Inclusive lower bound on the event date (UTC)."),
    date_to: date | None = Query(None, description="Inclusive upper bound on the event date (UTC)."),
    sort_by: Literal["created_at", "event_type", "actor"] = "created_at",
    sort_dir: Literal["asc", "desc"] = "desc",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=MAX_PAGE_SIZE),
    db: Session = Depends(get_db),
) -> AuditLogListResponse:
    # OUTER join, unlike GET /users' inner joins: audit_logs.user_id is
    # nullable and genuinely null for a failed sign-in against an email that
    # matches no account. Those rows are the ones an administrator most wants
    # to see, so an inner join would drop exactly the wrong events.
    query = db.query(AuditLog).outerjoin(User, AuditLog.user_id == User.id)

    if event_type:
        # Not validated against AUDIT_EVENT_TYPES: an unknown value simply
        # matches nothing, which is the right answer for a filter, and a
        # historical event type retired from the catalog stays queryable.
        query = query.filter(AuditLog.event_type.in_(event_type))

    if actor:
        needle = f"{actor.strip()}%"
        query = query.filter(
            or_(
                User.first_name.ilike(needle),
                User.last_name.ilike(needle),
                User.email.ilike(needle),
                User.username.ilike(needle),
            )
        )

    # Both bounds are inclusive *dates*, so the upper one covers the whole day
    # -- < the following midnight rather than <= the day's own midnight, which
    # would match only events at exactly 00:00:00.
    if date_from is not None:
        query = query.filter(AuditLog.created_at >= datetime.combine(date_from, time.min, tzinfo=timezone.utc))
    if date_to is not None:
        query = query.filter(
            AuditLog.created_at < datetime.combine(date_to, time.min, tzinfo=timezone.utc) + timedelta(days=1)
        )

    total = query.count()

    order_fn = asc if sort_dir == "asc" else desc
    # id is always appended as a tiebreak, in the same direction, so the order
    # is total rather than merely "newest first": created_at has millisecond
    # ties (a login writes its row in the same transaction as the token), and
    # event_type/actor tie constantly. Without it Postgres is free to return
    # tied rows in heap order, which shifts after any UPDATE -- the bug the
    # lookups endpoints hit -- so a row could appear on two pages or none.
    query = query.order_by(*(order_fn(column) for column in _SORT_COLUMNS[sort_by]), order_fn(AuditLog.id))

    start = (page - 1) * page_size
    # contains_eager reuses the outer join above rather than issuing a second
    # query per row for the actor, the same way list_users does.
    rows = (
        query.options(contains_eager(AuditLog.user))
        .offset(start)
        .limit(page_size)
        .all()
    )

    return AuditLogListResponse(
        items=[
            AuditLogRead(
                id=row.id,
                event_type=row.event_type,
                # Passed through as stored -- see the module docstring.
                event_detail=row.event_detail,
                ip_address=row.ip_address,
                user_agent=row.user_agent,
                created_at=row.created_at,
                # Named `actor` rather than `user`: the column records who
                # performed the event, not who it was performed on (that,
                # where it applies, is inside event_detail).
                actor=AuditLogActor.model_validate(row.user) if row.user is not None else None,
            )
            for row in rows
        ],
        total=total,
        event_types=list(AUDIT_EVENT_TYPES),
    )
