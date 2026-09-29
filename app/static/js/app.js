"use strict";

/* Query Execute frontend. Normal queries and saved-connection tests use only
   server-issued connection IDs; the add-form test is the explicit exception
   and sends the unsaved form values for a one-shot admin check. */
let connections = [];
let databases = [];
let groups = [];
let users = [];
let currentUser = null;
try {
    Object.defineProperty(window, "currentUser", {
        get() { return currentUser; },
        set(val) { currentUser = val; },
        configurable: true
    });
    Object.defineProperty(window, "connections", {
        get() { return connections; },
        set(val) { connections = val; },
        configurable: true
    });
    Object.defineProperty(window, "activeTabId", {
        get() { return activeTabId; },
        set(val) { activeTabId = val; },
        configurable: true
    });
} catch (_) {
    window.currentUser = currentUser;
    window.connections = connections;
    window.activeTabId = activeTabId;
}
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

// --- Query Tab Management ---

function createQueryTab(initialQuery = "") {
    scheduleWorkspaceSave();
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
        editorHost: null,
        singleResultContainer: null,
        _eventsBound: false,
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
    return queryTabs.find(t => t && t.id === activeTabId);
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
    if (!queryTabPanels) return;

    const validTabIds = new Set(queryTabs.map(t => t.id));

    // Clean up panels for closed tabs
    Array.from(queryTabPanels.children).forEach(panel => {
        if (!validTabIds.has(panel.dataset.tabId)) {
            panel.remove();
        }
    });

    // Ensure every tab in queryTabs has a persistent panel in the DOM
    queryTabs.forEach(tab => {
        let panel = queryTabPanels.querySelector(`.query-tab-panel[data-tab-id="${tab.id}"]`);
        if (!panel) {
            panel = document.createElement("div");
            panel.className = `query-tab-panel ${tab.id === activeTabId ? "active" : ""}`;
            panel.dataset.tabId = tab.id;
            panel.setAttribute("role", "tabpanel");
            panel.innerHTML = renderTabPanelContent(tab);
            queryTabPanels.appendChild(panel);
            bindTabPanelEvents(tab);
        } else {
            panel.classList.toggle("active", tab.id === activeTabId);
        }
    });

    const activeTab = getActiveTab();
    if (activeTab) {
        ensureTabElementReferences(activeTab);
        if (activeTab.editorInstance) {
            setTimeout(() => activeTab.editorInstance?.focus(), 50);
        }
    }
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
                    <button type="button" class="btn btn-secondary btn-sm" id="btn-explain-query-${tab.id}" title="Explain query execution plan" aria-label="Explain query execution plan">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                        <span>Explain</span>
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
                    <div class="results-quick-search-wrap">
                        <input type="search" class="results-quick-filter" id="result-search-${tab.id}" placeholder="Filter in results..." autocomplete="off">
                    </div>
                    <div class="results-view-mode-toggle" role="group" aria-label="View Mode">
                        <button type="button" class="btn btn-ghost btn-sm active" id="btn-view-grid-${tab.id}" title="Grid Table View">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>
                            Table
                        </button>
                        <button type="button" class="btn btn-ghost btn-sm" id="btn-view-chart-${tab.id}" title="Chart Visualization">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                            Chart
                        </button>
                    </div>
                    <span class="result-count" id="result-count-${tab.id}">0 rows</span>
                    <span class="execution-time" id="execution-time-${tab.id}">0 ms</span>
                    <div id="result-edit-actions-${tab.id}" class="result-edit-actions hidden">
                        <button type="button" class="btn btn-primary btn-sm" id="btn-apply-result-edits-${tab.id}" data-tab-id="${tab.id}">Apply</button>
                        <button type="button" class="btn btn-secondary btn-sm" id="btn-revert-result-edits-${tab.id}" data-tab-id="${tab.id}">Revert</button>
                    </div>
                    <div class="export-dropdown-wrapper">
                        <button class="btn btn-secondary btn-sm" id="btn-export-csv-${tab.id}" disabled>
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Export ▾
                        </button>
                        <div class="export-dropdown hidden" id="export-dropdown-${tab.id}">
                            <button type="button" class="export-option" data-format="csv" data-tab-id="${tab.id}">Export CSV</button>
                            <button type="button" class="export-option" data-format="json" data-tab-id="${tab.id}">Export JSON</button>
                            <button type="button" class="export-option" data-format="markdown" data-tab-id="${tab.id}">Export Markdown</button>
                            <button type="button" class="export-option" data-format="sql" data-tab-id="${tab.id}">Export SQL INSERT</button>
                        </div>
                    </div>
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

                <div id="single-result-container-${tab.id}" class="table-scroll-container hidden"></div>

                <div id="results-chart-container-${tab.id}" class="results-chart-panel hidden">
                    <div class="chart-controls-bar">
                        <div class="chart-control-item">
                            <label for="chart-type-${tab.id}">Type</label>
                            <select id="chart-type-${tab.id}" class="connection-group-filter">
                                <option value="bar">Bar Chart</option>
                                <option value="line">Line Chart</option>
                                <option value="pie">Pie Chart</option>
                                <option value="doughnut">Doughnut Chart</option>
                            </select>
                        </div>
                        <div class="chart-control-item">
                            <label for="chart-x-col-${tab.id}">X Axis (Category)</label>
                            <select id="chart-x-col-${tab.id}" class="connection-group-filter"></select>
                        </div>
                        <div class="chart-control-item">
                            <label for="chart-y-col-${tab.id}">Y Axis (Metric)</label>
                            <select id="chart-y-col-${tab.id}" class="connection-group-filter"></select>
                        </div>
                        <button type="button" class="btn btn-secondary btn-sm" id="btn-export-chart-${tab.id}" title="Download Chart Image">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Export PNG
                        </button>
                    </div>
                    <div class="chart-canvas-wrapper">
                        <canvas id="chart-canvas-${tab.id}" width="900" height="380"></canvas>
                    </div>
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

function ensureTabElementReferences(tab) {
    if (!tab) return;
    tab.editorContainer = document.getElementById(`editor-container-${tab.id}`);
    tab.editorHost = document.getElementById(`query-editor-${tab.id}`);
    tab.suggestionsElement = document.getElementById(`query-suggestions-${tab.id}`);
    tab.checkStatusElement = document.getElementById(`query-check-status-${tab.id}`);
    tab.executeBtn = document.getElementById(`btn-execute-query-${tab.id}`);
    tab.executeText = document.getElementById(`btn-execute-text-${tab.id}`);
    tab.executeSpinner = document.getElementById(`execute-spinner-${tab.id}`);
    tab.resultsContainer = document.getElementById(`results-container-${tab.id}`);
    tab.singleResultContainer = document.getElementById(`single-result-container-${tab.id}`);
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
    tab.parametersPanel = document.getElementById(`parameters-panel-${tab.id}`);
    tab.parametersList = document.getElementById(`parameters-list-${tab.id}`);
    tab.btnToggleParameters = document.getElementById(`btn-toggle-parameters-${tab.id}`);
    tab.btnRefreshParameters = document.getElementById(`btn-refresh-parameters-${tab.id}`);
    tab.btnExplain = document.getElementById(`btn-explain-query-${tab.id}`);
    tab.resultSearchInput = document.getElementById(`result-search-${tab.id}`);
    tab.btnViewGrid = document.getElementById(`btn-view-grid-${tab.id}`);
    tab.btnViewChart = document.getElementById(`btn-view-chart-${tab.id}`);
    tab.chartContainer = document.getElementById(`results-chart-container-${tab.id}`);
    tab.chartCanvas = document.getElementById(`chart-canvas-${tab.id}`);
    tab.chartTypeSelect = document.getElementById(`chart-type-${tab.id}`);
    tab.chartXSelect = document.getElementById(`chart-x-col-${tab.id}`);
    tab.chartYSelect = document.getElementById(`chart-y-col-${tab.id}`);
    tab.btnExportChart = document.getElementById(`btn-export-chart-${tab.id}`);
}

function bindTabPanelEvents(tab) {
    if (!tab) return;

    ensureTabElementReferences(tab);

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
    } else if (!tab.editorInstance && !tab.editorElement && tab.editorHost) {
        fallbackToTextarea(tab);
    }

    if (!tab._eventsBound) {
        tab._eventsBound = true;

        tab.executeBtn?.addEventListener("click", () => {
            if (tab.isExecuting) {
                cancelCurrentQuery(tab.id);
            } else {
                executeQuery(tab.id);
            }
        });

        // Clear editor
        document.getElementById(`btn-clear-editor-${tab.id}`)?.addEventListener("click", () => {
            if (tab.editorInstance) {
                tab.editorInstance.setValue("");
                tab.query = "";
                tab.isDirty = true;
                updateTabName(tab);
                updateQueryCheckForTab(tab);
                tab.editorInstance.focus();
            } else if (tab.editorElement) {
                tab.editorElement.value = "";
                tab.query = "";
                tab.isDirty = true;
                updateTabName(tab);
                updateQueryCheckForTab(tab);
                tab.editorElement.focus();
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

        // Export dropdown toggle and options
        tab.btnExportCsv?.addEventListener("click", (e) => {
            e.stopPropagation();
            const dropdown = document.getElementById(`export-dropdown-${tab.id}`);
            if (dropdown) {
                document.querySelectorAll(".export-dropdown").forEach(d => { if (d !== dropdown) d.classList.add("hidden"); });
                dropdown.classList.toggle("hidden");
            } else {
                exportData("csv", tab.id);
            }
        });

        document.querySelectorAll(`#export-dropdown-${tab.id} .export-option`).forEach(opt => {
            opt.addEventListener("click", (e) => {
                e.stopPropagation();
                const format = opt.dataset.format || "csv";
                exportData(format, tab.id);
                opt.closest(".export-dropdown")?.classList.add("hidden");
            });
        });

        // Suggestion clicks
        tab.suggestionsElement?.addEventListener("click", e => {
            const btn = e.target.closest("button[data-suggestion]");
            if (btn) insertSuggestionForTab(tab, btn.dataset.suggestion);
        });

        // Parameter panel toggle
        tab.btnToggleParameters?.addEventListener("click", () => toggleParametersPanel(tab));

        // Refresh parameters (auto-detect)
        tab.btnRefreshParameters?.addEventListener("click", () => refreshParameters(tab));

        // Explain query
        tab.btnExplain?.addEventListener("click", () => explainQuery(tab.id));

        // Result Search filter
        tab.resultSearchInput?.addEventListener("input", (e) => {
            applyResultFilter(tab, e.target.value);
        });

        // View mode toggle
        tab.btnViewGrid?.addEventListener("click", () => {
            tab.btnViewGrid.classList.add("active");
            tab.btnViewChart?.classList.remove("active");
            tab.singleResultContainer?.classList.remove("hidden");
            tab.chartContainer?.classList.add("hidden");
        });

        tab.btnViewChart?.addEventListener("click", () => {
            tab.btnViewChart.classList.add("active");
            tab.btnViewGrid?.classList.remove("active");
            tab.singleResultContainer?.classList.add("hidden");
            tab.chartContainer?.classList.remove("hidden");
            renderChartForTab(tab.id);
        });

        tab.chartTypeSelect?.addEventListener("change", () => renderChartForTab(tab.id));
        tab.chartXSelect?.addEventListener("change", () => renderChartForTab(tab.id));
        tab.chartYSelect?.addEventListener("change", () => renderChartForTab(tab.id));
        tab.btnExportChart?.addEventListener("click", () => exportChartPng(tab.id));
    }

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
        scheduleWorkspaceSave();
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
        const cols = matched.flatMap(item => (item.columns || []).map(c => typeof c === 'string' ? c : c?.name).filter(Boolean));
        suggestions = cols.filter(name => !dotColumnMatch[2] || name.toLowerCase().startsWith(dotColumnMatch[2].toLowerCase()));
    } else if (simpleContext && /(?:\b(?:WHERE|ON|AND|OR|BY|SET|SELECT)\s+|,\s*)[\w$]*$/i.test(simpleContext[2])) {
        const tableName = simpleContext[1].toLowerCase();
        const matched = tables.find(item => item.name.toLowerCase() === tableName || item.name.toLowerCase().endsWith(`.${tableName}`));
        const cols = (matched?.columns || []).map(c => typeof c === 'string' ? c : c?.name).filter(Boolean);
        suggestions = cols.filter(name => !word || name.toLowerCase().startsWith(word.toLowerCase()));
    } else if (/\bSELECT\s+[\w$]*$/i.test(before)) {
        const seen = new Set(before.match(/\b(?:FROM|JOIN)\s+([\w$]+)/gi)?.map(token => token.split(/\s+/).pop().toLowerCase()) || []);
        const cols = tables.filter(item => seen.has(item.name.toLowerCase())).flatMap(item => (item.columns || []).map(c => typeof c === 'string' ? c : c?.name).filter(Boolean));
        suggestions = cols.filter(name => !word || name.toLowerCase().startsWith(word.toLowerCase()));
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
    scheduleWorkspaceSave();
    if (tabId === activeTabId) return;
    activeTabId = tabId;
    renderQueryTabs();
    renderTabPanels();

    const activeTab = getActiveTab();
    if (activeTab) {
        loadTabConnectionSelection(activeTab);
        restoreTabResults(activeTab);
        if (activeTab.query && activeTab.query.trim()) {
            setTimeout(() => refreshParameters(activeTab), 100);
        }
        setTimeout(() => {
            if (activeTab.editorInstance) {
                activeTab.editorInstance.focus();
            } else if (activeTab.editorElement) {
                activeTab.editorElement.focus();
            }
        }, 50);
    }
}

function restoreTabResults(tab) {
    if (!tab) return;
    ensureTabElementReferences(tab);

    if (tab.resultHtml && tab.singleResultContainer) {
        tab.resultsPlaceholder?.classList.add("hidden");
        tab.multiResultsContainer?.classList.add("hidden");
        tab.errorContainer?.classList.add("hidden");
        tab.singleResultContainer.innerHTML = tab.resultHtml;
        tab.singleResultContainer.classList.remove("hidden");
        tab.singleResultContainer.querySelectorAll("td[contenteditable='true']").forEach(cell => {
            cell.addEventListener("blur", e => handleCellEdit(tab, e));
        });
    } else if (tab.multiResultHtml && tab.multiResultsContainer) {
        tab.resultsPlaceholder?.classList.add("hidden");
        tab.singleResultContainer?.classList.add("hidden");
        tab.errorContainer?.classList.add("hidden");
        tab.multiResultsContainer.classList.remove("hidden");
        tab.multiResultsContainer.innerHTML = tab.multiResultHtml;
    }
}

function addQueryTab() {
    let savedQueries = {};
    try {
        savedQueries = JSON.parse(localStorage.getItem("qe_saved_queries") || "{}");
    } catch (_) {}
    const tabId = `tab-${tabCounter + 1}`;
    const tab = createQueryTab(savedQueries[tabId] || "");
    activeTabId = tab.id;
    if (selectedConnectionIds.size === 1) {
        tab.connectionIds = new Set(selectedConnectionIds);
    }
    renderQueryTabs();
    renderTabPanels();
    loadTabConnectionSelection(tab);

    setTimeout(() => {
        if (tab.editorInstance) {
            tab.editorInstance.focus();
        } else if (tab.editorElement) {
            tab.editorElement.focus();
        }
    }, 100);
}

function closeQueryTab(tabId) {
    scheduleWorkspaceSave();
    const index = queryTabs.findIndex(t => t.id === tabId);
    if (index === -1) return;

    const tab = queryTabs[index];

    // Destroy CodeMirror editor instance
    if (tab.editorInstance && window.CodeMirrorEditor) {
        window.CodeMirrorEditor.destroyEditor(tabId);
    }

    if (window.InlineEditingManager) {
        window.InlineEditingManager.cleanupInlineEditing(tabId);
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
        addQueryTab();
        return;
    }

    if (wasActive) {
        const newIndex = Math.min(index, queryTabs.length - 1);
        activeTabId = queryTabs[newIndex].id;
    }

    renderQueryTabs();
    renderTabPanels();
    const activeTab = getActiveTab();
    if (activeTab) {
        loadTabConnectionSelection(activeTab);
    }
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
    selectedConnectionIds.forEach(connId => ensureSchemaMetadata(connId));
}

function loadTabConnectionSelection(tab) {
    if (!tab) return;
    selectedConnectionIds = new Set(tab.connectionIds || []);
    if (connectionsPanelList) {
        const buttons = connectionsPanelList.querySelectorAll(".connection-panel-item");
        buttons.forEach(btn => {
            const connId = btn.dataset.connectionId;
            const isSelected = selectedConnectionIds.has(connId);
            btn.classList.toggle("selected", isSelected);
            const check = btn.querySelector(".connection-panel-check");
            if (check) check.textContent = isSelected ? "✓" : "";
        });
    }
    if (selectedConnectionIds.size === 1) {
        const singleId = Array.from(selectedConnectionIds)[0];
        ensureSchemaMetadata(singleId);
        renderSchemaExplorer(singleId);
    } else {
        renderSchemaExplorer(null);
    }
}

async function initializeQueryTabs() {
    if (queryTabs.length === 0) {
        isRestoringWorkspace = true;
        
        // Load editor preferences
        try { editorPreferences = JSON.parse(localStorage.getItem("qe_editor_preferences") || "{}"); } 
        catch (_) { editorPreferences = {}; }

        let state = null;
        try {
            const data = await apiFetch("/api/workspace");
            if (data && data.state_json) state = JSON.parse(data.state_json);
        } catch (e) {
            console.warn("Failed to fetch workspace state", e);
        }

        if (state && state.tabs && state.tabs.length > 0) {
            queryTabs.length = 0; // Clear
            state.tabs.forEach(tState => {
                const tab = createQueryTab(tState.query || "");
                tab.id = tState.id || tab.id; // Restore ID if possible, else keep generated
                tab.name = tState.name || tab.name;
                tab.connectionIds = new Set(tState.connectionIds || []);
            });
            activeTabId = state.activeTabId || queryTabs[0].id;
            
            // Ensure activeTabId actually exists in loaded tabs
            if (!queryTabs.some(t => t.id === activeTabId)) {
                activeTabId = queryTabs[0].id;
            }
        } else {
            // Fallback to local storage (legacy) or empty tab
            let savedQueries = {};
            try { savedQueries = JSON.parse(localStorage.getItem("qe_saved_queries") || "{}"); } catch (_) {}
            const tab = createQueryTab(savedQueries[`tab-1`] || "");
            activeTabId = tab.id;
        }

        renderQueryTabs();
        renderTabPanels();
        
        // Setup editors for all loaded tabs
        queryTabs.forEach(tab => {
            const editorEl = document.getElementById(`editor-${tab.id}`);
            if (editorEl) {
                tab.editorElement = editorEl;
                if (window.EditorHighlighting) {
                    window.EditorHighlighting.initializeEditor(tab.id);
                } else {
                    setupBasicEditor(tab);
                }
            }
        });
        
        const activeTab = getActiveTab();
        if (activeTab) loadTabConnectionSelection(activeTab);
        
        isRestoringWorkspace = false;
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
    try {
        cacheDOMElements();
        setupSidebarVisibility();
        setupEventListeners();
        initSavedQueriesEvents();
        initScheduledTasksEvents();
        initDashboardEvents();
        initAIEvents();
        initDBMonitorEvents();
        initSchemaDiffEvents();
        initGlobalExportEvents();
    } catch (err) {
        console.error("DOM setup error:", err);
    }

    try {
        await initializeQueryTabs();
    } catch (err) {
        console.error("initializeQueryTabs error:", err);
    }

    try {
        const me = await apiFetch("/api/auth/me");
        currentUser = me.user;
        const label = document.getElementById("current-user-label");
        if (label) label.textContent = `${currentUser.username} · ${currentUser.role}`;
        document.querySelectorAll(".admin-only").forEach(node => node.classList.toggle("hidden", currentUser.role !== "admin"));
        const totpButton = document.getElementById("btn-account-security");
        if (totpButton) totpButton.textContent = currentUser.totp_enabled ? "Disable authenticator 2FA" : "Enable authenticator 2FA";

        checkForUpdates().catch(err => console.warn("Update check failed:", err));

        await Promise.allSettled([
            fetchDatabases().catch(err => console.error("fetchDatabases failed:", err)),
            fetchGroups().catch(err => console.error("fetchGroups failed:", err)),
            fetchConnections().catch(err => console.error("fetchConnections failed:", err)),
            fetchHistory().catch(err => console.error("fetchHistory failed:", err))
        ]);

        if (currentUser.role === "admin") {
            await Promise.allSettled([
                fetchUsers().catch(err => console.error("fetchUsers failed:", err)),
                renderGroupsAdmin().catch(err => console.error("renderGroupsAdmin failed:", err))
            ]);
        }

        const activeTab = getActiveTab();
        if (activeTab && activeTab.connectionIds.size === 0 && selectedConnectionIds.size > 0) {
            syncConnectionSelectionToActiveTab();
        }

        if (selectedConnectionIds.size) {
            Promise.all(Array.from(selectedConnectionIds).map(ensureSchemaMetadata))
                .then(() => updateQuerySuggestionsForTab(getActiveTab()))
                .catch(() => {});
        }

        historyRefreshInterval = setInterval(() => { if (currentView === "history-section") fetchHistory(); }, 10000);
    } catch (error) {
        if (!error.message.includes("Authentication required")) showToast(error.message, "error");
    }
}

if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize);
    } else if (typeof cacheDOMElements === "function") {
        initialize();
    } else {
        document.addEventListener("DOMContentLoaded", initialize);
    }
}



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
    queryGroupFilter?.addEventListener("change", renderQueryConnectionPanel);
    queryDbTypeFilter?.addEventListener("change", renderQueryConnectionPanel);
    queryDbSearch?.addEventListener("input", renderQueryConnectionPanel);
    connectionsGroupFilter?.addEventListener("change", renderConnectionsList);
    connectionsDbTypeFilter?.addEventListener("change", renderConnectionsList);
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

    // Schema Explorer controls
    document.getElementById("btn-refresh-schema")?.addEventListener("click", async () => {
        if (selectedConnectionIds.size === 1) {
            const connId = Array.from(selectedConnectionIds)[0];
            schemaMetadataCache.delete(connId);
            showToast("Refreshing schema...", "info");
            await renderSchemaExplorer(connId);
            showToast("Schema refreshed", "success");
        } else {
            showToast("Select a single connection to refresh schema", "info");
        }
    });

    document.getElementById("schema-table-search")?.addEventListener("input", () => {
        if (selectedConnectionIds.size === 1) {
            renderSchemaExplorer(Array.from(selectedConnectionIds)[0]);
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
    const current = (update.version || "").startsWith("v") ? update.version : `v${update.version || ""}`;
    const badge = document.getElementById("app-version-pill");
    const currentVersion = document.getElementById("current-app-version");
    if (currentVersion) currentVersion.textContent = current;
    if (badge) badge.textContent = current;
    const latestVersion = (update.latest_version || "").startsWith("v") ? update.latest_version : `v${update.latest_version || ""}`;
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
    if (log && Array.isArray(update.changelog)) log.innerHTML = update.changelog.map(release => `<li><strong>v${escapeHtml(String(release.version || "").replace(/^v/, ""))}</strong> — ${escapeHtml((release.notes || []).join("; "))}</li>`).join("");
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
    if (viewId === "scheduled-tasks-section") loadScheduledTasks();
    if (viewId === "dashboard-section") loadDashboardMetrics();
    if (viewId === "db-monitor-section") { loadDBMonitorConnections(); loadDBMonitor(); }
    if (viewId === "snippets-section" && window.SnippetsManager) {
        window.SnippetsManager.loadSnippets().then(() => window.SnippetsManager.renderSnippetsPanel());
    }
    if (viewId === "saved-queries-section") loadSavedQueries();
    if (viewId === "schema-diff-section") populateDiffConnectionSelects();
    if (viewId === "users-section" && currentUser?.role === "admin") fetchUsers();
    if (viewId === "groups-section" && currentUser?.role === "admin") renderGroupsAdmin();
    if (viewId === "settings-section") checkForUpdates();
    if (viewId === "connections-section") {
        renderConnectionsList();
    }
    if (viewId === "query-section") {
        renderQueryTabs();
        renderTabPanels();
        renderQueryConnectionPanel();
        const activeTab = getActiveTab();
        if (activeTab) {
            loadTabConnectionSelection(activeTab);
            if (activeTab.editorInstance) {
                setTimeout(() => activeTab.editorInstance.focus(), 50);
            }
        }
    }
}

async function fetchDatabases() {
    try {
        databases = await apiFetch("/api/databases");
    } catch (error) {
        console.error("fetchDatabases failed:", error);
        databases = [];
    }
    if (!Array.isArray(databases)) databases = [];
    if (connDbTypeSelect) {
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
    }
    if (queryDbTypeFilter) {
        const current = queryDbTypeFilter.value || "all";
        queryDbTypeFilter.innerHTML = '<option value="all">All Types</option>';
        databases.forEach(db => { const option = document.createElement("option"); option.value = db.type; option.textContent = db.name; queryDbTypeFilter.appendChild(option); });
        queryDbTypeFilter.value = [...queryDbTypeFilter.options].some(option => option.value === current) ? current : "all";
    }
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
async function fetchGroups() {
    try {
        groups = await apiFetch("/api/groups");
    } catch (error) {
        console.error("fetchGroups failed:", error);
        groups = [];
    }
    if (!Array.isArray(groups)) groups = [];
    populateGroupControls();
}
async function fetchConnections() {
    try {
        connections = await apiFetch("/api/connections");
    } catch (error) {
        console.error("fetchConnections failed:", error);
        connections = [];
    }
    if (!Array.isArray(connections)) connections = [];
    renderConnectionsList();
    renderQueryConnectionPanel();
    populateGroupControls();
}
function populateGroupControls() {
    const currentFilter = queryGroupFilter?.value || "all";
    const selected = new Set(Array.from(connGroupSelect?.selectedOptions || []).map(option => Number(option.value)));
    if (connGroupSelect) {
        connGroupSelect.innerHTML = "";
        (groups || []).forEach(group => { const option = new Option(group.name, group.id); option.selected = selected.has(group.id); connGroupSelect.appendChild(option); });
    }
    if (queryGroupFilter) {
        queryGroupFilter.innerHTML = '<option value="all">All Groups</option><option value="ungrouped">Ungrouped</option>';
        (groups || []).forEach(group => queryGroupFilter.appendChild(new Option(group.name, group.id)));
        queryGroupFilter.value = [...queryGroupFilter.options].some(option => option.value === currentFilter) ? currentFilter : "all";
    }
    if (connectionsGroupFilter) {
        const listValue = connectionsGroupFilter.value || "all";
        connectionsGroupFilter.innerHTML = '<option value="all">All Groups</option><option value="ungrouped">Ungrouped</option>';
        (groups || []).forEach(group => connectionsGroupFilter.appendChild(new Option(group.name, group.id)));
        connectionsGroupFilter.value = [...connectionsGroupFilter.options].some(option => option.value === listValue) ? listValue : "all";
    }
}
function visibleConnections() {
    const group = queryGroupFilter?.value || "all", type = queryDbTypeFilter?.value || "all";
    const search = (queryDbSearch?.value || "").trim().toLocaleLowerCase();
    return (connections || []).filter(connection => {
        const groupIds = connection.group_ids || [];
        const groupMatch = group === "all" || (group === "ungrouped" ? !groupIds.length : groupIds.includes(Number(group)));
        const typeMatch = type === "all" || connection.db_type === type;
        const searchMatch = !search || [connection.name, connection.database, connection.host, connection.username]
            .some(value => String(value || "").toLocaleLowerCase().includes(search));
        return groupMatch && typeMatch && searchMatch;
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
        ensureSchemaMetadata(items[0].id);
    }
    if (selectedConnectionIds.size === 1) {
        const singleId = Array.from(selectedConnectionIds)[0];
        ensureSchemaMetadata(singleId);
        renderSchemaExplorer(singleId);
    } else {
        renderSchemaExplorer(null);
    }
    items.forEach(connection => {
        const item = document.createElement("button");
        item.type = "button";
        const isSelected = selectedConnectionIds.has(connection.id);
        item.className = `connection-panel-item${isSelected ? " selected" : ""}`;
        item.dataset.connectionId = connection.id;
        const isSafe = Boolean(connection.extra_params && connection.extra_params.safe_mode);
        const isStrictRo = Boolean(connection.extra_params && connection.extra_params.strict_read_only);
        const safeBadge = isSafe ? '<span class="conn-safe-badge" title="Safe Mode enabled">🛡️</span>' : '';
        const roBadge = isStrictRo ? '<span class="conn-safe-badge" title="Strict Read-Only enabled">🔒</span>' : '';
        item.innerHTML = `<span class="connection-panel-info"><span class="connection-panel-name">${escapeHtml(connection.name)}</span>${safeBadge}${roBadge}</span><span class="connection-panel-check">${isSelected ? "✓" : ""}</span>`;
        item.addEventListener("click", () => {
            if (selectedConnectionIds.has(connection.id)) {
                selectedConnectionIds.delete(connection.id);
                scheduleWorkspaceSave();
            } else {
                selectedConnectionIds.add(connection.id);
                scheduleWorkspaceSave();
                ensureSchemaMetadata(connection.id);
            }
            renderQueryConnectionPanel();
            syncConnectionSelectionToActiveTab();
        });
        connectionsPanelList.appendChild(item);
    });
    syncConnectionSelectionToActiveTab();
}
function renderConnectionsList() {
    if (!connectionsListContainer) return;
    connectionsListContainer.innerHTML = "";
    const groupFilter = connectionsGroupFilter?.value || "all";
    const dbTypeFilter = connectionsDbTypeFilter?.value || "all";
    const searchTerm = (connectionsSearchInput?.value || "").trim().toLocaleLowerCase();
    const visible = (connections || []).filter(connection => {
        const groupIds = connection.group_ids || [];
        const groupMatch = groupFilter === "all" || (groupFilter === "ungrouped" ? !groupIds.length : groupIds.includes(Number(groupFilter)));
        const searchMatch = !searchTerm || [connection.name, connection.host, connection.database, connection.username, connection.db_type]
            .some(value => String(value || "").toLocaleLowerCase().includes(searchTerm));
        return groupMatch && searchMatch && (dbTypeFilter === "all" || connection.db_type === dbTypeFilter);
    });
    if (!visible.length) { connectionsListContainer.innerHTML = '<div class="empty-state"><p>No authorized connections match the current filters.</p></div>'; return; }
    const byGroup = new Map();
    visible.forEach(connection => {
        const assignedGroups = groupFilter !== "all" && groupFilter !== "ungrouped"
            ? (groups || []).filter(group => group.id === Number(groupFilter))
            : (connection.groups || []);
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
                ? (groups || []).filter(group => group.id === Number(groupFilter))
                : (connection.groups || []);
            const groupLabels = (assignedGroups || []).map(group => `<span class="connection-group-badge">${escapeHtml(group.name)}</span>`).join("");
            const safeLabel = connection.extra_params?.safe_mode ? '<span class="connection-group-badge safe-mode-badge" title="Safe Mode enabled">🛡️ Safe</span>' : '';
            card.innerHTML = `<div class="connection-header"><h4>${escapeHtml(connection.name)}</h4><span class="db-type-badge">${escapeHtml(connection.db_type)}</span>${groupLabels}${safeLabel}</div><div class="connection-details"><p><strong>Host:</strong> ${escapeHtml(connection.host || "N/A")}</p><p><strong>Port:</strong> ${escapeHtml(connection.port || "Default")}</p><p><strong>Database:</strong> ${escapeHtml(connection.database || "N/A")}</p><p><strong>Username:</strong> ${escapeHtml(connection.username || "N/A")}</p><p><strong>Password:</strong> ${connection.has_password ? "Saved (hidden)" : "Not set"}</p></div><div class="connection-actions"><button class="btn btn-icon btn-sm" data-action="test">Test</button>${currentUser?.role === "admin" ? `<button class="btn btn-icon btn-sm" data-action="edit">Edit</button><button class="btn btn-icon btn-sm danger" data-action="delete">Delete</button>` : ""}<button class="btn btn-icon btn-sm" data-action="use">Use</button></div>`;
            card.querySelector('[data-action="test"]')?.addEventListener("click", () => testConnection(connection.id));
            card.querySelector('[data-action="use"]')?.addEventListener("click", () => useConnection(connection.id));
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
        const safeModeEl = document.getElementById("conn-safe-mode");
        if (safeModeEl) safeModeEl.checked = Boolean(connection.extra_params?.safe_mode);
        const strictRoEl = document.getElementById("conn-strict-read-only");
        if (strictRoEl) strictRoEl.checked = Boolean(connection.extra_params?.strict_read_only);
        Array.from(connGroupSelect.options).forEach(option => { option.selected = connection.group_ids.includes(Number(option.value)); });
    } else {
        const defaultType = databases.find(database => database.available)?.type || databases[0]?.type || "";
        connDbTypeSelect.value = defaultType;
        applyDatabaseDefaults(defaultType);
        const safeModeEl = document.getElementById("conn-safe-mode");
        if (safeModeEl) safeModeEl.checked = false;
        const strictRoEl = document.getElementById("conn-strict-read-only");
        if (strictRoEl) strictRoEl.checked = false;
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
    const safeModeEl = document.getElementById("conn-safe-mode");
    if (safeModeEl && safeModeEl.checked) {
        extra.safe_mode = true;
    } else if (extra.safe_mode) {
        delete extra.safe_mode;
    }
    const strictRoEl = document.getElementById("conn-strict-read-only");
    if (strictRoEl && strictRoEl.checked) {
        extra.strict_read_only = true;
    } else if (extra.strict_read_only) {
        delete extra.strict_read_only;
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
    const tab = getTabById(tabId) || getActiveTab();
    if (!tab) return;
    ensureTabElementReferences(tab);

    // Get SQL from selection or full CodeMirror / fallback textarea
    let sql = "";
    let isSelectedOnly = false;
    if (tab.editorView) {
        const from = tab.editorView.state.selection.main.from;
        const to = tab.editorView.state.selection.main.to;
        if (from !== to) {
            const selectedText = tab.editorView.state.sliceDoc(from, to).trim();
            if (selectedText) {
                sql = selectedText;
                isSelectedOnly = true;
            }
        }
        if (!sql) {
            sql = tab.editorView.state.doc.toString().trim();
        }
    } else if (tab.editorElement) {
        const start = tab.editorElement.selectionStart;
        const end = tab.editorElement.selectionEnd;
        if (start !== end) {
            const selectedText = tab.editorElement.value.substring(start, end).trim();
            if (selectedText) {
                sql = selectedText;
                isSelectedOnly = true;
            }
        }
        if (!sql) {
            sql = tab.editorElement.value.trim();
        }
    }

    if (!sql) return showToast("Enter a SQL query first", "warning");
    if (tab.connectionIds.size === 0) return showToast("Select at least one connection", "warning");

    // Safe mode protection
    const safeConnections = Array.from(tab.connectionIds)
        .map(id => (connections || []).find(c => c.id === id))
        .filter(c => c && c.extra_params && c.extra_params.safe_mode);

    if (safeConnections.length > 0) {
        const isDestructive = /\b(DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b/i.test(sql) || (/\bUPDATE\b/i.test(sql) && !/\bWHERE\b/i.test(sql));
        if (isDestructive) {
            const names = safeConnections.map(c => c.name).join(", ");
            const confirmed = window.confirm(
                `🛡️ Safe Mode Warning:\n` +
                `Connection(s) [${names}] have Safe Mode enabled.\n` +
                `The following potentially destructive statement was detected:\n\n` +
                `"${sql.length > 150 ? sql.substring(0, 150) + "..." : sql}"\n\n` +
                `Do you want to proceed with execution?`
            );
            if (!confirmed) {
                return showToast("Execution cancelled by Safe Mode guard", "info");
            }
        }
    }

    if (isSelectedOnly) {
        showToast("Executing selected SQL snippet...", "info");
    }

    const executionId = "exec-" + Date.now() + "-" + Math.random().toString(36).substring(2, 8);
    tab.currentExecutionId = executionId;
    tab.isExecuting = true;

    if (tab.executeBtn) {
        tab.executeBtn.disabled = false;
        tab.executeBtn.classList.remove("btn-accent");
        tab.executeBtn.classList.add("btn-danger");
    }
    if (tab.executeText) tab.executeText.textContent = "Cancel";
    tab.executeSpinner?.classList.remove("hidden");
    tab.resultsPlaceholder?.classList.add("hidden");
    tab.singleResultContainer?.classList.add("hidden");
    if (tab.singleResultContainer) tab.singleResultContainer.innerHTML = "";
    tab.multiResultsContainer?.classList.add("hidden");
    if (tab.multiResultsContainer) tab.multiResultsContainer.innerHTML = "";
    tab.chartContainer?.classList.add("hidden");
    tab.errorContainer?.classList.add("hidden");
    tab.editActions?.classList.add("hidden");
    if (tab.btnExportCsv) tab.btnExportCsv.disabled = true;

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
                if (!tab.isExecuting) break;
                try {
                    const result = await apiFetch("/api/query", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ connection_id: connId, query: sql, limit, parameters, execution_id: executionId })
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
                body: JSON.stringify({ connection_id: connId, query: sql, limit, parameters, execution_id: executionId })
            });
            renderSingleResult(tab, connId, result);
        }
    } catch (error) {
        tab.resultsPlaceholder?.classList.add("hidden");
        tab.singleResultContainer?.classList.add("hidden");
        tab.multiResultsContainer?.classList.add("hidden");
        if (tab.errorMessage) tab.errorMessage.textContent = error.message;
        tab.errorContainer?.classList.remove("hidden");
        if (tab.resultCount) tab.resultCount.textContent = "0 rows";
        if (tab.executionTime) tab.executionTime.textContent = "0 ms";
        showToast(`Query failed: ${error.message}`, "error");
    } finally {
        tab.isExecuting = false;
        tab.currentExecutionId = null;
        if (tab.executeBtn) {
            tab.executeBtn.disabled = false;
            tab.executeBtn.classList.remove("btn-danger");
            tab.executeBtn.classList.add("btn-accent");
        }
        if (tab.executeText) tab.executeText.textContent = "Execute";
        tab.executeSpinner?.classList.add("hidden");
    }
}

function renderSingleResult(tab, connId, result) {
    ensureTabElementReferences(tab);
    const connection = (connections || []).find(c => c.id === connId);
    const dbName = connection?.name || connId;

    tab.resultsPlaceholder?.classList.add("hidden");
    tab.multiResultsContainer?.classList.add("hidden");
    tab.errorContainer?.classList.add("hidden");

    // Build editable grid
    const { html, editContext, rowCount, columns, rows } = buildEditableGrid(result, tab.id, connId);
    tab.currentEditContext = editContext;
    tab.currentResultData = { columns, rows };
    if (tab.resultCount) tab.resultCount.textContent = `${rowCount} row${rowCount !== 1 ? "s" : ""}`;
    if (tab.executionTime) tab.executionTime.textContent = `${result.execution_time_ms || 0} ms`;

    if (editContext && (currentUser?.role === "admin" || currentUser?.role === "writer")) {
        tab.editActions?.classList.remove("hidden");
        const btnApply = document.getElementById(`btn-apply-result-edits-${tab.id}`);
        if (btnApply) {
            btnApply.textContent = "Apply";
            btnApply.disabled = true;
        }
        const btnRevert = document.getElementById(`btn-revert-result-edits-${tab.id}`);
        if (btnRevert) btnRevert.disabled = true;
    } else {
        tab.editActions?.classList.add("hidden");
    }
    if (tab.btnExportCsv) tab.btnExportCsv.disabled = rowCount === 0;
    tab.currentExportData = { columns, rows };

    // Save HTML to tab for persistence when switching tabs
    tab.resultHtml = html;
    tab.multiResultHtml = null;

    if (tab.singleResultContainer) {
        tab.singleResultContainer.innerHTML = html;
        tab.singleResultContainer.classList.remove("hidden");
        tab.singleResultContainer.querySelectorAll("td[contenteditable='true']").forEach(cell => {
            cell.addEventListener("blur", e => handleCellEdit(tab, e));
        });
        if (window.InlineEditingManager) {
            window.InlineEditingManager.initializeInlineEditing(tab);
        }
        tab.singleResultContainer.querySelectorAll("thead th[data-column]").forEach((th, colIdx) => {
            th.addEventListener("click", () => {
                const colName = th.dataset.column;
                applySortToResults(tab.id, colIdx, colName);
            });
        });
        renderSummaryFooter(tab.id);
    }
}

function renderMultiResults(tab, results) {
    ensureTabElementReferences(tab);
    tab.resultsPlaceholder?.classList.add("hidden");
    tab.singleResultContainer?.classList.add("hidden");
    if (tab.singleResultContainer) tab.singleResultContainer.innerHTML = "";
    tab.errorContainer?.classList.add("hidden");
    tab.multiResultsContainer?.classList.remove("hidden");
    if (tab.multiResultsContainer) tab.multiResultsContainer.innerHTML = "";
    tab.editActions?.classList.add("hidden");
    if (tab.btnExportCsv) tab.btnExportCsv.disabled = true;

    let totalRows = 0;
    let multiHtml = "";
    results.forEach(r => {
        const connection = (connections || []).find(c => c.id === r.connectionId);
        const dbName = connection?.name || r.connectionId;

        const section = document.createElement("div");
        section.className = "multi-result-section";

        if (r.success) {
            const { html, rowCount } = buildEditableGrid(r.data, tab.id, r.connectionId);
            totalRows += rowCount;
            const execTime = r.data?.execution_time_ms;
            const sectionHtml = `
                <div class="multi-result-header">
                    <div class="multi-result-db-name">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                        <span>${escapeHtml(dbName)}</span>
                    </div>
                    <div class="multi-result-meta">
                        <span class="badge">${rowCount} row${rowCount !== 1 ? "s" : ""}</span>
                        ${execTime !== undefined ? `<span class="badge">${execTime} ms</span>` : ""}
                    </div>
                </div>
                <div class="table-scroll-container">${html}</div>
            `;
            section.innerHTML = sectionHtml;
            multiHtml += sectionHtml;
        } else {
            const sectionHtml = `
                <div class="multi-result-header error-header">
                    <div class="multi-result-db-name">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                        <span>${escapeHtml(dbName)}</span>
                    </div>
                    <div class="multi-result-meta">
                        <span class="badge badge-error">Failed</span>
                    </div>
                </div>
                <div class="error-container" style="padding: 1rem;">
                    <pre>${escapeHtml(r.error || "Unknown error")}</pre>
                </div>
            `;
            section.innerHTML = sectionHtml;
            multiHtml += sectionHtml;
        }
        tab.multiResultsContainer?.appendChild(section);
    });

    // Save HTML to tab for persistence when switching tabs
    tab.multiResultHtml = multiHtml;
    tab.resultHtml = null;

    if (tab.resultCount) tab.resultCount.textContent = `${totalRows} total row${totalRows !== 1 ? "s" : ""}`;
    if (tab.executionTime) tab.executionTime.textContent = `${results.reduce((sum, r) => sum + (r.data?.execution_time_ms || 0), 0)} ms`;
}

function buildEditableGrid(data, tabId, connId) {
    // Handle both full result object (has data.columns, data.data) and direct result
    const result = data?.data ? data : { data: data };
    const columns = result.data?.columns || result.columns;
    const rows = result.data?.data || result.rows || result.data || [];

    if (!columns || !rows) return { html: '<div class="empty-state table-empty-state"><p>No data returned</p></div>', editContext: null, rowCount: 0, columns: [], rows: [] };

    const rowCount = rows.length;

    if (rowCount === 0) return { html: '<div class="empty-state table-empty-state"><p>No rows returned</p></div>', editContext: null, rowCount: 0, columns, rows };
    
    // Determine if editable (single connection, simple SELECT with PK)
    const activeTab = getTabById(tabId);
    const isEditable = activeTab?.connectionIds.size === 1 &&
                       result.edit_context?.editable &&
                       (currentUser?.role === "admin" || currentUser?.role === "writer");

    let editContext = null;
    if (isEditable && result.edit_context) {
        editContext = {
            connection_id: connId || Array.from(activeTab?.connectionIds || [])[0],
            query: activeTab?.query || "",
            table: result.edit_context.table,
            key_column: result.edit_context.key_column,
            columns: columns
        };
    }

    // Detect column data types based on non-null row values
    const columnTypes = {};
    const sampleLimit = Math.min(rows.length, 100);
    columns.forEach(col => {
        let hasNonNull = false;
        let allNumber = true;
        let isInteger = true;
        let allBoolean = true;
        let allDate = true;

        for (let i = 0; i < sampleLimit; i++) {
            const val = rows[i]?.[col];
            if (val === null || val === undefined) continue;
            hasNonNull = true;

            if (typeof val !== "boolean") {
                allBoolean = false;
            }

            if (typeof val === "number") {
                if (!Number.isInteger(val)) isInteger = false;
            } else if (typeof val === "string" && val.trim() !== "" && !isNaN(Number(val)) && !isNaN(parseFloat(val))) {
                if (!/^-?\d+$/.test(val.trim())) isInteger = false;
            } else {
                allNumber = false;
            }

            if (typeof val === "string") {
                const isIsoDate = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(val.trim());
                if (!isIsoDate) allDate = false;
            } else {
                allDate = false;
            }
        }

        if (!hasNonNull) {
            columnTypes[col] = "text";
        } else if (allBoolean) {
            columnTypes[col] = "boolean";
        } else if (allNumber) {
            columnTypes[col] = isInteger ? "integer" : "float";
        } else if (allDate) {
            columnTypes[col] = "date";
        } else {
            columnTypes[col] = "text";
        }
    });
    
    // Build table HTML
    let html = `<table class="excel-grid"><thead><tr>`;
    html += `<th class="col-index" title="Row Index">#</th>`;
    columns.forEach((col, colIdx) => {
        const type = columnTypes[col] || "text";
        let alignClass = "col-text";
        if (type === "integer" || type === "float") alignClass = "col-number";
        else if (type === "boolean") alignClass = "col-center";
        else if (type === "date") alignClass = "col-date";
        html += `<th class="${alignClass}" data-column="${escapeHtml(col)}" data-type="${type}">${escapeHtml(col)}</th>`;
    });
    html += `</tr></thead><tbody>`;
    
    rows.forEach((row, rowIdx) => {
        html += `<tr>`;
        html += `<td class="row-index" title="Row ${rowIdx + 1}">${rowIdx + 1}</td>`;
        columns.forEach((col, colIdx) => {
            const value = row[col];
            const type = columnTypes[col] || "text";

            let displayValue = "";
            let isNull = false;
            if (value === null || value === undefined) {
                displayValue = '<span class="null-badge">NULL</span>';
                isNull = true;
            } else if (typeof value === "boolean") {
                displayValue = `<span class="bool-badge bool-${value}">${value}</span>`;
            } else if (type === "integer" || type === "float") {
                displayValue = `<span class="num-val">${escapeHtml(String(value))}</span>`;
            } else if (type === "date") {
                displayValue = `<span class="date-val">${escapeHtml(String(value))}</span>`;
            } else {
                displayValue = escapeHtml(String(value));
            }

            const editable = isEditable && col !== editContext?.key_column ? ' contenteditable="true" data-editable="true"' : "";
            const keyAttr = col === editContext?.key_column ? ` data-key="${escapeHtml(String(value))}"` : "";
            const colTypeClass = `type-${type} col-type-${type}${isNull ? " is-null" : ""}`;
            html += `<td class="${colTypeClass}"${editable}${keyAttr} data-column="${escapeHtml(col)}" data-column-index="${colIdx}" data-row-index="${rowIdx}">${displayValue}</td>`;
        });
        html += `</tr>`;
    });
    html += `</tbody></table>`;
    
    return { html, editContext, rowCount, columns, rows };
}

function handleCellEdit(tab, event) {
    const cell = event.target;
    if (cell.classList.contains("row-index")) return;
    const row = cell.closest("tr");
    const keyCell = row?.querySelector("[data-key]");
    const keyValue = keyCell?.dataset.key;
    const columnIdx = cell.dataset.columnIndex !== undefined ? parseInt(cell.dataset.columnIndex, 10) : cell.cellIndex;
    const columnName = cell.dataset.column || tab.currentResultData?.columns?.[columnIdx] || cell.closest("table")?.querySelectorAll("th")[cell.cellIndex]?.textContent;
    const newValue = cell.textContent.trim() === "NULL" ? null : cell.textContent;
    const rowIdx = cell.dataset.rowIndex !== undefined ? parseInt(cell.dataset.rowIndex, 10) : (row ? row.rowIndex - 1 : 0);
    const originalRow = tab.currentResultData?.rows?.[rowIdx];
    const originalValue = originalRow?.[columnName];
    
    const editKey = `${rowIdx}:${columnIdx}`;
    if (originalValue !== newValue) {
        tab.pendingEdits.set(editKey, {
            key_value: keyValue,
            keyValue: keyValue,
            column: columnName,
            columnName: columnName,
            value: newValue,
            newValue: newValue,
            originalValue: originalValue
        });
    } else {
        tab.pendingEdits.delete(editKey);
    }
    const count = tab.pendingEdits.size;
    const btnApply = document.getElementById(`btn-apply-result-edits-${tab.id}`);
    if (btnApply) {
        btnApply.textContent = count > 0 ? `Apply (${count})` : "Apply";
        btnApply.disabled = count === 0;
    }
    const btnRevert = document.getElementById(`btn-revert-result-edits-${tab.id}`);
    if (btnRevert) {
        btnRevert.disabled = count === 0;
    }
}

async function applyResultEdits(tabId) {
    const tab = getTabById(tabId);
    if (!tab) return;
    
    const edits = Array.from(tab.pendingEdits.values());
    if (edits.length === 0) return;
    
    const firstEdit = edits[0];
    if (!firstEdit.keyValue && firstEdit.key_value === undefined) {
        return showToast("Cannot identify rows to update (missing key column)", "error");
    }
    
    const connId = tab.currentEditContext?.connection_id || Array.from(tab.connectionIds)[0];
    const query = tab.currentEditContext?.query || tab.query;
    if (!connId || !query) {
        return showToast("Missing connection or query for edit application", "error");
    }
    
    try {
        const payloadEdits = edits.map(e => ({
            key_value: e.key_value ?? e.keyValue,
            column: typeof e.column === "string" ? e.column : (e.columnName || tab.currentResultData?.columns?.[e.column]),
            value: e.value !== undefined ? e.value : e.newValue
        }));
        
        const result = await apiFetch("/api/query/edits", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                connection_id: connId,
                query: query,
                edits: payloadEdits
            })
        });
        showToast(`Applied ${result.updated} change${result.updated !== 1 ? "s" : ""}`, "success");
        tab.pendingEdits.clear();
        const btnApply = document.getElementById(`btn-apply-result-edits-${tab.id}`);
        if (btnApply) {
            btnApply.textContent = "Apply";
            btnApply.disabled = true;
        }
        const btnRevert = document.getElementById(`btn-revert-result-edits-${tab.id}`);
        if (btnRevert) btnRevert.disabled = true;
        if (window.InlineEditingManager) {
            window.InlineEditingManager.cleanupInlineEditing(tab.id);
        }
        executeQuery(tab.id); // Re-execute to refresh
    } catch (error) {
        showToast(`Apply failed: ${error.message}`, "error");
    }
}

function revertResultEdits(tabId) {
    const tab = getTabById(tabId);
    if (!tab) return;
    tab.pendingEdits.clear();
    const btnApply = document.getElementById(`btn-apply-result-edits-${tab.id}`);
    if (btnApply) {
        btnApply.textContent = "Apply";
        btnApply.disabled = true;
    }
    const btnRevert = document.getElementById(`btn-revert-result-edits-${tab.id}`);
    if (btnRevert) btnRevert.disabled = true;
    if (window.InlineEditingManager) {
        window.InlineEditingManager.cleanupInlineEditing(tab.id);
    }
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

async function cancelCurrentQuery(tabId) {
    const tab = getTabById(tabId);
    if (!tab || !tab.isExecuting) return;
    if (tab.currentExecutionId) {
        showToast("Cancelling query...", "info");
        try {
            await apiFetch("/api/query/cancel", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ execution_id: tab.currentExecutionId })
            });
            showToast("Cancellation signal sent", "info");
        } catch (err) {
            console.warn("Cancel request error:", err);
        }
    }
    tab.isExecuting = false;
    tab.currentExecutionId = null;
    if (tab.executeBtn) {
        tab.executeBtn.classList.remove("btn-danger");
        tab.executeBtn.classList.add("btn-accent");
    }
    if (tab.executeText) tab.executeText.textContent = "Execute";
    tab.executeSpinner?.classList.add("hidden");
}

