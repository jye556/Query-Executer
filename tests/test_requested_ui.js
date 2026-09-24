const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const template = fs.readFileSync(path.join(root, "app/templates/index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "app/static/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "app/static/css/style.css"), "utf8");
const login = fs.readFileSync(path.join(root, "app/templates/login.html"), "utf8");

assert.match(template, /id="app-version-pill"[^>]*>v1\.0\.3<\/span>/);
assert.match(login, /style\.css\?v=v1\.0\.3/);
const controls = template.match(/<div class="header-controls">([\s\S]*?)<\/div>\s*<\/header>/)?.[1];
assert.ok(controls);
assert.doesNotMatch(controls, /status-indicator|Server Active|connection-status-text/);
assert.match(template, /id="btn-theme-toggle"[^>]*aria-label="Switch theme"/);
assert.equal((controls.match(/class="theme-icon-sun"/g) || []).length, 1);
assert.equal((controls.match(/class="theme-icon-moon"/g) || []).length, 1);
assert.equal((controls.match(/btn-theme-toggle/g) || []).length, 1);
assert.ok(controls.indexOf("btn-theme-toggle") < controls.indexOf("current-user-label"));
assert.ok(controls.indexOf("current-user-label") < controls.indexOf("btn-logout"));
assert.match(template, /<div class="app-container">/);
assert.match(template, /id="toast-container" class="toast-container"><\/div>\s*<\/div>\s*<\/body>/);
assert.match(template, /id="connections-search-input"/);
assert.match(script, /connectionsSearchInput = document\.getElementById\("connections-search-input"\)/);
assert.match(script, /function renderConnectionsList\(\)/);
assert.match(script, /connectionsSearchInput\?\.addEventListener\("input", renderConnectionsList\)/);
assert.match(script, /const searchTerm = \(connectionsSearchInput\?\.value \|\| ""\)/);
assert.match(css, /\.connection-search-input/);
assert.match(css, /\.app-header\s*\{[\s\S]*?justify-content:\s*space-between/);
assert.match(css, /\.auth-header-actions \{ display: flex; justify-content: flex-end/);

const loginStart = fs.readFileSync(path.join(root, "app/templates/login.html"), "utf8");
assert.match(loginStart, /if \(response\.status === 401 && body\.detail === 'Invalid authenticator code' && !needsTotp\)/);
assert.match(loginStart, /if \(needsTotp && !\/\^\[0-9\]\{6\}\$\/\.test\(totpInput\.value\.trim\(\)\)\)/);
assert.match(loginStart, /submit\.textContent = 'Verify and sign in';[\s\S]*?return;/);
assert.match(loginStart, /<div class="auth-header-actions">\s*<button type="button" id="btn-theme-toggle"/);
assert.match(loginStart, /document\.getElementById\('btn-theme-toggle'\)\?\.addEventListener\('click'/);
assert.match(loginStart, /applyTheme\(localStorage\.getItem\('qe-theme'\) \|\| 'dark'\)/);
assert.match(loginStart, /needsTotp = true/);

const start = script.indexOf("function renderConnectionsList()");
const end = script.indexOf("\nfunction showConnectionForm", start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);

class MockElement {
    constructor(tag = "div", textContent = "") {
        this.tag = tag;
        this.className = "";
        this.textContent = textContent;
        this.innerHTML = "";
        this.children = [];
        this.handlers = {};
        this.parent = null;
        this._classes = new Set();
        this.classList = { add: name => this._classes.add(name), remove: name => this._classes.delete(name), contains: name => this._classes.has(name) };
        this.dataset = {};
    }
    appendChild(child) { child.parent = this; this.children.push(child); }
    addEventListener(event, callback) { this.handlers[event] = callback; }
    querySelector(selector) {
        const action = selector.match(/data-action="([^"]+)"/)?.[1];
        if (!action) return null;
        return this.childrenByAction?.get(action) || this.children.find(child => child.dataset.action === action) || null;
    }
    set innerHTML(value) {
        this._html = value;
        this.children = [];
        this.childrenByAction = new Map();
        for (const match of value.matchAll(/<button[^>]*data-action="([^"]+)"[^>]*>([^<]*)<\/button>/g)) {
            const button = new MockElement("button", match[2]);
            button.dataset.action = match[1];
            this.childrenByAction.set(match[1], button);
        }
    }
    get innerHTML() { return this._html || ""; }
}
const rootElement = new MockElement();
const search = { value: "alpha", addEventListener(event, callback) { this.onInput = callback; } };
const list = { innerHTML: "", children: [], appendChild(child) { child.parent = this; this.children.push(child); } };
const groupsFilter = { value: "all" }, typeFilter = { value: "all" };
const context = {
    connectionsListContainer: list,
    connectionsGroupFilter: groupsFilter,
    connectionsDbTypeFilter: typeFilter,
    connectionsSearchInput: search,
    connections: [
        { id: "1", name: "Alpha backup", db_type: "postgresql", host: "db-prod", port: 5432, database: "archive", username: "app", has_password: false, groups: [], group_ids: [] },
        { id: "2", name: "Alpha production", db_type: "sqlite", host: "", port: null, database: "prod.db", username: "", has_password: false, groups: [], group_ids: [] },
        { id: "3", name: "Development", db_type: "sqlite", host: "", port: null, database: "dev.db", username: "", has_password: false, groups: [], group_ids: [] },
    ],
    groups: [], currentUser: { role: "viewer" },
    document: {
        createElement(tag) { return new MockElement(tag); },
        getElementById(id) { return id === "connections-list-container" ? list : null; },
        querySelector() { return null; },
    },
    escapeHtml: value => String(value),
    testConnection() {}, useConnection() {},
};
search.value = "db-prod";
vm.runInNewContext(`${script.slice(start, end)}\nrenderConnectionsList()`, context);
assert.match(list.children.map(child => child.textContent + child.innerHTML).join(" "), /Alpha backup/);
assert.doesNotMatch(list.children.map(child => child.textContent + child.innerHTML).join(" "), /Alpha production|Development/);
console.log("Header controls and connection search assertions passed");
