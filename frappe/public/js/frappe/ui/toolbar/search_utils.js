frappe.provide("frappe.search");
import { fuzzy_match } from "./fuzzy_match.js";

// Results scoring within this fraction of the best match are close enough that personal
// history, not the fuzzy score, should decide their order.
const FRECENCY_BAND = 0.7;

// fuzzy_match starts every match at 100 and scores quality either side of it, so a top
// score just above 100 puts the multiplicative cutoff under the pedestal and makes every
// result a near-tie. Hold the band there — below it the top match is weak too, and the
// plain fraction is the only thing left to measure against.
const FUZZY_BASE_SCORE = 100;

// The same route is emitted by several of the get_* builders below, so the scores the
// rerank redistributes contain duplicates — and Awesomplete's sort is stable, which
// resolves a tie by the original position. Without a nudge a promoted result only ever
// ties the copies that kept the top score, and renders behind them. Kept far below the
// 0.01 offsets get_doctypes uses as tie-breakers.
const RANK_EPSILON = 1e-6;

const MEMORY_KEY = "awesomebar_selections";
// Digit-only queries ("2024") would otherwise become integer-like object keys, which
// JavaScript enumerates in numeric order before insertion order — silently breaking the
// LRU eviction in frappe.search.memory.record.
const MEMORY_KEY_PREFIX = "q:";
const MEMORY_MAX_QUERIES = 100;
// Low enough that a single pick already pins, the way Raycast and Alfred learn. What
// makes that safe is the decay: a one-off fades in about three idle days, while a habit
// worth keeping lasts weeks.
const MEMORY_MIN_CONFIDENCE = 0.65;
// How long a remembered pick keeps half its weight once the query goes unused.
const MEMORY_HALF_LIFE_DAYS = 14;

// The key visit_key (route_history.py) folds every draft of a doctype into. It is a
// scoring key, not a route: nothing navigates to it.
const NEW_DOCUMENT_KEY_PREFIX = "New/";