async function explainQuery(tabId) {
    const tab = getTabById(tabId);
    if (!tab) return;
    ensureTabElementReferences(tab);

    let sql = "";
    if (tab.editorView) {
        const from = tab.editorView.state.selection.main.from;
        const to = tab.editorView.state.selection.main.to;
        if (from !== to) {
            sql = tab.editorView.state.sliceDoc(from, to).trim();
        }
        if (!sql) {
            sql = tab.editorView.state.doc.toString().trim();
        }
    } else if (tab.editorElement) {
        const start = tab.editorElement.selectionStart;
        const end = tab.editorElement.selectionEnd;
        if (start !== end) {
            sql = tab.editorElement.value.substring(start, end).trim();
        }
        if (!sql) {
            sql = tab.editorElement.value.trim();
        }
    }

    if (!sql) return showToast("Enter a SQL query first to explain", "warning");
    if (tab.connectionIds.size === 0) return showToast("Select a connection first", "warning");
    if (tab.connectionIds.size > 1) return showToast("EXPLAIN requires selecting a single connection", "warning");

    const connId = Array.from(tab.connectionIds)[0];
    const explainSql = /^EXPLAIN\b/i.test(sql) ? sql : `EXPLAIN ${sql}`;

    showToast("Generating query execution plan...", "info");
    try {
        const result = await apiFetch("/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connection_id: connId, query: explainSql, limit: 200 })
        });
        renderSingleResult(tab, connId, result);
        showToast("Execution plan generated", "success");
    } catch (err) {
        showToast(`Explain failed: ${err.message}`, "error");
    }
}

