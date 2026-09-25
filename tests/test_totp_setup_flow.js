const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
const script = fs.readFileSync(path.join(__dirname, "../app/static/js/app.js"), "utf8");
const start = script.indexOf("function setupEventListeners()");
const end = script.indexOf("\nasync function checkForUpdates()", start);
assert.notEqual(start, -1, "2FA handlers exist");
assert.notEqual(end, -1, "2FA handlers end before update checker");

const elements = new Map();
const eventHandlers = new Map();
const makeElement = id => ({
    id, value: "", textContent: "", disabled: false,
    dataset: {}, handlers: {},
    classList: { add(...names) { this.names = new Set([...(this.names || []), ...names]); }, remove(...names) { this.names = new Set([...(this.names || [])].filter(n => !names.includes(n))); } },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    querySelectorAll() { return []; },
    querySelector(selector) { return selector.includes("conn-username") ? { value: "" } : null; },
    reset() {}, showModal() {}, close() {}, focus() {}, checkValidity() { return /^\d{6}$/.test(elements.get("totp-step-two-code").value); },
});
for (const id of ["btn-confirm-totp-setup", "btn-copy-totp-secret", "totp-setup-form", "totp-step-one", "totp-step-two", "totp-step-two-code", "totp-setup-secret", "totp-setup-qr", "totp-setup-dialog", "btn-account-security", "btn-totp-back"]) elements.set(id, makeElement(id));
const cancel = makeElement("cancel");
const context = {
    document: {
        getElementById: id => elements.get(id) || null,
        querySelectorAll: selector => selector === "[data-cancel-totp-setup]" ? [cancel] : [],
        addEventListener() {},
    },
    window: { addEventListener() {} },
    navigator: {},
    currentUser: { totp_enabled: false },
    pendingTotpSetup: true,
    apiFetch: async (_url, options) => { eventHandlers.payload = JSON.parse(options.body); return {}; },
    showToast() {},
    localStorage: { getItem() { return "dark"; }, setItem() {} },
    applyTheme() {},
    sidebarToggle: { addEventListener() {}, setAttribute() {} }, sidebarClose: null, sidebar: { classList: { toggle() {}, add() {}, remove() {} } }, sidebarOverlay: { addEventListener() {}, classList: { remove() {}, add() {} } },
    sidebarLinks: [], btnShowAddConnection: null, btnCancelConnection: null,
    connGroupSelect: null, connNewGroupInput: null, queryGroupFilter: null, queryDbTypeFilter: null,
    queryDbSearch: null, connectionsGroupFilter: null, connectionsDbTypeFilter: null, connectionsSearchInput: null,
    connTogglePwdBtn: null, connPwdInput: { type: "password" }, addConnectionForm: null,
    connDbTypeSelect: null, btnExecuteQuery: null, queryEditor: null, btnExportCsv: null,
    btnClearHistory: null, addConnectionFormContainer: { classList: { add() {}, remove() {} } },
    currentUser: { totp_enabled: false, role: "viewer" },
    appViews: [], manageTotp() {}, logout() {}, toggleTheme() {}, saveConnection() {},
    testFormConnection() {}, executeQuery() {}, applyResultEdits() {}, revertResultEdits() {},
    formatSql() {}, exportResultsToCSV() {}, clearHistory() {}, showUserForm() {}, saveUserForm() {},
    showGroupForm() {}, saveGroupForm() {}, fetchHistory() {},
    btnNewQueryTab: null,
    queryTabsContainer: null,
    queryTabPanels: null,
};
vm.runInNewContext(`${script.slice(start, end)}\nsetupEventListeners()`, context);
const form = elements.get("totp-setup-form");
let prevented = false;
await form.handlers.submit({ preventDefault() { prevented = true; }, submitter: { dataset: { step: "1" } } });
assert.ok(prevented, "Step 1 suppresses native form submission");
assert.equal(elements.get("totp-step-one").classList.names.has("hidden"), true);
assert.equal(elements.get("totp-step-two").classList.names.has("hidden"), false);

let calls = 0;
context.apiFetch = async (_url, options) => { calls++; eventHandlers.payload = JSON.parse(options.body); return {}; };
elements.get("totp-step-two-code").value = "123";
await form.handlers.submit({ preventDefault() {}, submitter: { dataset: { step: "2" } } });
assert.equal(calls, 0, "Invalid code blocks verification request");
elements.get("totp-step-two-code").value = "123456";
await form.handlers.submit({ preventDefault() {}, submitter: { dataset: { step: "2" } } });
assert.equal(calls, 1, "Valid code sends verification request");
assert.deepEqual(eventHandlers.payload, { code: "123456" });
console.log("2FA step navigation and six-digit validation verified");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