frappe.search.utils = {
	setup_recent: function () {
		this.recent = JSON.parse(frappe.boot.user.recent || "[]") || [];
	},
	results_to_hide: [],
	get_recent_pages: function (keywords) {
		if (keywords === null) keywords = "";
		var me = this,
			values = [],
			options = [];

		function find(list, keywords, process) {
			list.forEach(function (item, i) {
				var _item = $.isArray(item) ? item[0] : item;
				_item = __(_item || "")
					.toLowerCase()
					.replace(/-/g, " ");

				if (keywords === _item || _item.indexOf(keywords) !== -1) {
					var option = process(item);

					if (option) {
						if ($.isPlainObject(option)) {
							option = [option];
						}
						option.forEach(function (o) {
							o.match = item;
							o.recent = true;
						});

						options = option.concat(options);
					}
				}
			});
		}

		me.recent.forEach(function (doctype, i) {
			values.push([doctype[1], ["Form", doctype[0], doctype[1]]]);
		});

		values = values.reverse();

		frappe.route_history.forEach(function (route, i) {
			if (route[0] === "Form") {
				values.push([route[2], route]);
			} else if (
				["List", "Tree", "Workspaces", "query-report"].includes(route[0]) ||
				route[2] === "Report"
			) {
				if (route[1]) {
					values.push([route[1], route]);
				}
			} else if (route[0]) {
				values.push([frappe.route_titles[route.join("/")] || route[0], route]);
			}
		});

		find(values, keywords, function (match) {
			const route = match[1];
			const out = { route: route };

			if (route[0] === "Form") {
				const doctype = route[1];
				if (route.length > 2 && doctype !== route[2]) {
					const docname = route[2];
					out.label = __(doctype) + " " + frappe.utils.bold(docname);
					out.value = __(doctype) + " " + docname;
				} else {
					out.label = __(doctype).bold();
					out.value = __(doctype);
				}
			} else if (
				["List", "Tree", "Workspaces", "query-report"].includes(route[0]) &&
				route.length > 1
			) {
				const view_type = route[0];
				const view_name = route[1];

				let labelSuffix;

				switch (view_type) {
					case "List":
						labelSuffix = __("List");
						break;
					case "Tree":
						labelSuffix = __("Tree");
						break;
					case "Workspaces":
						labelSuffix = __("Workspace");
						break;
					case "query-report":
						labelSuffix = __("Report");
						break;
				}

				out.label = __(view_name.bold()) + " " + labelSuffix;
				out.value = __(view_name) + " " + labelSuffix;
			} else if (match[0]) {
				out.label = frappe.utils.escape_html(match[0]).bold();
				out.value = match[0];
			} else {
				console.log("Illegal match", match);
			}
			out.index = 80;
			return out;
		});
		this.hide_results(options);
		return options;
	},
	hide_results(options) {
		if (this.results_to_hide.length == 0) return;
		this.results_to_hide.forEach((v, i) => {
			options.forEach((o, j) => {
				if (o.value == v) {
					options.splice(j, 1);
				}
			});
		});
	},
	get_frequent_links() {
		// Boot carries more links than this list shows, and `New/<doctype>` among them:
		// that key exists so frappe.search.frecency can score the routeless "New Invoice"
		// option, and it opens nothing on its own, so it must never become a link here.
		const links = frappe.search.frecency
			.links()
			.filter((link) => !link.route.startsWith(NEW_DOCUMENT_KEY_PREFIX))
			.slice(0, 5);
		// The server already ordered these by frecency, so rank is what carries that order
		// through. Ranking rather than the score itself keeps them on the small-integer
		// scale the visit count used — below get_recent_pages' index of 80, and never 0,
		// which the dropdown's sort reads as "no index".
		const options = links.map((link, rank) => {
			const label = frappe.utils.get_route_label(link.route);
			return {
				route: link.route,
				label: label,
				value: label,
				index: links.length - rank,
			};
		});
		if (!options.length) {
			return this.get_recent_pages("");
		}
		return options;
	},

	get_search_in_list: function (keywords) {
		var me = this;
		var out = [];
		if (keywords.split(" ").includes("in") && keywords.slice(-2) !== "in") {
			var parts = keywords.split(" in ");
			frappe.boot.user.can_read.forEach(function (item) {
				if (frappe.boot.user.can_search.includes(item)) {
					const search_result = me.fuzzy_search(parts[1], item, true);
					if (search_result.score) {
						out.push({
							type: "In List",
							label: __("Find {0} in {1}", [
								__(parts[0]),
								search_result.marked_string,
							]),
							value: __("Find {0} in {1}", [__(parts[0]), __(item)]),
							route_options: { name: ["like", "%" + parts[0] + "%"] },
							index: 1 + search_result.score,
							route: ["List", item],
						});
					}
				}
			});
		}
		return out;
	},

	get_creatables: function (keywords) {
		var me = this;
		var out = [];
		var firstKeyword = keywords.split(" ")[0];
		if (firstKeyword.toLowerCase() === __("new")) {
			frappe.boot.user.can_create.forEach(function (item) {
				const search_result = me.fuzzy_search(keywords.substr(4), item, true);
				var level = search_result.score;
				if (level) {
					out.push({
						type: "New",
						label: __("New {0}", [search_result.marked_string || __(item)]),
						value: __("New {0}", [__(item)]),
						index: 1 + level,
						match: item,
						onclick: function () {
							frappe.new_doc(item, true);
						},
					});
				}
			});
		}
		return out;
	},

	get_doctypes: function (keywords) {
		var me = this;
		var out = [];

		var score, marked_string, target;
		var option = function (type, route, order) {
			// check to skip extra list in the text
			// eg. Price List List should be only Price List
			let skip_list = type === "List" && target.endsWith("List");
			if (skip_list) {
				var label = marked_string || __(target);
			} else {
				label = __(`{0} ${skip_list ? "" : type}`, [marked_string || __(target)]);
			}
			return {
				type: type,
				label: label,
				value: __(`{0} ${type}`, [target]),
				index: score + order,
				match: target,
				route: route,
			};
		};
		frappe.boot.user.can_read.forEach(function (item) {
			const search_result = me.fuzzy_search(keywords, item, true);
			({ score, marked_string } = search_result);
			if (score) {
				target = item;
				if (frappe.boot.single_types.includes(item)) {
					out.push(option("", ["Form", item, item], 0.05));
				} else if (frappe.boot.user.can_search.includes(item)) {
					// include 'making new' option
					if (frappe.boot.user.can_create.includes(item)) {
						var match = item;
						out.push({
							type: "New",
							label: __("New {0}", [search_result.marked_string || __(item)]),
							value: __("New {0}", [__(item)]),
							index: score + 0.015,
							match: item,
							onclick: function () {
								frappe.new_doc(match, true);
							},
						});
					}
					const isTree = (frappe.boot.tree_view_doctypes || []).includes(item);
					let option_data = option(
						isTree ? "Tree" : "List",
						isTree ? ["Tree", item] : ["List", item],
						0.05
					);
					out.push(option_data);
					if (frappe.model.can_get_report(item)) {
						out.push(option("Report", ["List", item, "Report"], 0.04));
					}
				}
			}
		});
		return out;
	},

	/**
	 * Matches DocType Layouts (by title, falling back to name) so they are
	 * navigable from the Awesome Bar. Selecting one opens the base doctype's
	 * list filtered by the layout condition, with the layout context active.
	 */
	get_doctype_layouts: function (keywords) {
		var me = this;
		var out = [];
		(frappe.boot.doctype_layouts || []).forEach(function (layout) {
			if (!frappe.boot.user.can_read.includes(layout.document_type)) return;

			const display = layout.title || layout.name;
			const search_result = me.fuzzy_search(keywords, display, true);
			if (!search_result.score) return;

			// Only `_layout` (consumed by the list view for the breadcrumb +
			// filter context) is set. Setting `layout` would make the router
			// write `?layout=` into the URL, which shadows route_options in
			// parse_filters_from_route_options and drops the condition filters.
			const route_options = Object.assign(
				frappe.utils.parse_layout_condition_to_filters(layout.condition),
				{ _layout: layout.name }
			);
			out.push({
				type: "Layout",
				label: __("{0} List", [search_result.marked_string || display]),
				value: __("{0} List", [display]),
				description: __(layout.document_type),
				index: search_result.score,
				route: ["List", layout.document_type],
				route_options: route_options,
			});
		});
		return out;
	},

	get_reports: function (keywords) {
		var me = this;
		var out = [];
		var route;
		Object.keys(frappe.boot.allowed_reports).forEach(function (item) {
			const search_result = me.fuzzy_search(keywords, item, true);
			var level = search_result.score;
			if (level > 0) {
				var report = frappe.boot.allowed_reports[item];
				if (report.report_type == "Report Builder")
					route = ["List", report.ref_doctype, "Report", item];
				else route = ["query-report", item];
				out.push({
					type: "Report",
					label: __("Report {0}", [search_result.marked_string || __(item)]),
					value: __("Report {0}", [__(item)]),
					index: level,
					route: route,
				});
			}
		});
		return out;
	},

	get_pages: function (keywords) {
		var me = this;
		var out = [];
		this.pages = {};
		$.each(frappe.boot.page_info, function (name, p) {
			me.pages[p.title] = p;
			p.name = name;
		});
		Object.keys(this.pages).forEach(function (item) {
			if (item == "Hub" || item == "hub") return;
			const search_result = me.fuzzy_search(keywords, item, true);
			var level = search_result.score;
			if (level) {
				var page = me.pages[item];
				out.push({
					type: "Page",
					label: __("Open {0}", [search_result.marked_string || __(item)]),
					value: __("Open {0}", [__(item)]),
					match: item,
					index: level,
					route: [page.route || page.name],
				});
			}
		});
		var target = "Calendar";
		if (__("calendar").indexOf(keywords.toLowerCase()) === 0) {
			out.push({
				type: "Calendar",
				label: __("Open {0}", [__(target)]),
				value: __("Open {0}", [__(target)]),
				index: me.fuzzy_search(keywords, "Calendar"),
				match: target,
				route: ["List", "Event", target],
			});
		}
		target = "Hub";
		if (__("hub").indexOf(keywords.toLowerCase()) === 0) {
			out.push({
				type: "Hub",
				label: __("Open {0}", [__(target)]),
				value: __("Open {0}", [__(target)]),
				index: me.fuzzy_search(keywords, "Hub"),
				match: target,
				route: [target, "Item"],
			});
		}
		if (__("email inbox").indexOf(keywords.toLowerCase()) === 0) {
			out.push({
				type: "Inbox",
				label: __("Open {0}", [__("Email Inbox")]),
				value: __("Open {0}", [__("Email Inbox")]),
				index: me.fuzzy_search(keywords, "email inbox"),
				match: target,
				route: ["List", "Communication", "Inbox"],
			});
		}
		return out;
	},

	// Search covers every workspace the user is permitted (`frappe.workspaces`), not just those
	// carrying sidebar items. That matters because a rail only lists the entries its app's `Dock`
	// record names, so for a workspace no record names, search is the way back to it.
	get_workspaces: function (keywords) {
		var me = this;
		var out = [];
		Object.values(frappe.workspaces || {}).forEach(function (workspace) {
			const name = workspace.name;
			const title = workspace.title || workspace.label || name;
			if (!title) return;

			const search_result = me.fuzzy_search(keywords, title, true);
			const level = search_result.score;
			if (level > 0) {
				out.push({
					type: "Workspace",
					label: __("Open {0} Workspace", [search_result.marked_string || __(title)]),
					value: __("Open {0} Workspace", [__(title)]),
					index: level,
					// Not how it opens — onclick takes precedence below — but the route
					// Route History records it under, so frappe.search.frecency can rank it.
					route: ["Workspaces", name],
					// open the workspace's sidebar and land on its first item; falls back to the
					// workspace's own route when it has no sidebar items
					onclick: function () {
						frappe.app.sidebar.open_workspace(name);
					},
				});
			}
		});
		return out;
	},

	get_dashboards: function (keywords) {
		var me = this;
		var out = [];
		frappe.boot.dashboards.forEach(function (item) {
			const search_result = me.fuzzy_search(keywords, item.name, true);
			var level = search_result.score;
			if (level > 0) {
				var ret = {
					type: "Dashboard",
					label: __("{0} Dashboard", [search_result.marked_string || __(item.name)]),
					value: __("{0} Dashboard", [__(item.name)]),
					index: level,
					route: ["dashboard-view", item.name],
				};

				out.push(ret);
			}
		});
		return out;
	},

	get_global_results: function (keywords, start, limit, doctype = "") {
		var me = this;
		function get_results_sets(data) {
			var results_sets = [],
				result,
				set;
			function get_existing_set(doctype) {
				return results_sets.find(function (set) {
					return set.title === doctype;
				});
			}

			function make_description(content, doc_name) {
				var parts = content.split(" ||| ");
				var result_max_length = 300;
				var field_length = 120;
				var fields = [];
				var result_current_length = 0;
				var field_text = "";
				for (var i = 0; i < parts.length; i++) {
					var part = parts[i];
					if (part.toLowerCase().indexOf(keywords.toLowerCase()) !== -1) {
						// If the field contains the keyword
						let colon_index, field_value;
						if (part.indexOf(" &&& ") !== -1) {
							colon_index = part.indexOf(" &&& ");
							field_value = part.slice(colon_index + 5);
						} else {
							colon_index = part.indexOf(" : ");
							field_value = part.slice(colon_index + 3);
						}
						if (field_value.length > field_length) {
							// If field value exceeds field_length, find the keyword in it
							// and trim field value by half the field_length at both sides
							// ellipsify if necessary
							var field_data = "";
							var index = field_value.indexOf(keywords);
							field_data +=
								index < field_length / 2
									? field_value.slice(0, index)
									: "..." + field_value.slice(index - field_length / 2, index);
							field_data += field_value.slice(index, index + field_length / 2);
							field_data +=
								index + field_length / 2 < field_value.length ? "..." : "";
							field_value = field_data;
						}
						var field_name = part.slice(0, colon_index);

						// Find remaining result_length and add field length to result_current_length
						var remaining_length = result_max_length - result_current_length;
						result_current_length += field_name.length + field_value.length + 2;
						const search_result_name = me.fuzzy_search(keywords, field_name, true);
						const search_result_value = me.fuzzy_search(keywords, field_value, true);
						if (result_current_length < result_max_length) {
							// We have room, push the entire field
							field_text =
								'<span class="field-name text-muted">' +
								search_result_name.marked_string +
								": </span> " +
								search_result_value.marked_string;
							if (fields.indexOf(field_text) === -1 && doc_name !== field_value) {
								fields.push(field_text);
							}
						} else {
							// Not enough room
							if (field_name.length < remaining_length) {
								// Ellipsify (trim at word end) and push
								remaining_length -= field_name.length;
								field_text =
									'<span class="field-name text-muted">' +
									search_result_name.marked_string +
									": </span> ";
								field_value = field_value.slice(0, remaining_length);
								field_value =
									field_value.slice(0, field_value.lastIndexOf(" ")) + " ...";
								field_text += search_result_value.marked_string;
								fields.push(field_text);
							} else {
								// No room for even the field name, skip
								fields.push("...");
							}
							break;
						}
					}
				}
				return fields.join(", ");
			}

			data.forEach(function (d) {
				// more properties
				result = {
					label: d.title || d.name, // show title if exists
					value: d.name,
					description: make_description(d.content, d.name),
					route: ["Form", d.doctype, d.name],
					_global_raw_content: d.content,
					_global_doctype: d.doctype,
				};
				if (d.image || d.image === null) {
					result.image = d.image;
				}
				set = get_existing_set(d.doctype);
				if (set) {
					set.results.push(result);
				} else {
					set = {
						title: d.doctype,
						results: [result],
						fetch_type: "Global",
					};
					results_sets.push(set);
				}
			});
			return results_sets;
		}
		return new Promise(function (resolve, reject) {
			var args = { text: keywords };
			if (doctype) {
				args.doctype = doctype;
			}
			var offset = parseInt(start, 10) || 0;
			if (offset > 0) {
				args.start = offset;
				args.limit = parseInt(limit, 10);
				if (!args.limit || args.limit < 1) {
					args.limit = 20;
				}
			}
			frappe.call({
				method: "frappe.utils.global_search.search",
				args: args,
				callback: function (r) {
					if (r.message) {
						resolve(get_results_sets(r.message));
					} else {
						resolve([]);
					}
				},
			});
		});
	},

	/**
	 * Parses `__global_search` content into { field label - value list }.
	 * Segments are separated by `|||`; each segment is `label : value` (or `label &&& value` as fallback).
	 * Skips blank parts and the synthetic `name` field (the real name is shown in its own column).
	 */
	parse_global_search_fields: function (content) {
		const fields = {};
		if (!content) return fields;
		for (const raw of content.split("|||")) {
			let part = (raw || "").trim();
			if (!part.length) continue;
			let sep = " : ";
			let idx = part.indexOf(sep);
			if (idx === -1) {
				sep = " &&& ";
				idx = part.indexOf(sep);
			}
			if (idx === -1) continue;
			const label = part.slice(0, idx).trim();
			const value = part.slice(idx + sep.length).trim();
			if (!label.length || /^name$/i.test(label)) continue;
			if (!fields[label]) fields[label] = [];
			fields[label].push(value);
		}
		return fields;
	},

	/**
	 * Picks table column names for Global Search hits: walks each hit’s snippet text,
	 * finds every field label in that text, then returns each label once (first time we see it).
	 */
	global_search_field_columns_for_results: function (results) {
		const cols = [];
		const seen = Object.create(null);
		for (const r of results || []) {
			const fields = this.parse_global_search_fields(r._global_raw_content);
			for (const col of Object.keys(fields)) {
				if (!seen[col]) {
					seen[col] = 1;
					cols.push(col);
				}
			}
		}
		return cols;
	},

	/**
	 * Highlights search terms in text: wraps each term in `<mark>` tags.
	 */
	highlight_global_search_terms: function (text, keywords) {
		const s = text == null ? "" : String(text);
		const terms = keywords
			.split("&")
			.map((p) => p.trim())
			.filter(Boolean);
		if (!terms.length) return frappe.utils.escape_html(s);
		const escaped = terms.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		try {
			const re = new RegExp("(" + escaped.join("|") + ")", "gi");
			return s
				.split(re)
				.map((part) => {
					const isMatch =
						part && terms.some((t) => part.toLowerCase() === t.toLowerCase());
					const esc = frappe.utils.escape_html(part);
					return isMatch ? "<mark>" + esc + "</mark>" : esc;
				})
				.join("");
		} catch (e) {
			return frappe.utils.escape_html(s);
		}
	},

	fuzzy_search: function (keywords = "", _item = "", return_marked_string = false) {
		let item = __(_item);

		let [, score, matches] = fuzzy_match(keywords, item, return_marked_string);
		if (score == 0 && frappe.boot.lang !== "en" && item != _item) {
			item = _item || "";
			[, score, matches] = fuzzy_match(keywords, item, return_marked_string);
		}

		if (!return_marked_string) {
			return score;
		}
		if (score == 0) {
			return {
				score: score,
				marked_string: item,
			};
		}

		// Create Boolean mask to mark matching indices in the item string
		const matchArray = Array(item.length).fill(0);
		matches.forEach((index) => (matchArray[index] = 1));

		let marked_string = "";
		let buffer = "";

		// Clear the buffer and return marked matches.
		const flushBuffer = () => {
			if (!buffer) return "";
			const temp = `<mark>${buffer}</mark>`;
			buffer = "";
			return temp;
		};

		matchArray.forEach((isMatch, index) => {
			if (isMatch) {
				buffer += item[index];
			} else {
				marked_string += flushBuffer();
				marked_string += item[index];
			}
		});
		marked_string += flushBuffer();

		return { score, marked_string };
	},

	/**
	 * @deprecated Use frappe.search.utils.fuzzy_search(subseq, str, true).marked_string instead.
	 */
	bolden_match_part: function (str, subseq) {
		return this.fuzzy_search(subseq, str, true).marked_string;
	},

	get_executables(keywords) {
		let results = [];
		this.searchable_functions.forEach((item) => {
			const target = item.label.toLowerCase();
			const txt = keywords.toLowerCase();
			if (txt === target || target.indexOf(txt) === 0) {
				const search_result = this.fuzzy_search(txt, item.label, true);
				results.push({
					type: "Executable",
					value: search_result.marked_string,
					index: search_result.score,
					match: item.label,
					onclick: () => item.action.apply(this, item.args),
				});
			}
		});
		return results;
	},
	make_function_searchable(_function, label = null, args = null) {
		if (typeof _function !== "function") {
			throw new Error("First argument should be a function");
		}

		this.searchable_functions.push({
			label: label || _function.name,
			action: _function,
			args: args,
		});
	},
	searchable_functions: [],
};

