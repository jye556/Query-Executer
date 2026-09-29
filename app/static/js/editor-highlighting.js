"use strict";

/**
 * CodeMirror 6 Editor Module for Query Execute
 * Provides SQL syntax highlighting with multiple themes, line numbers,
 * bracket matching, auto-close brackets, tab handling, and configurable options.
 */

// Global editor instances per tab
const editorInstances = new Map();

// Default editor configuration
const DEFAULT_CONFIG = {
    fontSize: 14,
    lineWrapping: true,
    theme: "dark", // "dark" or "light"
    lineNumbers: true,
    bracketMatching: true,
    autoCloseBrackets: true,
    tabSize: 4,
    indentWithTab: true,
    readOnly: false,
    placeholder: "Enter any SQL statement here...\n\nSELECT * FROM users;\nCREATE TABLE example (id INTEGER);"
};

/**
 * Initialize CodeMirror editor for a tab
 * @param {string} tabId - Unique tab identifier
 * @param {HTMLElement} container - DOM element to host the editor
 * @param {string} initialQuery - Initial SQL content
 * @param {Object} options - Configuration options
 * @returns {Object} Editor instance with view and state
 */
async function createEditor(tabId, container, initialQuery = "", options = {}) {
    // Load CodeMirror modules dynamically via CDN
    await loadCodeMirrorModules();

    const config = { ...DEFAULT_CONFIG, ...options };
    const isDarkTheme = config.theme === "dark" || document.documentElement.dataset.theme === "dark";

    // Create editor state with extensions
    const state = EditorState.create({
        doc: initialQuery,
        extensions: [
            // Basic setup
            basicSetup,

            // SQL language support
            sql(),

            // Theme
            isDarkTheme ? oneDark : oneLight,

            // Line numbers
            config.lineNumbers ? lineNumbers() : [],

            // Bracket matching
            config.bracketMatching ? bracketMatching() : [],

            // Auto-close brackets
            config.autoCloseBrackets ? closeBrackets() : [],

            // Tab handling
            config.indentWithTab ? indentWithTab : [],

            // Tab size
            EditorView.tabSize.of(config.tabSize),

            // Font size
            EditorView.theme({
                "&": { fontSize: `${config.fontSize}px` },
                ".cm-content": { fontSize: `${config.fontSize}px` },
                ".cm-gutters": { fontSize: `${config.fontSize}px` }
            }),

            // Line wrapping
            EditorView.lineWrapping.of(config.lineWrapping),

            // Read only
            EditorView.editable.of(!config.readOnly),

            // Placeholder
            placeholder(config.placeholder),

            // Custom keymap for Ctrl+Enter and Ctrl+E to execute
            keymap.of([
                { key: "Ctrl-Enter", run: () => { executeQueryFromEditor(tabId); return true; } },
                { key: "Ctrl-e", run: () => { executeQueryFromEditor(tabId); return true; } },
                { key: "Mod-Enter", run: () => { executeQueryFromEditor(tabId); return true; } },
                { key: "Mod-e", run: () => { executeQueryFromEditor(tabId); return true; } },
                // Tab handling
                { key: "Tab", run: handleTabKey, shift: false },
                { key: "Shift-Tab", run: handleTabKey, shift: true }
            ]),

            // Update tab query on change
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    const tab = getEditorTab(tabId);
                    if (tab) {
                        tab.query = update.state.doc.toString();
                        tab.isDirty = true;
                        updateEditorTabName(tab);
                        // Debounce syntax check
                        debounceQueryCheck(tab);
                    }
                }
            }),

            // Selection change for suggestions
            EditorView.updateListener.of((update) => {
                if (update.selectionSet) {
                    const tab = getEditorTab(tabId);
                    if (tab) {
                        updateEditorQuerySuggestions(tab);
                    }
                }
            }),

            // Additional custom extensions
            ...(Array.isArray(config.extensions) ? config.extensions : [])
        ]
    });

    // Create editor view
    const view = new EditorView({
        state,
        parent: container
    });

    // Store editor instance
    const editorInstance = {
        view,
        state,
        tabId,
        config,
        updateConfig: (newConfig) => updateEditorConfig(tabId, newConfig),
        getValue: () => view.state.doc.toString(),
        setValue: (value) => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); },
        focus: () => view.focus(),
        destroy: () => view.destroy()
    };

    editorInstances.set(tabId, editorInstance);

    // Store reference on tab
    const tab = getEditorTab(tabId);
    if (tab) {
        tab.editorView = view;
        tab.editorInstance = editorInstance;
    }

    return editorInstance;
}

