"use strict";

/* Query Execute frontend. Normal queries and saved-connection tests use only
   server-issued connection IDs; the add-form test is the explicit exception
   and sends the unsaved form values for a one-shot admin check. */
let connections = [];
let databases = [];
let groups = [];
let users = [];
let currentUser = null;
let currentView = "query-section";
let editorContent = "";
let selectedConnectionIds = new Set();
let currentExportData = null;
let currentResultData = null;
let currentEditContext = null;
let pendingResultEdits = new Map();
let schemaMetadataCache = new Map();
let historyRefreshInterval = null;
let pendingTotpSetup = false;

let btnShowAddConnection, addConnectionFormContainer, addConnectionForm,
    btnCancelConnection, connTogglePwdBtn, connPwdInput, connectionsListContainer,
    queryLimitInput, connGroupSelect, connNewGroupInput, queryGroupFilter, queryDbTypeFilter, queryDbSearch,
    connectionsGroupFilter, connectionsDbTypeFilter, connDbTypeSelect, queryEditor, btnExecuteQuery, executeText, executeSpinner,
    resultsPlaceholder, tableScrollContainer, resultCount, executionTime, btnExportCsv,
    errorContainer, errorMessage, btnClearHistory, historyListContainer, toastContainer,
    sidebarToggle, sidebarClose, sidebar, appViews, sidebarLinks, connectionsPanelList,
    multiResultsContainer;

const csrfHeaders = () => {
    const token = getCookie("qe_csrf");
    return token ? { "X-CSRF-Token": token } : {};
};
function getCookie(name) {
    return document.cookie.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}