/**
 * Ranks results by how much and how recently this user visits them. Scores are decayed
 * server side; boot carries a copy so the first search ranks without waiting on a call.
 */
frappe.search.frecency = {
	scores: null,
	refreshed: false,

	/** The scored links the ranking reads. */
	links() {
		return frappe.boot.frequently_visited_links || [];
	},

	/**
	 * Bootinfo is cached per user with no expiry, so the scores it carries are as old as
	 * the session and decay never moves them — the whole point of scoring by recency.
	 * Re-read them once per page load, when the awesome bar is first opened.
	 */
	refresh() {
		if (this.refreshed) return;
		this.refreshed = true;
		frappe
			.xcall("frappe.desk.doctype.route_history.route_history.frequently_visited_links")
			.then((links) => {
				frappe.boot.frequently_visited_links = links;
				this.load();
			});
	},

	/**
	 * Route History stores the visited route ("List/Sales Invoice/List") while awesome
	 * bar options carry the route that opens it (["List", "Sales Invoice"]). Collapse
	 * both to the same key so a list and its views count as one entry.
	 */
	route_key(route) {
		const parts = typeof route === "string" ? route.split("/") : route;
		const is_list_view = parts[0] === "List" && !["Report", "Inbox"].includes(parts[2]);
		return (is_list_view ? parts.slice(0, 2) : parts).join("/");
	},

	// Summed, not assigned: a doctype's list, kanban and calendar routes all collapse to
	// one key, and they are the same page as far as ranking goes.
	load() {
		this.scores = {};
		this.links().forEach((link) => {
			const key = this.route_key(link.route);
			// A boot cached before this shipped carries no score; scoring it 0 leaves the
			// match ranking alone, where NaN would spread through every comparison.
			this.scores[key] = (this.scores[key] || 0) + (link.score || 0);
		});
		return this.scores;
	},

	score_of(option) {
		if (!this.scores) this.load();
		// "New Quotation" opens a form through a callback rather than a route, so it has
		// no route to key on and `match` is the only place its doctype survives. The key
		// is the one visit_key in route_history.py folds every draft of a doctype into.
		if (option.type === "New") return this.scores[NEW_DOCUMENT_KEY_PREFIX + option.match] || 0;
		return option.route ? this.scores[this.route_key(option.route)] || 0 : 0;
	},

	/**
	 * Reorders only the results that are already near-ties on match quality, so a
	 * frequently visited page can win a close call but never outrank a better match.
	 *
	 * Swaps their scores rather than their positions: Awesomplete re-sorts the list by
	 * `index` before rendering, so anything expressed as array order is discarded.
	 * Options must arrive sorted by `index` descending.
	 */
	rerank(options) {
		// fuzzy_match can go negative on long labels, and a non-positive top score puts
		// the multiplicative cutoff above it — nothing near-tie-worthy there anyway.
		if (!options.length || options[0].index <= 0) return;

		// Read before the loop below overwrites it, or the band is measured against
		// whatever score landed on the first option instead of the best match.
		const top_score = options[0].index;
		const cutoff =
			top_score > FUZZY_BASE_SCORE
				? Math.max(top_score * FRECENCY_BAND, FUZZY_BASE_SCORE)
				: top_score * FRECENCY_BAND;
		const near_ties = options.filter((option) => option.index >= cutoff);
		const scores_to_share = near_ties.map((option) => option.index);

		// Comparing scores would miss a result that moved up without gaining one, which
		// is what happens whenever the score it moved past was a duplicate of its own.
		const rank_before = new Map(near_ties.map((option, rank) => [option, rank]));

		near_ties
			.sort((a, b) => this.score_of(b) - this.score_of(a) || b.index - a.index)
			.forEach((option, rank) => {
				option.boosted_by_history = rank < rank_before.get(option);
				option.index = scores_to_share[rank] + (near_ties.length - rank) * RANK_EPSILON;
			});
	},
};

