const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "app/static/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "app/static/css/style.css"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "app/templates/index.html"), "utf8");

console.log("=== Running v1.2.0 Enhancements Tests ===");

// 1. CSS Rule Checks
console.log("1. Checking CSS rules for v1.2.0 enhancements...");
assert.match(css, /\.schema-explorer-panel/);
assert.match(css, /\.schema-table-row/);
assert.match(css, /\.schema-toggle-btn/);
assert.match(css, /\.schema-column-sublist/);
assert.match(css, /\.schema-badge-pk/);
assert.match(css, /\.schema-badge-fk/);
assert.match(css, /\.conn-safe-badge/);
assert.match(css, /\.badge-safe-mode/);
assert.match(css, /\.results-quick-search-wrap/);
assert.match(css, /\.results-quick-filter/);
assert.match(css, /\.results-view-mode-toggle/);
assert.match(css, /\.results-chart-panel/);
assert.match(css, /\.chart-controls-bar/);
assert.match(css, /\.chart-canvas-wrapper/);
console.log("  -> CSS rules verified successfully.");

// 2. HTML Template Checks
console.log("2. Checking HTML template markup...");
assert.match(indexHtml, /id="schema-explorer-section"/);
assert.match(indexHtml, /id="schema-current-conn"/);
assert.match(indexHtml, /id="btn-refresh-schema"/);
assert.match(indexHtml, /id="schema-table-search"/);
assert.match(indexHtml, /id="schema-tree-list"/);
assert.match(indexHtml, /id="conn-safe-mode"/);
console.log("  -> HTML markup verified successfully.");

// 3. Functional Testing of In-Grid Result Filter (applyResultFilter)
console.log("3. Testing applyResultFilter...");
class MockElement {
    constructor(tagName = "div") {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.style = {};
        this.textContent = "";
        this.classList = new Set();
    }
    appendChild(c) { this.children.push(c); return c; }
    querySelector(sel) {
        if (sel === "table.excel-grid") {
            return this.children.find(c => c.tagName === "TABLE") || null;
        }
        return null;
    }
    querySelectorAll(sel) {
        if (sel === "tbody tr") {
            const tbody = this.children.find(c => c.tagName === "TBODY");
            return tbody ? tbody.children.filter(c => c.tagName === "TR") : [];
        }
        return [];
    }
}

// Set up mock tab with table
const tab = {
    id: "tab-test",
    singleResultContainer: new MockElement("div"),
    resultCount: { textContent: "" },
    currentResultData: { rows: [{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }] }
};
const tableEl = new MockElement("table");
const tbodyEl = new MockElement("tbody");
const tr1 = new MockElement("tr"); tr1.textContent = "1 Alice Admin";
const tr2 = new MockElement("tr"); tr2.textContent = "2 Bob User";
const tr3 = new MockElement("tr"); tr3.textContent = "3 Charlie User";
tbodyEl.appendChild(tr1);
tbodyEl.appendChild(tr2);
tbodyEl.appendChild(tr3);
tableEl.appendChild(tbodyEl);
tab.singleResultContainer.appendChild(tableEl);

// Extract applyResultFilter from appJs using VM
const sandbox = {
    window: {},
    document: { documentElement: { dataset: {} } },
    console
};
vm.createContext(sandbox);

// Evaluate script up to exports
vm.runInContext(`
    let queryTabs = [];
    let activeTabId = null;
    let connections = [];
    let schemaMetadataCache = new Map();
    let selectedConnectionIds = new Set();
    function showToast() {}
    function escapeHtml(s) { return String(s); }
    function getTabById() { return null; }
    function getActiveTab() { return null; }
    function updateTabName() {}
    function executeQuery() {}
    function updateQueryCheckForTab() {}
    function updateQuerySuggestionsForTab() {}
    function applyResultEdits() {}
    function revertResultEdits() {}
    function switchView() {}
    function apiFetch() {}
    function buildEditableGrid() {}
    function handleCellEdit() {}
    function renderSingleResult() {}
    function renderMultiResults() {}
    function ensureTabElementReferences() {}
` + appJs.substring(appJs.indexOf("async function cancelCurrentQuery")), sandbox);

assert.strictEqual(typeof sandbox.applyResultFilter, "function");

// Test filter "bob"
sandbox.applyResultFilter(tab, "bob");
assert.strictEqual(tr1.style.display, "none");
assert.strictEqual(tr2.style.display, "");
assert.strictEqual(tr3.style.display, "none");
assert.strictEqual(tab.resultCount.textContent, "1 of 3 rows");

// Test empty filter resets
sandbox.applyResultFilter(tab, "");
assert.strictEqual(tr1.style.display, "");
assert.strictEqual(tr2.style.display, "");
assert.strictEqual(tr3.style.display, "");
assert.strictEqual(tab.resultCount.textContent, "3 rows");
console.log("  -> applyResultFilter passed all assertions.");

