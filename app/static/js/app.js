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
let selectedConnectionIds = new Set();
let currentExportData = null;
let currentResultData = null;
let currentEditContext = null;
let pendingResultEdits = new Map();
let schemaMetadataCache = new Map();
let historyRefreshInterval = null;
let pendingTotpSetup = false;

// Query tabs state
let queryTabs = [];
let activeTabId = null;
let tabCounter = 0;

// Editor preferences (loaded from localStorage)
let editorPreferences = {};

// Parameter panel state
let parameterPanelVisible = false;

let btnShowAddConnection, addConnectionFormContainer, addConnectionForm,
    btnCancelConnection, connTogglePwdBtn, connPwdInput, connectionsListContainer,
    queryLimitInput, connGroupSelect, connNewGroupInput, queryGroupFilter, queryDbTypeFilter, queryDbSearch,
    connectionsGroupFilter, connectionsDbTypeFilter, connectionsSearchInput, connDbTypeSelect,
    btnExecuteQuery, executeText, executeSpinner,
    resultsPlaceholder, tableScrollContainer, resultCount, executionTime, btnExportCsv,
    errorContainer, errorMessage, btnClearHistory, historyListContainer, toastContainer,
    sidebarToggle, sidebarClose, sidebar, appViews, sidebarLinks, connectionsPanelList,
    multiResultsContainer,
    queryTabsContainer, queryTabBar, queryTabPanels, btnNewQueryTab;

const csrfHeaders = () => {
    const token = getCookie("qe_csrf");
    return token ? { "X-CSRF-Token": token } : {};
};