function applyResultFilter(tab, filterText) {
    if (!tab || !tab.singleResultContainer) return;
    const table = tab.singleResultContainer.querySelector("table.excel-grid");
    if (!table) return;

    const term = (filterText || "").trim().toLowerCase();
    const rows = table.querySelectorAll("tbody tr");
    if (!rows.length) return;

    let visibleCount = 0;
    rows.forEach(tr => {
        if (!term) {
            tr.style.display = "";
            visibleCount++;
        } else {
            const text = tr.textContent.toLowerCase();
            const matches = text.includes(term);
            tr.style.display = matches ? "" : "none";
            if (matches) visibleCount++;
        }
    });

    if (tab.resultCount) {
        const total = tab.currentResultData?.rows?.length || rows.length;
        if (!term) {
            tab.resultCount.textContent = `${total} row${total !== 1 ? "s" : ""}`;
        } else {
            tab.resultCount.textContent = `${visibleCount} of ${total} row${total !== 1 ? "s" : ""}`;
        }
    }
}

function renderChartForTab(tabId) {
    const tab = getTabById(tabId);
    if (!tab || !tab.chartCanvas) return;
    ensureTabElementReferences(tab);

    const data = tab.currentResultData;
    if (!data || !data.columns || !data.rows || data.rows.length === 0) {
        const ctx = tab.chartCanvas.getContext("2d");
        ctx.clearRect(0, 0, tab.chartCanvas.width, tab.chartCanvas.height);
        ctx.fillStyle = document.documentElement.dataset.theme === "dark" ? "#94a3b8" : "#64748b";
        ctx.font = "14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("No data available to chart. Execute a query with rows first.", tab.chartCanvas.width / 2, tab.chartCanvas.height / 2);
        return;
    }

    const { columns, rows } = data;

    const currentX = tab.chartXSelect?.value;
    const currentY = tab.chartYSelect?.value;
    const optionsHtml = columns.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

    if (tab.chartXSelect && tab.chartYSelect) {
        if (tab.chartXSelect.options.length !== columns.length) {
            tab.chartXSelect.innerHTML = optionsHtml;
            tab.chartYSelect.innerHTML = optionsHtml;

            tab.chartXSelect.value = columns[0];
            let foundNumeric = false;
            for (const col of columns) {
                if (rows.some(r => typeof r[col] === "number" || (!isNaN(Number(r[col])) && r[col] !== null && r[col] !== ""))) {
                    if (col !== columns[0]) {
                        tab.chartYSelect.value = col;
                        foundNumeric = true;
                        break;
                    }
                }
            }
            if (!foundNumeric && columns.length > 1) {
                tab.chartYSelect.value = columns[1];
            }
        } else {
            if (currentX && columns.includes(currentX)) tab.chartXSelect.value = currentX;
            if (currentY && columns.includes(currentY)) tab.chartYSelect.value = currentY;
        }
    }

    const chartType = tab.chartTypeSelect?.value || "bar";
    const xCol = tab.chartXSelect?.value || columns[0];
    const yCol = tab.chartYSelect?.value || (columns[1] || columns[0]);

    drawCanvasChart(tab.chartCanvas, chartType, xCol, yCol, rows);
}

