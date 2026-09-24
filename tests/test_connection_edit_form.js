const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../app/static/js/app.js"), "utf8");
const start = source.indexOf("function applyDatabaseDefaults(");
const end = source.indexOf("\nasync function fetchGroups()", start);
assert.notEqual(start, -1, "applyDatabaseDefaults exists");
assert.notEqual(end, -1, "fetchGroups follows applyDatabaseDefaults");

const elements = new Map();
for (const id of ["form-title", "btn-submit-connection", "conn-name", "conn-host", "conn-port", "conn-database", "conn-database-group", "conn-username", "conn-extra-params"]) {
    elements.set(id, { textContent: "", value: "", classList: { remove() {} } });
}
const form = { dataset: {}, reset() {} };
const groups = { options: [{ value: "8", selected: false }] };
const context = {
    currentUser: { role: "admin" },
    addConnectionFormContainer: { classList: { remove() {} } },
    addConnectionForm: form,
    connDbTypeSelect: { value: "" },
    connGroupSelect: groups,
    connPwdInput: { value: "", type: "password" },
    databases: [{
        type: "postgresql",
        defaults: { host: "localhost", port: 5432, database: "postgres", username: "postgres", extra_params: {} },
    }],
    document: { getElementById: id => elements.get(id) },
};
const connection = {
    id: "c1",
    name: "Production",
    db_type: "postgresql",
    host: "db.example.test",
    port: 5433,
    database: "production",
    username: "app_user",
    extra_params: { sslmode: "require" },
    group_ids: [8],
};
const defaults = source.slice(start, end);
vm.runInNewContext(defaults, context);
const formStart = source.indexOf("function showConnectionForm(");
const formEnd = source.indexOf("\nfunction connectionPayload()", formStart);
assert.notEqual(formStart, -1, "showConnectionForm exists");
assert.notEqual(formEnd, -1, "connectionPayload follows showConnectionForm");
vm.runInNewContext(`${source.slice(formStart, formEnd)}\nshowConnectionForm(connection);`, { ...context, connection });
assert.equal(elements.get("conn-host").value, connection.host);
assert.equal(String(elements.get("conn-port").value), String(connection.port));
assert.equal(elements.get("conn-database").value, connection.database);
assert.equal(elements.get("conn-username").value, connection.username);
assert.equal(elements.get("conn-name").value, connection.name);
console.log("Edit form preserves saved connection fields");