/**
 * Handle Tab key for indentation
 */
function handleTabKey(view, shift) {
    const { state } = view;
    const { ranges } = state.selection;

    // Check if we have a selection spanning multiple lines
    let hasMultiLineSelection = false;
    for (const range of ranges) {
        const fromLine = state.doc.lineAt(range.from).number;
        const toLine = state.doc.lineAt(range.to).number;
        if (fromLine !== toLine) {
            hasMultiLineSelection = true;
            break;
        }
    }

    if (hasMultiLineSelection || ranges.some(r => r.from !== r.to)) {
        // Indent/outdent selected lines
        view.dispatch({
            changes: indentSelection(state, shift ? -1 : 1),
            selection: state.selection
        });
        return true;
    }

    // Single cursor - insert tab or spaces
    if (!shift) {
        view.dispatch({
            changes: { from: state.selection.main.head, insert: " ".repeat(view.state.facet(EditorView.tabSize)) }
        });
        return true;
    }

    return false; // Let default handle Shift-Tab for single cursor
}

/**
 * Indent or outdent selected lines
 */
function indentSelection(state, direction) {
    const changes = [];
    const { ranges } = state.selection;
    const tabSize = state.facet(EditorView.tabSize);
    const tabString = " ".repeat(tabSize);

    // Get unique lines from all ranges
    const lines = new Set();
    for (const range of ranges) {
        const fromLine = state.doc.lineAt(range.from).number;
        const toLine = state.doc.lineAt(range.to).number;
        for (let i = fromLine; i <= toLine; i++) {
            lines.add(i);
        }
    }

    const sortedLines = Array.from(lines).sort((a, b) => a - b);

    for (const lineNum of sortedLines) {
        const line = state.doc.line(lineNum);
        if (direction > 0) {
            // Indent
            changes.push({ from: line.from, insert: tabString });
        } else {
            // Outdent - remove leading tab or spaces
            const text = line.text;
            const match = text.match(/^(\t| {1,4})/);
            if (match) {
                changes.push({ from: line.from, to: line.from + match[1].length, insert: "" });
            }
        }
    }

    return changes;
}

/**
 * Update editor configuration
 */
function updateEditorConfig(tabId, newConfig) {
    const instance = editorInstances.get(tabId);
    if (!instance) return;

    instance.config = { ...instance.config, ...newConfig };
    const view = instance.view;

    // Apply theme change
    if (newConfig.theme !== undefined) {
        const isDark = newConfig.theme === "dark";
        view.dispatch({
            effects: isDark ? oneDark : oneLight
        });
    }

    // Apply font size change
    if (newConfig.fontSize !== undefined) {
        view.dispatch({
            effects: EditorView.theme({
                "&": { fontSize: `${newConfig.fontSize}px` },
                ".cm-content": { fontSize: `${newConfig.fontSize}px` },
                ".cm-gutters": { fontSize: `${newConfig.fontSize}px` }
            })
        });
    }

    // Apply line wrapping change
    if (newConfig.lineWrapping !== undefined) {
        view.dispatch({
            effects: EditorView.lineWrapping.of(newConfig.lineWrapping)
        });
    }

    // Apply line numbers change
    if (newConfig.lineNumbers !== undefined) {
        // Requires recreation of view for gutters
        recreateEditorWithConfig(tabId);
        return; // Early return since editor is recreated
    }

    // Apply tab size change
    if (newConfig.tabSize !== undefined) {
        view.dispatch({
            effects: EditorView.tabSize.of(newConfig.tabSize)
        });
    }

    // Apply bracket matching change (requires recreation)
    if (newConfig.bracketMatching !== undefined) {
        recreateEditorWithConfig(tabId);
        return;
    }

    // Apply auto-close brackets change (requires recreation)
    if (newConfig.autoCloseBrackets !== undefined) {
        recreateEditorWithConfig(tabId);
        return;
    }
}

