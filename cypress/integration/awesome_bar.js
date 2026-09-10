// Kept in step with search_utils.js, whose constants are not reachable from here.
const FRECENCY_BAND = 0.7;
const FUZZY_BASE_SCORE = 100;
const band_cutoff = (top_score) =>
	top_score > FUZZY_BASE_SCORE
		? Math.max(top_score * FRECENCY_BAND, FUZZY_BASE_SCORE)
		: top_score * FRECENCY_BAND;

context("Awesome Bar", () => {
	before(() => {
		cy.visit("/login");
		cy.login();
		cy.visit("/desk/todo"); // Make sure ToDo filters are cleared.
		cy.clear_filters();
		cy.visit("/desk/web-page"); // Make sure Blog Post filters are cleared.
		cy.clear_filters();
		cy.visit("/desk/build"); // Go to some other page.
	});

	beforeEach(() => {
		// a pin recorded by an earlier test would leak into this one, and the store is
		// read into memory once, so clearing storage alone does not undo it
		cy.clearLocalStorage(/awesomebar_selections/);
		cy.window().then((win) => {
			win.frappe.search.memory.cache = null;
		});
		cy.get("body").type("{esc}");
		cy.wait(300);
		// the global-search trigger moved from the page header into the dock (icon only)
		cy.get(".dock .navbar-modal-search-mobile").as("awesome_bar_search");
		cy.get("@awesome_bar_search").click();
		cy.get("#navbar-search").as("awesome_bar");
		cy.get("#navbar-search").type("{selectall}");
		cy.wait(400);
	});

	afterEach(() => {
		cy.get("body").type("{esc}");
		cy.wait(400);
	});

	after(() => {
		cy.visit("/desk/todo"); // Make sure we're not bleeding any filters to the next spec.
		cy.clear_filters();
	});

	it("opens awesome bar on click", () => {
		cy.get("@awesome_bar").should("be.visible");
	});

	it("navigates to doctype list", () => {
		cy.get("@awesome_bar").type("todo");
		cy.get(".awesomplete").findByRole("listbox").should("be.visible");
		cy.get("@awesome_bar").type("{enter}");
		cy.get(".title-text").should("contain", "To Do");
		cy.location("pathname").should("eq", "/desk/todo");
	});

	it("lets frecency win a near-tie and marks the result it moved up", () => {
		cy.window()
			.its("frappe")
			.then((frappe) => {
				const awesome_bar = frappe.app.awesome_bar;
				const options = awesome_bar.build_options("todo");
				// any result close enough to the top match to sit inside the frecency band
				const runner_up = options.find(
					(option) =>
						option.route &&
						option.value !== options[0].value &&
						option.index >= band_cutoff(options[0].index)
				);

				const original_scores = frappe.search.frecency.scores;
				frappe.search.frecency.scores = {
					[frappe.search.frecency.route_key(runner_up.route)]: 1000,
				};

				// ranking lives in `index`, not array order: Awesomplete re-sorts by it
				const reranked = awesome_bar.build_options("todo");
				const boosted = reranked.find((option) => option.value === runner_up.value);

				expect(boosted.index).to.equal(Math.max(...reranked.map((o) => o.index)));
				expect(boosted.boosted_by_history).to.be.true;
				expect(boosted.pinned_for_query).to.be.undefined;
				expect(boosted.label).to.contain("icon-history");

				frappe.search.frecency.scores = original_scores;
			});
	});

	it("never pushes a better match below a worse one", () => {
		cy.window()
			.its("frappe")
			.then((frappe) => {
				// Scored here rather than searched for: which doctypes match a query depends
				// on what is installed, and on a bare site every result for a short query is
				// a variant of the same doctype, all of them inside the band.
				const best = { value: "ToDo List", index: 190, route: ["List", "ToDo"] };
				const weak = { value: "Note List", index: 60, route: ["List", "Note"] };

				const original_scores = frappe.search.frecency.scores;
				frappe.search.frecency.scores = {
					[frappe.search.frecency.route_key(weak.route)]: 1000,
				};

				frappe.search.frecency.rerank([best, weak]);

				expect(weak.index).to.be.lessThan(best.index);
				expect(weak.boosted_by_history).to.not.be.true;

				frappe.search.frecency.scores = original_scores;
			});
	});

	it("pins the result picked for a query, and unlearns it when contradicted", () => {
		cy.window()
			.its("frappe")
			.then((frappe) => {
				const awesome_bar = frappe.app.awesome_bar;
				const runner_up = awesome_bar.build_options("todo")[1].value;

				frappe.search.memory.record("todo", runner_up);

				const pinned = awesome_bar.build_options("todo")[0];
				expect(pinned.value).to.equal(runner_up);
				expect(pinned.pinned_for_query).to.be.true;
				expect(pinned.label).to.contain("icon-pin");

				// one contradicting pick is enough to let the better match win again
				frappe.search.memory.record("todo", "something else");
				expect(awesome_bar.build_options("todo")[0].value).to.not.equal(runner_up);
			});
	});

	it("forgets a pin that has gone unused", () => {
		cy.window().then((win) => {
			const frappe = win.frappe;
			const awesome_bar = frappe.app.awesome_bar;
			const runner_up = awesome_bar.build_options("todo")[1].value;

			frappe.search.memory.record("todo", runner_up);

			const memory = frappe.search.memory.load();
			memory["q:todo"].last_used = Date.now() - 10 * 24 * 60 * 60 * 1000;
			win.localStorage.setItem(frappe.search.memory.storage_key(), JSON.stringify(memory));

			expect(frappe.search.memory.recall("todo")).to.equal(null);
			expect(awesome_bar.build_options("todo")[0].value).to.not.equal(runner_up);
		});
	});

	it("keeps a trusted shorter prefix when the longer one is still undecided", () => {
		cy.window()
			.its("frappe")
			.then((frappe) => {
				const awesome_bar = frappe.app.awesome_bar;
				const remembered = awesome_bar.build_options("todo")[1].value;

				// "tod" becomes a settled habit
				frappe.search.memory.record("tod", remembered);
				frappe.search.memory.record("tod", remembered);
				frappe.search.memory.record("tod", remembered);
				// "todo" is stored but contested, so it has nothing to say yet
				frappe.search.memory.record("todo", remembered);
				frappe.search.memory.record("todo", remembered);
				frappe.search.memory.record("todo", "something else");

				expect(frappe.search.memory.recall("todo")).to.equal(remembered);
				expect(awesome_bar.build_options("todo")[0].value).to.equal(remembered);
			});
	});

	// Route History now records singles, so their routes reach the navbar's frequent list.
	it("labels a single by its doctype rather than as a Form", () => {
		cy.window()
			.its("frappe")
			.then((frappe) => {
				expect(
					frappe.utils.get_route_label("Form/System Settings/System Settings")
				).to.contain("System Settings");
				expect(
					frappe.utils.get_route_label("Form/System Settings/System Settings")
				).to.not.equal("Form");
			});
	});

	it("keeps a remembered pick out of the way once it stops matching", () => {
		cy.window()
			.its("frappe")
			.then((frappe) => {
				const awesome_bar = frappe.app.awesome_bar;
				frappe.search.memory.record("todo", "ToDo List");

				const other_query = awesome_bar.build_options("web page");
				expect(other_query.map((option) => option.value)).to.not.include("ToDo List");
			});
	});

	// it("finds text in doctype list", () => {
	// 	cy.get("@awesome_bar").type("test in todo");
	// 	cy.wait(150); // Wait a bit before hitting enter.
	// 	cy.get("@awesome_bar").type("{enter}");
	// 	cy.get(".title-text").should("contain", "To Do");
	// 	cy.wait(400); // Wait a bit longer before checking the filter.
	// 	cy.get('[data-original-title="ID"]:visible > input').should("have.value", "%test%");

	// 	// filter preserved, now finds something else
	// 	cy.visit("/desk/todo");
	// 	cy.get(".title-text").should("contain", "To Do");
	// 	cy.wait(200); // Wait a bit longer before checking the filter.
	// 	cy.get('[data-original-title="ID"]:visible > input').as("filter");
	// 	cy.get("@filter").should("have.value", "%test%");
	// 	cy.get("@awesome_bar_search").click();
	// 	cy.wait(400);
	// 	cy.get("@awesome_bar").type("anothertest in todo");
	// 	cy.wait(200); // Wait a bit longer before hitting enter.
	// 	cy.get("@awesome_bar").type("{enter}");
	// 	cy.wait(200); // Wait a bit longer before checking the filter.
	// 	cy.get("@filter").should("have.value", "%anothertest%");
	// });

	it("navigates to another doctype, filter not bleeding", () => {
		cy.get("@awesome_bar").type("web page");
		cy.wait(150); // Wait a bit before hitting enter.
		cy.get("@awesome_bar").type("{enter}");
		cy.get(".title-text").should("contain", "Web Page");
		cy.location("search").should("be.empty");
	});

	it("navigates to new form", () => {
		cy.get("@awesome_bar").type("new web page");
		cy.wait(150); // Wait a bit before hitting enter
		cy.get("@awesome_bar").type("{enter}");
		cy.get(".title-text-form:visible").should("have.text", "New Web Page");
	});

	it("calculates math expressions", () => {
		cy.get("@awesome_bar").type("55 + 32");
		cy.wait(150); // Wait a bit before hitting enter
		cy.get("@awesome_bar").type("{downarrow}{enter}");
		cy.get(".modal-title").should("contain", "Result");
		cy.get(".msgprint").should("contain", "55 + 32 = 87");
	});

	it("support number formats in math expressions", () => {
		cy.window()
			.its("frappe")
			.then((frappe) => {
				frappe.boot.sysdefaults.number_format = "#,###.##";
			});
		cy.get("@awesome_bar").type("1,250.2 + 1,250.2");
		cy.wait(150); // Wait a bit before hitting enter
		cy.get("@awesome_bar").type("{downarrow}{enter}");
		cy.get(".modal-title").should("contain", "Result");
		cy.get(".msgprint").should("contain", "1,250.2 + 1,250.2 = 2,500.4");
		cy.hide_dialog();

		cy.get("@awesome_bar_search").click();
		cy.window()
			.its("frappe")
			.then((frappe) => {
				frappe.boot.sysdefaults.number_format = "#.###,##";
			});
		cy.get("@awesome_bar").type("1.500,2 + 1.500,2");
		cy.wait(150); // Wait a bit before hitting enter
		cy.get("@awesome_bar").type("{downarrow}{enter}");
		cy.get(".modal-title").should("contain", "Result");
		cy.get(".msgprint").should("contain", "1.500,2 + 1.500,2 = 3.000,4");
	});
});