function setQueryCheck(message, state = "ready") {
    const status = document.getElementById("query-check-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
}
function updateQueryCheck() {
    const sql = queryEditor.value.trim();
    if (!sql) return setQueryCheck("Ready", "ready");
    const quotes = { "'": "'", '"': '"', "`": "`", "[": "]" };
    const stack = [];
    let quote = "", lineComment = false, blockComment = false;
    for (let i = 0; i < sql.length; i++) {
        const c = sql[i], next = sql[i + 1];
        if (lineComment) { if (c === "\n") lineComment = false; continue; }
        if (blockComment) { if (c === "*" && next === "/") { blockComment = false; i++; } continue; }
        if (quote) { if (c === quote && next === quote) { i++; continue; } if (c === quote) quote = ""; continue; }
        if (c === "-" && next === "-") { lineComment = true; i++; continue; }
        if (c === "/" && next === "*") { blockComment = true; i++; continue; }
        if (quotes[c]) { quote = quotes[c]; if (c !== "[") quote = c; else quote = "]"; continue; }
        if (c === "(" || c === "[") stack.push(c);
        if (c === ")" || c === "]") {
            const open = stack.pop();
            if (!open || (open === "(" && c !== ")") || (open === "[" && c !== "]")) return setQueryCheck("Error: unmatched closing delimiter", "error");
        }
    }
    if (quote || blockComment || stack.length) return setQueryCheck("Error: incomplete quote, comment, or parenthesis", "error");
    const visible = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[(?:[^\]]|\]\])*(?:\]|$)/g, "''");
    const semicolons = (visible.match(/;/g) || []).length;
    if (semicolons > 1 || /;\s*\S/.test(visible)) return setQueryCheck("Error: run one SQL statement at a time", "error");
    if (selectedConnectionIds.size === 1) {
        const selection = queryEditor.value.slice(queryEditor.selectionStart, queryEditor.selectionEnd).trim();
        const checkSql = selection || sql;
        const selected = selectedConnectionIds.values().next().value;
        apiFetch("/api/query/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connection_id: selected, query: checkSql }) })
            .then(result => { if (queryEditor.value.trim() === sql && (queryEditor.value.slice(queryEditor.selectionStart, queryEditor.selectionEnd).trim() || sql) === checkSql) setQueryCheck(result.valid ? "Query syntax is valid" : `Error: ${result.error}`, result.valid ? "valid" : "error"); })
            .catch(() => { if (queryEditor.value.trim() === sql) setQueryCheck("Syntax could not be checked; execution will still validate", "ready"); });
        return;
    }
    setQueryCheck("Syntax structure looks balanced; select one connection for a syntax check", "valid");
}
function hideQuerySuggestions() {
    document.getElementById("query-suggestions")?.classList.add("hidden");
}
function updateQuerySuggestions() {
    const popup = document.getElementById("query-suggestions");
    if (!popup || selectedConnectionIds.size !== 1) return hideQuerySuggestions();
    const before = queryEditor.value.slice(0, queryEditor.selectionStart);
    const fromMatch = before.match(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([\w$]*)$/i);
    const simpleContext = before.match(/\b(?:FROM|JOIN)\s+([A-Za-z_][\w$]*)\b([\s\S]*)$/i);
    const dotColumnMatch = before.match(/\b(?:WHERE|ON|AND|OR|BY|SET|SELECT|,)\s*([\w$]+)\.([\w$]*)$/i);
    const word = before.match(/[A-Za-z_][A-Za-z0-9_$]*$/)?.[0] || "";
    const tables = Array.from(schemaMetadataCache.values()).flatMap(item => item.tables || []);
    const existing = new Set(before.match(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([\w$]+)/gi)?.map(token => token.split(/\s+/).pop().toLowerCase()) || []);
    let suggestions = [];
    if (fromMatch) {
        const prefix = fromMatch[1];
        suggestions = tables.map(item => item.name).filter(name => (!prefix || name.toLowerCase().startsWith(prefix.toLowerCase())) && !existing.has(name.toLowerCase()));
    } else if (dotColumnMatch) {
        const tableName = dotColumnMatch[1].toLowerCase();
        const matched = tables.filter(item => item.name.toLowerCase() === tableName || item.name.toLowerCase().endsWith(`.${tableName}`));
        suggestions = matched.flatMap(item => item.columns).filter(name => !dotColumnMatch[2] || name.toLowerCase().startsWith(dotColumnMatch[2].toLowerCase()));
    } else if (simpleContext && /(?:\b(?:WHERE|ON|AND|OR|BY|SET|SELECT)\s+|,\s*)[\w$]*$/i.test(simpleContext[2])) {
        const tableName = simpleContext[1].toLowerCase();
        const matched = tables.find(item => item.name.toLowerCase() === tableName || item.name.toLowerCase().endsWith(`.${tableName}`));
        suggestions = (matched?.columns || []).filter(name => !word || name.toLowerCase().startsWith(word.toLowerCase()));
    } else if (/\bSELECT\s+[\w$]*$/i.test(before)) {
        const seen = new Set(before.match(/\b(?:FROM|JOIN)\s+([\w$]+)/gi)?.map(token => token.split(/\s+/).pop().toLowerCase()) || []);
        suggestions = tables.filter(item => seen.has(item.name.toLowerCase())).flatMap(item => item.columns).filter(name => !word || name.toLowerCase().startsWith(word.toLowerCase()));
    }
    suggestions = [...new Set(suggestions)].slice(0, 8);
    if (!suggestions.length) return hideQuerySuggestions();
    popup.innerHTML = suggestions.map(value => `<button type="button" role="option" data-suggestion="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join("");
    popup.classList.remove("hidden");
}
function insertSuggestion(value) {
    const start = queryEditor.selectionStart, end = queryEditor.selectionEnd;
    const before = queryEditor.value.slice(0, start), after = queryEditor.value.slice(end);
    const tokenStart = before.search(/[A-Za-z_][A-Za-z0-9_$]*$/);
    queryEditor.value = `${before.slice(0, tokenStart < 0 ? before.length : tokenStart)}${value}${after}`;
    const cursor = queryEditor.value.length - after.length;
    queryEditor.setSelectionRange(cursor, cursor);
    queryEditor.focus(); saveEditorState(); updateQueryCheck(); hideQuerySuggestions();
}
async function ensureSchemaMetadata(connectionId) {
    if (schemaMetadataCache.has(connectionId)) return;
    try { schemaMetadataCache.set(connectionId, await apiFetch(`/api/connections/${connectionId}/schema`)); }
    catch (_) { schemaMetadataCache.set(connectionId, { tables: [] }); }
}

function escapeHtml(value) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return String(value ?? "").replace(/[&<>"']/g, char => map[char]);
}

async function apiFetch(url, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) Object.assign(headers, csrfHeaders());
    const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
    if (response.status === 401) {
        const next = `${window.location.pathname}${window.location.search}`;
        if (!window.location.pathname.endsWith("/login.html")) {
            window.location.assign(`/login.html?next=${encodeURIComponent(next)}`);
        }
        throw new Error("Authentication required");
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
    return body;
}

function cacheDOMElements() {
    btnShowAddConnection = document.getElementById("btn-show-add-connection");
    addConnectionFormContainer = document.getElementById("add-connection-form-container");
    addConnectionForm = document.getElementById("add-connection-form");
    btnCancelConnection = document.getElementById("btn-cancel-connection");
    connTogglePwdBtn = document.getElementById("conn-toggle-pwd-btn");
    connPwdInput = document.getElementById("conn-password");
    connectionsListContainer = document.getElementById("connections-list-container");
    queryLimitInput = document.getElementById("query-limit");
    connGroupSelect = document.getElementById("conn-group");
    connNewGroupInput = document.getElementById("conn-new-group");
    queryGroupFilter = document.getElementById("query-group-filter");
    queryDbTypeFilter = document.getElementById("query-db-type-filter");
    queryDbSearch = document.getElementById("query-db-search");
    connectionsGroupFilter = document.getElementById("connections-group-filter");
    connectionsDbTypeFilter = document.getElementById("connections-db-type-filter");
    connDbTypeSelect = document.getElementById("conn-db-type");
    queryEditor = document.getElementById("query-editor");
    btnExecuteQuery = document.getElementById("btn-execute-query");
    executeText = document.getElementById("btn-execute-text");
    executeSpinner = document.getElementById("execute-spinner");
    resultsPlaceholder = document.getElementById("results-placeholder");
    tableScrollContainer = document.getElementById("results-container");
    resultCount = document.getElementById("result-count");
    executionTime = document.getElementById("execution-time");
    btnExportCsv = document.getElementById("btn-export-csv");
    errorContainer = document.getElementById("error-container");
    errorMessage = document.getElementById("error-message");
    btnClearHistory = document.getElementById("btn-clear-history");
    historyListContainer = document.getElementById("history-list-container");
    toastContainer = document.getElementById("toast-container");
    sidebarToggle = document.getElementById("sidebar-toggle");
    sidebarClose = document.getElementById("sidebar-close");
    sidebar = document.getElementById("sidebar");
    appViews = document.querySelectorAll(".app-view");
    sidebarLinks = document.querySelectorAll(".sidebar-link");
    connectionsPanelList = document.getElementById("connections-panel-list");
    multiResultsContainer = document.getElementById("multi-results-container");
}

async function fetchVersionData() {
    try {
        const response = await fetch("/api/version", { credentials: "same-origin" });
        if (!response.ok) return null;
        return await response.json();
    } catch (_) {
        return null;
    }
}

async function initialize() {
    cacheDOMElements();
    setupSidebarVisibility();
    setupEventListeners();
    try {
        const me = await apiFetch("/api/auth/me");
        currentUser = me.user;
        const label = document.getElementById("current-user-label");
        if (label) label.textContent = `${currentUser.username} · ${currentUser.role}`;
        document.querySelectorAll(".admin-only").forEach(node => node.classList.toggle("hidden", currentUser.role !== "admin"));
        const totpButton = document.getElementById("btn-account-security");
        if (totpButton) totpButton.textContent = currentUser.totp_enabled ? "Disable authenticator 2FA" : "Enable authenticator 2FA";
        await checkForUpdates();
        if (!queryEditor.value.trim()) setQueryCheck("Ready", "ready");
        else setQueryCheck("Syntax structure looks balanced; database will verify SQL", "valid");
        await Promise.all([fetchDatabases(), fetchGroups(), fetchConnections(), fetchHistory()]);
        if (currentUser.role === "admin") await Promise.all([fetchUsers(), renderGroupsAdmin()]);
        loadEditorState();
        updateQueryCheck();
        if (selectedConnectionIds.size) await Promise.all(Array.from(selectedConnectionIds).map(ensureSchemaMetadata)).then(updateQuerySuggestions);
        historyRefreshInterval = setInterval(() => { if (currentView === "history-section") fetchHistory(); }, 10000);
    } catch (error) {
        if (!error.message.includes("Authentication required")) showToast(error.message, "error");
    }
}

document.addEventListener("DOMContentLoaded", initialize);

function setupSidebarVisibility() {
    if (!sidebar) return;
    sidebar.classList.toggle("hidden", window.innerWidth <= 768);
}
window.addEventListener("resize", setupSidebarVisibility);

function setupEventListeners() {
    const confirmTotp = document.getElementById("btn-confirm-totp-setup");
    const copyTotp = document.getElementById("btn-copy-totp-secret");
    const cancelTotpButtons = document.querySelectorAll("[data-cancel-totp-setup]");
    const totpSetupForm = document.getElementById("totp-setup-form");
    const totpStepOne = document.getElementById("totp-step-one");
    const totpStepTwo = document.getElementById("totp-step-two");
    const totpSetupSecret = document.getElementById("totp-setup-secret");
    const totpSetupQr = document.getElementById("totp-setup-qr");
    const fallbackCopy = () => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(totpSetupSecret);
        selection.removeAllRanges();
        selection.addRange(range);
        try {
            if (document.execCommand("copy")) showToast("Authenticator key copied", "success");
            else showToast("Select the setup key and copy it", "error");
        } catch (_) { showToast("Select the setup key and copy it", "error"); }
        selection.removeAllRanges();
    };
    copyTotp?.addEventListener("click", async () => {
        try {
            if (!navigator.clipboard?.writeText) return fallbackCopy();
            await navigator.clipboard.writeText(totpSetupSecret.textContent);
            showToast("Authenticator key copied", "success");
        } catch (_) { fallbackCopy(); }
    });
    totpStepTwo?.querySelectorAll("input, button").forEach(element => { element.disabled = true; });
    cancelTotpButtons.forEach(button => button.addEventListener("click", () => {
        pendingTotpSetup = false;
        totpStepOne?.classList.remove("hidden");
        totpStepTwo?.classList.add("hidden");
        totpStepTwo?.querySelectorAll("input, button").forEach(element => { element.disabled = true; });
        document.getElementById("totp-setup-form")?.reset();
        document.getElementById("totp-setup-dialog")?.close();
    }));
    document.getElementById("btn-totp-back")?.addEventListener("click", () => {
        totpStepOne?.classList.remove("hidden");
        totpStepTwo?.classList.add("hidden");
        totpStepTwo?.querySelectorAll("input, button").forEach(element => { element.disabled = true; });
        document.getElementById("btn-copy-totp-secret")?.focus();
    });
    totpSetupForm?.addEventListener("submit", async event => {
        const step = event.submitter?.dataset.step || "1";
        if (!pendingTotpSetup) {
            event.preventDefault();
            return;
        }
        if (step === "1") {
            event.preventDefault();
            totpStepOne?.classList.add("hidden");
            totpStepTwo?.classList.remove("hidden");
            totpStepTwo?.querySelectorAll("input, button").forEach(element => { element.disabled = false; });
            const verifyTotp = document.getElementById("totp-step-two-code");
            verifyTotp.value = "";
            verifyTotp.focus();
            return;
        }
        const verifyTotp = document.getElementById("totp-step-two-code");
        event.preventDefault();
        if (!totpSetupForm.checkValidity()) return;
        confirmTotp.disabled = true;
        try {
            await apiFetch("/api/auth/totp/enable", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: verifyTotp.value.trim() }),
            });
            pendingTotpSetup = false;
            totpSetupForm.reset();
            totpStepOne?.classList.remove("hidden");
            totpStepTwo?.classList.add("hidden");
            totpStepTwo?.querySelectorAll("input, button").forEach(element => { element.disabled = true; });
            document.getElementById("totp-setup-dialog").close();
            showToast("Authenticator-app 2FA enabled", "success");
            currentUser.totp_enabled = true;
            document.getElementById("btn-account-security").textContent = "Disable authenticator 2FA";
        } catch (error) {
            showToast(error.message, "error");
        } finally {
            confirmTotp.disabled = false;
        }
    });

    const settingsTabs = document.querySelectorAll("[data-settings-tab]");
    settingsTabs.forEach(tab => tab.addEventListener("click", () => {
        settingsTabs.forEach(item => item.classList.toggle("active", item === tab));
        document.querySelectorAll(".settings-tab-panel").forEach(panel => panel.classList.toggle("hidden", panel.id !== tab.dataset.settingsTab));
    }));
    document.getElementById("btn-apply-update")?.addEventListener("click", event => {
        event.currentTarget.href = event.currentTarget.dataset.releaseUrl || "#";
    });
    sidebarToggle?.addEventListener("click", () => sidebar.classList.toggle("hidden"));
    sidebarClose?.addEventListener("click", () => sidebar.classList.add("hidden"));
    sidebarLinks.forEach(link => link.addEventListener("click", event => {
        event.preventDefault();
        switchView(link.dataset.view);
        sidebarLinks.forEach(item => item.classList.remove("active"));
        link.classList.add("active");
    }));
    document.getElementById("btn-logout")?.addEventListener("click", logout);
    document.getElementById("btn-account-security")?.addEventListener("click", manageTotp);
    document.getElementById("btn-theme-toggle")?.addEventListener("click", toggleTheme);
    applyTheme(localStorage.getItem("qe-theme") || "dark");
    btnShowAddConnection?.addEventListener("click", () => showConnectionForm());
    btnCancelConnection?.addEventListener("click", () => addConnectionFormContainer.classList.add("hidden"));
    connGroupSelect?.addEventListener("change", () => {
        const selected = Array.from(connGroupSelect.selectedOptions).map(option => option.value);
        connNewGroupInput.classList.toggle("hidden", !selected.includes("__new__"));
        if (!selected.includes("__new__")) connNewGroupInput.value = "";
    });
    queryGroupFilter?.addEventListener("change", () => { renderQueryConnectionPanel(); fetchConnections(); });
    queryDbTypeFilter?.addEventListener("change", () => { renderQueryConnectionPanel(); fetchConnections(); });
    queryDbSearch?.addEventListener("input", renderQueryConnectionPanel);
    connectionsGroupFilter?.addEventListener("change", () => { renderConnectionsList(); fetchConnections(); });
    connectionsDbTypeFilter?.addEventListener("change", () => { renderConnectionsList(); fetchConnections(); });
    connTogglePwdBtn?.addEventListener("click", () => { connPwdInput.type = connPwdInput.type === "password" ? "text" : "password"; });
    addConnectionForm?.addEventListener("submit", saveConnection);
    document.getElementById("btn-form-test-conn")?.addEventListener("click", testFormConnection);
    connDbTypeSelect?.addEventListener("change", () => applyDatabaseDefaults(connDbTypeSelect.value));
    btnExecuteQuery?.addEventListener("click", executeQuery);
    queryEditor?.addEventListener("keydown", event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); executeQuery(); }
        if (event.key === "Escape") hideQuerySuggestions();
        if (event.key === "Tab" && !event.shiftKey && !document.getElementById("query-suggestions")?.classList.contains("hidden")) {
            const option = document.querySelector("#query-suggestions [data-suggestion]");
            if (option) { event.preventDefault(); insertSuggestion(option.dataset.suggestion); }
        }
    });
    queryEditor?.addEventListener("input", saveEditorState);
    queryEditor?.addEventListener("input", () => { updateQueryCheck(); updateQuerySuggestions(); });
    queryEditor?.addEventListener("click", updateQuerySuggestions);
    queryEditor?.addEventListener("keyup", updateQuerySuggestions);
    queryEditor?.addEventListener("select", updateQuerySuggestions);
    document.getElementById("query-suggestions")?.addEventListener("mousedown", event => {
        const option = event.target.closest("[data-suggestion]");
        if (!option) return;
        event.preventDefault(); insertSuggestion(option.dataset.suggestion);
    });
    document.getElementById("btn-apply-result-edits")?.addEventListener("click", applyResultEdits);
    document.getElementById("btn-revert-result-edits")?.addEventListener("click", revertResultEdits);
    document.getElementById("btn-clear-editor")?.addEventListener("click", () => { queryEditor.value = ""; saveEditorState(); });
    document.getElementById("btn-format-sql")?.addEventListener("click", formatSql);
    btnExportCsv?.addEventListener("click", exportResultsToCSV);
    btnClearHistory?.addEventListener("click", clearHistory);
    queryEditor?.addEventListener("input", saveEditorState);
    document.getElementById("btn-show-users")?.addEventListener("click", () => switchView("users-section"));
    document.getElementById("btn-show-groups")?.addEventListener("click", () => switchView("groups-section"));
    document.getElementById("btn-logout")?.setAttribute("aria-label", "Log out of Query Execute");
    document.getElementById("btn-add-user")?.addEventListener("click", () => showUserForm());
    document.getElementById("btn-cancel-user")?.addEventListener("click", () => document.getElementById("admin-user-form").classList.add("hidden"));
    document.getElementById("admin-user-form")?.addEventListener("submit", saveUserForm);
    document.getElementById("btn-add-group")?.addEventListener("click", () => showGroupForm());
    document.getElementById("btn-cancel-group")?.addEventListener("click", () => document.getElementById("admin-group-form").classList.add("hidden"));
    document.getElementById("admin-group-form")?.addEventListener("submit", saveGroupForm);
}

async function checkForUpdates() {
    const status = document.getElementById("update-status");
    const pageUpdate = document.getElementById("version-update-banner");
    const pageMessage = document.getElementById("version-update-message");
    const pageLink = document.getElementById("version-update-link");
    if (!status && !pageUpdate) return;
    const update = await fetchVersionData();
    if (!update) {
        if (status) status.textContent = "Unable to check for updates right now.";
        if (pageUpdate) pageUpdate.classList.add("hidden");
        return;
    }
    const current = update.version.startsWith("v") ? update.version : `v${update.version}`;
    const badge = document.getElementById("app-version-pill");
    const currentVersion = document.getElementById("current-app-version");
    if (currentVersion) currentVersion.textContent = current;
    if (badge) badge.textContent = current;
    const latestVersion = update.latest_version.startsWith("v") ? update.latest_version : `v${update.latest_version}`;
    const message = update.update_available ? `Version ${latestVersion} is available.` : "";
    if (status) status.textContent = update.update_available ? `New version ${latestVersion} is available.` : `You're up to date (${current}).`;
    const updateLink = document.getElementById("btn-apply-update");
    if (updateLink) {
        updateLink.href = update.release_url;
        updateLink.dataset.releaseUrl = update.release_url;
        updateLink.classList.toggle("hidden", !update.update_available);
    }
    if (pageUpdate && pageMessage && pageLink) {
        pageMessage.textContent = message;
        pageLink.href = update.release_url;
        pageUpdate.classList.toggle("hidden", !update.update_available);
    }
    const log = document.getElementById("release-log");
    if (log) log.innerHTML = update.changelog.map(release => `<li><strong>v${escapeHtml(release.version.replace(/^v/, ""))}</strong> — ${escapeHtml((release.notes || []).join("; "))}</li>`).join("");
}

function applyTheme(theme) {
    const value = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = value;
    document.body.classList.toggle("light-theme", value === "light");
    document.body.classList.toggle("dark-theme", value === "dark");
    const button = document.getElementById("btn-theme-toggle");
    if (button) { button.textContent = value === "dark" ? "Light mode" : "Dark mode"; button.setAttribute("aria-label", `Switch to ${value === "dark" ? "light" : "dark"} theme`); }
    try { localStorage.setItem("qe-theme", value); } catch (_) {}
}
function toggleTheme() { applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); }

