frappe.route_history_queue = [];
// "Form" is not here: is_route_useful decides Form routes itself, keeping singles and
// drafts while still dropping the saved documents that would bury everything else.
const routes_to_skip = ["social", "setup-wizard", "recorder"];

const save_routes = frappe.utils.debounce(() => {
	if (frappe.session.user === "Guest") return;
	const routes = frappe.route_history_queue;
	if (!routes.length) return;

	frappe.route_history_queue = [];

	frappe
		.xcall("frappe.desk.doctype.route_history.route_history.deferred_insert", {
			routes: routes,
		})
		.catch(() => {
			frappe.route_history_queue.concat(routes);
		});
}, 10000);

frappe.router.on("change", () => {
	const route = frappe.get_route();
	if (is_route_useful(route)) {
		frappe.route_history_queue.push({
			creation: frappe.datetime.now_datetime(),
			route: frappe.get_route_str(),
		});

		save_routes();
	}
});

function is_route_useful(route) {
	if (!route[1]) {
		// A desk Page is a single-segment route, and one the awesome bar offers as a
		// result — dropping every one of them left Pages unrankable however often they
		// were opened. Boot already permission-filters page_info.
		return Boolean(frappe.boot.page_info?.[route[0]]);
	} else if (route[0] === "Form") {
		// Form is in routes_to_skip because one row per saved document would bury the
		// destinations this table is read for. Neither of these carries that volume: a
		// single is one row per doctype, and every draft of a doctype folds to a single
		// key in visit_key (route_history.py).
		return (
			(route[1] === route[2] && (frappe.boot.single_types || []).includes(route[1])) ||
			is_new_document(route[1], route[2])
		);
	} else if ((route[0] === "List" && !route[2]) || routes_to_skip.includes(route[0])) {
		return false;
	} else {
		return true;
	}
}

/**
 * Whether a Form route points at an unsaved draft rather than a stored document.
 *
 * Mirrors frappe.model.get_new_name, which names a draft `slug(new-<doctype>-<random>)`,
 * and its slug only lowercases and turns spaces into dashes. The trailing dash is what
 * keeps `Quotation` from claiming a `Quotation Item` draft.
 */
function is_new_document(doctype, docname) {
	return (
		Boolean(docname) && docname.startsWith(`new-${doctype.toLowerCase().replace(/ /g, "-")}-`)
	);
}
