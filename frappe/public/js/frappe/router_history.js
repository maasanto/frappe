frappe.route_history_queue = [];
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
	// First, or one-segment pages like "setup-wizard" would slip past it.
	if (routes_to_skip.includes(route[0])) {
		return false;
	} else if (!route[1]) {
		return Boolean(frappe.boot.page_info?.[route[0]]);
	} else if (route[0] === "Form") {
		// Not saved documents: one row each would bury everything else.
		return (
			(route[1] === route[2] && (frappe.boot.single_types || []).includes(route[1])) ||
			frappe.model.is_new_name(route[1], route[2])
		);
	} else if (route[0] === "List" && !route[2]) {
		return false;
	} else {
		return true;
	}
}