async function manageTotp() {
    if (!currentUser?.totp_enabled) {
        try {
            const setup = await apiFetch("/api/auth/totp/setup", { method: "POST" });
            document.getElementById("totp-setup-secret").textContent = setup.secret;
            const image = document.getElementById("totp-setup-qr");
            image.setAttribute("shape-rendering", "crispEdges");
            image.setAttribute("preserveAspectRatio", "xMidYMid meet");
            image.src = setup.qr_code_data_url;
            document.getElementById("totp-step-two-code").value = "";
            totpSetupForm?.reset();
            pendingTotpSetup = true;
            totpStepOne?.classList.remove("hidden");
            totpStepTwo?.classList.add("hidden");
            totpStepTwo?.querySelectorAll("input, button").forEach(element => { element.disabled = true; });
            document.getElementById("totp-setup-dialog").showModal();
            document.getElementById("btn-copy-totp-secret").focus();
        } catch (error) { showToast(error.message, "error"); }
        return;
    }
    const code = prompt("Enter your current authenticator code to disable two-factor authentication:");
    if (code === null) return;
    try {
        await apiFetch("/api/auth/totp/disable", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: code.trim() }),
        });
        showToast("Authenticator verification disabled", "success");
        currentUser.totp_enabled = false;
        document.getElementById("btn-account-security").textContent = "Enable authenticator 2FA";
    } catch (error) { showToast(error.message, "error"); }
}

