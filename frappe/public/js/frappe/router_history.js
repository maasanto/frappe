frappe.route_history_queue = [];
const routes_to_skip = ["Form", "social", "setup-wizard", "recorder"];

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
			frappe.route_history_queue = routes.concat(frappe.route_history_queue);
		});
}, 10000);

frappe.router.on("change", () => {
	const route = frappe.get_route();
	const route_str = frappe.get_route_str();
	if (is_route_useful(route) && route_str !== frappe._last_route_history) {
		frappe._last_route_history = route_str;
		frappe.route_history_queue.push({
			creation: frappe.datetime.now_datetime(),
			route: route_str,
		});

		save_routes();
	}
});

function is_route_useful(route) {
	if (!route[1]) {
		return false;
	} else if (routes_to_skip.includes(route[0])) {
		return false;
	} else {
		return true;
	}
}
