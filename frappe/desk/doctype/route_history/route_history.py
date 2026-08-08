# Copyright (c) 2022, Frappe Technologies and contributors
# License: MIT. See LICENSE

from collections import Counter
from datetime import datetime
from typing import Any

import frappe
from frappe.deferred_insert import deferred_insert as _deferred_insert
from frappe.model.document import Document

# Kept well inside the Route History retention window, which Log Settings defaults to
# 90 days: decay can only separate visits that are still in the table, so cutting
# retention to around one half-life quietly turns this back into a raw visit count.
FRECENCY_HALF_LIFE_DAYS = 14
MAX_LINKS = 50
# Beyond this many visits the oldest ones are dropped: after a few half-lives they
# contribute almost nothing, and boot must not pay for an unpruned history.
MAX_SAMPLED_VISITS = 10_000


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


def frecency(visits: list[dict], now: datetime) -> dict[str, float]:
	"""Score each route by how much *and* how recently it was visited.

	A visit is worth 1 point on the day it happens and half that after every
	FRECENCY_HALF_LIFE_DAYS, so a route used daily this week outranks one used
	twice as often but abandoned a month ago. Raw counts can't express that.
	"""
	scores = {}
	for visit in visits:
		age_days = (now - visit["creation"]).total_seconds() / 86400
		scores[visit["route"]] = scores.get(visit["route"], 0) + 0.5 ** (age_days / FRECENCY_HALF_LIFE_DAYS)
	return scores


@frappe.whitelist()
def frequently_visited_links(limit: int = 5):
	from frappe.desk.desk_views import DeskViews

	limit = min(frappe.utils.cint(limit) or 5, MAX_LINKS)

	# Decayed in Python rather than in SQL to stay portable across MariaDB and
	# Postgres. Move the decay into the query if boot latency ever shows up.
	#
	# Relies on the index on `user`: without it the creation-ordered fetch walks the
	# whole table through the creation index, which is 25x slower on a busy site.
	visits = frappe.get_all(
		"Route History",
		fields=["route", "creation"],
		filters={"user": frappe.session.user},
		order_by="creation desc",
		limit=MAX_SAMPLED_VISITS,
	)
	scores = frecency(visits, frappe.utils.now_datetime())
	# count is what this endpoint returned before frecency; kept so callers outside
	# the awesome bar keep working.
	counts = Counter(visit["route"] for visit in visits)

	allowed_report_names = set(DeskViews.get_allowed_reports(cache=True).keys())
	result = []
	for route, score in sorted(scores.items(), key=lambda item: item[1], reverse=True):
		if _is_permitted_link(route, allowed_report_names):
			result.append({"route": route, "count": counts[route], "score": round(score, 3)})
		if len(result) == limit:
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