async function logout() {
    try { await apiFetch("/api/auth/logout", { method: "POST" }); } catch (_) {}
    window.location.assign("/login.html");
}
function switchView(viewId) {
    appViews.forEach(view => view.classList.toggle("hidden", view.id !== viewId));
    currentView = viewId;
    if (window.innerWidth <= 768) sidebar.classList.add("hidden");
    if (viewId === "history-section") fetchHistory();
    if (viewId === "users-section" && currentUser?.role === "admin") fetchUsers();
    if (viewId === "groups-section" && currentUser?.role === "admin") renderGroupsAdmin();
    if (viewId === "settings-section") checkForUpdates();
    if (viewId === "connections-section") fetchConnections();
    if (viewId === "query-section") fetchConnections();
}

async function fetchDatabases() {
    databases = await apiFetch("/api/databases");
    connDbTypeSelect.innerHTML = '<option value="">-- Select Type --</option>';
    databases.forEach(db => {
        const option = document.createElement("option");
        option.value = db.type; option.textContent = `${db.name}${db.available ? "" : " (driver not installed)"}`; option.disabled = !db.available;
        connDbTypeSelect.appendChild(option);
    });
    if (databases.some(db => db.available)) {
        connDbTypeSelect.value = databases.find(db => db.available).type;
        applyDatabaseDefaults(connDbTypeSelect.value);
    }
    const current = queryDbTypeFilter.value || "all";
    queryDbTypeFilter.innerHTML = '<option value="all">All Types</option>';
    databases.forEach(db => { const option = document.createElement("option"); option.value = db.type; option.textContent = db.name; queryDbTypeFilter.appendChild(option); });
    queryDbTypeFilter.value = [...queryDbTypeFilter.options].some(option => option.value === current) ? current : "all";
    if (connectionsDbTypeFilter) {
        const listValue = connectionsDbTypeFilter.value || "all";
        connectionsDbTypeFilter.innerHTML = '<option value="all">All Types</option>';
        databases.forEach(db => connectionsDbTypeFilter.appendChild(new Option(db.name, db.type)));
        connectionsDbTypeFilter.value = [...connectionsDbTypeFilter.options].some(option => option.value === listValue) ? listValue : "all";
    }
}
function applyDatabaseDefaults(dbType) {
    const database = databases.find(item => item.type === dbType);
    if (!database?.defaults) return;
    const defaults = database.defaults;
    document.getElementById("conn-host").value = defaults.host ?? "";
    document.getElementById("conn-port").value = defaults.port ?? "";
    document.getElementById("conn-database").value = defaults.database ?? "";
    document.getElementById("conn-username").value = defaults.username ?? "";
    document.getElementById("conn-extra-params").value = JSON.stringify(defaults.extra_params || {}, null, 2);
    const dialectPlaceholder = dbType === "sqlite" ? "Path to .db file or :memory:" : "Database name / server path";
    document.getElementById("conn-database").placeholder = dialectPlaceholder;
    document.getElementById("conn-database-group").classList.remove("hidden");
    connPwdInput.value = "";
}
async function fetchGroups() { groups = await apiFetch("/api/groups"); populateGroupControls(); }
async function fetchConnections() {
    // Keep each view's filters independent while ensuring the authorization
    // boundary is always enforced by the server-side query.
    const params = new URLSearchParams();
    const activeGroup = currentView === "connections-section" ? connectionsGroupFilter?.value : queryGroupFilter?.value;
    const activeType = currentView === "connections-section" ? connectionsDbTypeFilter?.value : queryDbTypeFilter?.value;
    if (activeGroup && activeGroup !== "all" && activeGroup !== "ungrouped") params.set("group_id", activeGroup);
    if (activeGroup === "ungrouped") params.set("group", "ungrouped");
    if (activeType && activeType !== "all") params.set("db_type", activeType);
    connections = await apiFetch(`/api/connections${params.toString() ? `?${params}` : ""}`);
    renderConnectionsList();
    renderQueryConnectionPanel();
    populateGroupControls();
}
function populateGroupControls() {
    const currentFilter = queryGroupFilter?.value || "all";
    const selected = new Set(Array.from(connGroupSelect?.selectedOptions || []).map(option => Number(option.value)));
    if (connGroupSelect) {
        connGroupSelect.innerHTML = "";
        groups.forEach(group => { const option = new Option(group.name, group.id); option.selected = selected.has(group.id); connGroupSelect.appendChild(option); });
    }
    if (queryGroupFilter) {
        queryGroupFilter.innerHTML = '<option value="all">All Groups</option><option value="ungrouped">Ungrouped</option>';
        groups.forEach(group => queryGroupFilter.appendChild(new Option(group.name, group.id)));
        queryGroupFilter.value = [...queryGroupFilter.options].some(option => option.value === currentFilter) ? currentFilter : "all";
    }
    if (connectionsGroupFilter) {
        const listValue = connectionsGroupFilter.value || "all";
        connectionsGroupFilter.innerHTML = '<option value="all">All Groups</option><option value="ungrouped">Ungrouped</option>';
        groups.forEach(group => connectionsGroupFilter.appendChild(new Option(group.name, group.id)));
        connectionsGroupFilter.value = [...connectionsGroupFilter.options].some(option => option.value === listValue) ? listValue : "all";
    }
}
function visibleConnections() {
    const group = queryGroupFilter?.value || "all", type = queryDbTypeFilter?.value || "all";
    const search = (queryDbSearch?.value || "").trim().toLocaleLowerCase();
    return connections.filter(connection => {
        const groupMatch = group === "all" || (group === "ungrouped" ? !connection.group_ids.length : connection.group_ids.includes(Number(group)));
        const typeMatch = type === "all" || connection.db_type === type;
        const databaseName = String(connection.database || "").toLocaleLowerCase();
        return groupMatch && typeMatch && (!search || databaseName.includes(search));
    });
}
async function renderQueryConnectionPanel() {
    if (!connectionsPanelList) return;
    connectionsPanelList.innerHTML = "";
    const items = visibleConnections();
    selectedConnectionIds.forEach(id => { if (!connections.some(connection => connection.id === id)) selectedConnectionIds.delete(id); });
    if (!items.length) { connectionsPanelList.innerHTML = '<p class="panel-empty">No authorized connections match these filters.</p>'; return; }
    if (items.length === 1 && selectedConnectionIds.size === 0) {
        selectedConnectionIds.add(items[0].id);
        await ensureSchemaMetadata(items[0].id);
    }
    if (selectedConnectionIds.size === 1) await ensureSchemaMetadata(Array.from(selectedConnectionIds)[0]);
    items.forEach(connection => {
        const item = document.createElement("button"); item.type = "button"; item.className = `connection-panel-item${selectedConnectionIds.has(connection.id) ? " selected" : ""}`;
        item.innerHTML = `<span class="connection-panel-info"><span class="connection-panel-name">${escapeHtml(connection.name)}</span></span><span class="connection-panel-check">${selectedConnectionIds.has(connection.id) ? "✓" : ""}</span>`;
        item.addEventListener("click", () => {
            selectedConnectionIds.has(connection.id) ? selectedConnectionIds.delete(connection.id) : selectedConnectionIds.add(connection.id);
            renderQueryConnectionPanel(); updateQuerySuggestions();
        });
        connectionsPanelList.appendChild(item);
    });
    updateQuerySuggestions();
}
function renderConnectionsList() {
    connectionsListContainer.innerHTML = "";
    const groupFilter = connectionsGroupFilter?.value || "all";
    const dbTypeFilter = connectionsDbTypeFilter?.value || "all";
    const visible = connections.filter(connection => {
        const groupMatch = groupFilter === "all" || (groupFilter === "ungrouped" ? !connection.group_ids.length : connection.group_ids.includes(Number(groupFilter)));
        return groupMatch && (dbTypeFilter === "all" || connection.db_type === dbTypeFilter);
    });
    if (!visible.length) { connectionsListContainer.innerHTML = '<div class="empty-state"><p>No authorized connections match the current filters.</p></div>'; return; }
    const byGroup = new Map();
    visible.forEach(connection => {
        const assignedGroups = groupFilter !== "all" && groupFilter !== "ungrouped"
            ? groups.filter(group => group.id === Number(groupFilter))
            : connection.groups;
        const groupNames = assignedGroups?.length ? assignedGroups.map(group => group.name) : ["Ungrouped"];
        groupNames.forEach(name => {
            if (!byGroup.has(name)) byGroup.set(name, []);
            byGroup.get(name).push(connection);
        });
    });
    for (const [groupName, items] of byGroup) {
        const heading = document.createElement("h3");
        heading.className = "connection-group-heading";
        heading.textContent = `${groupName} (${items.length})`;
        connectionsListContainer.appendChild(heading);
        items.forEach(connection => {
            const card = document.createElement("div"); card.className = "connection-card";
            const assignedGroups = groupFilter !== "all" && groupFilter !== "ungrouped"
                ? groups.filter(group => group.id === Number(groupFilter))
                : connection.groups;
            const groupLabels = assignedGroups.map(group => `<span class="connection-group-badge">${escapeHtml(group.name)}</span>`).join("");
            card.innerHTML = `<div class="connection-header"><h4>${escapeHtml(connection.name)}</h4><span class="db-type-badge">${escapeHtml(connection.db_type)}</span>${groupLabels}</div><div class="connection-details"><p><strong>Host:</strong> ${escapeHtml(connection.host || "N/A")}</p><p><strong>Port:</strong> ${escapeHtml(connection.port || "Default")}</p><p><strong>Database:</strong> ${escapeHtml(connection.database || "N/A")}</p><p><strong>Username:</strong> ${escapeHtml(connection.username || "N/A")}</p><p><strong>Password:</strong> ${connection.has_password ? "Saved (hidden)" : "Not set"}</p></div><div class="connection-actions"><button class="btn btn-icon btn-sm" data-action="test">Test</button>${currentUser?.role === "admin" ? `<button class="btn btn-icon btn-sm" data-action="edit">Edit</button><button class="btn btn-icon btn-sm danger" data-action="delete">Delete</button>` : ""}<button class="btn btn-icon btn-sm" data-action="use">Use</button></div>`;
            card.querySelector('[data-action="test"]').addEventListener("click", () => testConnection(connection.id));
            card.querySelector('[data-action="use"]').addEventListener("click", () => useConnection(connection.id));
            card.querySelector('[data-action="edit"]')?.addEventListener("click", () => showConnectionForm(connection));
            card.querySelector('[data-action="delete"]')?.addEventListener("click", () => deleteConnection(connection.id));
            connectionsListContainer.appendChild(card);
        });
    }
}

