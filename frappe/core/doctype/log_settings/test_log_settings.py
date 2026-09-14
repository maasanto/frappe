# Copyright (c) 2022, Frappe Technologies and Contributors
# License: MIT. See LICENSE

import frappe
from frappe.core.doctype.log_settings.log_settings import _supports_log_clearing, run_log_clean_up
from frappe.tests import IntegrationTestCase
from frappe.utils import add_to_date, now_datetime

CLEARED_LOGTYPES = ("Activity Log", "Error Log", "Email Queue")
RETENTION_DAYS = 1


class TestLogSettings(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()

		settings = frappe.get_doc("Log Settings")
		for logtype in CLEARED_LOGTYPES:
			settings.register_doctype(logtype, RETENTION_DAYS)
		settings.save()

	def setUp(self) -> None:
		if self._testMethodName == "test_delete_logs":
			self.datetime = frappe._dict()
			self.datetime.current = now_datetime()
			self.datetime.past = add_to_date(self.datetime.current, days=-4)
			self.stale = setup_test_logs(self.datetime.past)
			self.fresh = setup_test_logs(self.datetime.current)

	def tearDown(self) -> None:
		if self._testMethodName == "test_delete_logs":
			del self.datetime

	def test_delete_logs(self):
		for logtype, name in self.stale.items():
			self.assertTrue(frappe.db.exists(logtype, name), f"{logtype} test record was not created")

		run_log_clean_up()

		# anything older than the retention window goes, anything inside it stays
		for logtype in CLEARED_LOGTYPES:
			with self.subTest(logtype=logtype):
				self.assertFalse(frappe.db.exists(logtype, self.stale[logtype]))
				self.assertTrue(frappe.db.exists(logtype, self.fresh[logtype]))

	def test_logtype_identification(self):
		supported_types = [
			"Error Log",
			"Activity Log",
			"Email Queue",
			"Route History",
			"Scheduled Job Log",
		]

		for lt in supported_types:
			self.assertTrue(_supports_log_clearing(lt), f"{lt} should be recognized as log type")

		unsupported_types = ["DocType", "User", "Non Existing dt"]
		for dt in unsupported_types:
			self.assertFalse(_supports_log_clearing(dt), f"{dt} shouldn't be recognized as log type")


def setup_test_logs(creation) -> dict[str, str]:
	"""Create one log of each cleared type, backdated to `creation`. Return their names by doctype."""
	logs = {
		"Activity Log": {"subject": "Test subject", "full_name": "test user2"},
		"Error Log": {"method": "test_method", "error": "traceback"},
		"Email Queue": {
			"sender": "test1@example.com",
			"message": "This is a test email1",
			"priority": 1,
			"expose_recipients": "test@receiver.com",
		},
	}

	names = {}
	for doctype, values in logs.items():
		doc = frappe.get_doc({"doctype": doctype, **values}).insert(ignore_permissions=True)
		doc.db_set("creation", creation)
		names[doctype] = doc.name

	return names