function drawCanvasChart(canvas, type, xCol, yCol, rows) {
    if (!canvas || !rows || !rows.length) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width > 50 ? rect.width : (canvas.width || 800);
    const height = rect.height > 50 ? rect.height : (canvas.height || 360);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const ctx = canvas.getContext("2d");
    if (ctx.resetTransform) ctx.resetTransform();
    ctx.scale(dpr, dpr);

    const isDark = document.documentElement.dataset.theme === "dark";
    const bgFill = isDark ? "#0f172a" : "#ffffff";
    const textFill = isDark ? "#cbd5e1" : "#334155";
    const subTextFill = isDark ? "#64748b" : "#94a3b8";
    const gridLineFill = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.08)";

    ctx.fillStyle = bgFill;
    ctx.fillRect(0, 0, width, height);

    const maxItems = 30;
    const chartRows = rows.slice(0, maxItems);

    const labels = chartRows.map((r, i) => {
        const val = r[xCol];
        if (val === null || val === undefined) return `Item ${i + 1}`;
        const str = String(val);
        return str.length > 14 ? str.substring(0, 12) + "…" : str;
    });

    const values = chartRows.map(r => {
        const val = r[yCol];
        const num = Number(val);
        return isNaN(num) ? 0 : num;
    });

    const palette = [
        "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
        "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#14b8a6",
        "#6366f1", "#eab308", "#a855f7", "#22c55e", "#0ea5e9"
    ];

    if (type === "pie" || type === "doughnut") {
        const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
        const centerX = width * 0.38;
        const centerY = height * 0.5;
        const radius = Math.min(centerX, centerY) * 0.78;
        const innerRadius = type === "doughnut" ? radius * 0.52 : 0;

        if (total <= 0) {
            ctx.fillStyle = subTextFill;
            ctx.font = "14px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("All values are zero or non-numeric", centerX, centerY);
            return;
        }

        let startAngle = -Math.PI / 2;
        values.forEach((val, i) => {
            const sliceAngle = (Math.max(0, val) / total) * 2 * Math.PI;
            const endAngle = startAngle + sliceAngle;
            const color = palette[i % palette.length];

            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, startAngle, endAngle);
            if (innerRadius > 0) {
                ctx.arc(centerX, centerY, innerRadius, endAngle, startAngle, true);
            } else {
                ctx.lineTo(centerX, centerY);
            }
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = bgFill;
            ctx.lineWidth = 2;
            ctx.stroke();

            startAngle = endAngle;
        });

        // Legend on the right side
        const legendX = width * 0.70;
        const legendCount = Math.min(values.length, 12);
        let legendY = Math.max(25, centerY - (legendCount * 22) / 2);
        ctx.textAlign = "left";
        ctx.font = "12px sans-serif";

        for (let i = 0; i < legendCount; i++) {
            const color = palette[i % palette.length];
            const pct = ((Math.max(0, values[i]) / total) * 100).toFixed(1);

            ctx.fillStyle = color;
            ctx.fillRect(legendX, legendY - 9, 12, 12);

            ctx.fillStyle = textFill;
            ctx.fillText(`${labels[i]}: ${values[i]} (${pct}%)`, legendX + 18, legendY);
            legendY += 22;
        }
        if (values.length > 12) {
            ctx.fillStyle = subTextFill;
            ctx.fillText(`+ ${values.length - 12} more items`, legendX + 18, legendY);
        }
        return;
    }

    // Bar / Line Chart coordinates
    const paddingLeft = 60;
    const paddingRight = 30;
    const paddingTop = 30;
    const paddingBottom = 55;

    const plotWidth = width - paddingLeft - paddingRight;
    const plotHeight = height - paddingTop - paddingBottom;

    const maxVal = Math.max(0, ...values);
    const minVal = Math.min(0, ...values);
    const niceMax = maxVal === 0 && minVal === 0 ? 10 : (maxVal <= 0 ? 0 : maxVal * 1.15);

    // Draw grid lines and Y-axis scale
    const steps = 5;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    for (let s = 0; s <= steps; s++) {
        const yFrac = s / steps;
        const yVal = (minVal + (niceMax - minVal) * (1 - yFrac));
        const py = paddingTop + yFrac * plotHeight;

        ctx.strokeStyle = gridLineFill;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(paddingLeft, py);
        ctx.lineTo(width - paddingRight, py);
        ctx.stroke();

        ctx.fillStyle = subTextFill;
        ctx.fillText(Number(yVal.toFixed(1)).toLocaleString(), paddingLeft - 8, py + 4);
    }

    // Baseline (Y=0)
    const zeroY = paddingTop + (1 - (0 - minVal) / ((niceMax - minVal) || 1)) * plotHeight;
    ctx.strokeStyle = subTextFill;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(paddingLeft, zeroY);
    ctx.lineTo(width - paddingRight, zeroY);
    ctx.stroke();

    const count = values.length;
    if (count === 0) return;

    if (type === "bar") {
        const slotWidth = plotWidth / count;
        const barWidth = Math.max(8, Math.min(48, slotWidth * 0.65));

        values.forEach((val, i) => {
            const px = paddingLeft + i * slotWidth + (slotWidth - barWidth) / 2;
            const h = ((val - Math.min(0, minVal)) / ((niceMax - Math.min(0, minVal)) || 1)) * plotHeight;
            const py = zeroY - h;

            const color = palette[i % palette.length];
            ctx.fillStyle = color;
            ctx.fillRect(px, py, barWidth, h);

            ctx.fillStyle = textFill;
            ctx.textAlign = "center";
            ctx.font = "10px sans-serif";
            if (barWidth >= 16) {
                ctx.fillText(String(val), px + barWidth / 2, py - 4);
            }

            ctx.save();
            ctx.translate(px + barWidth / 2, zeroY + 14);
            ctx.rotate(count > 8 ? -Math.PI / 4 : 0);
            ctx.fillStyle = textFill;
            ctx.textAlign = count > 8 ? "right" : "center";
            ctx.fillText(labels[i], 0, 0);
            ctx.restore();
        });
    } else if (type === "line") {
        const points = values.map((val, i) => {
            const px = paddingLeft + (count === 1 ? plotWidth / 2 : (i / (count - 1)) * plotWidth);
            const py = paddingTop + (1 - (val - minVal) / ((niceMax - minVal) || 1)) * plotHeight;
            return { x: px, y: py, val, label: labels[i] };
        });

        // Area fill under line
        const grad = ctx.createLinearGradient(0, paddingTop, 0, height - paddingBottom);
        grad.addColorStop(0, "rgba(59, 130, 246, 0.3)");
        grad.addColorStop(1, "rgba(59, 130, 246, 0.0)");

        ctx.beginPath();
        ctx.moveTo(points[0].x, zeroY);
        points.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.lineTo(points[points.length - 1].x, zeroY);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        points.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        });
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 2.5;
        ctx.stroke();

        points.forEach((p) => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
            ctx.fillStyle = "#3b82f6";
            ctx.fill();
            ctx.strokeStyle = bgFill;
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.save();
            ctx.translate(p.x, zeroY + 14);
            ctx.rotate(count > 8 ? -Math.PI / 4 : 0);
            ctx.fillStyle = textFill;
            ctx.font = "10px sans-serif";
            ctx.textAlign = count > 8 ? "right" : "center";
            ctx.fillText(p.label, 0, 0);
            ctx.restore();
        });
    }
}