function showConnectionForm(connection = null) {
    if (currentUser?.role !== "admin") return;
    addConnectionFormContainer.classList.remove("hidden"); addConnectionForm.reset();
    addConnectionForm.dataset.editId = connection?.id || "";
    document.getElementById("form-title").textContent = connection ? "Edit Database Connection" : "Add Database Connection";
    document.getElementById("btn-submit-connection").textContent = connection ? "Update Connection" : "Save Connection";
    if (connection) {
        document.getElementById("conn-name").value = connection.name;
        connDbTypeSelect.value = connection.db_type;
        applyDatabaseDefaults(connection.db_type);
        document.getElementById("conn-host").value = connection.host || "";
        document.getElementById("conn-port").value = connection.port || "";
        document.getElementById("conn-database").value = connection.database || "";
        document.getElementById("conn-username").value = connection.username || "";
        document.getElementById("conn-extra-params").value = JSON.stringify(connection.extra_params || {}, null, 2);
        Array.from(connGroupSelect.options).forEach(option => { option.selected = connection.group_ids.includes(Number(option.value)); });
    } else {
        const defaultType = databases.find(database => database.available)?.type || databases[0]?.type || "";
        connDbTypeSelect.value = defaultType;
        applyDatabaseDefaults(defaultType);
    }
    connPwdInput.value = ""; connPwdInput.type = "password";
}
function connectionPayload() {
    let extra = {};
    const raw = document.getElementById("conn-extra-params").value.trim();
    if (raw) {
        extra = JSON.parse(raw);
        if (!extra || Array.isArray(extra) || typeof extra !== "object") throw new Error("Extra parameters must be a JSON object");
    }
    const selected = Array.from(connGroupSelect.selectedOptions).map(option => option.value);
    return { name: document.getElementById("conn-name").value, db_type: connDbTypeSelect.value, host: document.getElementById("conn-host").value || null, port: document.getElementById("conn-port").value ? Number(document.getElementById("conn-port").value) : null, database: document.getElementById("conn-database").value || null, username: document.getElementById("conn-username").value || null, ...(connPwdInput.value ? { password: connPwdInput.value } : {}), extra_params: extra, group_ids: selected.map(Number) };
}
async function saveConnection(event) {
    event.preventDefault();
    try {
        const payload = connectionPayload(); const id = addConnectionForm.dataset.editId;
        await apiFetch(id ? `/api/connections/${id}` : "/api/connections", { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        showToast(id ? "Connection updated" : "Connection saved", "success"); addConnectionFormContainer.classList.add("hidden"); await fetchConnections();
    } catch (error) { showToast(error.message, "error"); }
}
async function testFormConnection() {
    let payload;
    try {
        payload = connectionPayload();
        if (!payload.db_type) throw new Error("Select a database type");
        if (!payload.database) throw new Error("Enter a database name or path");
    } catch (error) {
        showToast(`Invalid connection values: ${error.message}`, "error");
        return;
    }
    const button = document.getElementById("btn-form-test-conn");
    const text = document.getElementById("btn-form-test-text");
    const spinner = document.getElementById("form-test-spinner");
    button.disabled = true;
    text.textContent = "Testing…";
    spinner.classList.remove("hidden");
    try {
        const result = await apiFetch("/api/connections/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                db_type: payload.db_type,
                host: payload.host || "",
                port: payload.port,
                database: payload.database,
                username: payload.username || "",
                password: payload.password ?? null,
                extra_params: payload.extra_params,
            }),
        });
        showToast(result.message || (result.success ? "Connection successful" : "Connection failed"), result.success ? "success" : "error");
    } catch (error) {
        showToast(error.message, "error");
    } finally {
        button.disabled = false;
        text.textContent = "Test Connection";
        spinner.classList.add("hidden");
    }
}
async function testConnection(id) { try { const result = await apiFetch(`/api/connections/${id}/test`, { method: "POST" }); showToast(result.message || "Connection successful", result.success ? "success" : "error"); } catch (error) { showToast(error.message, "error"); } }
async function deleteConnection(id) { if (!confirm("Delete this connection?")) return; try { await apiFetch(`/api/connections/${id}`, { method: "DELETE" }); selectedConnectionIds.delete(id); showToast("Connection deleted", "success"); await fetchConnections(); } catch (error) { showToast(error.message, "error"); } }
function useConnection(id) { selectedConnectionIds.add(id); switchView("query-section"); renderQueryConnectionPanel(); queryEditor.focus(); }