/**
 * Remembers what you picked for a given query, so picking Sales Invoice once for "inv"
 * pins it for "inv" next time. Conditioned on the query rather than on the result, so it
 * only fires where the habit was actually formed.
 *
 * Device-local by design: no schema, no boot payload, and nothing to migrate.
 */
frappe.search.memory = {
	normalize(query) {
		return (query || "").trim().toLowerCase().replace(/\s\s+/g, " ");
	},

	// localStorage is shared across every Frappe user of a browser profile — on a shared
	// terminal one user's habits must not shape another user's ranking.
	storage_key() {
		return `${MEMORY_KEY}:${frappe.session.user}`;
	},

	// Read once and kept in memory: recall runs on every keystroke, and re-parsing the
	// whole store that often is work no keystroke should pay for.
	cache: null,

	load() {
		if (this.cache) return this.cache;
		try {
			this.cache = JSON.parse(localStorage.getItem(this.storage_key())) || {};
		} catch (e) {
			// Corrupted storage: starting over only costs relearning a few picks.
			this.cache = {};
		}
		return this.cache;
	},

	/**
	 * Laplace-smoothed selection rate, with both counters faded by how long the query has
	 * gone unused. One pick earns a pin and one contradicting pick corrects a fresh one —
	 * it flips a single-pick pin outright and unpins a double-pick one — while a habit
	 * repeated three or more times takes more than one stray pick to dislodge. A pin you
	 * stop using expires without needing a contradiction at all.
	 *
	 * The fade applies to the totals rather than to each pick separately: keeping a
	 * timestamp per pick would grow the payload to sharpen a tie-breaker.
	 */
	confidence(entry) {
		const idle_days = entry.last_used
			? (Date.now() - entry.last_used) / (24 * 60 * 60 * 1000)
			: 0;
		const weight = 0.5 ** (idle_days / MEMORY_HALF_LIFE_DAYS);
		return (entry.hits * weight + 1) / ((entry.hits + entry.misses) * weight + 2);
	},

	record(query, value) {
		const normalized_query = this.normalize(query);
		if (normalized_query.length < 2) return;

		const memory = this.load();
		const stored_key = MEMORY_KEY_PREFIX + normalized_query;
		const entry = memory[stored_key];
		let updated;

		if (!entry || (entry.value !== value && entry.misses + 1 >= entry.hits)) {
			updated = { value: value, hits: 1, misses: 0 };
		} else if (entry.value === value) {
			updated = { ...entry, hits: entry.hits + 1 };
		} else {
			updated = { ...entry, misses: entry.misses + 1 };
		}

		// Reinserting moves the key to the end of the iteration order, so the eviction
		// below drops the least recently used query rather than the oldest one.
		delete memory[stored_key];
		memory[stored_key] = { ...updated, last_used: Date.now() };

		const queries = Object.keys(memory);
		if (queries.length > MEMORY_MAX_QUERIES) delete memory[queries[0]];

		try {
			localStorage.setItem(this.storage_key(), JSON.stringify(memory));
		} catch (e) {
			// storage full or disabled: the boost is optional, dropping it is fine
		}
	},

	recall(query) {
		const normalized_query = this.normalize(query);
		const memory = this.load();

		// The pick was recorded when the query was usually shorter than what's typed by
		// now, so the longest stored prefix of the current query wins. A prefix that is
		// stored but not yet trusted is skipped rather than taken as an answer: typing one
		// more letter must not drop a pin the shorter query still earns.
		for (let length = normalized_query.length; length >= 2; length--) {
			const entry = memory[MEMORY_KEY_PREFIX + normalized_query.slice(0, length)];
			if (entry && this.confidence(entry) > MEMORY_MIN_CONFIDENCE) {
				return entry.value;
			}
		}
		return null;
	},

	/**
	 * Scores the result this user keeps picking for this exact query above every other
	 * match. Only touches what the search already matched, so a remembered choice never
	 * reappears once it stops matching what is being typed.
	 */
	pin(options, query) {
		const remembered = this.recall(query);
		if (!remembered) return;

		// Every copy, not just the first. deduplicate keeps one option per source for
		// anything carrying a description, so a route reachable as both a doctype and a
		// desk entry survives twice — pinning one would leave the pair split apart in the
		// ranking, with only one carrying the history marker.
		const pinned = options.filter((option) => option.value === remembered);
		if (!pinned.length) return;

		const top_index = Math.max(...options.map((option) => option.index)) + 1;
		pinned.forEach((option) => {
			option.index = top_index;
			option.boosted_by_history = true;
			option.pinned_for_query = true;
		});
	},
};

