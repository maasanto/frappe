# Copyright (c) 2018, Frappe Technologies and contributors
# License: MIT. See LICENSE

import frappe
from frappe.model.document import Document
from frappe.utils import add_days, now


class ViewLog(Document):
	_DOCTYPE_NAME = "View Log"

	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		reference_doctype: DF.Link | None
		reference_name: DF.DynamicLink | None
		viewed_by: DF.Data | None
	# end: auto-generated types

	@staticmethod
	def clear_old_logs(days=180):
		table = frappe.qb.DocType("View Log")
		frappe.db.delete(table, filters=(table.creation < add_days(now(), -days)))
