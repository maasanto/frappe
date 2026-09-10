const list_view = "/desk/todo";

// test round trip with filter types

const test_queries = [
	"?status=Open",
	`?date=%5B"Between"%2C%5B"2022-06-01"%2C"2022-06-30"%5D%5D`,
	`?date=%5B">"%2C"2022-06-01"%5D`,
	`?name=%5B"like"%2C"%2542%25"%5D`,
	`?status=%5B"not%20in"%2C%5B"Open"%2C"Closed"%5D%5D`,
	`?status=%5B%22%21%3D%22%2C%22Closed%22%5D&status=%5B%22%21%3D%22%2C%22Cancelled%22%5D`,
];

describe("SPA Routing", { scrollBehavior: false }, () => {
	before(() => {
		cy.login();
		cy.go_to_list("ToDo");
	});

	after(() => {
		cy.clear_filters(); // avoid flake in future tests
	});

	it("should apply filter on list view from route", () => {
		test_queries.forEach((query) => {
			const full_url = `${list_view}${query}`;
			cy.visit(full_url);
			cy.findByTitle("To Do").should("exist");

			const expected = new URLSearchParams(query);
			cy.location().then((loc) => {
				const actual = new URLSearchParams(loc.search);
				// This might appear like a dumb test checking visited URL to itself
				// but it's actually doing a round trip
				// URL with params -> parsed filters -> new URL
				// if it's same that means everything worked in between.
				expect(actual.toString()).to.eq(expected.toString());
			});
		});
	});
});

// The awesome bar ranks its results on Route History and offers desk Pages, single
// doctypes and "New <doctype>" among them, so a destination the router declines to
// record can never be ranked, however often it is opened.
describe("Route history", { scrollBehavior: false }, () => {
	// Held in a closure rather than an alias: Cypress clears aliases before every test,
	// so one registered in `before` is gone by the time a test asks for it.
	let saved_todo;

	before(() => {
		cy.login();
		cy.insert_doc("ToDo", { description: "route history" }, true).then((todo) => {
			saved_todo = todo.name;
		});
	});

	function queued_routes(win) {
		return win.frappe.route_history_queue.map((visit) => visit.route);
	}

	it("records a desk Page, which is a one-segment route", () => {
		cy.visit("/desk/backups");
		cy.window().should((win) => {
			expect(queued_routes(win)).to.include("backups");
		});
	});

	it("records a single, whose Form route repeats the doctype as the document name", () => {
		cy.visit("/desk/system-settings");
		cy.window().should((win) => {
			expect(queued_routes(win)).to.include("Form/System Settings/System Settings");
		});
	});

	it("records an unsaved draft", () => {
		cy.visit("/desk/todo/new");
		cy.window().should((win) => {
			const drafts = queued_routes(win).filter((route) =>
				route.startsWith("Form/ToDo/new-todo-")
			);
			expect(drafts).to.have.length.of.at.least(1);
		});
	});

	it("leaves saved documents out, so they cannot bury the rest", () => {
		cy.visit(`/desk/todo/${saved_todo}`);
		cy.window().should((win) => {
			expect(queued_routes(win)).to.not.include(`Form/ToDo/${saved_todo}`);
		});
	});
});
