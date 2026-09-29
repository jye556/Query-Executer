const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const indexHtml = fs.readFileSync(path.join(__dirname, "../app/templates/index.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "../app/static/js/app.js"), "utf8");

// Parse indexHtml to collect all element IDs
const idMatches = [...indexHtml.matchAll(/id="([^"]+)"/g)].map(m => m[1]);

class Element {
    constructor(tag = "div", id = "") {
        this.tagName = tag.toUpperCase();
        this.id = id;
        this.className = "";
        this._classList = new Set();
        this.classList = {
            add: (c) => this._classList.add(c),
            remove: (c) => this._classList.delete(c),
            contains: (c) => this._classList.has(c),
            toggle: (c, force) => {
                if (force === undefined) {
                    if (this._classList.has(c)) { this._classList.delete(c); return false; }
                    else { this._classList.add(c); return true; }
                }
                if (force) { this._classList.add(c); return true; }
                else { this._classList.delete(c); return false; }
            }
        };
        this.attributes = new Map();
        this.dataset = {};
        this.children = [];
        this.parentElement = null;
        this.innerHTML = "";
        this.textContent = "";
        this.value = "";
        this.style = {};
        this.disabled = false;
        this.checked = false;
        this.options = [];
        this.selectedOptions = [];
    }
    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }
    setAttribute(name, val) { this.attributes.set(name, String(val)); }
    getAttribute(name) { return this.attributes.get(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(event, fn) {}
    removeEventListener(event, fn) {}
    querySelector(sel) {
        if (sel.includes("data-action")) return new Element("button");
        return null;
    }
    querySelectorAll(sel) { return []; }
    focus() {}
    blur() {}
    reset() {}
}

const elementsById = new Map();
idMatches.forEach(id => {
    elementsById.set(id, new Element("div", id));
});

// Configure elements
elementsById.get("query-group-filter").value = "all";
elementsById.get("query-db-type-filter").value = "all";
elementsById.get("connections-group-filter").value = "all";
elementsById.get("connections-db-type-filter").value = "all";

const doc = {
    documentElement: new Element("html"),
    body: new Element("body"),
    getElementById: (id) => elementsById.get(id) || null,
    querySelectorAll: (sel) => {
        if (sel === ".app-view") return [elementsById.get("query-section"), elementsById.get("connections-section")].filter(Boolean);
        if (sel === ".sidebar-link") return [];
        if (sel === ".admin-only") return [];
        return [];
    },
    querySelector: (sel) => null,
    createElement: (tag) => new Element(tag),
    addEventListener(event, fn) {
        if (event === "DOMContentLoaded") {
            setTimeout(fn, 10);
        }
    }
};

const sandbox = {
    window: {},
    document: doc,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 12345, // stub interval to prevent node loop staying open
    clearInterval: () => {},
    URLSearchParams,
    innerWidth: 1200,
    addEventListener: () => {},
    Option: function(text, val) { return { text, value: val }; },
    showToast: (msg, type) => {},
    localStorage: {
        getItem: () => null,
        setItem: () => {}
    },
    fetch: async (url, opts) => {
        const headers = { get: (name) => name === "content-type" ? "application/json" : null };
        if (url === "/api/auth/me") {
            return { ok: true, status: 200, headers, json: async () => ({ user: { id: 7, username: "admin", role: "admin", totp_enabled: false } }) };
        }
        if (url === "/api/version") {
            return { ok: true, status: 200, headers, json: async () => ({ version: "1.1.1", latest_version: "v1.1.1", update_available: false, changelog: [] }) };
        }
        if (url.startsWith("/api/connections")) {
            return { ok: true, status: 200, headers, json: async () => [
                { id: "88624025", name: "Grouped Test", db_type: "firebird", host: "127.0.0.1", port: 3050, database: "/tmp/test.fdb", username: "SYSDBA", groups: [{ id: 2, name: "Remote Firebird" }], group_ids: [2], has_password: true },
                { id: "13082ef4", name: "KM MYRETAIL", db_type: "firebird", host: "192.168.1.3", port: 3050, database: "\\CustomerDB\\temp\\jye\\CS Grocer\\KM\\MYRETAIL.GDB", username: "SYSDBA", groups: [{ id: 1, name: "CS Grocer" }], group_ids: [1], has_password: true }
            ] };
        }
        if (url === "/api/databases") {
            return { ok: true, status: 200, headers, json: async () => [
                { type: "sqlite", name: "SQLite", available: true },
                { type: "firebird", name: "Firebird", available: true }
            ] };
        }
        if (url === "/api/groups") {
            return { ok: true, status: 200, headers, json: async () => [{ id: 1, name: "CS Grocer" }, { id: 2, name: "Remote Firebird" }] };
        }
        if (url === "/api/history") {
            return { ok: true, status: 200, headers, json: async () => [] };
        }
        if (url === "/api/users") {
            return { ok: true, status: 200, headers, json: async () => [{ id: 7, username: "admin", role: "admin", is_active: true, group_ids: [], totp_enabled: false }] };
        }
        return { ok: true, status: 200, headers, json: async () => ({}) };
    }
};
sandbox.window = sandbox;

vm.createContext(sandbox);

try {
    vm.runInContext(appJs, sandbox);
} catch (err) {
    console.error("app.js load error:", err);
    process.exit(1);
}

setTimeout(() => {
    try {
        assert.equal(sandbox.queryTabs?.length, 1, "queryTabs should have 1 default tab initialized");
        assert.equal(sandbox.activeTabId, "tab-1", "activeTabId should be 'tab-1'");
        assert.equal(sandbox.connections?.length, 2, "connections array should contain the 2 mock connections");
        
        const connList = elementsById.get("connections-list-container");
        assert.ok(connList.children.length >= 2, "connectionsListContainer should have grouped connection elements");
        
        const queryConnPanel = elementsById.get("connections-panel-list");
        assert.equal(queryConnPanel.children.length, 2, "connectionsPanelList should have 2 connection buttons for selection");
        
        const queryTabsEl = elementsById.get("query-tabs");
        assert.match(queryTabsEl.innerHTML, /data-tab-id="tab-1"/, "queryTabs should render tab-1 HTML button");

        console.log("Browser initialization and DOM rendering verified successfully!");
        process.exit(0);
    } catch (err) {
        console.error("Assertion failed:", err);
        process.exit(1);
    }
}, 100);
