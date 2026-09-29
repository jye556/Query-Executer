const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "app/static/js/app.js"), "utf8");
const snippetsJs = fs.readFileSync(path.join(root, "app/static/js/snippets.js"), "utf8");
const sqlFormatterJs = fs.readFileSync(path.join(root, "app/static/js/sql-formatter.js"), "utf8");
const autocompleteJs = fs.readFileSync(path.join(root, "app/static/js/autocomplete.js"), "utf8");
const inlineEditingJs = fs.readFileSync(path.join(root, "app/static/js/inline-editing.js"), "utf8");

(async () => {
    // 1. Verify escapeHtml in app.js
    {
        const sandbox = { window: {}, document: {}, setTimeout, clearTimeout };
        vm.createContext(sandbox);
        const match = appJs.match(/function escapeHtml\(value\)[\s\S]*?\n\}/);
        assert.ok(match, "escapeHtml should exist in app.js");
        vm.runInContext(match[0], sandbox);
        
        const unescaped = '<script>alert("xss & \'test\'")</script>';
        const escaped = sandbox.escapeHtml(unescaped);
        assert.equal(escaped, '&lt;script&gt;alert(&quot;xss &amp; &#039;test&#039;&quot;)&lt;/script&gt;');
        assert.doesNotMatch(escaped, /<script>/);
    }

    // 2. Verify sql-formatter.js sync fallback and dialect detection
    {
        const sandbox = { window: {}, console, setTimeout, clearTimeout };
        vm.createContext(sandbox);
        vm.runInContext(sqlFormatterJs, sandbox);

        const dialect1 = sandbox.detectSqlDialect("SELECT id, name::text FROM users ILIKE '%test%'");
        assert.equal(dialect1, "postgresql");

        const dialect2 = sandbox.detectSqlDialect("SELECT id FROM users AUTO_INCREMENT LIMIT 0, 10");
        assert.equal(dialect2, "mysql");

        const dialect3 = sandbox.detectSqlDialect("PRAGMA table_info(users)");
        assert.equal(dialect3, "sqlite");

        const formatted = sandbox.formatSqlSync("select id, name from users where id = 1");
        assert.match(formatted, /SELECT/);
        assert.match(formatted, /FROM/);
        assert.match(formatted, /WHERE/);
    }

    // 3. Verify snippets.js loadSnippets handling of array responses and showSnippetForm
    {
        let fetchedUrl = null;
        const mockSnippets = [
            { id: "snip-1", name: "Select All", category: "General", sql: "SELECT * FROM users", is_favorite: true, is_shared: false, user_id: 1 }
        ];

        const elements = new Map();
        function getElement(id) {
            if (!elements.has(id)) {
                elements.set(id, {
                    id,
                    value: "",
                    textContent: "",
                    checked: false,
                    classList: { add: () => {}, remove: () => {} },
                    dataset: {},
                    reset: function() { this.value = ""; this.textContent = ""; this.checked = false; },
                    addEventListener: () => {}
                });
            }
            return elements.get(id);
        }

        const sandbox = {
            window: {},
            document: {
                getElementById: (id) => getElement(id),
                querySelector: () => null,
                querySelectorAll: () => []
            },
            apiFetch: async (url) => {
                fetchedUrl = url;
                return mockSnippets; // Returns array directly as FastAPI does
            },
            showToast: () => {},
            console,
            setTimeout,
            clearTimeout
        };
        sandbox.window = sandbox;

        vm.createContext(sandbox);
        vm.runInContext(snippetsJs, sandbox);

        // Test loadSnippets
        const loaded = await sandbox.loadSnippets();
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0].name, "Select All");

        // Test showSnippetForm with string ID
        sandbox.showSnippetForm("snip-1");
        assert.equal(getElement("snippet-form-container").dataset.editId, "snip-1");
        assert.equal(getElement("snippet-name").value, "Select All");
        assert.equal(getElement("snippet-sql").value, "SELECT * FROM users");
        assert.equal(getElement("snippet-favorite").checked, true);
        assert.equal(getElement("snippet-form-title").textContent, "Edit Snippet");

        // Test showSnippetForm with null for new snippet
        sandbox.showSnippetForm(null);
        assert.equal(getElement("snippet-form-container").dataset.editId, "");
        assert.equal(getElement("snippet-form-title").textContent, "New Snippet");
    }

    // 4. Verify autocomplete.js context analysis
    {
        const sandbox = { window: {}, document: {}, console, setTimeout, clearTimeout };
        sandbox.window = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(autocompleteJs, sandbox);

        const matchTable = autocompleteJs.match(/function analyzeSqlContext[\s\S]*?\n\}/);
        assert.ok(matchTable, "analyzeSqlContext should exist in autocomplete.js");
    }

    console.log("All editor and snippet enhancement unit tests passed successfully!");
})();
