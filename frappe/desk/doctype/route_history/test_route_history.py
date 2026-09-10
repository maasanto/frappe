# Copyright (c) 2022, Frappe Technologies and contributors
# License: MIT. See LICENSE

from datetime import date, timedelta

import frappe
from frappe.desk.doctype.route_history.route_history import (
	FRECENCY_HALF_LIFE_DAYS,
	MAX_LINKS,
	_is_permitted_link,
	frequently_visited_links,
	score_visits,
	visit_key,
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

	def test_drafts_of_a_doctype_are_scored_as_one_destination(self):
		"""Counted raw, each draft is a singleton that never survives the boot cut."""
		scores = score_visits(
			visits("Form/Sales Invoice/new-sales-invoice-fjqbxlmzvd", 1, 0)
			+ visits("Form/Sales Invoice/new-sales-invoice-qpwoeiruty", 1, 0),
			TODAY,
		)

		self.assertEqual(list(scores), ["New/Sales Invoice"])
		self.assertAlmostEqual(scores["New/Sales Invoice"], 2.0)


class TestVisitKey(UnitTestCase):
	def test_a_stored_document_keeps_its_own_route(self):
		self.assertEqual(visit_key("Form/Quotation/QTN-0001"), "Form/Quotation/QTN-0001")

	def test_the_prefix_is_anchored(self):
		"""A stored document may be named anything, including something draft-shaped."""
		self.assertEqual(
			visit_key("Form/Quotation/QTN-new-quotation-0001"),
			"Form/Quotation/QTN-new-quotation-0001",
		)

	def test_the_doctype_is_matched_whole(self):
		"""Without the trailing dash `Quotation` would swallow every neighbouring doctype."""
		self.assertEqual(
			visit_key("Form/Quotation/new-quotationx-fjqbxlmzvd"),
			"Form/Quotation/new-quotationx-fjqbxlmzvd",
		)

	def test_a_two_word_doctype_is_slugged(self):
		self.assertEqual(visit_key("Form/Sales Invoice/new-sales-invoice-fjqbxlmzvd"), "New/Sales Invoice")

	def test_other_routes_pass_through_untouched(self):
		self.assertEqual(visit_key("List/Sales Invoice/List"), "List/Sales Invoice/List")
		self.assertEqual(visit_key("bank-reconciliation"), "bank-reconciliation")


class TestIsPermittedLink(IntegrationTestCase):
	# Administrator short-circuits every permission check, so the filter can only be
	# observed as someone else.
	READER = "frecency-reader@example.com"

	def setUp(self):
		frappe.get_doc(
			{
				"doctype": "User",
				"email": self.READER,
				"first_name": "Jane",
				"last_name": "Doe",
				"send_welcome_email": 0,
			}
		).insert(ignore_if_duplicate=True)

	def test_a_route_naming_a_doctype_that_no_longer_exists_is_dropped(self):
		"""Route History keeps routes long after the doctype behind them is renamed away."""
		with self.set_user(self.READER):
			self.assertFalse(_is_permitted_link("Form/No Such Doctype/No Such Doctype", set()))

	def test_a_single_the_user_may_not_read_is_dropped(self):
		with self.set_user(self.READER):
			self.assertFalse(_is_permitted_link("Form/System Settings/System Settings", set()))

	def test_a_list_route_is_still_left_to_the_list_view(self):
		with self.set_user(self.READER):
			self.assertTrue(_is_permitted_link("List/System Settings/List", set()))


class TestFrequentlyVisitedLinks(IntegrationTestCase):
	def setUp(self):
		frappe.db.delete("Route History", {"user": frappe.session.user})
		self.visit("List/Note/List", 3)
		self.visit("List/ToDo/List", 1)

	def visit(self, route: str, times: int):
		for _ in range(times):
			frappe.get_doc({"doctype": "Route History", "route": route, "user": frappe.session.user}).insert()

	def test_the_payload_is_ordered_most_frecent_first(self):
		links = frequently_visited_links()

		self.assertEqual([link["route"] for link in links], ["List/Note/List", "List/ToDo/List"])
		self.assertGreater(links[0]["score"], links[1]["score"])

	def test_the_navbar_still_gets_the_raw_visit_count_it_ranks_on(self):
		links = frequently_visited_links()

		self.assertEqual(links[0]["count"], 3)

	def test_the_payload_is_capped(self):
		"""Boot carries this list, so a heavy user's history must not decide its size."""
		for i in range(MAX_LINKS + 5):
			self.visit(f"List/Note {i}/List", 1)

		self.assertEqual(len(frequently_visited_links()), MAX_LINKS)

	def test_drafts_reach_the_payload_folded_into_one_destination(self):
		"""The fold happens before the top-N cut, or every draft arrives as a singleton."""
		self.visit("Form/Note/new-note-fjqbxlmzvd", 1)
		self.visit("Form/Note/new-note-qpwoeiruty", 1)

		links = {link["route"]: link for link in frequently_visited_links()}

		self.assertEqual(links["New/Note"]["count"], 2)