function exportChartPng(tabId) {
    const tab = getTabById(tabId);
    if (!tab || !tab.chartCanvas) return;
    try {
        const link = document.createElement("a");
        link.download = `query-chart-${Date.now()}.png`;
        link.href = tab.chartCanvas.toDataURL("image/png");
        link.click();
        showToast("Chart exported as PNG", "success");
    } catch (err) {
        showToast("Export failed: " + err.message, "error");
    }
}

function insertTextIntoActiveEditor(text) {
    const tab = getActiveTab();
    if (!tab) return;
    ensureTabElementReferences(tab);

    if (tab.editorView) {
        const view = tab.editorView;
        const main = view.state.selection.main;
        view.dispatch({
            changes: { from: main.from, to: main.to, insert: text },
            selection: { anchor: main.from + text.length }
        });
        view.focus();
    } else if (tab.editorElement) {
        const el = tab.editorElement;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.substring(0, start) + text + el.value.substring(end);
        el.selectionStart = el.selectionEnd = start + text.length;
        el.focus();
    }
    tab.query = tab.editorView ? tab.editorView.state.doc.toString() : (tab.editorElement?.value || "");
    tab.isDirty = true;
    updateTabName(tab);
    updateQueryCheckForTab(tab);
    showToast(`Inserted "${text}" into editor`, "info");
}

function loadAndRunQueryInActiveTab(sqlText) {
    const tab = getActiveTab();
    if (!tab) return;
    ensureTabElementReferences(tab);

    if (tab.editorInstance) {
        tab.editorInstance.setValue(sqlText);
    } else if (tab.editorElement) {
        tab.editorElement.value = sqlText;
    }
    tab.query = sqlText;
    tab.isDirty = true;
    updateTabName(tab);
    updateQueryCheckForTab(tab);
    executeQuery(tab.id);
}

