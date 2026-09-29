const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "app/static/js/app.js"), "utf8");
const inlineEditingJs = fs.readFileSync(path.join(root, "app/static/js/inline-editing.js"), "utf8");
const css = fs.readFileSync(path.join(root, "app/static/css/style.css"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "app/templates/index.html"), "utf8");

// 1. Verify CSS rules
console.log("Checking CSS rules for Query Results...");

// Sticky header with opaque background
assert.match(css, /\.excel-grid thead th\s*\{[^}]*position:\s*sticky/);
assert.match(css, /\.excel-grid thead th\s*\{[^}]*background-color:\s*#161b26/);
assert.match(css, /:root\[data-theme="light"\] \.excel-grid thead th\s*\{[^}]*background-color:\s*#f1f5f9/);

// Row index sticky to left
assert.match(css, /\.excel-grid th\.col-index,\s*\.excel-grid td\.row-index\s*\{[^}]*position:\s*sticky;\s*left:\s*0/);
assert.match(css, /\.excel-grid th\.col-index\s*\{[^}]*z-index:\s*20/);
assert.match(css, /\.excel-grid td\.row-index\s*\{[^}]*z-index:\s*5/);

// Scroll container has overflow: auto (not overflow-y: hidden)
assert.match(css, /\.table-scroll-container\s*\{[^}]*overflow:\s*auto/);
assert.doesNotMatch(css, /\.table-scroll-container\s*\{[^}]*overflow-y:\s*hidden/);

// Column alignments
assert.match(css, /\.excel-grid th\.col-number,\s*\.excel-grid td\.type-number,\s*\.excel-grid td\.type-integer,\s*\.excel-grid td\.type-float\s*\{[^}]*text-align:\s*right/);
assert.match(css, /\.excel-grid th\.col-center,\s*\.excel-grid td\.type-boolean\s*\{[^}]*text-align:\s*center/);
assert.match(css, /\.excel-grid th\.col-text,\s*\.excel-grid td\.type-text\s*\{[^}]*text-align:\s*left/);
assert.match(css, /\.excel-grid th\.col-date,\s*\.excel-grid td\.type-date\s*\{[^}]*text-align:\s*left/);

// Badges
assert.match(css, /\.null-badge\s*\{[^}]*font-style:\s*italic/);
assert.match(css, /\.bool-badge\.bool-true\s*\{[^}]*color:\s*#34d399/);
assert.match(css, /\.bool-badge\.bool-false\s*\{[^}]*color:\s*#f87171/);

// Results card & meta
assert.match(css, /\.query-tab-panel \.results-card/);
assert.doesNotMatch(css, /\.query-editor-split > \.query-right-panel > \.results-card/);
assert.match(css, /\.results-card \.card-header/);
assert.match(css, /\.results-meta/);

// Multi results
assert.match(css, /\.multi-result-header/);
assert.match(css, /\.multi-result-db-name/);
assert.match(css, /\.multi-result-meta/);

// 2. Functional testing of buildEditableGrid & handleCellEdit
console.log("Testing buildEditableGrid output...");

// Mock environment
class MockClassList {
    constructor() { this.classes = new Set(); }
    add(...args) { args.forEach(c => this.classes.add(c)); }
    remove(...args) { args.forEach(c => this.classes.delete(c)); }
    contains(c) { return this.classes.has(c); }
    toggle(c, force) {
        if (force === undefined) {
            if (this.classes.has(c)) { this.classes.delete(c); return false; }
            this.classes.add(c); return true;
        }
        if (force) { this.classes.add(c); return true; }
        this.classes.delete(c); return false;
    }
}

class MockNode {
    constructor(tagName = "div") {
        this.tagName = tagName.toUpperCase();
        this.classList = new MockClassList();
        this.dataset = {};
        this.attributes = {};
        this.children = [];
        this.parentNode = null;
        this.textContent = "";
        this.innerHTML = "";
    }
    setAttribute(name, val) { this.attributes[name] = String(val); }
    getAttribute(name) { return this.attributes[name]; }
    hasAttribute(name) { return name in this.attributes; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    closest(selector) {
        let cur = this;
        while (cur) {
            if (selector === "tr" && cur.tagName === "TR") return cur;
            if (selector === "table" && cur.tagName === "TABLE") return cur;
            cur = cur.parentNode;
        }
        return null;
    }
    querySelector(selector) {
        if (selector === "[data-key]") {
            return this.children.find(c => c.dataset?.key !== undefined) || null;
        }
        return null;
    }
    querySelectorAll(selector) {
        if (selector === "th") {
            return this.children.filter(c => c.tagName === "TH");
        }
        return [];
    }
}

// Extract buildEditableGrid and test with mock dataset
const escapeHtml = (val) => String(val ?? "").replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);

// Run buildEditableGrid inside vm context
const vm = require("node:vm");
const doc = {
    documentElement: new MockNode("html"),
    body: new MockNode("body"),
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (tag) => new MockNode(tag),
    addEventListener: () => {}
};

const context = {
    window: { addEventListener: () => {} },
    document: doc,
    currentUser: { role: "admin" },
    connections: [{ id: "c1", name: "Production SQLite" }],
    console,
    setTimeout: () => {},
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    innerWidth: 1200,
    addEventListener: () => {}
};

vm.createContext(context);
vm.runInContext(appJs, context);

vm.runInContext(`
window.currentUser = { role: "admin" };
const activeTab = getTabById("tab-1") || createQueryTab();
activeTab.connectionIds.clear();
activeTab.connectionIds.add("c1");

const testData = {
    columns: ["id", "username", "salary", "is_admin", "joined_at", "notes"],
    data: [
        { id: 1, username: "Alice", salary: 75000.50, is_admin: true, joined_at: "2024-01-15T09:30:00Z", notes: null },
        { id: 2, username: "Bob", salary: 54000.00, is_admin: false, joined_at: "2024-03-20T14:15:00Z", notes: "Contractor" }
    ],
    edit_context: {
        editable: true,
        table: "users",
        key_column: "id"
    }
};

const result = buildEditableGrid(testData, "tab-1", "c1");
window.__gridResult = result;
`, context);

const gridResult = context.window.__gridResult;
assert.ok(gridResult);
assert.equal(gridResult.rowCount, 2);
assert.equal(gridResult.columns.length, 6);

const html = gridResult.html;

// Verify Row index column header
assert.ok(html.includes('<th class="col-index" title="Row Index">#</th>'), "Header must contain row index #");

// Verify Typed column headers
assert.ok(html.includes('<th class="col-number" data-column="id" data-type="integer">id</th>'), "id column header should be col-number");
assert.ok(html.includes('<th class="col-text" data-column="username" data-type="text">username</th>'), "username column header should be col-text");
assert.ok(html.includes('<th class="col-number" data-column="salary" data-type="float">salary</th>'), "salary column header should be col-number float");
assert.ok(html.includes('<th class="col-center" data-column="is_admin" data-type="boolean">is_admin</th>'), "is_admin column header should be col-center boolean");
assert.ok(html.includes('<th class="col-date" data-column="joined_at" data-type="date">joined_at</th>'), "joined_at column header should be col-date");

// Verify Row index data cells
assert.ok(html.includes('<td class="row-index" title="Row 1">1</td>'), "Row 1 must have index 1");
assert.ok(html.includes('<td class="row-index" title="Row 2">2</td>'), "Row 2 must have index 2");

// Verify NULL badge
assert.ok(html.includes('<span class="null-badge">NULL</span>'), "Null notes should have null-badge");

// Verify Boolean badges
assert.ok(html.includes('<span class="bool-badge bool-true">true</span>'), "True boolean should have bool-true badge");
assert.ok(html.includes('<span class="bool-badge bool-false">false</span>'), "False boolean should have bool-false badge");

// Verify Number value span
assert.ok(html.includes('<span class="num-val">75000.5</span>'), "Numeric values should be wrapped in num-val");

// Verify Date value span
assert.ok(html.includes('<span class="date-val">2024-01-15T09:30:00Z</span>'), "Date values should be wrapped in date-val");

// Verify data attributes for editing
assert.ok(html.includes('data-column="username"'), "Data cells should have data-column");
assert.ok(html.includes('data-column-index="1"'), "Data cells should have data-column-index");
assert.ok(html.includes('data-row-index="0"'), "Data cells should have data-row-index");
assert.ok(html.includes('data-key="1"'), "Key cell should have data-key");
assert.ok(html.includes('contenteditable="true"'), "Editable cells should have contenteditable");

// 3. Test handleCellEdit logic with row-index ignored
console.log("Testing handleCellEdit...");
vm.runInContext(`
const mockTab = {
    id: "tab-1",
    currentResultData: {
        columns: ["id", "username", "salary", "is_admin", "joined_at", "notes"],
        rows: [
            { id: 1, username: "Alice", salary: 75000.50, is_admin: true, joined_at: "2024-01-15T09:30:00Z", notes: null },
            { id: 2, username: "Bob", salary: 54000.00, is_admin: false, joined_at: "2024-03-20T14:15:00Z", notes: "Contractor" }
        ]
    },
    pendingEdits: new Map()
};

// Simulate editing username on row 0 (Alice -> Alicia)
const mockCell = {
    classList: { contains: (c) => false },
    closest: (sel) => {
        if (sel === "tr") {
            return {
                rowIndex: 1,
                querySelector: (s) => s === "[data-key]" ? { dataset: { key: "1" } } : null
            };
        }
        if (sel === "table") {
            return {
                querySelectorAll: () => [
                    { textContent: "#" },
                    { textContent: "id" },
                    { textContent: "username" }
                ]
            };
        }
        return null;
    },
    dataset: {
        column: "username",
        columnIndex: "1",
        rowIndex: "0"
    },
    cellIndex: 2,
    textContent: "Alicia"
};

handleCellEdit(mockTab, { target: mockCell });
window.__pendingEditsCount = mockTab.pendingEdits.size;
window.__firstEdit = mockTab.pendingEdits.get("0:1");
`, context);

assert.equal(context.window.__pendingEditsCount, 1);
assert.equal(context.window.__firstEdit.column, "username");
assert.equal(context.window.__firstEdit.newValue, "Alicia");
assert.equal(context.window.__firstEdit.originalValue, "Alice");
assert.equal(context.window.__firstEdit.key_value, "1");

console.log("All Query Results alignment tests passed successfully!");