/**
 * Recreate editor with new config (for options that require full rebuild)
 */
function recreateEditorWithConfig(tabId) {
    const instance = editorInstances.get(tabId);
    if (!instance) return;

    const tab = getEditorTab(tabId);
    const container = instance.view.dom.parentElement;
    const value = instance.getValue();

    instance.destroy();
    editorInstances.delete(tabId);

    // Recreate with new config
    createEditor(tabId, container, value, instance.config);
}

/**
 * Debounced query check
 */
let queryCheckTimeouts = new Map();

function debounceQueryCheck(tab) {
    const existing = queryCheckTimeouts.get(tab.id);
    if (existing) clearTimeout(existing);

    queryCheckTimeouts.set(tab.id, setTimeout(() => {
        updateEditorQueryCheck(tab);
        queryCheckTimeouts.delete(tab.id);
    }, 500));
}

/**
 * Execute query from editor (called by keymap)
 */
function executeQueryFromEditor(tabId) {
    const tab = getEditorTab(tabId);
    if (tab && window.executeQuery) {
        window.executeQuery(tab.id);
    }
}

/**
 * Get tab by ID (uses global queryTabs from app.js)
 */
function getEditorTab(tabId) {
    if (typeof window !== "undefined" && typeof window.getTabById === "function") {
        return window.getTabById(tabId);
    }
    if (typeof window !== "undefined" && window.queryTabs) {
        return window.queryTabs.find(t => t && t.id === tabId);
    }
    return null;
}

/**
 * Update tab name (uses global function from app.js)
 */
function updateEditorTabName(tab) {
    if (typeof window !== "undefined" && typeof window.updateTabName === "function") {
        window.updateTabName(tab);
    }
}

/**
 * Update query check for tab (uses global function from app.js)
 */
function updateEditorQueryCheck(tab) {
    if (typeof window !== "undefined" && typeof window.updateQueryCheckForTab === "function") {
        window.updateQueryCheckForTab(tab);
    }
}

/**
 * Update query suggestions for tab (uses global function from app.js)
 */
function updateEditorQuerySuggestions(tab) {
    if (typeof window !== "undefined" && typeof window.updateQuerySuggestionsForTab === "function") {
        window.updateQuerySuggestionsForTab(tab);
    }
}


/**
 * Load CodeMirror 6 modules from CDN
 */
let codeMirrorLoaded = false;
let codeMirrorLoadPromise = null;

async function loadCodeMirrorModules() {
    if (codeMirrorLoaded) return;
    if (codeMirrorLoadPromise) return codeMirrorLoadPromise;

    codeMirrorLoadPromise = (async () => {
        // Check if modules are already available
        if (window.CodeMirror) {
            // Destructure from global CodeMirror object
            const CM = window.CodeMirror;
            window.EditorState = CM.EditorState;
            window.EditorView = CM.EditorView;
            window.basicSetup = CM.basicSetup;
            window.lineNumbers = CM.lineNumbers;
            window.bracketMatching = CM.bracketMatching;
            window.closeBrackets = CM.closeBrackets;
            window.indentWithTab = CM.indentWithTab;
            window.keymap = CM.keymap;
            window.placeholder = CM.placeholder;
            window.oneDark = CM.oneDark;
            window.oneLight = CM.oneLight;
            window.sql = CM.sql;
            codeMirrorLoaded = true;
            return;
        }

        // Load from CDN using ES modules
        try {
            const modules = await import("https://cdn.jsdelivr.net/npm/@codemirror/view@6/+esm");
            window.EditorView = modules.EditorView;
            window.keymap = modules.keymap;
            window.lineNumbers = modules.lineNumbers;
            window.bracketMatching = modules.bracketMatching;
            window.placeholder = modules.placeholder;
            window.EditorView_theme = modules.theme;
        } catch (e) {
            console.error("Failed to load @codemirror/view:", e);
            throw e;
        }

        try {
            const stateModule = await import("https://cdn.jsdelivr.net/npm/@codemirror/state@6/+esm");
            window.EditorState = stateModule.EditorState;
        } catch (e) {
            console.error("Failed to load @codemirror/state:", e);
            throw e;
        }

        try {
            const cmModule = await import("https://cdn.jsdelivr.net/npm/codemirror@6/+esm");
            window.basicSetup = cmModule.basicSetup;
        } catch (e) {
            console.warn("Failed to load codemirror basicSetup:", e);
            window.basicSetup = [];
        }

        try {
            const langModule = await import("https://cdn.jsdelivr.net/npm/@codemirror/language@6/+esm");
            window.indentWithTab = langModule.indentWithTab;
            if (langModule.bracketMatching) window.bracketMatching = langModule.bracketMatching;
        } catch (e) {
            console.warn("Optional @codemirror/language not loaded:", e);
            window.indentWithTab = [];
        }

        try {
            const acModule = await import("https://cdn.jsdelivr.net/npm/@codemirror/autocomplete@6/+esm");
            window.closeBrackets = acModule.closeBrackets;
        } catch (e) {
            console.warn("Optional @codemirror/autocomplete not loaded:", e);
            window.closeBrackets = () => [];
        }

        try {
            const langSqlModule = await import("https://cdn.jsdelivr.net/npm/@codemirror/lang-sql@6/+esm");
            window.sql = langSqlModule.sql;
        } catch (e) {
            console.error("Failed to load @codemirror/lang-sql:", e);
            throw e;
        }

        try {
            const themeOneDarkModule = await import("https://cdn.jsdelivr.net/npm/@codemirror/theme-one-dark@6/+esm");
            window.oneDark = themeOneDarkModule.oneDark;
        } catch (e) {
            console.warn("Optional @codemirror/theme-one-dark not loaded:", e);
            window.oneDark = [];
        }

        window.oneLight = [];

        codeMirrorLoaded = true;
    })();

    return codeMirrorLoadPromise;
}