async function renderSchemaExplorer(connectionId) {
    const panel = document.getElementById("schema-explorer-section");
    const connBadge = document.getElementById("schema-current-conn");
    const emptyState = document.getElementById("schema-empty-state");
    const treeList = document.getElementById("schema-tree-list");
    if (!panel || !treeList) return;

    if (!connectionId) {
        if (connBadge) connBadge.textContent = "No connection";
        if (emptyState) {
            emptyState.classList.remove("hidden");
            emptyState.innerHTML = "<p>Select a single connection to explore tables, columns, and foreign keys.</p>";
        }
        treeList.innerHTML = "";
        return;
    }

    const connection = (connections || []).find(c => c.id === connectionId);
    const connName = connection?.name || connectionId;
    if (connBadge) connBadge.textContent = connName;

    await ensureSchemaMetadata(connectionId);
    const schema = schemaMetadataCache.get(connectionId) || { tables: [] };
    const tables = schema.tables || [];

    if (!tables.length) {
        if (emptyState) {
            emptyState.classList.remove("hidden");
            emptyState.innerHTML = `<p>No tables found in ${escapeHtml(connName)}.</p>`;
        }
        treeList.innerHTML = "";
        return;
    }

    if (emptyState) emptyState.classList.add("hidden");

    const searchInput = document.getElementById("schema-table-search");
    const query = (searchInput?.value || "").trim().toLowerCase();

    treeList.innerHTML = "";
    tables.forEach(table => {
        const tableName = typeof table === "string" ? table : table.name;
        const columns = table.columns || [];
        const fks = new Set((table.foreign_keys || []).map(fk => fk.column || fk.from_column));

        if (query) {
            const tableMatch = tableName.toLowerCase().includes(query);
            const colMatch = columns.some(c => (c.name || c).toLowerCase().includes(query));
            if (!tableMatch && !colMatch) return;
        }

        const li = document.createElement("li");
        li.className = "schema-table-item";

        const row = document.createElement("div");
        row.className = "schema-table-row";
        row.innerHTML = `
            <button type="button" class="schema-toggle-btn" aria-label="Toggle ${escapeHtml(tableName)} columns">▶</button>
            <span class="schema-table-name" title="Click to insert table name">${escapeHtml(tableName)}</span>
            <div class="schema-table-quick-actions">
                <button type="button" class="btn btn-ghost btn-xs schema-action-select" title="Query first 100 rows">SELECT</button>
                <button type="button" class="btn btn-ghost btn-xs schema-action-ddl" title="Generate CREATE TABLE DDL">DDL</button>
            </div>
        `;

        const sublist = document.createElement("ul");
        sublist.className = "schema-column-sublist hidden";

        if (columns.length > 0) {
            columns.forEach(col => {
                const colName = typeof col === "string" ? col : col.name;
                const colType = typeof col === "object" && col.type ? col.type : "";
                const isPk = typeof col === "object" && Boolean(col.is_primary_key);
                const isFk = fks.has(colName);

                const colLi = document.createElement("li");
                colLi.className = "schema-column-item";
                colLi.innerHTML = `
                    <span class="schema-col-name" title="Click to insert column">${escapeHtml(colName)}</span>
                    <span class="schema-col-meta">
                        ${isPk ? '<span class="schema-badge-pk" title="Primary Key">🔑 PK</span>' : ""}
                        ${isFk ? '<span class="schema-badge-fk" title="Foreign Key">🔗 FK</span>' : ""}
                        ${colType ? `<span class="schema-col-type">${escapeHtml(colType)}</span>` : ""}
                    </span>
                `;
                colLi.querySelector(".schema-col-name")?.addEventListener("click", () => {
                    insertTextIntoActiveEditor(colName);
                });
                sublist.appendChild(colLi);
            });
        } else {
            const emptyColLi = document.createElement("li");
            emptyColLi.className = "schema-column-item schema-empty-cols";
            emptyColLi.textContent = "No columns listed";
            sublist.appendChild(emptyColLi);
        }

        const toggleBtn = row.querySelector(".schema-toggle-btn");
        const toggleExpand = () => {
            const isHidden = sublist.classList.contains("hidden");
            sublist.classList.toggle("hidden", !isHidden);
            toggleBtn.textContent = isHidden ? "▼" : "▶";
        };
        toggleBtn.addEventListener("click", e => {
            e.stopPropagation();
            toggleExpand();
        });

        row.querySelector(".schema-table-name")?.addEventListener("click", () => {
            insertTextIntoActiveEditor(tableName);
        });

        row.querySelector(".schema-action-select")?.addEventListener("click", e => {
            e.stopPropagation();
            loadAndRunQueryInActiveTab(`SELECT * FROM ${tableName} LIMIT 100;`);
        });

        row.querySelector(".schema-action-ddl")?.addEventListener("click", e => {
            e.stopPropagation();
            generateTableDDL(connectionId, tableName);
        });

        li.appendChild(row);
        li.appendChild(sublist);
        treeList.appendChild(li);
    });
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


// ── v1.3.0 Feature Functions ──────────────────────────────────

// ── Multi-Format Export ──
function exportData(format, tabId) {
    const tab = getTabById(tabId);
    if (!tab || !tab.currentExportData) {
        showToast("No data to export", "warning");
        return;
    }
    const { columns, rows } = tab.currentExportData;
    if (!columns || !rows || rows.length === 0) {
        showToast("No rows to export", "warning");
        return;
    }

    let content, filename, mimeType;
    const timestamp = Date.now();

    switch (format) {
        case "csv":
            content = [columns.join(","), ...rows.map(row => columns.map((col, idx) => {
                const val = Array.isArray(row) ? row[idx] : row[col];
                if (val === null || val === undefined) return "";
                const str = String(val);
                return str.includes(",") || str.includes('"') || str.includes("\n") ? `"${str.replace(/"/g, '""')}"` : str;
            }).join(","))].join("\n");
            filename = `query-results-${timestamp}.csv`;
            mimeType = "text/csv;charset=utf-8;";
            break;

        case "json":
            const jsonObj = rows.map(row => {
                const item = {};
                columns.forEach((col, idx) => {
                    item[col] = Array.isArray(row) ? row[idx] : row[col];
                });
                return item;
            });
            content = JSON.stringify(jsonObj, null, 2);
            filename = `query-results-${timestamp}.json`;
            mimeType = "application/json;charset=utf-8;";
            break;

        case "markdown":
            const header = "| " + columns.join(" | ") + " |";
            const separator = "| " + columns.map(() => "---").join(" | ") + " |";
            const body = rows.map(row => "| " + columns.map((col, idx) => {
                const val = Array.isArray(row) ? row[idx] : row[col];
                if (val === null || val === undefined) return "NULL";
                return String(val).replace(/\|/g, "\\|").replace(/\n/g, " ");
            }).join(" | ") + " |").join("\n");
            content = header + "\n" + separator + "\n" + body;
            filename = `query-results-${timestamp}.md`;
            mimeType = "text/markdown;charset=utf-8;";
            break;

        case "sql":
            const tblName = "exported_data";
            content = rows.map(row => {
                const vals = columns.map((col, idx) => {
                    const val = Array.isArray(row) ? row[idx] : row[col];
                    if (val === null || val === undefined) return "NULL";
                    if (typeof val === "number") return String(val);
                    if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
                    return `'${String(val).replace(/'/g, "''")}'`;
                });
                return `INSERT INTO ${tblName} (${columns.map(c => `"${c.replace(/"/g, '""')}"`).join(", ")}) VALUES (${vals.join(", ")});`;
            }).join("\n");
            filename = `query-results-${timestamp}.sql`;
            mimeType = "text/sql;charset=utf-8;";
            break;

        default:
            showToast(`Unknown export format: ${format}`, "error");
            return;
    }

    const blob = new Blob([content], { type: mimeType });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast(`Exported as ${format.toUpperCase()}`, "success");
}

function initGlobalExportEvents() {
    document.addEventListener("click", () => {
        document.querySelectorAll(".export-dropdown").forEach(d => d.classList.add("hidden"));
    });
}

// ── Column Sorting ──
let columnSortState = { tabId: null, column: null, direction: "asc" };

function applySortToResults(tabId, colIndex, colName) {
    const tab = getTabById(tabId);
    if (!tab || !tab.currentExportData) return;

    if (columnSortState.tabId === tabId && columnSortState.column === colIndex) {
        columnSortState.direction = columnSortState.direction === "asc" ? "desc" : "asc";
    } else {
        columnSortState = { tabId, column: colIndex, direction: "asc" };
    }

    const dir = columnSortState.direction === "asc" ? 1 : -1;
    const { columns, rows } = tab.currentExportData;

    const sortedRows = [...rows].sort((a, b) => {
        const va = Array.isArray(a) ? a[colIndex] : a[colName];
        const vb = Array.isArray(b) ? b[colIndex] : b[colName];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
        const na = Number(va);
        const nb = Number(vb);
        if (!isNaN(na) && !isNaN(nb) && typeof va !== "boolean" && typeof vb !== "boolean" && String(va).trim() !== "" && String(vb).trim() !== "") {
            return (na - nb) * dir;
        }
        return String(va).localeCompare(String(vb)) * dir;
    });

    tab.currentExportData.rows = sortedRows;

    // Update table body rows in the DOM
    const container = document.getElementById(`single-result-container-${tabId}`);
    if (!container) return;
    const tbody = container.querySelector("tbody");
    if (!tbody) return;

    // Re-render tbody
    const trs = tbody.querySelectorAll("tr");
    if (trs.length === sortedRows.length) {
        // Re-order existing rows or re-generate rows
        const { html } = buildEditableGrid({ data: { columns, data: sortedRows } }, tabId, Array.from(tab.connectionIds || [])[0]);
        const temp = document.createElement("div");
        temp.innerHTML = html;
        const newTbody = temp.querySelector("tbody");
        if (newTbody) tbody.innerHTML = newTbody.innerHTML;
    }

    // Rebind editable cell blur listeners
    tbody.querySelectorAll("td[contenteditable='true']").forEach(cell => {
        cell.addEventListener("blur", e => handleCellEdit(tab, e));
    });

    // Update header classes
    container.querySelectorAll("thead th[data-column]").forEach((th, idx) => {
        th.classList.remove("sort-asc", "sort-desc");
        if (idx === colIndex) {
            th.classList.add(columnSortState.direction === "asc" ? "sort-asc" : "sort-desc");
        }
    });

    renderSummaryFooter(tabId);
}

// ── Summary Footer Bar ──
function renderSummaryFooter(tabId) {
    const tab = getTabById(tabId);
    if (!tab || !tab.currentExportData) return;
    const { columns, rows } = tab.currentExportData;
    const container = document.getElementById(`single-result-container-${tabId}`);
    if (!container || !columns || !rows || rows.length === 0) return;

    container.querySelector(".results-summary-footer")?.remove();

    const numericStats = [];
    columns.forEach((col, idx) => {
        const nums = [];
        rows.forEach(r => {
            const val = Array.isArray(r) ? r[idx] : r[col];
            if (val !== null && val !== undefined && val !== "") {
                const n = Number(val);
                if (!isNaN(n) && typeof val !== "boolean") {
                    nums.push(n);
                }
            }
        });
        if (nums.length > 0 && nums.length >= rows.length * 0.5) {
            const sum = nums.reduce((acc, v) => acc + v, 0);
            const avg = sum / nums.length;
            const min = Math.min(...nums);
            const max = Math.max(...nums);
            numericStats.push({ col, sum, avg, min, max, count: nums.length });
        }
    });

    if (numericStats.length === 0) return;

    const footer = document.createElement("div");
    footer.className = "results-summary-footer";
    footer.innerHTML = `
        <div class="summary-bar">
            ${numericStats.slice(0, 6).map(s => `
                <div class="summary-stat">
                    <span class="summary-label">${escapeHtml(s.col)}</span>
                    <div class="summary-values">
                        <span title="Sum"><strong>Σ</strong> ${s.sum.toLocaleString(undefined, {maximumFractionDigits: 2})}</span>
                        <span title="Average"><strong>μ</strong> ${s.avg.toLocaleString(undefined, {maximumFractionDigits: 2})}</span>
                        <span title="Min"><strong>↓</strong> ${s.min.toLocaleString(undefined, {maximumFractionDigits: 2})}</span>
                        <span title="Max"><strong>↑</strong> ${s.max.toLocaleString(undefined, {maximumFractionDigits: 2})}</span>
                    </div>
                </div>
            `).join("")}
        </div>
    `;
    container.appendChild(footer);
}

// ── DDL Generation ──
async function generateTableDDL(connId, tableName) {
    try {
        const data = await apiFetch(`/api/connections/${connId}/tables/${encodeURIComponent(tableName)}/ddl`);
        const ddl = data.ddl || `-- No DDL available for ${tableName}`;
        const tab = getActiveTab();
        if (tab) {
            ensureTabElementReferences(tab);
            if (tab.editorInstance) {
                tab.editorInstance.setValue(ddl);
            } else if (tab.editorElement) {
                tab.editorElement.value = ddl;
            }
            tab.query = ddl;
            tab.isDirty = true;
            updateTabName(tab);
            updateQueryCheckForTab(tab);
            switchView("query-section");
            showToast(`DDL for "${tableName}" loaded into editor`, "success");
        } else {
            showToast("No active editor tab. Open a query tab first.", "warning");
        }
    } catch (e) {
        showToast("DDL generation failed: " + e.message, "error");
    }
}


// ── Workspace State ──
let isRestoringWorkspace = false;
let saveWorkspaceTimeout = null;

function scheduleWorkspaceSave() {
    if (isRestoringWorkspace) return;
    if (saveWorkspaceTimeout) clearTimeout(saveWorkspaceTimeout);
    saveWorkspaceTimeout = setTimeout(saveWorkspaceState, 2000);
}

async function saveWorkspaceState() {
    if (isRestoringWorkspace) return;
    const state = {
        activeTabId: activeTabId,
        tabs: queryTabs.map(t => ({
            id: t.id,
            name: t.name,
            query: t.query,
            connectionIds: Array.from(t.connectionIds || [])
        }))
    };
    try {
        await apiFetch("/api/workspace", {
            method: "PUT",
            body: JSON.stringify({ state_json: JSON.stringify(state) })
        });
    } catch (e) {
        console.warn("Failed to save workspace state", e);
    }
}

// ── Saved Queries Management ──
let savedQueriesList = [];

async function loadSavedQueries() {
    try {
        const data = await apiFetch("/api/saved-queries");
        savedQueriesList = Array.isArray(data) ? data : [];
        renderSavedQueriesList();
    } catch (e) {
        showToast("Failed to load saved queries: " + e.message, "error");
    }
}

function renderSavedQueriesList() {
    const container = document.getElementById("saved-queries-list");
    if (!container) return;
    const search = (document.getElementById("saved-queries-search")?.value || "").toLowerCase();
    const filtered = savedQueriesList.filter(q =>
        q.name.toLowerCase().includes(search) ||
        (q.description || "").toLowerCase().includes(search) ||
        (q.tags || []).some(t => t.toLowerCase().includes(search))
    );

    if (filtered.length === 0) {
        container.innerHTML = '<div class="table-placeholder" style="padding:2rem;text-align:center;"><p>No saved queries found.</p></div>';
        return;
    }

    container.innerHTML = filtered.map(q => `
        <div class="snippet-item" data-id="${q.id}">
            <div class="snippet-info">
                <strong>${escapeHtml(q.name)}</strong>
                ${q.description ? `<span class="snippet-description">${escapeHtml(q.description)}</span>` : ""}
                ${(q.tags && q.tags.length) ? `<span class="snippet-tags" style="font-size:0.75rem;color:var(--text-muted);">${q.tags.map(t => '#' + escapeHtml(t)).join(' ')}</span>` : ""}
            </div>
            <div class="snippet-actions">
                <button type="button" class="btn btn-ghost btn-sm" onclick="loadSavedQueryIntoEditor(${q.id})" title="Load into editor">Load</button>
                <button type="button" class="btn btn-ghost btn-sm" onclick="editSavedQuery(${q.id})" title="Edit">Edit</button>
                <button type="button" class="btn btn-ghost btn-sm" onclick="deleteSavedQuery(${q.id})" title="Delete" style="color:var(--error);">Delete</button>
            </div>
        </div>
    `).join("");
}