function getCookie(name) {
    return document.cookie.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&")
        .replace(/</g, "<")
        .replace(/>/g, ">")
        .replace(/"/g, "\"")
        .replace(/'/g, "&#039;");
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

// --- Query Tab Management ---

function createQueryTab(initialQuery = "") {
    const tabId = `tab-${++tabCounter}`;
    const tab = {
        id: tabId,
        name: "Untitled",
        query: initialQuery,
        connectionIds: new Set(),
        resultData: null,
        editContext: null,
        pendingEdits: new Map(),
        executionTime: 0,
        resultCount: 0,
        error: null,
        isDirty: false,
        resultHtml: null,
        multiResultHtml: null,
        currentExportData: null,
        currentEditContext: null,
        editorView: null,
        editorInstance: null,
        editorContainer: null,
        parameters: {},
        parametersPanel: null,
        parametersList: null,
        btnToggleParameters: null,
        btnRefreshParameters: null
    };
    queryTabs.push(tab);
    return tab;
}

function getActiveTab() {
    return queryTabs.find(t => t.id === activeTabId);
}

function getTabById(tabId) {
    if (!tabId) return null;
    const found = queryTabs.find(t => t && t.id === tabId);
    if (!found) {
        console.error(`[getTabById] Tab not found: "${tabId}". Available:`, queryTabs.map(t => t?.id));
    }
    return found;
}

function renderQueryTabs() {
    if (!queryTabsContainer) return;
    queryTabsContainer.innerHTML = queryTabs.map(tab => `
        <button type="button" class="query-tab ${tab.id === activeTabId ? "active" : ""}" data-tab-id="${tab.id}" role="tab" aria-selected="${tab.id === activeTabId}">
            <span class="query-tab-title">${escapeHtml(tab.name)}</span>
            <button type="button" class="query-tab-close" data-close-tab="${tab.id}" aria-label="Close tab">
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </button>
    `).join("");
}

function renderTabPanels() {
    console.log(`[renderTabPanels] activeTabId: ${activeTabId}, queryTabs:`, queryTabs.map(t => t.id));
    if (!queryTabPanels) {
        console.error(`[renderTabPanels] queryTabPanels not found!`);
        return;
    }
    queryTabPanels.innerHTML = queryTabs.map(tab => `
        <div class="query-tab-panel ${tab.id === activeTabId ? "active" : ""}" data-tab-id="${tab.id}" role="tabpanel">
            ${renderTabPanelContent(tab)}
        </div>
    `).join("");

    // Re-bind events for the active panel
    const activeTab = getActiveTab();
    console.log(`[renderTabPanels] Binding events for activeTab:`, activeTab?.id);
    if (activeTab) {
        console.log(`[renderTabPanels] Checking DOM elements for tab ${activeTab.id}:`);
        console.log(`  btn-execute-query-${activeTab.id}:`, document.getElementById(`btn-execute-query-${activeTab.id}`));
        console.log(`  query-editor-${activeTab.id}:`, document.getElementById(`query-editor-${activeTab.id}`));
        console.log(`  results-container-${activeTab.id}:`, document.getElementById(`results-container-${activeTab.id}`));
    }
    bindTabPanelEvents(activeTab);
}

function renderTabPanelContent(tab) {
    return `
        <section class="grid-card editor-card">
            <div class="card-header">
                <div class="header-title">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <h2>SQL Query Editor</h2>
                </div>
                <div class="editor-header-actions">
                    <button type="button" class="btn btn-ghost btn-sm" id="btn-toggle-parameters-${tab.id}" title="Toggle Parameters Panel" aria-label="Toggle Parameters Panel">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                        <span class="btn-text">Parameters</span>
                    </button>
                    <button type="button" class="btn btn-accent btn-large" id="btn-execute-query-${tab.id}" data-tab-id="${tab.id}">
                        <svg class="icon-play" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        <span id="btn-execute-text-${tab.id}">Execute</span>
                        <div class="btn-spinner hidden" id="execute-spinner-${tab.id}"></div>
                    </button>
                </div>
            </div>

            <!-- Parameters Panel -->
            <div class="parameters-panel hidden" id="parameters-panel-${tab.id}" role="region" aria-label="Query Parameters">
                <div class="parameters-header">
                    <h3>Query Parameters</h3>
                    <button type="button" class="btn btn-ghost btn-sm" id="btn-refresh-parameters-${tab.id}" title="Auto-detect parameters">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                    </button>
                </div>
                <div class="parameters-list" id="parameters-list-${tab.id}">
                    <p class="parameters-empty">No parameters detected. Click "Auto-detect" or enter a query with bind variables.</p>
                </div>
            </div>

            <div class="editor-pane">
                <div class="editor-container" id="editor-container-${tab.id}">
                    <div class="editor-header">
                        <span class="editor-lang">SQL</span>
                        <div class="editor-actions">
                            <span id="query-check-status-${tab.id}" class="query-check-status" role="status" aria-live="polite">Ready</span>
                            <button type="button" class="btn btn-ghost btn-sm" id="btn-format-sql-${tab.id}" title="Format SQL">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                            </button>
                            <button type="button" class="btn btn-ghost btn-sm" id="btn-clear-editor-${tab.id}" title="Clear Editor">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            </button>
                        </div>
                    </div>
                    <div id="query-editor-${tab.id}" class="cm-editor-host"></div>
                    <div id="query-suggestions-${tab.id}" class="query-suggestions hidden" role="listbox" aria-label="Table and field suggestions"></div>
                </div>
            </div>
        </section>

        <!-- MULTI-DATABASE RESULTS SECTION -->
        <section class="grid-card results-card">
            <div class="card-header">
                <div class="header-title">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="1"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
                    <h2>Query Results</h2>
                </div>
                <div class="results-meta">
                    <span class="result-count" id="result-count-${tab.id}">0 rows</span>
                    <span class="execution-time" id="execution-time-${tab.id}">0 ms</span>
                    <div id="result-edit-actions-${tab.id}" class="result-edit-actions hidden">
                        <button type="button" class="btn btn-primary btn-sm" id="btn-apply-result-edits-${tab.id}" data-tab-id="${tab.id}">Apply</button>
                        <button type="button" class="btn btn-secondary btn-sm" id="btn-revert-result-edits-${tab.id}" data-tab-id="${tab.id}">Revert</button>
                    </div>
                    <button class="btn btn-secondary btn-sm" id="btn-export-csv-${tab.id}" disabled>
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Export CSV
                    </button>
                </div>
            </div>

            <div class="results-container" id="results-container-${tab.id}" data-edit-context="">
                <div id="results-placeholder-${tab.id}" class="table-placeholder">
                    <div class="placeholder-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/></svg>
                    </div>
                    <h4>No Query Executed Yet</h4>
                    <p>Select a connection, enter a SQL query, and click Execute to see results.</p>
                </div>

                <div id="multi-results-container-${tab.id}" class="hidden">
                    <!-- Each selected connection gets its own result section -->
                </div>

                <div class="error-container hidden" id="error-container-${tab.id}">
                    <div class="error-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                    </div>
                    <h4>Query Error</h4>
                    <pre id="error-message-${tab.id}"></pre>
                </div>
            </div>
        </section>
    `;
}

function bindTabPanelEvents(tab) {
    if (!tab) return;

    // Get DOM elements
    tab.editorContainer = document.getElementById(`editor-container-${tab.id}`);
    tab.editorHost = document.getElementById(`query-editor-${tab.id}`);
    tab.suggestionsElement = document.getElementById(`query-suggestions-${tab.id}`);
    tab.checkStatusElement = document.getElementById(`query-check-status-${tab.id}`);
    tab.executeBtn = document.getElementById(`btn-execute-query-${tab.id}`);
    tab.executeText = document.getElementById(`btn-execute-text-${tab.id}`);
    tab.executeSpinner = document.getElementById(`execute-spinner-${tab.id}`);
    tab.resultsContainer = document.getElementById(`results-container-${tab.id}`);
    tab.multiResultsContainer = document.getElementById(`multi-results-container-${tab.id}`);
    tab.resultsPlaceholder = document.getElementById(`results-placeholder-${tab.id}`);
    tab.errorContainer = document.getElementById(`error-container-${tab.id}`);
    tab.errorMessage = document.getElementById(`error-message-${tab.id}`);
    tab.resultCount = document.getElementById(`result-count-${tab.id}`);
    tab.executionTime = document.getElementById(`execution-time-${tab.id}`);
    tab.btnExportCsv = document.getElementById(`btn-export-csv-${tab.id}`);
    tab.btnApplyEdits = document.getElementById(`btn-apply-result-edits-${tab.id}`);
    tab.btnRevertEdits = document.getElementById(`btn-revert-result-edits-${tab.id}`);
    tab.editActions = document.getElementById(`result-edit-actions-${tab.id}`);

    // Parameter panel elements
    tab.parametersPanel = document.getElementById(`parameters-panel-${tab.id}`);
    tab.parametersList = document.getElementById(`parameters-list-${tab.id}`);
    tab.btnToggleParameters = document.getElementById(`btn-toggle-parameters-${tab.id}`);
    tab.btnRefreshParameters = document.getElementById(`btn-refresh-parameters-${tab.id}`);

    // Initialize parameter values storage for this tab
    if (!tab.parameters) {
        tab.parameters = {};
    }

    // Initialize CodeMirror editor if not already created
    if (!tab.editorInstance && tab.editorHost && window.CodeMirrorEditor) {
        const isDarkTheme = document.documentElement.dataset.theme === "dark";
        const prefs = editorPreferences[tab.id] || {};

        window.CodeMirrorEditor.createEditor(tab.id, tab.editorHost, tab.query, {
            theme: prefs.theme || (isDarkTheme ? "dark" : "light"),
            fontSize: prefs.fontSize || 14,
            lineWrapping: prefs.lineWrapping !== false,
            lineNumbers: prefs.lineNumbers !== false,
            bracketMatching: true,
            autoCloseBrackets: true,
            tabSize: prefs.tabSize || 4,
            indentWithTab: true,
            placeholder: "Enter any SQL statement here...\n\nSELECT * FROM users;\nCREATE TABLE example (id INTEGER);"
        }).then(instance => {
            tab.editorInstance = instance;
            tab.editorView = instance.view;

            // Restore query value
            if (tab.query) {
                instance.setValue(tab.query);
            }

            // Apply preferences after editor is ready
            if (Object.keys(prefs).length > 0) {
                window.CodeMirrorEditor.applyEditorPreferences(tab.id, prefs);
            }

            // Focus editor if this is the active tab
            if (tab.id === activeTabId) {
                instance.focus();
            }
        }).catch(err => {
            console.error("Failed to initialize CodeMirror:", err);
            // Fallback to textarea
            fallbackToTextarea(tab);
        });
    } else if (tab.editorInstance) {
        // Editor already exists, just focus if active
        if (tab.id === activeTabId) {
            tab.editorInstance.focus();
        }
    }

    // Execute button - bind directly to current tab object to avoid lookup issues
    const boundTab = tab;
    console.log(`[bindTabPanelEvents] Binding executeBtn for tab ${tab.id}:`, tab.executeBtn);
    tab.executeBtn?.addEventListener("click", () => {
        console.log(`[executeBtn] Clicked for tab ${boundTab.id}`);
        executeQuery(boundTab.id);
    });
    if (!tab.executeBtn) {
        console.error(`[bindTabPanelEvents] executeBtn NOT FOUND for tab ${tab.id}`);
    }

    // Clear editor
    document.getElementById(`btn-clear-editor-${tab.id}`)?.addEventListener("click", () => {
        if (tab.editorInstance) {
            tab.editorInstance.setValue("");
            tab.query = "";
            tab.isDirty = true;
            updateTabName(tab);
            updateQueryCheckForTab(tab);
            tab.editorInstance.focus();
        }
    });

    // Format SQL
    document.getElementById(`btn-format-sql-${tab.id}`)?.addEventListener("click", () => {
        if (window.SqlFormatter) {
            window.SqlFormatter.formatEditorSql(tab.id);
        } else {
            showToast("SQL formatter not loaded", "warning");
        }
    });

    // Apply edits
    tab.btnApplyEdits?.addEventListener("click", () => applyResultEdits(tab.id));

    // Revert edits
    tab.btnRevertEdits?.addEventListener("click", () => revertResultEdits(tab.id));

    // Export CSV
    tab.btnExportCsv?.addEventListener("click", () => exportCsv(tab.id));

    // Suggestion clicks
    tab.suggestionsElement?.addEventListener("click", e => {
        const btn = e.target.closest("button[data-suggestion]");
        if (btn) insertSuggestionForTab(tab, btn.dataset.suggestion);
    });

    // Parameter panel toggle
    tab.btnToggleParameters?.addEventListener("click", () => toggleParametersPanel(tab));

    // Refresh parameters (auto-detect)
    tab.btnRefreshParameters?.addEventListener("click", () => refreshParameters(tab));

    // Initialize query check
    updateQueryCheckForTab(tab);

    // Initialize parameters panel if query has parameters
    if (tab.query && tab.query.trim()) {
        setTimeout(() => refreshParameters(tab), 100);
    }

    // Initialize autocomplete if connection is selected
    if (tab.connectionIds.size > 0 && window.AutocompleteManager) {
        setTimeout(() => {
            const connectionId = Array.from(tab.connectionIds)[0];
            window.AutocompleteManager.initializeAutocomplete(tab);
        }, 200);
    }
}

/**
 * Fallback to textarea if CodeMirror fails to load
 */
function fallbackToTextarea(tab) {
    if (!tab.editorHost) return;

    tab.editorHost.innerHTML = `
        <textarea id="query-editor-fallback-${tab.id}" class="code-editor" spellcheck="false"
            placeholder="Enter any SQL statement here...&#10;&#10;SELECT * FROM users;&#10;CREATE TABLE example (id INTEGER);">${escapeHtml(tab.query)}</textarea>
    `;

    const editor = document.getElementById(`query-editor-fallback-${tab.id}`);
    tab.editorElement = editor;

    editor.addEventListener("keydown", event => {
        if ((event.ctrlKey || event.metaKey) && (event.key === "Enter" || event.key.toLowerCase() === "e")) {
            event.preventDefault();
            executeQuery(tab.id);
        }
        if (event.key === "Escape") hideQuerySuggestions();
    });
    editor.addEventListener("input", () => {
        tab.query = editor.value;
        tab.isDirty = true;
        updateTabName(tab);
        updateQueryCheckForTab(tab);
        updateQuerySuggestionsForTab(tab);
    });
    editor.addEventListener("click", () => updateQuerySuggestionsForTab(tab));
    editor.addEventListener("keyup", () => updateQuerySuggestionsForTab(tab));
    editor.addEventListener("select", () => updateQuerySuggestionsForTab(tab));

    // Auto-save query to localStorage on input
    const saveQueryToStorage = () => {
        try {
            const savedTabs = JSON.parse(localStorage.getItem("qe_saved_queries") || "{}");
            savedTabs[tab.id] = tab.query;
            localStorage.setItem("qe_saved_queries", JSON.stringify(savedTabs));
        } catch (_) {}
    };
    editor.addEventListener("input", saveQueryToStorage);

    editor.value = tab.query;
    updateQueryCheckForTab(tab);
}

function updateQueryCheckForTab(tab) {
    const sql = tab.query.trim();
    if (!sql) return setTabQueryCheck(tab, "Ready", "ready");

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
            if (!open || (open === "(" && c !== ")") || (open === "[" && c !== "]")) return setTabQueryCheck(tab, "Error: unmatched closing delimiter", "error");
        }
    }
    if (quote || blockComment || stack.length) return setTabQueryCheck(tab, "Error: incomplete quote, comment, or parenthesis", "error");

    const visible = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[(?:[^\]]|\]\])*\]/g, "''");
    const semicolons = (visible.match(/;/g) || []).length;
    if (semicolons > 1 || /;\s*\S/.test(visible)) return setTabQueryCheck(tab, "Error: run one SQL statement at a time", "error");

    if (tab.connectionIds.size === 1) {
        // Get selection from CodeMirror or fallback textarea
        let selection = "";
        if (tab.editorView) {
            const { state } = tab.editorView;
            const { ranges } = state.selection;
            if (ranges[0].from !== ranges[0].to) {
                selection = state.sliceDoc(ranges[0].from, ranges[0].to).trim();
            }
        } else if (tab.editorElement) {
            selection = tab.editorElement.value.slice(tab.editorElement.selectionStart, tab.editorElement.selectionEnd).trim();
        }
        const checkSql = selection || sql;
        const selected = tab.connectionIds.values().next().value;
        apiFetch("/api/query/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connection_id: selected, query: checkSql }) })
            .then(result => {
                const currentSql = tab.query.trim();
                const currentSelection = tab.editorView
                    ? tab.editorView.state.sliceDoc(tab.editorView.state.selection.main.from, tab.editorView.state.selection.main.to).trim()
                    : (tab.editorElement ? tab.editorElement.value.slice(tab.editorElement.selectionStart, tab.editorElement.selectionEnd).trim() : "");
                if (currentSql === sql && (currentSelection || sql) === checkSql)
                    setTabQueryCheck(tab, result.valid ? "Query syntax is valid" : `Error: ${result.error}`, result.valid ? "valid" : "error");
            })
            .catch(() => { if (tab.query.trim() === sql) setTabQueryCheck(tab, "Syntax could not be checked; execution will still validate", "ready"); });
        return;
    }
    setTabQueryCheck(tab, "Syntax structure looks balanced; select one connection for a syntax check", "valid");
}

