# Copyright (c) 2022, Frappe Technologies and contributors
# License: MIT. See LICENSE

from datetime import datetime, timedelta

import frappe
from frappe.desk.doctype.route_history.route_history import (
	FRECENCY_HALF_LIFE_DAYS,
	frecency,
	frequently_visited_links,
)
from frappe.tests import IntegrationTestCase, UnitTestCase

NOW = datetime(2026, 7, 30, 12, 0, 0)


def visits(route: str, count: int, days_ago: float) -> list[dict]:
	return [{"route": route, "creation": NOW - timedelta(days=days_ago)}] * count


class TestFrecency(UnitTestCase):
	def test_a_visit_halves_in_value_every_half_life(self):
		scores = frecency(
			visits("List/Item/List", 1, 0) + visits("List/Customer/List", 1, FRECENCY_HALF_LIFE_DAYS),
			NOW,
		)

		self.assertAlmostEqual(scores["List/Item/List"], 1.0)
		self.assertAlmostEqual(scores["List/Customer/List"], 0.5)

	def test_recent_use_outranks_a_larger_but_stale_count(self):
		scores = frecency(
			visits("List/Sales Invoice/List", 10, 1) + visits("List/Purchase Invoice/List", 30, 60),
			NOW,
		)

		self.assertGreater(scores["List/Sales Invoice/List"], scores["List/Purchase Invoice/List"])

	def test_future_dated_visits_score_no_more_than_fresh_ones(self):
		scores = frecency(visits("List/Item/List", 1, -2 * FRECENCY_HALF_LIFE_DAYS), NOW)

		self.assertAlmostEqual(scores["List/Item/List"], 1.0)

	def test_frequency_still_decides_between_equally_recent_routes(self):
		scores = frecency(
			visits("List/Sales Invoice/List", 10, 3) + visits("List/Purchase Invoice/List", 2, 3),
			NOW,
		)

		self.assertGreater(scores["List/Sales Invoice/List"], scores["List/Purchase Invoice/List"])


class TestFrequentlyVisitedLinks(IntegrationTestCase):
	def setUp(self):
		frappe.db.delete("Route History", {"user": frappe.session.user})
		for route, visit_count in (("List/Note/List", 3), ("List/ToDo/List", 1)):
			for _ in range(visit_count):
				frappe.get_doc(
					{"doctype": "Route History", "route": route, "user": frappe.session.user}
				).insert()

	def test_payload_keeps_count_and_orders_by_score(self):
		links = frequently_visited_links(limit=10)

		self.assertEqual([link["route"] for link in links], ["List/Note/List", "List/ToDo/List"])
		self.assertEqual(links[0]["count"], 3)
		self.assertGreater(links[0]["score"], links[1]["score"])

	def test_limit_cannot_be_talked_out_of_its_bounds(self):
		self.assertEqual(len(frequently_visited_links(limit=-1)), 1)
		self.assertEqual(len(frequently_visited_links(limit=1)), 1)
