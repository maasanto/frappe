# Copyright (c) 2022, Frappe Technologies and contributors
# License: MIT. See LICENSE

from collections import Counter
from datetime import date
from typing import TYPE_CHECKING, Any

import frappe
from frappe.deferred_insert import deferred_insert as _deferred_insert
from frappe.model.document import Document
from frappe.query_builder.functions import CalendarDate, Count

if TYPE_CHECKING:
	from frappe.desk.desk_views import DeskViews

# Keep well below Route History retention (90 days), or there is little left to decay.
FRECENCY_HALF_LIFE_DAYS = 14.0
# Older visits weigh under 1%.
FRECENCY_WINDOW_DAYS = round(7 * FRECENCY_HALF_LIFE_DAYS)
# More than the navbar's five, so the awesome bar can rank beyond them.
MAX_LINKS = 30


class RouteHistory(Document):
	_DOCTYPE_NAME = "Route History"

	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		route: DF.Data | None
		user: DF.Link | None
	# end: auto-generated types

	@staticmethod
	def clear_old_logs(days=30):
		from frappe.query_builder import Interval
		from frappe.query_builder.functions import Now

		table = frappe.qb.DocType("Route History")
		frappe.db.delete(table, filters=(table.creation < (Now() - Interval(days=days))))


@frappe.whitelist()
def deferred_insert(routes: str | list[dict[str, Any]]):
	routes = [
		{
			"user": frappe.session.user,
			"route": route.get("route"),
			"creation": route.get("creation"),
		}
		for route in frappe.parse_json(routes)
	]

	_deferred_insert("Route History", routes)


def is_new_document(doctype: str, docname: str) -> bool:
	"""Server-side twin of frappe.model.is_new_name; the two must agree."""
	return docname.startswith(f"new-{doctype.lower().replace(' ', '-')}-")


def visit_key(route: str) -> str:
	"""Fold drafts into one key per doctype, or each would be cut from the top N alone."""
	parts = route.split("/")
	if len(parts) == 3 and parts[0] == "Form" and is_new_document(parts[1], parts[2]):
		# looked up by the awesome bar's "New <doctype>" option
		return f"New/{parts[1]}"
	return route


def daily_visits(user: str) -> list[dict]:
	"""Relies on the index on `user`."""
	table = frappe.qb.DocType("Route History")
	# A string bound rather than NOW(), which sqlite lacks.
	oldest_scored_day = frappe.utils.add_to_date(days=-FRECENCY_WINDOW_DAYS, as_string=True)
	return (
		frappe.qb.from_(table)
		.select(
			table.route,
			CalendarDate(table.creation).as_("day"),
			Count("*").as_("count"),
		)
		.where(table.user == user)
		.where(table.creation >= oldest_scored_day)
		.groupby(table.route, CalendarDate(table.creation))
	).run(as_dict=True)


def score_visits(visits: list[dict], today: date) -> Counter:
	scores = Counter()
	for visit in visits:
		# Browser clocks can run ahead of the server, and sqlite returns the day as text.
		age_days = max(0, (today - frappe.utils.getdate(visit["day"])).days)
		scores[visit_key(visit["route"])] += visit["count"] * 0.5 ** (age_days / FRECENCY_HALF_LIFE_DAYS)
	return scores


@frappe.whitelist()
def frequently_visited_links() -> list[dict]:
	from frappe.desk.desk_views import DeskViews

	visits = daily_visits(frappe.session.user)
	scores = score_visits(visits, frappe.utils.now_datetime().date())
	# `count` is what this endpoint returned before `score`; kept for existing consumers.
	counts = Counter()
	for visit in visits:
		counts[visit_key(visit["route"])] += visit["count"]

	views = DeskViews()
	result = []
	for route, score in scores.most_common():
		if _is_permitted_link(route, views):
			result.append({"route": route, "count": counts[route], "score": round(score, 3)})
		if len(result) >= MAX_LINKS:
			break
	return result


def _is_permitted_link(route: str, views: "DeskViews") -> bool:
	"""Drop routes the user can no longer open: Route History outlives permissions."""
	parts = route.split("/")
	# Desk Page: "<page name>"
	if len(parts) == 1:
		return route in views.allowed_pages
	# Query Report: "query-report/<name>"
	if len(parts) >= 2 and parts[0] == "query-report":
		return parts[1] in views.allowed_reports
	# Report Builder: "List/<doctype>/Report/<name>"
	if len(parts) >= 4 and parts[0] == "List" and parts[2] == "Report":
		return parts[3] in views.allowed_reports
	# Workspace: "Workspaces/<name>" or "Workspaces/private/<name>"
	if parts[0] == "Workspaces":
		return parts[-1] in views.allowed_workspaces
	# Singles skew privileged (System Settings…); list routes are checked when opened.
	if len(parts) >= 2 and parts[0] in ("Form", "New"):
		return _can_open_doctype(parts[1], "create" if parts[0] == "New" else "read")
	return True


def _can_open_doctype(doctype: str, ptype: str) -> bool:
	try:
		return bool(frappe.has_permission(doctype, ptype))
	except frappe.DoesNotExistError:
		# the doctype was renamed or removed after the visit was recorded
		return False