function setTabQueryCheck(tab, message, state) {
    if (tab.checkStatusElement) {
        tab.checkStatusElement.textContent = message;
        tab.checkStatusElement.dataset.state = state;
    }
}

function hideQuerySuggestions() {
    queryTabs.forEach(tab => tab.suggestionsElement?.classList.add("hidden"));
}

function updateQuerySuggestionsForTab(tab) {
    const popup = tab.suggestionsElement;
    if (!popup || tab.connectionIds.size !== 1) return popup?.classList.add("hidden");

    // Get text before cursor from CodeMirror or fallback textarea
    let before = "";
    if (tab.editorView) {
        const { state } = tab.editorView;
        const pos = state.selection.main.head;
        before = state.sliceDoc(0, pos);
    } else if (tab.editorElement) {
        before = tab.editorElement.value.slice(0, tab.editorElement.selectionStart);
    } else {
        return popup.classList.add("hidden");
    }

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
    if (!suggestions.length) return popup.classList.add("hidden");
    popup.innerHTML = suggestions.map(value => `<button type="button" role="option" data-suggestion="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join("");
    popup.classList.remove("hidden");
}

function insertSuggestionForTab(tab, value) {
    if (tab.editorView) {
        const { state } = tab.editorView;
        const { from, to } = state.selection.main;
        const before = state.sliceDoc(0, from);
        const tokenStart = before.search(/[A-Za-z_][A-Za-z0-9_$]*$/);
        const insertPos = tokenStart < 0 ? from : from - (before.length - tokenStart);

        tab.editorView.dispatch({
            changes: { from: insertPos, to, insert: value },
            selection: { anchor: insertPos + value.length }
        });
        tab.editorView.focus();
        tab.query = tab.editorView.state.doc.toString();
        tab.isDirty = true;
        updateTabName(tab);
        updateQueryCheckForTab(tab);
        hideQuerySuggestions();
    } else if (tab.editorElement) {
        const start = tab.editorElement.selectionStart, end = tab.editorElement.selectionEnd;
        const before = tab.editorElement.value.slice(0, start), after = tab.editorElement.value.slice(end);
        const tokenStart = before.search(/[A-Za-z_][A-Za-z0-9_$]*$/);
        tab.editorElement.value = `${before.slice(0, tokenStart < 0 ? before.length : tokenStart)}${value}${after}`;
        const cursor = tab.editorElement.value.length - after.length;
        tab.editorElement.setSelectionRange(cursor, cursor);
        tab.editorElement.focus();
        tab.query = tab.editorElement.value;
        tab.isDirty = true;
        updateTabName(tab);
        updateQueryCheckForTab(tab);
        hideQuerySuggestions();
    }
}

function switchTab(tabId) {
    console.log(`[switchTab] Switching to tab: ${tabId}, current: ${activeTabId}`);
    if (tabId === activeTabId) return;
    activeTabId = tabId;
    renderQueryTabs();
    renderTabPanels();

    // Sync connection selection to active tab
    syncConnectionSelectionToActiveTab();

    // Restore results for the active tab
    const activeTab = getActiveTab();
    if (activeTab) {
        restoreTabResults(activeTab);
        // Refresh parameters panel for the active tab
        if (activeTab.query && activeTab.query.trim()) {
            setTimeout(() => refreshParameters(activeTab), 100);
        }
    }

    // Focus editor for the active tab
    setTimeout(() => {
        const tab = getActiveTab();
        if (tab && tab.editorInstance) {
            tab.editorInstance.focus();
        } else if (tab && tab.editorElement) {
            tab.editorElement.focus();
        }
    }, 50);
}

function restoreTabResults(tab) {
    if (!tab.resultsContainer || !tab.multiResultsContainer) return;

    if (tab.resultHtml) {
        // Single connection result
        tab.resultsPlaceholder.classList.add("hidden");
        tab.multiResultsContainer.classList.add("hidden");
        tab.errorContainer?.classList.add("hidden");
        tab.resultsContainer.innerHTML = tab.resultHtml;
        tab.resultsContainer.querySelectorAll("td[contenteditable='true']").forEach(cell => {
            cell.addEventListener("blur", e => handleCellEdit(tab, e));
        });
    } else if (tab.multiResultHtml) {
        // Multi-connection results
        tab.resultsPlaceholder.classList.add("hidden");
        tab.errorContainer?.classList.add("hidden");
        tab.multiResultsContainer.classList.remove("hidden");
        tab.multiResultsContainer.innerHTML = tab.multiResultHtml;
    }
}

function addQueryTab() {
    // Load saved queries from localStorage
    let savedQueries = {};
    try {
        savedQueries = JSON.parse(localStorage.getItem("qe_saved_queries") || "{}");
    } catch (_) {}
    const tabId = `tab-${tabCounter + 1}`;
    const tab = createQueryTab(savedQueries[tabId] || "");
    activeTabId = tab.id;
    renderQueryTabs();
    renderTabPanels();
    syncConnectionSelectionToActiveTab();

    // Bind events for the new tab
    console.log(`[addQueryTab] Created tab ${tab.id}, binding events...`);
    bindTabPanelEvents(tab);

    // Focus editor after a brief delay to allow CodeMirror to initialize
    setTimeout(() => {
        if (tab.editorInstance) {
            tab.editorInstance.focus();
        } else if (tab.editorElement) {
            tab.editorElement.focus();
        }
    }, 100);
}

function closeQueryTab(tabId) {
    const index = queryTabs.findIndex(t => t.id === tabId);
    if (index === -1) return;

    const tab = queryTabs[index];

    // Destroy CodeMirror editor instance
    if (tab.editorInstance && window.CodeMirrorEditor) {
        window.CodeMirrorEditor.destroyEditor(tabId);
    }

    // Clean up editor preferences
    delete editorPreferences[tabId];

    const wasActive = tab.id === activeTabId;
    queryTabs.splice(index, 1);

    // Remove saved query for closed tab
    try {
        const savedQueries = JSON.parse(localStorage.getItem("qe_saved_queries") || "{}");
        delete savedQueries[tabId];
        localStorage.setItem("qe_saved_queries", JSON.stringify(savedQueries));
    } catch (_) {}

    if (queryTabs.length === 0) {
        // Create a new empty tab
        addQueryTab();
        return;
    }

    if (wasActive) {
        // Activate the previous tab or the next one
        const newIndex = Math.min(index, queryTabs.length - 1);
        activeTabId = queryTabs[newIndex].id;
    }

    renderQueryTabs();
    renderTabPanels();
    syncConnectionSelectionToActiveTab();
}

function updateTabName(tab) {
    if (!tab.isDirty && !tab.query.trim()) {
        tab.name = "Untitled";
    } else if (tab.isDirty) {
        // Extract first meaningful line
        const firstLine = tab.query.trim().split("\n")[0].trim();
        if (firstLine) {
            tab.name = firstLine.length > 30 ? firstLine.slice(0, 30) + "…" : firstLine;
        }
    }
    renderQueryTabs();
}

/**
 * Save editor preferences to localStorage
 */
function saveEditorPreferences() {
    try {
        localStorage.setItem("qe_editor_preferences", JSON.stringify(editorPreferences));
    } catch (_) {}
}

/**
 * Update editor preferences for a tab
 */
function updateEditorPreferences(tabId, prefs) {
    if (!editorPreferences[tabId]) {
        editorPreferences[tabId] = {};
    }
    editorPreferences[tabId] = { ...editorPreferences[tabId], ...prefs };
    saveEditorPreferences();

    // Apply to existing editor
    if (window.CodeMirrorEditor) {
        window.CodeMirrorEditor.applyEditorPreferences(tabId, editorPreferences[tabId]);
    }
}

/**
 * Get editor preferences for a tab
 */
function getEditorPreferences(tabId) {
    return editorPreferences[tabId] || {};
}

/**
 * Save editor preferences handler
 */
function saveEditorPreferencesHandler() {
    const activeTab = getActiveTab();
    if (!activeTab) return;

    const prefs = {
        fontSize: parseInt(document.getElementById("editor-font-size")?.value) || 14,
        tabSize: parseInt(document.getElementById("editor-tab-size")?.value) || 4,
        lineWrapping: document.getElementById("editor-line-wrapping")?.checked !== false,
        lineNumbers: document.getElementById("editor-line-numbers")?.checked !== false,
        bracketMatching: document.getElementById("editor-bracket-matching")?.checked !== false,
        autoCloseBrackets: document.getElementById("editor-auto-close-brackets")?.checked !== false,
        theme: document.getElementById("editor-theme")?.value || "auto"
    };

    updateEditorPreferences(activeTab.id, prefs);
    showToast("Editor preferences saved", "success");
}

/**
 * Reset editor preferences to defaults
 */
function resetEditorPreferencesHandler() {
    const activeTab = getActiveTab();
    if (!activeTab) return;

    const defaults = {
        fontSize: 14,
        tabSize: 4,
        lineWrapping: true,
        lineNumbers: true,
        bracketMatching: true,
        autoCloseBrackets: true,
        theme: "auto"
    };

    // Update form fields
    document.getElementById("editor-font-size").value = defaults.fontSize;
    document.getElementById("editor-tab-size").value = defaults.tabSize;
    document.getElementById("editor-line-wrapping").checked = defaults.lineWrapping;
    document.getElementById("editor-line-numbers").checked = defaults.lineNumbers;
    document.getElementById("editor-bracket-matching").checked = defaults.bracketMatching;
    document.getElementById("editor-auto-close-brackets").checked = defaults.autoCloseBrackets;
    document.getElementById("editor-theme").value = defaults.theme;

    updateEditorPreferences(activeTab.id, defaults);
    showToast("Editor preferences reset to defaults", "info");
}

/**
 * Toggle the parameters panel visibility
 */
function toggleParametersPanel(tab) {
    if (!tab.parametersPanel || !tab.btnToggleParameters) return;

    const isHidden = tab.parametersPanel.classList.contains("hidden");
    if (isHidden) {
        tab.parametersPanel.classList.remove("hidden");
        tab.btnToggleParameters.classList.add("active");
        tab.btnToggleParameters.setAttribute("aria-expanded", "true");
    } else {
        tab.parametersPanel.classList.add("hidden");
        tab.btnToggleParameters.classList.remove("active");
        tab.btnToggleParameters.setAttribute("aria-expanded", "false");
    }
}

/**
 * Refresh parameters by auto-detecting from the current query
 */
async function refreshParameters(tab) {
    if (!tab.parametersList) return;

    // Get current query from editor
    let sql = "";
    if (tab.editorView) {
        sql = tab.editorView.state.doc.toString().trim();
    } else if (tab.editorElement) {
        sql = tab.editorElement.value.trim();
    } else {
        sql = tab.query || "";
    }

    if (!sql) {
        tab.parametersList.innerHTML = '<p class="parameters-empty">No query entered. Enter a SQL query with bind variables to detect parameters.</p>';
        return;
    }

    // Need a connection to detect parameters
    if (tab.connectionIds.size === 0) {
        tab.parametersList.innerHTML = '<p class="parameters-empty">Select a connection first to detect parameters.</p>';
        return;
    }

    const connectionId = tab.connectionIds.values().next().value;

    try {
        // Call API to parse parameters
        const result = await apiFetch("/api/query/parameters", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connection_id: connectionId, query: sql })
        });

        renderParametersPanel(tab, result.parameters);
    } catch (error) {
        console.error("Failed to detect parameters:", error);
        tab.parametersList.innerHTML = '<p class="parameters-empty">Could not detect parameters. Enter parameters manually.</p>';
    }
}

/**
 * Render the parameters panel with detected parameters
 */
function renderParametersPanel(tab, parameters) {
    if (!tab.parametersList) return;

    if (!parameters || parameters.length === 0) {
        tab.parametersList.innerHTML = '<p class="parameters-empty">No parameters detected in the query. Supported formats: :name, $1, ?, @name, %(name)s</p>';
        return;
    }

    let html = '';
    parameters.forEach((param, index) => {
        const paramName = param.name || param.display_name;
        const displayName = param.display_name || param.name;
        const style = param.style || 'unknown';
        const occurrences = param.occurrences || 1;

        // Get existing value or default
        const existingValue = tab.parameters[paramName] ?? '';

        // Determine input type based on parameter name/pattern
        const inputType = inferInputType(paramName, param);
        const inputHtml = createParameterInput(paramName, existingValue, inputType, param);

        html += `
            <div class="parameter-item" data-param-name="${escapeHtml(paramName)}">
                <div class="parameter-item-header">
                    <span class="parameter-name">
                        ${escapeHtml(displayName)}
                        <span class="parameter-style-badge">${escapeHtml(style)}</span>
                    </span>
                    <span class="parameter-occurrences">${occurrences} occurrence${occurrences !== 1 ? 's' : ''}</span>
                </div>
                <div class="parameter-input-wrapper">
                    ${inputHtml}
                </div>
            </div>
        `;
    });

    tab.parametersList.innerHTML = html;

    // Bind input change events
    tab.parametersList.querySelectorAll('.parameter-input, .parameter-select').forEach(input => {
        input.addEventListener('change', (e) => {
            const paramItem = e.target.closest('.parameter-item');
            if (paramItem) {
                const paramName = paramItem.dataset.paramName;
                tab.parameters[paramName] = e.target.value;
                // Clear error state
                e.target.classList.remove('parameter-error');
                const errorEl = paramItem.querySelector('.parameter-error-message');
                if (errorEl) errorEl.remove();
            }
        });
        input.addEventListener('input', (e) => {
            const paramItem = e.target.closest('.parameter-item');
            if (paramItem) {
                const paramName = paramItem.dataset.paramName;
                tab.parameters[paramName] = e.target.value;
            }
        });
    });
}

/**
 * Infer input type based on parameter name
 */
function inferInputType(paramName, param) {
    const name = paramName.toLowerCase();

    // Date/time patterns
    if (name.includes('date') || name.includes('time') || name.includes('created_at') || name.includes('updated_at') || name.includes('timestamp')) {
        return 'datetime-local';
    }

    // Boolean patterns
    if (name.includes('is_') || name.includes('has_') || name.includes('enabled') || name.includes('active') || name.includes('flag') || name.startsWith('is') || name.startsWith('has')) {
        return 'boolean';
    }

    // Enum-like patterns (status, type, category, etc.)
    if (name.includes('status') || name.includes('type') || name.includes('category') || name.includes('role') || name.includes('state')) {
        return 'enum';
    }

    // Email
    if (name.includes('email')) {
        return 'email';
    }

    // Number patterns
    if (name.includes('id') || name.includes('count') || name.includes('num') || name.includes('amount') || name.includes('price') || name.includes('qty') || name.includes('quantity')) {
        return 'number';
    }

    // Default to text
    return 'text';
}

/**
 * Create parameter input HTML based on type
 */
function createParameterInput(paramName, value, type, param) {
    const safeName = escapeHtml(paramName);
    const safeValue = escapeHtml(String(value ?? ''));

    switch (type) {
        case 'datetime-local':
            return `<label>Value: <input type="datetime-local" class="parameter-input" name="${safeName}" value="${safeValue}"></label>`;
        case 'date':
            return `<label>Value: <input type="date" class="parameter-input" name="${safeName}" value="${safeValue}"></label>`;
        case 'time':
            return `<label>Value: <input type="time" class="parameter-input" name="${safeName}" value="${safeValue}"></label>`;
        case 'boolean':
            return `<label>Value: <select class="parameter-input parameter-select" name="${safeName}"><option value="">-- Select --</option><option value="true"${value === 'true' || value === true ? ' selected' : ''}>True</option><option value="false"${value === 'false' || value === false ? ' selected' : ''}>False</option></select></label>`;
        case 'enum':
            // For enum, we'd need to fetch actual enum values from DB; for now use text with suggestions
            return `<label>Value: <input type="text" class="parameter-input" name="${safeName}" value="${safeValue}" placeholder="Enter value" list="enum-${safeName}"><datalist id="enum-${safeName}"><option value="active"><option value="inactive"><option value="pending"><option value="completed"></datalist></label>`;
        case 'number':
            return `<label>Value: <input type="number" class="parameter-input" name="${safeName}" value="${safeValue}" step="any"></label>`;
        case 'email':
            return `<label>Value: <input type="email" class="parameter-input" name="${safeName}" value="${safeValue}" placeholder="email@example.com"></label>`;
        default:
            return `<label>Value: <input type="text" class="parameter-input" name="${safeName}" value="${safeValue}" placeholder="Enter value"></label>`;
    }
}

/**
 * Get parameters object for query execution
 */
function getTabParameters(tab) {
    if (!tab.parameters) return {};
    // Filter out empty values
    const params = {};
    for (const [key, value] of Object.entries(tab.parameters)) {
        if (value !== '' && value !== null && value !== undefined) {
            params[key] = value;
        }
    }
    return params;
}

function syncConnectionSelectionToActiveTab() {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    
    // Update active tab's connection IDs from global selection
    activeTab.connectionIds = new Set(selectedConnectionIds);
    
    // Update UI to show which connections are selected for this tab
    updateConnectionSelectionUI(activeTab);
}

function updateConnectionSelectionUI(tab) {
    // This will be called when connection selection changes
    // We just need to ensure the active tab reflects the current selection
    if (tab) {
        tab.connectionIds = new Set(selectedConnectionIds);
        // Trigger schema metadata loading for selected connections
        selectedConnectionIds.forEach(connId => ensureSchemaMetadata(connId));
    }
}

function initializeQueryTabs() {
    if (queryTabs.length === 0) {
        // Load saved queries from localStorage
        let savedQueries = {};
        try {
            savedQueries = JSON.parse(localStorage.getItem("qe_saved_queries") || "{}");
        } catch (_) {}

        // Load editor preferences
        try {
            editorPreferences = JSON.parse(localStorage.getItem("qe_editor_preferences") || "{}");
        } catch (_) {
            editorPreferences = {};
        }

        const tab = createQueryTab(savedQueries[`tab-1`] || "");
        activeTabId = tab.id;
        renderQueryTabs();
        renderTabPanels();
    }
}

// --- Rest of the functions ---

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
        await Promise.all([fetchDatabases(), fetchGroups(), fetchConnections(), fetchHistory()]);
        if (currentUser.role === "admin") await Promise.all([fetchUsers(), renderGroupsAdmin()]);
        initializeQueryTabs();
        if (selectedConnectionIds.size) await Promise.all(Array.from(selectedConnectionIds).map(ensureSchemaMetadata)).then(updateQuerySuggestionsForTab);
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
    document.getElementById("btn-auto-update")?.addEventListener("click", autoUpdate);
    document.getElementById("btn-auto-update-banner")?.addEventListener("click", autoUpdate);

    // Editor preferences event listeners
    document.getElementById("btn-save-editor-prefs")?.addEventListener("click", saveEditorPreferencesHandler);
    document.getElementById("btn-reset-editor-prefs")?.addEventListener("click", resetEditorPreferencesHandler);

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
    connectionsSearchInput?.addEventListener("input", renderConnectionsList);
    connTogglePwdBtn?.addEventListener("click", () => { connPwdInput.type = connPwdInput.type === "password" ? "text" : "password"; });
    addConnectionForm?.addEventListener("submit", saveConnection);
    document.getElementById("btn-form-test-conn")?.addEventListener("click", testFormConnection);
    connDbTypeSelect?.addEventListener("change", () => applyDatabaseDefaults(connDbTypeSelect.value));
    btnNewQueryTab?.addEventListener("click", addQueryTab);
    document.getElementById("btn-logout")?.setAttribute("aria-label", "Log out of Query Execute");
    document.getElementById("btn-add-user")?.addEventListener("click", () => showUserForm());
    document.getElementById("btn-cancel-user")?.addEventListener("click", () => document.getElementById("admin-user-form").classList.add("hidden"));
    document.getElementById("admin-user-form")?.addEventListener("submit", saveUserForm);
    document.getElementById("btn-add-group")?.addEventListener("click", () => showGroupForm());
    document.getElementById("btn-cancel-group")?.addEventListener("click", () => document.getElementById("admin-group-form").classList.add("hidden"));
    document.getElementById("admin-group-form")?.addEventListener("submit", saveGroupForm);

    // Snippets form event listeners
    document.getElementById("btn-new-snippet")?.addEventListener("click", () => {
        if (window.SnippetsManager) window.SnippetsManager.showSnippetForm(null);
    });
    document.getElementById("btn-cancel-snippet")?.addEventListener("click", () => {
        if (window.SnippetsManager) window.SnippetsManager.cancelSnippetForm();
    });
    document.getElementById("snippet-form")?.addEventListener("submit", (e) => {
        if (window.SnippetsManager) window.SnippetsManager.saveSnippetForm(e);
    });

    // Tab close buttons (delegated)
    queryTabsContainer?.addEventListener("click", e => {
        const closeBtn = e.target.closest("[data-close-tab]");
        if (closeBtn) {
            e.stopPropagation();
            closeQueryTab(closeBtn.dataset.closeTab);
        }
        const tabBtn = e.target.closest(".query-tab");
        if (tabBtn && !closeBtn) {
            switchTab(tabBtn.dataset.tabId);
        }
    });
}

async function checkForUpdates() {
    const status = document.getElementById("update-status");
    const pageUpdate = document.getElementById("version-update-banner");
    const pageMessage = document.getElementById("version-update-message");
    const pageLink = document.getElementById("version-update-link");
    const autoUpdateBtn = document.getElementById("btn-auto-update");
    const autoUpdateBannerBtn = document.getElementById("btn-auto-update-banner");
    const updateProgress = document.getElementById("update-progress");
    if (!status && !pageUpdate) return;
    const update = await fetchVersionData();
    if (!update) {
        if (status) status.textContent = "Unable to check for updates right now.";
        if (pageUpdate) pageUpdate.classList.add("hidden");
        if (autoUpdateBtn) autoUpdateBtn.style.display = "none";
        if (autoUpdateBannerBtn) autoUpdateBannerBtn.style.display = "none";
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
    if (autoUpdateBtn) {
        autoUpdateBtn.style.display = update.update_available ? "inline-flex" : "none";
    }
    if (autoUpdateBannerBtn) {
        autoUpdateBannerBtn.style.display = update.update_available ? "inline-flex" : "none";
    }
    if (pageUpdate && pageMessage && pageLink) {
        pageMessage.textContent = message;
        pageLink.href = update.release_url;
        pageUpdate.classList.toggle("hidden", !update.update_available);
    }
    const log = document.getElementById("release-log");
    if (log) log.innerHTML = update.changelog.map(release => `<li><strong>v${escapeHtml(release.version.replace(/^v/, ""))}</strong> — ${escapeHtml((release.notes || []).join("; "))}</li>`).join("");
}

async function autoUpdate() {
    const autoUpdateBtn = document.getElementById("btn-auto-update");
    const autoUpdateBannerBtn = document.getElementById("btn-auto-update-banner");
    const updateProgress = document.getElementById("update-progress");
    const status = document.getElementById("update-status");

    const buttons = [autoUpdateBtn, autoUpdateBannerBtn].filter(Boolean);
    if (!buttons.length) return;

    buttons.forEach(btn => {
        btn.disabled = true;
        btn.textContent = "Updating...";
    });
    if (updateProgress) {
        updateProgress.style.display = "block";
        updateProgress.textContent = "Fetching updates...";
    }
    if (status) status.textContent = "Updating...";

    try {
        const response = await apiFetch("/api/update", { method: "POST" });

        if (response.success) {
            if (response.updated) {
                if (updateProgress) updateProgress.textContent = `Updated to ${response.new_version}. Restarting...`;
                if (status) status.textContent = `Updated to ${response.new_version}. Restarting application...`;
                showToast(`Updated to version ${response.new_version}. Restarting application.`, "success");
                // Auto-restart: reload page with retry until server responds
                const reloadWithRetry = () => {
                    window.location.reload();
                };
                setTimeout(reloadWithRetry, 2000);
            } else {
                if (updateProgress) updateProgress.textContent = "Already up to date.";
                if (status) status.textContent = "You're up to date.";
                showToast("Already up to date", "info");
            }
            buttons.forEach(btn => { btn.style.display = "none"; });
            const updateLink = document.getElementById("btn-apply-update");
            if (updateLink) updateLink.classList.add("hidden");
        } else {
            throw new Error(response.error || "Update failed");
        }
    } catch (error) {
        if (updateProgress) updateProgress.textContent = `Error: ${error.message}`;
        if (status) status.textContent = `Update failed: ${error.message}`;
        showToast(`Update failed: ${error.message}`, "error");
        buttons.forEach(btn => {
            btn.disabled = false;
            btn.textContent = "Update now";
        });
    }
}

function applyTheme(theme) {
    const value = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = value;
    document.body.classList.toggle("light-theme", value === "light");
    document.body.classList.toggle("dark-theme", value === "dark");
    const button = document.getElementById("btn-theme-toggle");
    if (button) {
        button.setAttribute("aria-label", `Switch to ${value === "dark" ? "light" : "dark"} theme`);
        button.title = `Switch to ${value === "dark" ? "light" : "dark"} theme`;
    }
    try { localStorage.setItem("qe-theme", value); } catch (_) {}

    // Update CodeMirror editor themes for all tabs
    if (window.CodeMirrorEditor) {
        queryTabs.forEach(tab => {
            if (tab.editorInstance) {
                window.CodeMirrorEditor.updateEditorTheme(tab.id, value === "dark");
            }
        });
    }
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
    if (viewId === "snippets-section" && window.SnippetsManager) {
        window.SnippetsManager.loadSnippets().then(() => window.SnippetsManager.renderSnippetsPanel());
    }
    if (viewId === "users-section" && currentUser?.role === "admin") fetchUsers();
    if (viewId === "groups-section" && currentUser?.role === "admin") renderGroupsAdmin();
    if (viewId === "settings-section") checkForUpdates();
    if (viewId === "connections-section") fetchConnections();
    if (viewId === "query-section") {
        fetchConnections();
        // Re-render tabs when switching back to query section
        renderQueryTabs();
        renderTabPanels();
    }
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
        // Don't await - trigger schema load in background
        ensureSchemaMetadata(items[0].id);
    }
    if (selectedConnectionIds.size === 1) {
        // Don't await - trigger schema load in background
        ensureSchemaMetadata(Array.from(selectedConnectionIds)[0]);
    }
    items.forEach(connection => {
        const item = document.createElement("button"); item.type = "button"; item.className = `connection-panel-item${selectedConnectionIds.has(connection.id) ? " selected" : ""}`;
        item.innerHTML = `<span class="connection-panel-info"><span class="connection-panel-name">${escapeHtml(connection.name)}</span></span><span class="connection-panel-check">${selectedConnectionIds.has(connection.id) ? "✓" : ""}</span>`;
        item.addEventListener("click", () => {
            selectedConnectionIds.has(connection.id) ? selectedConnectionIds.delete(connection.id) : selectedConnectionIds.add(connection.id);
            renderQueryConnectionPanel();
            syncConnectionSelectionToActiveTab();
        });
        connectionsPanelList.appendChild(item);
    });
    syncConnectionSelectionToActiveTab();
}
function renderConnectionsList() {
    connectionsListContainer.innerHTML = "";
    const groupFilter = connectionsGroupFilter?.value || "all";
    const dbTypeFilter = connectionsDbTypeFilter?.value || "all";
    const searchTerm = (connectionsSearchInput?.value || "").trim().toLocaleLowerCase();
    const visible = connections.filter(connection => {
        const groupMatch = groupFilter === "all" || (groupFilter === "ungrouped" ? !connection.group_ids.length : connection.group_ids.includes(Number(groupFilter)));
        const searchMatch = !searchTerm || [connection.name, connection.host, connection.database, connection.username, connection.db_type]
            .some(value => String(value || "").toLocaleLowerCase().includes(searchTerm));
        return groupMatch && searchMatch && (dbTypeFilter === "all" || connection.db_type === dbTypeFilter);
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
function useConnection(id) { selectedConnectionIds.add(id); switchView("query-section"); renderQueryConnectionPanel(); syncConnectionSelectionToActiveTab(); }

async function executeQuery(tabId) {
    console.log(`[executeQuery] Called with tabId: ${tabId}`);
    const tab = getTabById(tabId);
    if (!tab) {
        console.error(`[executeQuery] Tab not found: ${tabId}`);
        // Try to get active tab as fallback
        const activeTab = getActiveTab();
        if (activeTab) {
            console.log(`[executeQuery] Falling back to active tab: ${activeTab.id}`);
            return executeQuery(activeTab.id);
        }
        return;
    }

    console.log(`[executeQuery] Tab found:`, tab);
    console.log(`[executeQuery] tab.connectionIds:`, tab.connectionIds);
    console.log(`[executeQuery] tab.editorView:`, tab.editorView);
    console.log(`[executeQuery] tab.editorElement:`, tab.editorElement);

    // Get SQL from CodeMirror or fallback textarea
    let sql = "";
    if (tab.editorView) {
        sql = tab.editorView.state.doc.toString().trim();
    } else if (tab.editorElement) {
        sql = tab.editorElement.value.trim();
    }

    console.log(`[executeQuery] SQL: "${sql}"`);

    if (!sql) return showToast("Enter a SQL query first", "warning");
    if (tab.connectionIds.size === 0) return showToast("Select at least one connection", "warning");

    tab.executeBtn.disabled = true;
    tab.executeText.textContent = "Executing...";
    tab.executeSpinner.classList.remove("hidden");
    tab.resultsPlaceholder.classList.add("hidden");
    tab.multiResultsContainer.classList.add("hidden");
    tab.multiResultsContainer.innerHTML = "";
    tab.errorContainer.classList.add("hidden");
    tab.editActions.classList.add("hidden");
    tab.btnExportCsv.disabled = true;

    const limit = parseInt(queryLimitInput?.value) || 1000;
    const connIds = Array.from(tab.connectionIds);
    const isMulti = connIds.length > 1;

    // Get parameters for this tab
    const parameters = getTabParameters(tab);

    try {
        if (isMulti) {
            // Multi-connection execution
            const results = [];
            for (const connId of connIds) {
                try {
                    const result = await apiFetch("/api/query", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ connection_id: connId, query: sql, limit, parameters })
                    });
                    results.push({ connectionId: connId, success: true, data: result });
                } catch (error) {
                    results.push({ connectionId: connId, success: false, error: error.message });
                }
            }
            renderMultiResults(tab, results);
        } else {
            // Single connection execution
            const connId = connIds[0];
            const result = await apiFetch("/api/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ connection_id: connId, query: sql, limit, parameters })
            });
            renderSingleResult(tab, connId, result);
        }
    } catch (error) {
        tab.resultsPlaceholder.classList.add("hidden");
        tab.errorContainer.classList.remove("hidden");
        tab.errorMessage.textContent = error.message;
        tab.resultCount.textContent = "0 rows";
        tab.executionTime.textContent = "0 ms";
        showToast(`Query failed: ${error.message}`, "error");
    } finally {
        tab.executeBtn.disabled = false;
        tab.executeText.textContent = "Execute";
        tab.executeSpinner.classList.add("hidden");
    }
}

function renderSingleResult(tab, connId, result) {
    const connection = connections.find(c => c.id === connId);
    const dbName = connection?.name || connId;

    tab.resultsPlaceholder.classList.add("hidden");
    tab.multiResultsContainer.classList.add("hidden");
    tab.errorContainer.classList.add("hidden");

    // Build editable grid
    const { html, editContext, rowCount, columns, rows } = buildEditableGrid(result, tab.id);
    tab.currentEditContext = editContext;
    tab.currentResultData = { columns, rows };
    tab.resultCount.textContent = `${rowCount} row${rowCount !== 1 ? "s" : ""}`;
    tab.executionTime.textContent = `${result.execution_time_ms || 0} ms`;

    if (editContext && (currentUser?.role === "admin" || currentUser?.role === "writer")) {
        tab.editActions.classList.remove("hidden");
    } else {
        tab.editActions.classList.add("hidden");
    }
    tab.btnExportCsv.disabled = rowCount === 0;
    tab.currentExportData = { columns, rows };

    // Save HTML to tab for persistence when switching tabs
    tab.resultHtml = html;
    tab.multiResultHtml = null;

    tab.resultsContainer.innerHTML = html;
    tab.resultsContainer.querySelectorAll("td[contenteditable='true']").forEach(cell => {
        cell.addEventListener("blur", e => handleCellEdit(tab, e));
    });
}

function renderMultiResults(tab, results) {
    tab.resultsPlaceholder.classList.add("hidden");
    tab.errorContainer.classList.add("hidden");
    tab.multiResultsContainer.classList.remove("hidden");
    tab.multiResultsContainer.innerHTML = "";
    tab.editActions.classList.add("hidden");
    tab.btnExportCsv.disabled = true;

    let totalRows = 0;
    let multiHtml = "";
    results.forEach(r => {
        const connection = connections.find(c => c.id === r.connectionId);
        const dbName = connection?.name || r.connectionId;

        const section = document.createElement("div");
        section.className = "multi-result-section";

        if (r.success) {
            const { html, rowCount } = buildEditableGrid(r.data, tab.id);
            totalRows += rowCount;
            const sectionHtml = `<h4>${escapeHtml(dbName)} (${rowCount} row${rowCount !== 1 ? "s" : ""})</h4>${html}`;
            section.innerHTML = sectionHtml;
            multiHtml += sectionHtml;
        } else {
            const sectionHtml = `<h4>${escapeHtml(dbName)}</h4><div class="error-container"><h4>Error</h4><pre>${escapeHtml(r.error)}</pre></div>`;
            section.innerHTML = sectionHtml;
            multiHtml += sectionHtml;
        }
        tab.multiResultsContainer.appendChild(section);
    });

    // Save HTML to tab for persistence when switching tabs
    tab.multiResultHtml = multiHtml;
    tab.resultHtml = null;

    tab.resultCount.textContent = `${totalRows} total row${totalRows !== 1 ? "s" : ""}`;
    tab.executionTime.textContent = `${results.reduce((sum, r) => sum + (r.data?.execution_time_ms || 0), 0)} ms`;
}

function buildEditableGrid(data, tabId) {
    // Handle both full result object (has data.columns, data.data) and direct result
    const result = data?.data ? data : { data: data };
    const columns = result.data?.columns || result.columns;
    const rows = result.data?.data || result.rows || result.data || [];

    if (!columns || !rows) return { html: "<p>No data returned</p>", editContext: null, rowCount: 0, columns: [], rows: [] };

    const rowCount = rows.length;

    if (rowCount === 0) return { html: "<p>No rows returned</p>", editContext: null, rowCount: 0, columns, rows };
    
    // Determine if editable (single connection, simple SELECT with PK)
    const activeTab = getTabById(tabId);
    const isEditable = activeTab?.connectionIds.size === 1 &&
                       result.edit_context &&
                       (currentUser?.role === "admin" || currentUser?.role === "writer");

    let editContext = null;
    if (isEditable && result.edit_context) {
        editContext = {
            connection_id: result.edit_context.connection_id,
            table: result.edit_context.table,
            key_column: result.edit_context.key_column,
            columns: columns
        };
    }
    
    // Build table HTML
    let html = `<table class="excel-grid"><thead><tr>`;
    columns.forEach(col => { html += `<th>${escapeHtml(col)}</th>`; });
    html += `</tr></thead><tbody>`;
    
    rows.forEach((row, rowIdx) => {
        html += `<tr>`;
        columns.forEach((col, colIdx) => {
            const value = row[col];
            const displayValue = value === null ? '<span class="null-value">NULL</span>' : escapeHtml(String(value));
            const editable = isEditable && col !== editContext?.key_column ? ' contenteditable="true"' : "";
            const keyAttr = col === editContext?.key_column ? ` data-key="${escapeHtml(String(value))}"` : "";
            html += `<td${editable}${keyAttr}>${displayValue}</td>`;
        });
        html += `</tr>`;
    });
    html += `</tbody></table>`;
    
    return { html, editContext, rowCount, columns, rows };
}

function handleCellEdit(tab, event) {
    const cell = event.target;
    const row = cell.closest("tr");
    const keyCell = row.querySelector("[data-key]");
    const keyValue = keyCell?.dataset.key;
    const column = cell.cellIndex;
    const newValue = cell.textContent.trim() === "NULL" ? null : cell.textContent;
    const originalRow = tab.currentResultData?.rows?.[row.rowIndex - 1];
    const originalValue = originalRow?.[tab.currentResultData.columns[column]];
    
    if (originalValue !== newValue) {
        tab.pendingEdits.set(`${row.rowIndex}:${column}`, {
            keyValue,
            column,
            newValue,
            originalValue
        });
    } else {
        tab.pendingEdits.delete(`${row.rowIndex}:${column}`);
    }
}

async function applyResultEdits(tabId) {
    const tab = getTabById(tabId);
    if (!tab || tab.pendingEdits.size === 0) return;
    
    const edits = Array.from(tab.pendingEdits.values());
    const firstEdit = edits[0];
    if (!firstEdit.keyValue) return showToast("Cannot identify rows to update (missing key column)", "error");
    
    try {
        const result = await apiFetch("/api/query/edits", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                connection_id: tab.currentEditContext.connection_id,
                table: tab.currentEditContext.table,
                key_column: tab.currentEditContext.key_column,
                key_value: firstEdit.keyValue,
                changes: edits.map(e => ({ column: e.column, value: e.newValue }))
            })
        });
        showToast(`Applied ${result.updated} change${result.updated !== 1 ? "s" : ""}`, "success");
        tab.pendingEdits.clear();
        executeQuery(tab.id); // Re-execute to refresh
    } catch (error) {
        showToast(`Apply failed: ${error.message}`, "error");
    }
}

function revertResultEdits(tabId) {
    const tab = getTabById(tabId);
    tab.pendingEdits.clear();
    executeQuery(tab.id);
    showToast("Changes reverted", "info");
}

function exportCsv(tabId) {
    const tab = getTabById(tabId);
    if (!tab || !tab.currentExportData) return;
    
    const { columns, rows } = tab.currentExportData;
    const csv = [columns.join(","), ...rows.map(row => columns.map(col => {
        const value = row[col];
        if (value === null) return "";
        const str = String(value);
        return str.includes(",") || str.includes('"') || str.includes("\n") ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(","))].join("\n");
    
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `query-results-${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast("CSV exported", "success");
}

async function ensureSchemaMetadata(connectionId) {
    if (schemaMetadataCache.has(connectionId)) return;
    try { schemaMetadataCache.set(connectionId, await apiFetch(`/api/connections/${connectionId}/schema`)); }
    catch (_) { schemaMetadataCache.set(connectionId, { tables: [] }); }
}

// --- Rest of the functions (unchanged from original) ---

async function fetchHistory() { try { renderHistoryList(await apiFetch("/api/history")); } catch (error) { showToast(error.message, "error"); } }
function renderHistoryList(history) { historyListContainer.innerHTML = ""; if (!history.length) { historyListContainer.innerHTML = '<div class="empty-state"><p>No query history yet.</p></div>'; return; } history.forEach(item => { const row = document.createElement("div"); row.className = "history-row"; row.innerHTML = `<span class="history-row-time">${escapeHtml(new Date(item.executed_at).toLocaleString())}</span><span class="history-row-status ${item.success ? "success" : "error"}">${item.success ? "Success" : "Failed"}</span><span class="history-row-query" title="${escapeHtml(item.query)}">${escapeHtml(item.query.replace(/\s+/g, " "))}</span><span class="history-row-meta">${item.row_count || 0} rows</span><span class="history-row-meta">${item.execution_time_ms || 0}ms</span><span class="history-row-connection">${escapeHtml(item.connection_id || "No connection")}</span><span class="history-row-actions"><button class="btn btn-icon btn-sm use-history">↗</button><button class="btn btn-icon btn-sm copy-history">⧉</button></span>`; row.querySelector(".use-history").addEventListener("click", () => { const tab = getActiveTab(); if (tab) { tab.editorElement.value = item.query; tab.query = item.query; tab.isDirty = true; updateTabName(tab); } switchView("query-section"); }); row.querySelector(".copy-history").addEventListener("click", () => navigator.clipboard.writeText(item.query)); historyListContainer.appendChild(row); }); }
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
    connectionsSearchInput = document.getElementById("connections-search-input");
    connDbTypeSelect = document.getElementById("conn-db-type");
    
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
    
    // Tab elements
    queryTabsContainer = document.getElementById("query-tabs");
    queryTabBar = document.getElementById("query-tab-bar");
    queryTabPanels = document.getElementById("query-tab-panels");
    btnNewQueryTab = document.getElementById("btn-new-query-tab");
}

function showToast(message, type = "info") { if (!toastContainer) return; toastContainer.innerHTML = `<div class="toast toast-${type}"><div class="toast-content"><span class="toast-message">${escapeHtml(message)}</span></div></div>`; setTimeout(() => { toastContainer.innerHTML = ""; }, 3500); }