function editSavedQuery(id) {
    const q = savedQueriesList.find(x => x.id === id);
    if (!q) return;
    const form = document.getElementById("saved-query-form");
    if (!form) return;
    document.getElementById("saved-query-id").value = q.id;
    document.getElementById("saved-query-name").value = q.name;
    document.getElementById("saved-query-description").value = q.description || "";
    document.getElementById("saved-query-sql").value = q.sql;
    document.getElementById("saved-query-tags").value = (q.tags || []).join(", ");
    form.classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth" });
}

async function deleteSavedQuery(id) {
    if (!confirm("Are you sure you want to delete this saved query?")) return;
    try {
        await apiFetch(`/api/saved-queries/${id}`, { method: "DELETE" });
        showToast("Saved query deleted", "success");
        loadSavedQueries();
    } catch (e) {
        showToast("Delete failed: " + e.message, "error");
    }
}

function loadSavedQueryIntoEditor(id) {
    const q = savedQueriesList.find(x => x.id === id);
    if (!q) return;
    const tab = getActiveTab();
    if (tab) {
        ensureTabElementReferences(tab);
        if (tab.editorInstance) {
            tab.editorInstance.setValue(q.sql);
        } else if (tab.editorElement) {
            tab.editorElement.value = q.sql;
        }
        tab.query = q.sql;
        tab.isDirty = true;
        updateTabName(tab);
        updateQueryCheckForTab(tab);
        switchView("query-section");
        showToast(`Loaded "${q.name}" into editor`, "success");
    } else {
        showToast("No active editor tab. Open a query tab first.", "warning");
    }
}

function initSavedQueriesEvents() {
    const form = document.getElementById("saved-query-form");
    const btnNew = document.getElementById("btn-new-saved-query");
    const btnCancel = document.getElementById("btn-cancel-saved-query");
    const searchInput = document.getElementById("saved-queries-search");

    if (btnNew) {
        btnNew.addEventListener("click", () => {
            const tab = getActiveTab();
            const currentSql = tab ? (tab.editorInstance ? tab.editorInstance.getValue() : tab.editorElement?.value || "") : "";
            document.getElementById("saved-query-id").value = "";
            document.getElementById("saved-query-name").value = "";
            document.getElementById("saved-query-description").value = "";
            document.getElementById("saved-query-sql").value = currentSql;
            document.getElementById("saved-query-tags").value = "";
            form?.classList.remove("hidden");
            form?.scrollIntoView({ behavior: "smooth" });
        });
    }

    if (btnCancel) {
        btnCancel.addEventListener("click", () => form?.classList.add("hidden"));
    }

    if (searchInput) {
        searchInput.addEventListener("input", renderSavedQueriesList);
    }

    if (form) {
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const id = document.getElementById("saved-query-id").value;
            const payload = {
                name: document.getElementById("saved-query-name").value.trim(),
                sql: document.getElementById("saved-query-sql").value.trim(),
                description: document.getElementById("saved-query-description").value.trim(),
                tags: document.getElementById("saved-query-tags").value.split(",").map(t => t.trim()).filter(Boolean)
            };
            try {
                if (id) {
                    await apiFetch(`/api/saved-queries/${id}`, {
                        method: "PUT",
                        body: JSON.stringify(payload)
                    });
                    showToast("Saved query updated", "success");
                } else {
                    await apiFetch("/api/saved-queries", {
                        method: "POST",
                        body: JSON.stringify(payload)
                    });
                    showToast("Query saved successfully", "success");
                }
                form.classList.add("hidden");
                loadSavedQueries();
            } catch (err) {
                showToast("Save failed: " + err.message, "error");
            }
        });
    }
}

// ── Schema Diff ──
function populateDiffConnectionSelects() {
    const src = document.getElementById("diff-conn-source");
    const tgt = document.getElementById("diff-conn-target");
    if (!src || !tgt) return;
    const conns = connections || [];
    const opts = conns.map(c => `<option value="${c.id}">${escapeHtml(c.name || c.database)} (${escapeHtml(c.db_type || "")})</option>`).join("");
    src.innerHTML = '<option value="">Select source connection...</option>' + opts;
    tgt.innerHTML = '<option value="">Select target connection...</option>' + opts;
}

async function runSchemaDiff() {
    const srcId = document.getElementById("diff-conn-source")?.value;
    const tgtId = document.getElementById("diff-conn-target")?.value;
    const resultsDiv = document.getElementById("schema-diff-results");
    if (!srcId || !tgtId) {
        showToast("Please select both source and target connections", "warning");
        return;
    }
    if (srcId === tgtId) {
        showToast("Source and target must be different connections", "warning");
        return;
    }

    if (resultsDiv) {
        resultsDiv.innerHTML = '<div style="padding:2rem;text-align:center;"><div class="spinner"></div><p style="margin-top:1rem;">Comparing schemas...</p></div>';
    }

    try {
        const data = await apiFetch("/api/schema/diff", {
            method: "POST",
            body: JSON.stringify({
                source_connection_id: parseInt(srcId, 10),
                target_connection_id: parseInt(tgtId, 10)
            })
        });
        renderSchemaDiffResults(data);
    } catch (e) {
        if (resultsDiv) {
            resultsDiv.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--error);"><p>Diff comparison failed: ${escapeHtml(e.message)}</p></div>`;
        }
    }
}

function renderSchemaDiffResults(data) {
    const container = document.getElementById("schema-diff-results");
    if (!container) return;
    const diffs = data.differences || [];
    if (diffs.length === 0) {
        container.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--success);"><p>✅ Schemas are identical — no differences found between the two databases.</p></div>';
        return;
    }

    let html = `
        <div class="schema-diff-summary" style="margin-bottom:1rem;padding:0.75rem 1rem;background:var(--surface);border-radius:8px;border:1px solid var(--border);">
            <strong>${diffs.length} difference${diffs.length !== 1 ? "s" : ""} found</strong>
            <span style="color:var(--text-muted);margin-left:0.5rem;">Source: ${escapeHtml(data.source || "")} vs Target: ${escapeHtml(data.target || "")}</span>
        </div>
        <div class="schema-diff-list">
    `;

    diffs.forEach(d => {
        let icon = "🟡";
        let borderColor = "var(--warning, orange)";
        let desc = "";

        if (d.type === "missing_table") {
            icon = "🔴";
            borderColor = "var(--error)";
            desc = `Table <code>${escapeHtml(d.table)}</code> exists in source but is missing in target`;
        } else if (d.type === "missing_column") {
            icon = "🟡";
            borderColor = "var(--warning, orange)";
            desc = `Column <code>${escapeHtml(d.table)}.${escapeHtml(d.column)}</code> exists in source but is missing in target`;
        } else if (d.type === "type_mismatch") {
            icon = "🟠";
            borderColor = "var(--accent)";
            desc = `Column <code>${escapeHtml(d.table)}.${escapeHtml(d.column)}</code> type mismatch: <code>${escapeHtml(d.source_type)}</code> in source → <code>${escapeHtml(d.target_type)}</code> in target`;
        } else {
            desc = escapeHtml(JSON.stringify(d));
        }

        html += `
            <div class="snippet-item" style="border-left: 3px solid ${borderColor}; margin-bottom: 0.5rem; padding: 0.75rem 1rem; background: var(--surface); border-radius: 6px;">
                <div class="snippet-info">
                    <span>${icon} ${desc}</span>
                </div>
            </div>
        `;
    });

    html += "</div>";
    container.innerHTML = html;
}

function initSchemaDiffEvents() {
    document.getElementById("btn-run-schema-diff")?.addEventListener("click", runSchemaDiff);
}

// Global exports for modular scripts
window.queryTabs = queryTabs;
window.exportData = exportData;
window.applySortToResults = applySortToResults;
window.renderSummaryFooter = renderSummaryFooter;
window.generateTableDDL = generateTableDDL;
window.savedQueriesList = savedQueriesList;
window.loadSavedQueries = loadSavedQueries;
window.renderSavedQueriesList = renderSavedQueriesList;
window.editSavedQuery = editSavedQuery;
window.deleteSavedQuery = deleteSavedQuery;
window.loadSavedQueryIntoEditor = loadSavedQueryIntoEditor;
window.populateDiffConnectionSelects = populateDiffConnectionSelects;
window.runSchemaDiff = runSchemaDiff;
window.renderSchemaDiffResults = renderSchemaDiffResults;
window.columnSortState = columnSortState;
window.getTabById = getTabById;
window.getActiveTab = getActiveTab;
window.updateTabName = updateTabName;
window.executeQuery = executeQuery;
window.updateQueryCheckForTab = updateQueryCheckForTab;
window.updateQuerySuggestionsForTab = updateQuerySuggestionsForTab;
window.applyResultEdits = applyResultEdits;
window.revertResultEdits = revertResultEdits;
window.switchView = switchView;
window.showToast = showToast;
window.escapeHtml = escapeHtml;
window.apiFetch = apiFetch;
window.buildEditableGrid = buildEditableGrid;
window.handleCellEdit = handleCellEdit;
window.renderSingleResult = renderSingleResult;
window.renderMultiResults = renderMultiResults;
window.cancelCurrentQuery = cancelCurrentQuery;
window.explainQuery = explainQuery;
window.applyResultFilter = applyResultFilter;
window.renderChartForTab = renderChartForTab;
window.drawCanvasChart = drawCanvasChart;
window.exportChartPng = exportChartPng;
window.renderSchemaExplorer = renderSchemaExplorer;
window.insertTextIntoActiveEditor = insertTextIntoActiveEditor;
window.loadAndRunQueryInActiveTab = loadAndRunQueryInActiveTab;
window.scheduleWorkspaceSave = scheduleWorkspaceSave;


// ── ER Diagram Generator ──
let erZoomLevel = 1.0;

function showERDiagram() {
    if (selectedConnectionIds.size !== 1) {
        showToast("Select a single connection to view its ER diagram.", "info");
        return;
    }
    const connId = Array.from(selectedConnectionIds)[0];
    const schema = schemaMetadataCache.get(connId);
    if (!schema || !schema.tables || schema.tables.length === 0) {
        showToast("No schema data available. Please refresh or select a valid connection.", "warning");
        return;
    }

    let mermaidCode = "erDiagram\n";
    schema.tables.forEach(table => {
        const tName = typeof table === "string" ? table : table.name;
        mermaidCode += `  "${tName}" {\n`;
        const cols = table.columns || [];
        cols.forEach(col => {
            const cName = typeof col === "string" ? col : col.name;
            let cType = (typeof col === "object" && col.type ? col.type : "string").replace(/[^a-zA-Z0-9_]/g, "_");
            if (!cType) cType = "string";
            const pk = (typeof col === "object" && col.is_primary_key) ? " PK" : "";
            mermaidCode += `    ${cType} ${cName}${pk}\n`;
        });
        mermaidCode += `  }\n`;

        const fks = table.foreign_keys || [];
        fks.forEach(fk => {
            // relation: }o--||
            mermaidCode += `  "${tName}" }o--|| "${fk.ref_table}" : "${fk.column} -> ${fk.ref_column}"\n`;
        });
    });

    const container = document.getElementById("er-diagram-container");
    container.innerHTML = `<div class="mermaid">${mermaidCode}</div>`;
    
    document.getElementById("er-diagram-modal").showModal();
    
    // Initialize mermaid if loaded
    if (window.mermaid) {
        try {
            window.mermaid.initialize({ startOnLoad: false, theme: document.body.classList.contains("dark-theme") ? "dark" : "default" });
            window.mermaid.run({ nodes: [container.querySelector('.mermaid')] });
        } catch (e) {
            console.warn("Mermaid rendering failed", e);
            container.innerHTML = `<p style="color:var(--error);">Failed to render ER diagram. Schema might be too complex or contain unsupported characters.</p><pre style="font-size:10px;">${escapeHtml(mermaidCode)}</pre>`;
        }
    }
    
    erZoomLevel = 1.0;
    container.style.transform = `scale(${erZoomLevel})`;
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("btn-view-er-diagram")?.addEventListener("click", showERDiagram);
    
    const container = document.getElementById("er-diagram-container");
    document.getElementById("btn-zoom-in-er")?.addEventListener("click", () => {
        erZoomLevel += 0.2;
        container.style.transform = `scale(${erZoomLevel})`;
    });
    document.getElementById("btn-zoom-out-er")?.addEventListener("click", () => {
        erZoomLevel = Math.max(0.2, erZoomLevel - 0.2);
        container.style.transform = `scale(${erZoomLevel})`;
    });
    document.getElementById("btn-reset-zoom-er")?.addEventListener("click", () => {
        erZoomLevel = 1.0;
        container.style.transform = `scale(${erZoomLevel})`;
    });
});


// ── CSV Import ──
function initImportCsvEvents() {
    document.getElementById("btn-import-csv")?.addEventListener("click", () => {
        if (selectedConnectionIds.size !== 1) {
            showToast("Select a single connection to import data into.", "info");
            return;
        }
        document.getElementById("import-csv-form").reset();
        document.getElementById("import-csv-modal").showModal();
    });

    document.getElementById("import-csv-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const connId = Array.from(selectedConnectionIds)[0];
        if (!connId) return;

        const form = e.target;
        const submitBtn = document.getElementById("btn-submit-import");
        submitBtn.disabled = true;
        submitBtn.textContent = "Importing...";

        try {
            const formData = new FormData(form);
            const response = await fetch(`/api/connections/${connId}/import`, {
                method: "POST",
                body: formData
            });

            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.detail || "Import failed");
            }

            showToast(`Successfully imported ${result.rows_inserted} rows into ${result.table}`, "success");
            document.getElementById("import-csv-modal").close();
            
            // Refresh schema
            schemaMetadataCache.delete(connId);
            await renderSchemaExplorer(connId);

        } catch (error) {
            showToast(error.message, "error");
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "Import Data";
        }
    });
}

