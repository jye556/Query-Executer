"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "app/templates/index.html"), "utf8");
const appJs = fs.readFileSync(path.join(root, "app/static/js/app.js"), "utf8");
const styleCss = fs.readFileSync(path.join(root, "app/static/css/style.css"), "utf8");

console.log("=== Running v1.3.0 Enhancements Frontend Tests ===");

// 1. Check CSS rules for v1.3.0 enhancements
console.log("1. Checking CSS rules for v1.3.0 enhancements...");
assert.ok(styleCss.includes(".export-dropdown-wrapper"), "CSS must include .export-dropdown-wrapper");
assert.ok(styleCss.includes(".export-dropdown"), "CSS must include .export-dropdown");
assert.ok(styleCss.includes(".results-summary-footer"), "CSS must include .results-summary-footer");
assert.ok(styleCss.includes(".summary-bar"), "CSS must include .summary-bar");
assert.ok(styleCss.includes(".summary-stat"), "CSS must include .summary-stat");
assert.ok(styleCss.includes(".schema-diff-list"), "CSS must include .schema-diff-list");
assert.ok(styleCss.includes("#saved-queries-list"), "CSS must include #saved-queries-list");
assert.ok(styleCss.includes("th[data-column]"), "CSS must include th[data-column] sort styles");
assert.ok(styleCss.includes(".sort-asc"), "CSS must include .sort-asc");
assert.ok(styleCss.includes(".sort-desc"), "CSS must include .sort-desc");
console.log("  -> CSS rules verified successfully.");

// 2. Check HTML markup
console.log("2. Checking HTML template markup...");
assert.ok(indexHtml.includes('data-view="saved-queries-section"'), "Sidebar must have saved-queries-section link");
assert.ok(indexHtml.includes('data-view="schema-diff-section"'), "Sidebar must have schema-diff-section link");
assert.ok(indexHtml.includes('id="saved-queries-section"'), "Template must contain saved-queries-section view");
assert.ok(indexHtml.includes('id="schema-diff-section"'), "Template must contain schema-diff-section view");
assert.ok(indexHtml.includes('id="conn-strict-read-only"'), "Connection form must contain Strict Read-Only checkbox");
assert.ok(indexHtml.includes('id="saved-query-form"'), "Template must contain saved-query-form");
assert.ok(indexHtml.includes('id="saved-queries-search"'), "Template must contain saved-queries-search");
assert.ok(indexHtml.includes('id="diff-conn-source"'), "Schema diff view must have source selector");
assert.ok(indexHtml.includes('id="diff-conn-target"'), "Schema diff view must have target selector");
assert.ok(indexHtml.includes('id="btn-run-schema-diff"'), "Schema diff view must have compare button");
console.log("  -> HTML markup verified successfully.");

// 3. Test JS methods exported on window
console.log("3. Testing exported JS methods...");
const expectedExports = [
    "exportData",
    "applySortToResults",
    "renderSummaryFooter",
    "generateTableDDL",
    "savedQueriesList",
    "loadSavedQueries",
    "renderSavedQueriesList",
    "editSavedQuery",
    "deleteSavedQuery",
    "loadSavedQueryIntoEditor",
    "populateDiffConnectionSelects",
    "runSchemaDiff",
    "renderSchemaDiffResults",
    "columnSortState"
];

for (const exp of expectedExports) {
    assert.ok(appJs.includes(`window.${exp} = ${exp}`), `app.js must export window.${exp}`);
}
console.log("  -> Window exports verified successfully.");

// 4. Test Export dropdown in tab template
console.log("4. Testing export dropdown in tab template...");
assert.ok(appJs.includes('class="export-dropdown-wrapper"'), "Tab panel must include export dropdown wrapper");
assert.ok(appJs.includes('data-format="csv"'), "Export dropdown must have CSV option");
assert.ok(appJs.includes('data-format="json"'), "Export dropdown must have JSON option");
assert.ok(appJs.includes('data-format="markdown"'), "Export dropdown must have Markdown option");
assert.ok(appJs.includes('data-format="sql"'), "Export dropdown must have SQL option");
console.log("  -> Export dropdown in tab template verified successfully.");

// 5. Test DDL button in Schema Explorer
console.log("5. Testing DDL button in Schema Explorer...");
assert.ok(appJs.includes('schema-action-ddl'), "Schema explorer must contain DDL action button");
assert.ok(appJs.includes('generateTableDDL(connectionId, tableName)'), "DDL button must call generateTableDDL");
console.log("  -> DDL button verified successfully.");

// 6. Test Strict Read-Only in connection form
console.log("6. Testing Strict Read-Only checkbox handling in JS...");
assert.ok(appJs.includes('conn-strict-read-only'), "app.js must handle conn-strict-read-only");
assert.ok(appJs.includes('extra.strict_read_only = true'), "app.js must set strict_read_only in payload");
assert.ok(appJs.includes('delete extra.strict_read_only'), "app.js must clean up strict_read_only when unchecked");
console.log("  -> Strict Read-Only checkbox handling verified successfully.");

console.log("\n>>> ALL V1.3.0 FRONTEND TESTS PASSED! <<<");