/** Closes the navbar Awesome Bar modal. */
function hide_navbar_search_modal() {
	const $modal = $("#navbar-search").closest(".modal");
	if ($modal.length) $modal.modal("hide");
}

/**
 * Open the global search dialog from the navbar Awesome Bar (Ctrl/Cmd+G).
 */
frappe.search.open_global_search_from_navbar_shortcut = function (e) {
	const from_bar = ($("#navbar-search").val() || "").trim();
	const dlg = frappe.searchdialog?.search;
	if (dlg?.toggle_global_search_dialog) {
		hide_navbar_search_modal();
		dlg.toggle_global_search_dialog(from_bar);
	}
	if (e) {
		e.preventDefault();
	}
	return false;
};

/**
 * Open the navbar Awesome Bar from Global Search (Ctrl/Cmd+K).
 */
frappe.search.open_awesomebar_from_global_search_shortcut = function (e) {
	if (e) {
		e.preventDefault();
	}
	const awesome_bar = frappe.app.awesome_bar;
	if (awesome_bar?.is_open()) {
		awesome_bar.close();
		return false;
	}
	const dlg = frappe.searchdialog?.search;
	if (dlg?.search_dialog?.is_visible) {
		const keywords = (dlg.$input?.val() || "").trim();
		dlg.search_dialog.hide();
		$("#navbar-search").val(keywords);
	}
	awesome_bar.open();
	return false;
};
