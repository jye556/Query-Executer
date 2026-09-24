const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const template = fs.readFileSync(path.join(__dirname, "../app/templates/login.html"), "utf8");
const inlineScript = template.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, "login template must contain the login controller");
assert.match(template, /<form id="login-form"[^>]*method="post"/i, "login form must never put credentials in a GET query string");

function makeLogin(fetchImpl) {
    const handlers = {};
    const nodes = new Map();
    const makeNode = id => {
        const node = {
            id, value: "", textContent: "", disabled: false, required: false, hidden: true, focused: false,
            attributes: {},
            classList: { add(name) { node.hidden = name === "hidden" ? true : node.hidden; }, remove(name) { node.hidden = name === "hidden" ? false : node.hidden; } },
            addEventListener(name, callback) { handlers[`${id}:${name}`] = callback; },
            setAttribute(name, value) { node.attributes[name] = value; },
            focus() { node.focused = true; },
        };
        return node;
    };
    for (const id of ["login-form", "login-submit", "login-error", "login-totp-group", "login-totp", "login-username", "login-password", "btn-theme-toggle"])
        nodes.set(id, makeNode(id));
    nodes.get("login-form").addEventListener = (name, callback) => { handlers[`form:${name}`] = callback; };
    nodes.get("login-username").value = "alice";
    nodes.get("login-password").value = "password-value-for-test";
    const document = {
        documentElement: { dataset: {} },
        body: { classList: { toggle() {} } },
        getElementById(id) { return nodes.get(id) || null; },
    };
    const assigned = [];
    const context = {
        document,
        submit: nodes.get("login-submit"),
        error: nodes.get("login-error"),
        totpGroup: nodes.get("login-totp-group"),
        totpInput: nodes.get("login-totp"),
        window: { location: { search: "", assign(value) { assigned.push(value); } } },
        localStorage: { getItem() { return "dark"; }, setItem() {} },
        URLSearchParams,
        fetch: fetchImpl,
    };
    vm.runInNewContext(inlineScript, context);
    return { nodes, handlers, assigned };
}

(async () => {
    let calls = 0;
    const login = makeLogin(async () => {
        calls++;
        return { ok: false, status: 401, async json() { return { detail: "Invalid authenticator code" }; } };
    });
    const submit = login.handlers["form:submit"];
    assert.equal(typeof submit, "function", "login script must bind a submit handler to the form");
    const event = { preventDefault() {} };

    await submit(event);
    assert.equal(calls, 1, "password submission should discover that this account requires TOTP");
    assert.equal(login.nodes.get("login-totp-group").hidden, false);
    assert.equal(login.nodes.get("login-totp").required, true);
    assert.equal(login.nodes.get("login-error").hidden, true, "initial TOTP prompt should not say the code is invalid");
    assert.equal(login.nodes.get("login-submit").textContent, "Verify and sign in");

    await submit(event);
    assert.equal(calls, 1, "empty authenticator code must be rejected client-side");
    assert.equal(login.nodes.get("login-error").textContent, "Enter the 6-digit authenticator code to continue.");
    assert.equal(login.nodes.get("login-totp").focused, true);

    login.nodes.get("login-totp").value = "123456";
    await submit(event);
    assert.equal(calls, 2);
    assert.equal(login.nodes.get("login-error").textContent, "Invalid authenticator code", "only a rejected submitted code should show invalid-code feedback");

    const successful = makeLogin(async () => ({ ok: true, status: 200, async json() { return { user: { username: "alice" } }; } }));
    successful.nodes.get("login-totp").value = "123456";
    await successful.handlers["form:submit"](event);
    assert.deepEqual(successful.assigned, ["/"], "successful login should navigate to the app");
    console.log("Login TOTP prompt, empty-code validation, rejection, and success flow verified");
})().catch(error => { console.error(error); process.exitCode = 1; });