document.addEventListener("DOMContentLoaded", () => {
    initImportCsvEvents();
});


// ── Scheduled Tasks ──
function initScheduledTasksEvents() {
    document.getElementById("btn-refresh-scheduled-tasks")?.addEventListener("click", loadScheduledTasks);
    document.getElementById("btn-create-scheduled-task")?.addEventListener("click", openCreateScheduledTaskModal);
    document.getElementById("create-scheduled-task-form")?.addEventListener("submit", handleCreateScheduledTask);
}

async function loadScheduledTasks() {
    const tbody = document.getElementById("scheduled-tasks-tbody");
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading tasks...</td></tr>';
    try {
        const response = await fetch("/api/scheduled-queries");
        if (!response.ok) throw new Error("Failed to load scheduled tasks");
        const tasks = await response.json();
        
        if (tasks.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No scheduled tasks found.</td></tr>';
            return;
        }
        
        tbody.innerHTML = "";
        tasks.forEach(task => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${escapeHtml(task.name)}</td>
                <td><code style="background:var(--code-bg);padding:2px;border-radius:3px;">${escapeHtml(task.query.substring(0, 30))}${task.query.length > 30 ? '...' : ''}</code></td>
                <td>${escapeHtml(task.cron_schedule)}</td>
                <td>${escapeHtml(task.connection_id)}</td>
                <td>${task.last_run_at ? new Date(task.last_run_at).toLocaleString() : 'Never'}</td>
                <td>
                    <span style="color: ${task.last_status === 'success' ? 'var(--success)' : (task.last_status === 'error' ? 'var(--error)' : 'inherit')}">
                        ${task.last_status || 'Pending'}
                    </span>
                </td>
                <td>
                    <button class="btn btn-sm btn-ghost btn-run-task" data-id="${task.id}" title="Run Now">▶</button>
                    <button class="btn btn-sm btn-ghost btn-delete-task" style="color:var(--error);" data-id="${task.id}" title="Delete">🗑</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        // Bind actions
        tbody.querySelectorAll('.btn-run-task').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.target.closest('button').dataset.id;
                try {
                    await apiFetch(`/api/scheduled-queries/${id}/run`, { method: "POST" });
                    showToast("Task run started", "success");
                    loadScheduledTasks();
                } catch (err) {
                    showToast("Failed to run task: " + err.message, "error");
                }
            });
        });
        
        tbody.querySelectorAll('.btn-delete-task').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                if (!confirm("Delete this scheduled task?")) return;
                const id = e.target.closest('button').dataset.id;
                try {
                    await apiFetch(`/api/scheduled-queries/${id}`, { method: "DELETE" });
                    showToast("Task deleted", "success");
                    loadScheduledTasks();
                } catch (err) {
                    showToast("Failed to delete task: " + err.message, "error");
                }
            });
        });
        
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--error);">${escapeHtml(e.message)}</td></tr>`;
    }
}

async function openCreateScheduledTaskModal() {
    document.getElementById("create-scheduled-task-form").reset();
    
    // Populate connections
    const select = document.getElementById("st-connection-id");
    select.innerHTML = '<option value="">Select a connection...</option>';
    try {
        const response = await fetch("/api/connections");
        const connections = await response.json();
        connections.forEach(c => {
            const opt = document.createElement("option");
            opt.value = c.id;
            opt.textContent = c.name;
            select.appendChild(opt);
        });
    } catch (e) {}
    
    // If active tab has query, pre-fill it
    const activeTab = getActiveTab();
    if (activeTab && activeTab.query) {
        document.getElementById("st-query").value = activeTab.query;
        if (activeTab.connectionIds.size === 1) {
            document.getElementById("st-connection-id").value = Array.from(activeTab.connectionIds)[0];
        }
    }
    
    document.getElementById("create-scheduled-task-modal").showModal();
}

async function handleCreateScheduledTask(e) {
    e.preventDefault();
    const btn = document.getElementById("btn-save-scheduled-task");
    btn.disabled = true;
    btn.textContent = "Saving...";
    
    try {
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());
        
        await apiFetch("/api/scheduled-queries", {
            method: "POST",
            body: JSON.stringify(data)
        });
        
        showToast("Scheduled task created", "success");
        document.getElementById("create-scheduled-task-modal").close();
        loadScheduledTasks();
    } catch (err) {
        showToast("Failed to create task: " + err.message, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "Save Task";
    }
}


// ── Dashboard Metrics ──
function initDashboardEvents() {
    document.getElementById("btn-refresh-dashboard")?.addEventListener("click", loadDashboardMetrics);
}


async function loadDashboardMetrics() {
    const grid = document.getElementById("dashboard-metrics-grid");
    if (!grid) return;
    
    grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted);">Refreshing dashboard...</div>';
    
    try {
        const response = await fetch("/api/saved-queries");
        if (!response.ok) throw new Error("Failed to fetch queries");
        const queries = await response.json();
        
        const dashboardQueries = queries.filter(q => {
            if (!q.tags) return false;
            try {
                const tags = JSON.parse(q.tags);
                return tags.includes("metric") || tags.some(t => t.startsWith("chart_"));
            } catch(e) { return false; }
        });
        
        if (dashboardQueries.length === 0) {
            grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 2rem; border: 1px dashed var(--border); border-radius: 8px;">No dashboard items found. Save a query and add the tag "metric", "chart_bar", "chart_line", or "chart_pie" to see it here.</div>';
            return;
        }
        
        grid.innerHTML = "";
        
        for (const mq of dashboardQueries) {
            let tags = [];
            try { tags = JSON.parse(mq.tags); } catch(e) {}
            
            const isMetric = tags.includes("metric");
            const chartTag = tags.find(t => t.startsWith("chart_"));
            const chartType = chartTag ? chartTag.replace("chart_", "") : "bar";
            
            const card = document.createElement("div");
            card.className = "metric-card";
            // Charts span 2 columns if grid allows
            card.style = `background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; box-shadow: 0 2px 4px rgba(0,0,0,0.05); display: flex; flex-direction: column; gap: 0.5rem; ${!isMetric ? "grid-column: span 2; min-height: 300px;" : ""}`;
            
            const title = document.createElement("h3");
            title.style = "margin: 0; font-size: 1rem; color: var(--text-muted); font-weight: 500;";
            title.textContent = mq.name;
            card.appendChild(title);
            
            const valueContainer = document.createElement("div");
            valueContainer.style = "flex: 1; display: flex; flex-direction: column; justify-content: center; position: relative;";
            card.appendChild(valueContainer);
            
            if (isMetric) {
                const value = document.createElement("div");
                value.className = "metric-value";
                value.style = "font-size: 2.5rem; font-weight: 700; color: var(--primary); margin: 0.5rem 0;";
                value.textContent = "...";
                valueContainer.appendChild(value);
            } else {
                // Chart Canvas
                const canvas = document.createElement("canvas");
                canvas.style = "width: 100%; height: 250px; display: block;";
                valueContainer.appendChild(canvas);
            }
            
            const footer = document.createElement("div");
            footer.style = "font-size: 0.8rem; color: var(--text-muted); margin-top: auto;";
            footer.textContent = "Loading...";
            card.appendChild(footer);
            
            grid.appendChild(card);
            
            // Execute the query
            try {
                const qRes = await apiFetch("/api/execute", {
                    method: "POST",
                    body: JSON.stringify({
                        query: mq.sql,
                        connection_id: mq.connection_id
                    })
                });
                
                if (qRes.success && qRes.results && qRes.results.length > 0) {
                    if (isMetric) {
                        const row = qRes.results[0];
                        const firstVal = Object.values(row)[0];
                        const vSpan = valueContainer.querySelector('.metric-value');
                        if (vSpan) vSpan.textContent = firstVal !== null ? firstVal : "NULL";
                    } else {
                        // Draw Chart
                        const canvas = valueContainer.querySelector('canvas');
                        const columns = qRes.columns || Object.keys(qRes.results[0]);
                        const xCol = columns[0];
                        const yCol = columns[1] || columns[0];
                        if (canvas && window.drawCanvasChart) {
                            // Delay slightly so layout calculates size
                            setTimeout(() => {
                                window.drawCanvasChart(canvas, chartType, xCol, yCol, qRes.results);
                            }, 50);
                        }
                    }
                    footer.textContent = `Updated just now`;
                } else {
                    if (isMetric) {
                        const vSpan = valueContainer.querySelector('.metric-value');
                        if (vSpan) {
                            vSpan.textContent = "-";
                            vSpan.style.color = "var(--error)";
                        }
                    }
                    footer.textContent = qRes.error || "No data returned";
                }
            } catch (err) {
                if (isMetric) {
                    const vSpan = valueContainer.querySelector('.metric-value');
                    if (vSpan) {
                        vSpan.textContent = "Err";
                        vSpan.style.color = "var(--error)";
                    }
                }
                footer.textContent = err.message;
            }
        }
        
    } catch (e) {
        grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--error);">${escapeHtml(e.message)}</div>`;
    }
}


// ── AI Assistant ──
function initAIEvents() {
    document.getElementById("btn-ai-assist")?.addEventListener("click", () => {
        const activeTab = getActiveTab();
        if (!activeTab || activeTab.connectionIds.size === 0) {
            showToast("Please select a database connection first.", "warning");
            return;
        }
        document.getElementById("ai-prompt").value = "";
        document.getElementById("ai-assist-modal").showModal();
        setTimeout(() => document.getElementById("ai-prompt").focus(), 100);
    });

    document.getElementById("ai-assist-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const activeTab = getActiveTab();
        if (!activeTab) return;
        const connId = Array.from(activeTab.connectionIds)[0];
        if (!connId) return;

        const prompt = document.getElementById("ai-prompt").value;
        const btn = document.getElementById("btn-submit-ai");
        btn.disabled = true;
        btn.textContent = "Generating...";

        try {
            const response = await apiFetch("/api/ai/text-to-sql", {
                method: "POST",
                body: JSON.stringify({ prompt, connection_id: connId })
            });

            if (response.sql) {
                // Insert into editor
                if (activeTab.editorElement && activeTab.editorElement.editorView) {
                    const view = activeTab.editorElement.editorView;
                    const doc = view.state.doc;
                    // Append if not empty, otherwise replace
                    if (doc.toString().trim() === "") {
                        view.dispatch({ changes: { from: 0, to: doc.length, insert: response.sql } });
                    } else {
                        view.dispatch({ changes: { from: doc.length, insert: "\n\n" + response.sql } });
                    }
                } else if (activeTab.editorElement) {
                    activeTab.editorElement.value += (activeTab.editorElement.value ? "\n\n" : "") + response.sql;
                }
                
                // Manually trigger change
                tab.query = response.sql; // This gets overwritten by the editor listener but safe fallback
                
                document.getElementById("ai-assist-modal").close();
                showToast("SQL generated successfully!", "success");
            }
        } catch (err) {
            showToast("AI Generation failed: " + err.message, "error");
        } finally {
            btn.disabled = false;
            btn.textContent = "Generate SQL";
        }
    });
}


// ── DB Monitor ──
function initDBMonitorEvents() {
    document.getElementById("btn-refresh-monitor")?.addEventListener("click", loadDBMonitor);
    document.getElementById("db-monitor-connection-select")?.addEventListener("change", loadDBMonitor);
}

async function loadDBMonitorConnections() {
    const select = document.getElementById("db-monitor-connection-select");
    if (!select) return;
    try {
        const response = await fetch("/api/connections");
        const connections = await response.json();
        
        const currentVal = select.value;
        select.innerHTML = '<option value="">Select Connection...</option>';
        connections.forEach(c => {
            const opt = document.createElement("option");
            opt.value = c.id;
            opt.textContent = c.name;
            select.appendChild(opt);
        });
        if (currentVal) select.value = currentVal;
    } catch(e) {}
}

async function loadDBMonitor() {
    const select = document.getElementById("db-monitor-connection-select");
    const tbody = document.getElementById("db-monitor-tbody");
    if (!select || !tbody) return;
    
    const connId = select.value;
    if (!connId) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Select a connection to monitor...</td></tr>';
        return;
    }
    
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading sessions...</td></tr>';
    
    try {
        const response = await fetch(`/api/connections/${connId}/monitor/sessions`);
        if (!response.ok) throw new Error("Failed to load sessions");
        const data = await response.json();
        const sessions = data.sessions || [];
        
        if (sessions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No active sessions found.</td></tr>';
            return;
        }
        
        tbody.innerHTML = "";
        sessions.forEach(s => {
            // Postgres vs MySQL differences
            const pid = s.pid || s.Id;
            const user = s.usename || s.User;
            const state = s.state || s.Command;
            const duration = s.duration_sec || s.Time;
            const query = s.query || s.Info || "";
            
            if (!pid && s.info) {
                // SQLite or unsupported
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">${escapeHtml(s.info)}</td></tr>`;
                return;
            }
            
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${escapeHtml(pid)}</td>
                <td>${escapeHtml(user)}</td>
                <td>${escapeHtml(state)}</td>
                <td>${escapeHtml(duration !== null ? Number(duration).toFixed(2) + 's' : '-')}</td>
                <td style="max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(query)}">${escapeHtml(query)}</td>
                <td>
                    <button class="btn btn-sm btn-ghost btn-kill-session" style="color:var(--error);" data-id="${pid}" title="Kill Session">Kill</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        tbody.querySelectorAll('.btn-kill-session').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                if (!confirm("Are you sure you want to kill this database session? This may interrupt active queries.")) return;
                const pid = e.target.closest('button').dataset.id;
                try {
                    await apiFetch(`/api/connections/${connId}/monitor/kill/${pid}`, { method: "POST" });
                    showToast(`Session ${pid} terminated`, "success");
                    loadDBMonitor();
                } catch (err) {
                    showToast("Failed to kill session: " + err.message, "error");
                }
            });
        });
        
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--error);">${escapeHtml(e.message)}</td></tr>`;
    }
}
