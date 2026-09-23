# Copyright (c) 2022, Frappe Technologies and contributors
# License: MIT. See LICENSE

from collections import Counter
from datetime import date
from typing import Any

import frappe
from frappe.deferred_insert import deferred_insert as _deferred_insert
from frappe.model.document import Document
from frappe.query_builder.functions import CalendarDate, Count

# Kept well inside the Route History retention window, which Log Settings defaults to
# 90 days: decay can only separate visits that are still in the table, so cutting
# retention to around one half-life quietly turns this back into a raw visit count.
FRECENCY_HALF_LIFE_DAYS = 14.0
# Seven half-lives, so a visit left out here was worth under 1% of one from today and
# could not have changed an order. Deliberately wider than the default retention window:
# what it bounds is the site that keeps Route History for a year, or forever.
FRECENCY_WINDOW_DAYS = round(7 * FRECENCY_HALF_LIFE_DAYS)
MAX_LINKS = 5


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
		scores[visit["route"]] += visit["count"] * 0.5 ** (age_days / FRECENCY_HALF_LIFE_DAYS)
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
		counts[visit["route"]] += visit["count"]

	allowed_report_names = set(DeskViews.get_allowed_reports(cache=True).keys())
	result = []
	for route, score in scores.most_common():
		if _is_permitted_link(route, allowed_report_names):
			result.append({"route": route, "count": counts[route], "score": round(score, 3)})
		if len(result) >= MAX_LINKS:
			break
	return result


def _is_permitted_link(route: str, allowed_report_names: set) -> bool:
	"""Filter Route History entries by report accessibility.

	Route History persists routes forever. When the user loses permission on
	the underlying report/doctype, the route stays in the table and would
	otherwise resurface as a "frequently visited" suggestion. Non-report
	routes (Form/List/etc.) pass through — their permissions are enforced
	when the route is followed.
	"""
	parts = route.split("/")
	# Query Report: "query-report/<name>"
	if len(parts) >= 2 and parts[0] == "query-report":
		return parts[1] in allowed_report_names
	# Report Builder: "List/<doctype>/Report/<name>"
	if len(parts) >= 4 and parts[0] == "List" and parts[2] == "Report":
		return parts[3] in allowed_report_names
	return True