/**
 * Get editor instance for a tab
 */
function getEditorInstance(tabId) {
    return editorInstances.get(tabId);
}

/**
 * Destroy editor instance for a tab
 */
function destroyEditor(tabId) {
    const instance = editorInstances.get(tabId);
    if (instance) {
        instance.destroy();
        editorInstances.delete(tabId);
    }
}

/**
 * Set editor value
 */
function setEditorValue(tabId, value) {
    const instance = editorInstances.get(tabId);
    if (instance) {
        instance.setValue(value);
    }
}

/**
 * Get editor value
 */
function getEditorValue(tabId) {
    const instance = editorInstances.get(tabId);
    return instance ? instance.getValue() : "";
}

/**
 * Focus editor
 */
function focusEditor(tabId) {
    const instance = editorInstances.get(tabId);
    if (instance) {
        instance.focus();
    }
}

/**
 * Update editor theme based on app theme
 */
function updateEditorTheme(tabId, isDark) {
    updateEditorConfig(tabId, { theme: isDark ? "dark" : "light" });
}

/**
 * Apply user preferences to editor
 */
function applyEditorPreferences(tabId, preferences) {
    const config = {};

    // Handle preferences without "editor" prefix (new format)
    if (preferences.fontSize) config.fontSize = preferences.fontSize;
    if (preferences.lineWrapping !== undefined) config.lineWrapping = preferences.lineWrapping;
    if (preferences.lineNumbers !== undefined) config.lineNumbers = preferences.lineNumbers;
    if (preferences.tabSize) config.tabSize = preferences.tabSize;
    if (preferences.bracketMatching !== undefined) config.bracketMatching = preferences.bracketMatching;
    if (preferences.autoCloseBrackets !== undefined) config.autoCloseBrackets = preferences.autoCloseBrackets;

    // Handle theme - "auto" means follow app theme
    if (preferences.theme) {
        if (preferences.theme === "auto") {
            config.theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
        } else {
            config.theme = preferences.theme;
        }
    }

    if (Object.keys(config).length > 0) {
        updateEditorConfig(tabId, config);
    }
}

// Export for global access
window.CodeMirrorEditor = {
    createEditor,
    getEditorInstance,
    destroyEditor,
    setEditorValue,
    getEditorValue,
    focusEditor,
    updateEditorTheme,
    applyEditorPreferences,
    updateEditorConfig,
    DEFAULT_CONFIG
};

// Also export individual functions for backward compatibility
window.createCodeMirrorEditor = createEditor;
window.destroyCodeMirrorEditor = destroyEditor;