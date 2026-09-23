# Copyright (c) 2022, Frappe Technologies and contributors
# License: MIT. See LICENSE

from datetime import date, timedelta

import frappe
from frappe.desk.doctype.route_history.route_history import (
	FRECENCY_HALF_LIFE_DAYS,
	FRECENCY_WINDOW_DAYS,
	MAX_LINKS,
	frequently_visited_links,
	score_visits,
)
from frappe.tests import IntegrationTestCase, UnitTestCase

TODAY = date(2026, 7, 30)


def visits(route: str, count: int, days_ago: float) -> list[dict]:
	"""One day-bucket, the shape daily_visits returns."""
	return [{"route": route, "day": TODAY - timedelta(days=days_ago), "count": count}]


class TestScoreVisits(UnitTestCase):
	def test_a_visit_halves_in_value_every_half_life(self):
		scores = score_visits(
			visits("List/Item/List", 1, 0) + visits("List/Customer/List", 1, FRECENCY_HALF_LIFE_DAYS),
			TODAY,
		)

		self.assertAlmostEqual(scores["List/Item/List"], 1.0)
		self.assertAlmostEqual(scores["List/Customer/List"], 0.5)

	def test_recent_use_outranks_a_larger_but_stale_count(self):
		scores = score_visits(
			visits("List/Sales Invoice/List", 10, 1) + visits("List/Purchase Invoice/List", 30, 60),
			TODAY,
		)

		self.assertGreater(scores["List/Sales Invoice/List"], scores["List/Purchase Invoice/List"])

	def test_frequency_still_decides_between_equally_recent_routes(self):
		scores = score_visits(
			visits("List/Sales Invoice/List", 10, 3) + visits("List/Purchase Invoice/List", 2, 3),
			TODAY,
		)

		self.assertGreater(scores["List/Sales Invoice/List"], scores["List/Purchase Invoice/List"])

	def test_a_days_visits_are_worth_their_count(self):
		"""Buckets carry a count; scoring one as a single visit would flatten heavy days."""
		scores = score_visits(visits("List/Item/List", 7, 0), TODAY)

		self.assertAlmostEqual(scores["List/Item/List"], 7.0)

	def test_future_dated_visits_score_no_more_than_fresh_ones(self):
		scores = score_visits(visits("List/Item/List", 1, -2 * FRECENCY_HALF_LIFE_DAYS), TODAY)

		self.assertAlmostEqual(scores["List/Item/List"], 1.0)


class TestFrequentlyVisitedLinks(IntegrationTestCase):
	def setUp(self):
		frappe.db.delete("Route History", {"user": frappe.session.user})
		self.visit("List/Note/List", 3)
		self.visit("List/ToDo/List", 1)

	def visit(self, route: str, times: int):
		"""Return the last visit inserted, so a test can backdate it."""
		for _ in range(times):
			visit = frappe.get_doc(
				{"doctype": "Route History", "route": route, "user": frappe.session.user}
			).insert()
		return visit

	def test_the_payload_is_ordered_most_frecent_first(self):
		links = frequently_visited_links()

		self.assertEqual([link["route"] for link in links], ["List/Note/List", "List/ToDo/List"])
		self.assertGreater(links[0]["score"], links[1]["score"])

	def test_the_payload_still_carries_the_raw_visit_count_it_used_to_return(self):
		links = frequently_visited_links()

		self.assertEqual(links[0]["count"], 3)

	def test_the_payload_is_capped(self):
		"""Boot carries this list, so a heavy user's history must not decide its size."""
		for i in range(MAX_LINKS + 5):
			self.visit(f"List/Note {i}/List", 1)

		self.assertEqual(len(frequently_visited_links()), MAX_LINKS)

	def test_visits_older_than_the_scoring_window_are_left_out(self):
		"""They are worth under 1% of a visit from today, so all they can cost is the scan
		— and on a site that never trims Route History they would be the bulk of it."""
		stale = self.visit("List/Blog Post/List", 1)
		stale.db_set(
			"creation",
			frappe.utils.add_days(frappe.utils.nowdate(), -FRECENCY_WINDOW_DAYS - 1),
			update_modified=False,
		)

		self.assertNotIn("List/Blog Post/List", [link["route"] for link in frequently_visited_links()])
