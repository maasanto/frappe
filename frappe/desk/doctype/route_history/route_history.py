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

# Kept well inside the Route History retention window, which Log Settings defaults to
# 90 days: decay can only separate visits that are still in the table, so cutting
# retention to around one half-life quietly turns this back into a raw visit count.
FRECENCY_HALF_LIFE_DAYS = 14.0
# Seven half-lives, so a visit left out here was worth under 1% of one from today and
# could not have changed an order. Deliberately wider than the default retention window:
# what it bounds is the site that keeps Route History for a year, or forever.
FRECENCY_WINDOW_DAYS = round(7 * FRECENCY_HALF_LIFE_DAYS)
# The navbar only lists the first few; the rest exist so the awesome bar has history on
# candidates the navbar would never show.
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
	"""Whether a Form route points at an unsaved draft rather than a stored document.

	Server-side twin of frappe.model.is_new_name, which the router uses to decide whether
	to record the visit at all; the two must agree on what a draft name looks like.
	"""
	return docname.startswith(f"new-{doctype.lower().replace(' ', '-')}-")


def visit_key(route: str) -> str:
	"""The key a visit is counted under.

	Every draft of a doctype routes to a different generated name, so counted raw they
	are singletons worth one visit each and none of them survives the top-N cut in
	frequently_visited_links below. Folding them here rather than in the browser is the
	whole point: the cut happens first, and by then the drafts are gone.

	Only routes with a per-visit identity need this. A list view is already one route
	however often it is opened, which is why the awesome bar still collapses those itself.
	"""
	parts = route.split("/")
	if len(parts) == 3 and parts[0] == "Form" and is_new_document(parts[1], parts[2]):
		# Kept in step with frappe.search.frecency in search_utils.js, which is what the
		# awesome bar's routeless "New Quotation" option looks itself up by.
		return f"New/{parts[1]}"
	return route


def daily_visits(user: str) -> list[dict]:
	"""One row per route per day, rather than one per visit.

	Grouping in SQL is what keeps this affordable: a busy user accumulates tens of
	thousands of rows over the scoring window, and the decay only needs to know how many
	visits landed on each day. Day granularity is ample against a half-life measured in
	weeks.

	Relies on the index on `user`: without it this walks the whole table through the
	creation index instead of the user's own slice of it.
	"""
	table = frappe.qb.DocType("Route History")
	# Compared against a plain string rather than the backend's NOW(): sqlite has no such
	# function, and a date-only bound matches the day granularity below anyway.
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
	"""Score each route by how much *and* how recently it was visited.

	A visit is worth 1 point on the day it happens and half that after every
	FRECENCY_HALF_LIFE_DAYS, so a route used daily this week outranks one used twice as
	often but abandoned a month ago. Raw counts can't express that.
	"""
	scores = Counter()
	for visit in visits:
		# Timestamps come from the browser clock via deferred_insert, so a visit can sit
		# ahead of server time — it must never be worth more than one from today.
		# sqlite's DATE() hands back a string where the other backends return a date.
		age_days = max(0, (today - frappe.utils.getdate(visit["day"])).days)
		scores[visit_key(visit["route"])] += visit["count"] * 0.5 ** (age_days / FRECENCY_HALF_LIFE_DAYS)
	return scores


@frappe.whitelist()
def frequently_visited_links() -> list[dict]:
	from frappe.desk.desk_views import DeskViews

	visits = daily_visits(frappe.session.user)
	# Decayed in Python rather than in SQL to stay portable across the backends.
	scores = score_visits(visits, frappe.utils.now_datetime().date())
	# score is what everything in-tree ranks on; count is what this endpoint returned
	# before frecency, kept so an app reading the old payload still finds it.
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
	"""Filter Route History entries by what the user may still open.

	Route History persists routes forever. When the user loses permission on the
	underlying page, report, workspace or doctype, the route stays in the table and would
	otherwise resurface as a "frequently visited" suggestion.
	"""
	parts = route.split("/")
	# Desk Page: "<page name>", the only single-segment route router_history records
	if len(parts) == 1:
		return route in views.allowed_pages
	# Query Report: "query-report/<name>"
	if parts[0] == "query-report":
		return parts[1] in views.allowed_reports
	# Report Builder: "List/<doctype>/Report/<name>"
	if len(parts) >= 4 and parts[0] == "List" and parts[2] == "Report":
		return parts[3] in views.allowed_reports
	# Workspace: "Workspaces/<name>" or "Workspaces/private/<name>"
	if parts[0] == "Workspaces":
		return parts[-1] in views.allowed_workspaces
	# A single and the folded draft key both name their doctype directly, and singles
	# skew privileged — System Settings, Print Settings. List routes stay as they were,
	# checked when the list is opened.
	if len(parts) >= 2 and parts[0] in ("Form", "New"):
		return _can_open_doctype(parts[1], "create" if parts[0] == "New" else "read")
	return True


def _can_open_doctype(doctype: str, ptype: str) -> bool:
	try:
		return bool(frappe.has_permission(doctype, ptype))
	except frappe.DoesNotExistError:
		# the doctype was renamed or removed after the visit was recorded
		return False