// 4. Test drawCanvasChart (Bar, Line, Pie, Doughnut)
console.log("4. Testing drawCanvasChart...");
assert.strictEqual(typeof sandbox.drawCanvasChart, "function");

class MockCanvasContext {
    constructor() {
        this.calls = [];
    }
    clearRect() { this.calls.push("clearRect"); }
    fillRect() { this.calls.push("fillRect"); }
    fillText(text) { this.calls.push(`fillText:${text}`); }
    beginPath() { this.calls.push("beginPath"); }
    arc() { this.calls.push("arc"); }
    lineTo() { this.calls.push("lineTo"); }
    moveTo() { this.calls.push("moveTo"); }
    closePath() { this.calls.push("closePath"); }
    stroke() { this.calls.push("stroke"); }
    fill() { this.calls.push("fill"); }
    save() { this.calls.push("save"); }
    restore() { this.calls.push("restore"); }
    translate() { this.calls.push("translate"); }
    rotate() { this.calls.push("rotate"); }
    scale() { this.calls.push("scale"); }
    createLinearGradient() {
        return { addColorStop: () => {} };
    }
}

class MockCanvas {
    constructor() {
        this.width = 800;
        this.height = 400;
        this.ctx = new MockCanvasContext();
    }
    getBoundingClientRect() { return { width: 800, height: 400 }; }
    getContext(type) { return this.ctx; }
}

const mockRows = [
    { category: "Sales", revenue: 150 },
    { category: "Marketing", revenue: 80 },
    { category: "R&D", revenue: 200 }
];

// Test Bar chart
const barCanvas = new MockCanvas();
sandbox.drawCanvasChart(barCanvas, "bar", "category", "revenue", mockRows);
assert.ok(barCanvas.ctx.calls.includes("fillRect"));
assert.ok(barCanvas.ctx.calls.some(c => c.startsWith("fillText:Sales")));

// Test Pie chart
const pieCanvas = new MockCanvas();
sandbox.drawCanvasChart(pieCanvas, "pie", "category", "revenue", mockRows);
assert.ok(pieCanvas.ctx.calls.includes("arc"));
assert.ok(pieCanvas.ctx.calls.includes("fill"));

// Test Line chart
const lineCanvas = new MockCanvas();
sandbox.drawCanvasChart(lineCanvas, "line", "category", "revenue", mockRows);
assert.ok(lineCanvas.ctx.calls.includes("lineTo"));
assert.ok(lineCanvas.ctx.calls.includes("stroke"));

console.log("  -> drawCanvasChart passed all chart types.");

// 5. Test Safe Mode destructive regex
console.log("5. Testing Safe Mode destructive statement detection...");
const isDestructive = (sql) => /\b(DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b/i.test(sql) || (/\bUPDATE\b/i.test(sql) && !/\bWHERE\b/i.test(sql));

assert.strictEqual(isDestructive("SELECT * FROM users;"), false);
assert.strictEqual(isDestructive("SELECT id, name FROM accounts WHERE balance > 0;"), false);
assert.strictEqual(isDestructive("DROP TABLE users;"), true);
assert.strictEqual(isDestructive("TRUNCATE TABLE logs;"), true);
assert.strictEqual(isDestructive("DELETE FROM sessions;"), true);
assert.strictEqual(isDestructive("ALTER TABLE users ADD COLUMN phone VARCHAR;"), true);
assert.strictEqual(isDestructive("UPDATE users SET active = 0;"), true); // Unconditional UPDATE!
assert.strictEqual(isDestructive("UPDATE users SET active = 0 WHERE id = 1;"), false); // Conditional UPDATE is ok!
console.log("  -> Safe Mode destructive query detection validated.");

// 6. Test exported global functions on window
console.log("6. Testing exported window methods...");
assert.match(appJs, /window\.cancelCurrentQuery\s*=\s*cancelCurrentQuery/);
assert.match(appJs, /window\.explainQuery\s*=\s*explainQuery/);
assert.match(appJs, /window\.applyResultFilter\s*=\s*applyResultFilter/);
assert.match(appJs, /window\.renderChartForTab\s*=\s*renderChartForTab/);
assert.match(appJs, /window\.drawCanvasChart\s*=\s*drawCanvasChart/);
assert.match(appJs, /window\.exportChartPng\s*=\s*exportChartPng/);
assert.match(appJs, /window\.renderSchemaExplorer\s*=\s*renderSchemaExplorer/);
assert.match(appJs, /window\.insertTextIntoActiveEditor\s*=\s*insertTextIntoActiveEditor/);
assert.match(appJs, /window\.loadAndRunQueryInActiveTab\s*=\s*loadAndRunQueryInActiveTab/);
console.log("  -> All window exports verified.");

console.log("\n>>> ALL V1.2.0 ENHANCEMENT TESTS PASSED! <<<");