async function executeQuery() {
    const selectedText = queryEditor.value.slice(queryEditor.selectionStart, queryEditor.selectionEnd).trim();
    const query = (selectedText || queryEditor.value).trim(); if (!query) return showToast("Enter a SQL query", "warning");
    const ids = Array.from(selectedConnectionIds); if (!ids.length) return showToast("Select at least one connection", "warning");
    setQueryCheck("Checking…", "checking");
    executeText.textContent = "Executing…"; executeSpinner.classList.remove("hidden"); btnExportCsv.disabled = true;
    try {
        const results = await Promise.all(ids.map(async id => { const result = await apiFetch("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connection_id: id, query, limit: Number(queryLimitInput.value || 1000) }) }); return { ...result, connection_id: id, connection_name: connections.find(connection => connection.id === id)?.name || id }; }));
        displayResults(results, query); showToast("Query completed", results.some(result => !result.success) ? "warning" : "success");
        setQueryCheck(results.find(result => !result.success)?.error || "Query executed successfully", results.some(result => !result.success) ? "error" : "valid");
    } catch (error) { displayError(error.message); setQueryCheck(`Error: ${error.message}`, "error"); showToast(error.message, "error"); }
    finally { executeText.textContent = "Execute"; executeSpinner.classList.add("hidden"); }
}
function displayResults(results, query) {
    resultsPlaceholder.classList.add("hidden"); errorContainer.classList.add("hidden"); multiResultsContainer.classList.remove("hidden"); multiResultsContainer.innerHTML = ""; currentExportData = null; currentResultData = null; currentEditContext = null; pendingResultEdits.clear();
    if (results.length === 1 && results[0].success) {
        const result = results[0]; currentResultData = structuredClone(result.data || []); currentEditContext = result.edit_context?.editable ? { ...result.edit_context, connection_id: result.connection_id, query, key_values: currentResultData.map(row => row[result.edit_context.key_column]) } : null;
        if (result.columns?.length) currentExportData = { columns: result.columns, data: structuredClone(result.data || []) };
        renderEditableResults(result);
        resultCount.textContent = `${result.count || 0} rows`; executionTime.textContent = `${result.execution_time_ms || 0} ms`;
        btnExportCsv.disabled = !currentExportData?.data.length;
        document.getElementById("result-edit-actions")?.classList.toggle("hidden", !currentEditContext);
        tableScrollContainer.dataset.editContext = currentEditContext ? "editable" : "";
        return;
    }
    document.getElementById("result-edit-actions")?.classList.add("hidden");
    tableScrollContainer.dataset.editContext = "";
    let totalRows = 0, totalTime = 0;
    results.forEach(result => {
        totalRows += result.count || 0; totalTime += result.execution_time_ms || 0;
        const section = document.createElement("section"); section.className = "multi-result-section";
        const header = document.createElement("div"); header.className = "multi-result-header"; header.innerHTML = `<span class="multi-result-db-name">${escapeHtml(result.connection_name)}</span><span class="multi-result-meta">${result.count || 0} rows · ${result.execution_time_ms || 0}ms</span>`; section.appendChild(header);
        if (!result.success) { const error = document.createElement("div"); error.className = "multi-result-empty"; error.textContent = result.error || "Query failed"; section.appendChild(error); }
        else if (result.columns?.length) { currentExportData ||= { columns: result.columns, data: [] }; currentExportData.data.push(...(result.data || [])); const scroll = document.createElement("div"); scroll.className = "table-scroll-container"; const table = document.createElement("table"); table.className = "multi-result-table"; table.innerHTML = `<thead><tr>${result.columns.map(column => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${(result.data || []).map(row => `<tr>${result.columns.map(column => `<td>${escapeHtml(row[column])}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${result.columns.length}">No data returned</td></tr>`}</tbody>`; scroll.appendChild(table); section.appendChild(scroll); }
        else { const message = document.createElement("div"); message.className = "multi-result-empty"; message.textContent = result.message || `${result.count || 0} row(s) affected`; section.appendChild(message); }
        multiResultsContainer.appendChild(section);
    });
    resultCount.textContent = `${totalRows} rows`; executionTime.textContent = `${totalTime} ms`; btnExportCsv.disabled = !currentExportData?.data.length;
}
function renderEditableResults(result) {
    multiResultsContainer.innerHTML = "";
    const section = document.createElement("section"); section.className = "multi-result-section";
    const header = document.createElement("div"); header.className = "multi-result-header"; header.innerHTML = `<span class="multi-result-db-name">${escapeHtml(result.connection_name)}</span><span class="multi-result-meta">${result.count || 0} rows · ${result.execution_time_ms || 0}ms</span>`;
    const scroll = document.createElement("div"); scroll.className = "table-scroll-container";
    const table = document.createElement("table"); table.className = "multi-result-table excel-grid";
    const originals = structuredClone(result.data || []);
    table.innerHTML = `<thead><tr>${(result.columns || []).map(column => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${currentResultData.map((row, rowIndex) => `<tr>${result.columns.map(column => {
        const editable = currentEditContext && (currentUser?.role === "admin" || currentUser?.role === "writer") && column !== currentEditContext.key_column;
        return `<td contenteditable="${editable ? "true" : "false"}" data-row="${rowIndex}" data-column="${escapeHtml(column)}">${escapeHtml(row[column])}</td>`;
    }).join("")}</tr>`).join("") || `<tr><td colspan="${result.columns.length}">No data returned</td></tr>`}</tbody>`;
    table.addEventListener("input", event => {
        const cell = event.target.closest("td[contenteditable='true']");
        if (!cell) return;
        const row = Number(cell.dataset.row), column = cell.dataset.column;
        if ((currentUser?.role !== "admin" && currentUser?.role !== "writer") || !currentEditContext || column === currentEditContext.key_column) return;
        currentResultData[row][column] = cell.textContent;
        const original = originals[row][column];
        const id = `${row}:${column}`;
        if (String(cell.textContent) === String(original ?? "")) pendingResultEdits.delete(id);
        else pendingResultEdits.set(id, { key_value: currentEditContext.key_values[row], column, value: cell.textContent });
        updatePendingEditState();
    });
    scroll.appendChild(table); section.append(header, scroll); multiResultsContainer.appendChild(section);
}
function updatePendingEditState() {
    document.getElementById("result-edit-actions")?.classList.toggle("hidden", !currentEditContext);
    const apply = document.getElementById("btn-apply-result-edits");
    if (apply) apply.disabled = !pendingResultEdits.size;
}
async function applyResultEdits() {
    if (currentUser?.role !== "admin" && currentUser?.role !== "writer") {
        showToast("Write permission is required to edit results", "warning");
        return;
    }
    if (!currentEditContext || !pendingResultEdits.size) return;
    const button = document.getElementById("btn-apply-result-edits"); button.disabled = true;
    executeText.textContent = "Applying…"; executeSpinner.classList.remove("hidden");
    try {
        const result = await apiFetch("/api/query/edits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connection_id: currentEditContext.connection_id, query: currentEditContext.query, edits: Array.from(pendingResultEdits.values()) }) });
        if (!result.success) throw new Error(result.error || "Could not apply edits");
        pendingResultEdits.clear();
        showToast(`Applied ${result.updated} change(s)`, "success");
        await executeQueryText(currentEditContext.query, [currentEditContext.connection_id]);
    } catch (error) { showToast(error.message, "error"); button.disabled = false; updatePendingEditState(); }
    finally { executeText.textContent = "Execute"; executeSpinner.classList.add("hidden"); }
}
async function executeQueryText(query, ids) {
    const results = await Promise.all(ids.map(async id => ({ ...(await apiFetch("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connection_id: id, query, limit: Number(queryLimitInput.value || 1000) }) })), connection_id: id, connection_name: connections.find(connection => connection.id === id)?.name || id })));
    displayResults(results, query);
}
async function revertResultEdits() {
    if (!currentResultData || !currentEditContext || !currentExportData || !pendingResultEdits.size) return;
    pendingResultEdits.clear();
    try {
        await executeQueryText(currentEditContext.query, [currentEditContext.connection_id]);
        showToast("Unsaved edits reverted", "success");
    } catch (error) { showToast(error.message, "error"); }
}

function displayError(message) { resultsPlaceholder.classList.add("hidden"); multiResultsContainer.classList.add("hidden"); errorContainer.classList.remove("hidden"); errorMessage.textContent = message; }
function formatSql() { queryEditor.value = queryEditor.value.replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|LIMIT)\s+/gi, "\n$1 "); saveEditorState(); }
function exportResultsToCSV() { if (!currentExportData) return; const csv = [currentExportData.columns, ...currentExportData.data.map(row => currentExportData.columns.map(column => String(row[column] ?? "").replaceAll('"', '""')))].map(row => row.map(value => `"${value}"`).join(",")).join("\n"); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = "query-results.csv"; link.click(); }

async function fetchHistory() { try { renderHistoryList(await apiFetch("/api/history")); } catch (error) { showToast(error.message, "error"); } }
function renderHistoryList(history) { historyListContainer.innerHTML = ""; if (!history.length) { historyListContainer.innerHTML = '<div class="empty-state"><p>No query history yet.</p></div>'; return; } history.forEach(item => { const row = document.createElement("div"); row.className = "history-row"; row.innerHTML = `<span class="history-row-time">${escapeHtml(new Date(item.executed_at).toLocaleString())}</span><span class="history-row-status ${item.success ? "success" : "error"}">${item.success ? "Success" : "Failed"}</span><span class="history-row-query" title="${escapeHtml(item.query)}">${escapeHtml(item.query.replace(/\s+/g, " "))}</span><span class="history-row-meta">${item.row_count || 0} rows</span><span class="history-row-meta">${item.execution_time_ms || 0}ms</span><span class="history-row-connection">${escapeHtml(item.connection_id || "No connection")}</span><span class="history-row-actions"><button class="btn btn-icon btn-sm use-history">↗</button><button class="btn btn-icon btn-sm copy-history">⧉</button></span>`; row.querySelector(".use-history").addEventListener("click", () => { queryEditor.value = item.query; saveEditorState(); switchView("query-section"); }); row.querySelector(".copy-history").addEventListener("click", () => navigator.clipboard.writeText(item.query)); historyListContainer.appendChild(row); }); }
async function clearHistory() {
    const isAdmin = currentUser?.role === "admin";
    const prompt = isAdmin ? "Clear all query history?" : "Clear your query history?";
    if (!confirm(prompt)) return;
    try {
        const result = await apiFetch("/api/history", { method: "DELETE" });
        showToast(isAdmin ? `All history cleared (${result.deleted || 0} rows)` : "History cleared", "success");
        fetchHistory();
    } catch (error) {
        showToast(error.message, "error");
    }
}

async function fetchUsers() { if (currentUser?.role !== "admin") return; users = await apiFetch("/api/users"); const container = document.getElementById("users-list-container"); if (!container) return; container.innerHTML = users.map(user => `<div class="admin-row"><strong>${escapeHtml(user.username)}</strong><span>${escapeHtml(user.role)}</span><span>${user.is_active ? "Active" : "Inactive"}</span><span>Groups: ${user.group_ids.length}</span><span>2FA: ${user.totp_enabled ? "Enabled" : "Off"}</span><button class="btn btn-secondary btn-sm" data-action="edit" data-user-id="${user.id}">Edit</button><button class="btn btn-secondary btn-sm" data-action="delete" data-user-id="${user.id}">Delete</button></div>`).join(""); container.querySelectorAll('[data-action="edit"]').forEach(button => button.addEventListener("click", () => showUserForm(users.find(user => user.id === Number(button.dataset.userId))))); container.querySelectorAll('[data-action="delete"]').forEach(button => button.addEventListener("click", () => deleteUser(Number(button.dataset.userId)))); }
function showUserForm(user = null) {
    const form = document.getElementById("admin-user-form");
    form.classList.remove("hidden"); form.reset();
    document.getElementById("admin-user-id").value = user?.id || "";
    document.getElementById("admin-user-username").value = user?.username || "";
    document.getElementById("admin-user-username").disabled = Boolean(user);
    document.getElementById("admin-user-role").value = user?.role || "viewer";
    document.getElementById("admin-user-password").value = "";
    const groupSelect = document.getElementById("admin-user-groups");
    groupSelect.innerHTML = groups.map(group => `<option value="${group.id}"${user?.group_ids?.includes(group.id) ? " selected" : ""}>${escapeHtml(group.name)}</option>`).join("");
}
async function saveUserForm(event) {
    event.preventDefault();
    const id = document.getElementById("admin-user-id").value;
    const password = document.getElementById("admin-user-password").value;
    const group_ids = Array.from(document.getElementById("admin-user-groups").selectedOptions).map(option => Number(option.value));
    const payload = { role: document.getElementById("admin-user-role").value, group_ids };
    // Omit blank passwords entirely; this keeps an edit from accidentally
    // replacing the existing Argon2id hash with an empty value.
    if (password) payload.password = password;
    if (!id) { payload.username = document.getElementById("admin-user-username").value; if (!password) return showToast("A password is required", "warning"); }
    try { await apiFetch(id ? `/api/users/${id}` : "/api/users", { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); document.getElementById("admin-user-form").classList.add("hidden"); showToast("User saved", "success"); fetchUsers(); } catch (error) { showToast(error.message, "error"); }
}
async function deleteUser(id) { if (!confirm("Delete this user?")) return; try { await apiFetch(`/api/users/${id}`, { method: "DELETE" }); showToast("User deleted", "success"); fetchUsers(); } catch (error) { showToast(error.message, "error"); } }
async function renderGroupsAdmin() { if (currentUser?.role !== "admin") return; const container = document.getElementById("groups-list-container"); if (!container) return; groups = await apiFetch("/api/groups"); container.innerHTML = groups.map(group => `<div class="admin-row"><strong>${escapeHtml(group.name)}</strong><span>ID ${group.id}</span><button class="btn btn-secondary btn-sm" data-action="edit" data-group-id="${group.id}">Edit</button><button class="btn btn-secondary btn-sm" data-action="delete" data-group-id="${group.id}">Delete</button></div>`).join(""); container.querySelectorAll('[data-action="edit"]').forEach(button => button.addEventListener("click", () => showGroupForm(groups.find(group => group.id === Number(button.dataset.groupId))))); container.querySelectorAll('[data-action="delete"]').forEach(button => button.addEventListener("click", () => deleteGroup(Number(button.dataset.groupId)))); populateGroupControls(); }
function showGroupForm(group = null) { const form = document.getElementById("admin-group-form"); form.classList.remove("hidden"); form.reset(); document.getElementById("admin-group-id").value = group?.id || ""; document.getElementById("admin-group-name").value = group?.name || ""; }
async function saveGroupForm(event) { event.preventDefault(); const id = document.getElementById("admin-group-id").value; const name = document.getElementById("admin-group-name").value; try { await apiFetch(id ? `/api/groups/${id}` : "/api/groups", { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }); document.getElementById("admin-group-form").classList.add("hidden"); showToast("Group saved", "success"); await renderGroupsAdmin(); } catch (error) { showToast(error.message, "error"); } }
async function deleteGroup(id) { if (!confirm("Delete this group and its memberships?")) return; try { await apiFetch(`/api/groups/${id}`, { method: "DELETE" }); showToast("Group deleted", "success"); renderGroupsAdmin(); fetchConnections(); } catch (error) { showToast(error.message, "error"); } }

function saveEditorState() { try { localStorage.setItem("queryEditorContent", queryEditor.value); localStorage.setItem("queryEditorCursorPos", queryEditor.selectionStart); } catch (_) {} }
function loadEditorState() { try { queryEditor.value = localStorage.getItem("queryEditorContent") || ""; } catch (_) {} }
function showToast(message, type = "info") { if (!toastContainer) return; toastContainer.innerHTML = `<div class="toast toast-${type}"><div class="toast-content"><span class="toast-message">${escapeHtml(message)}</span></div></div>`; setTimeout(() => { toastContainer.innerHTML = ""; }, 3500); }
