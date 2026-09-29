"use strict";

/**
 * SQL Autocomplete Module for Query Execute
 * Provides context-aware SQL autocomplete with schema awareness
 * Integrates with CodeMirror 6 autocomplete system
 */

function escapeHtml(value) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return String(value ?? "").replace(/[&<>"']/g, char => map[char]);
}


// Schema metadata cache
const schemaCache = new Map();

/**
 * Load schema metadata for a connection
 */
async function loadSchemaMetadata(connectionId) {
    if (schemaCache.has(connectionId)) {
        return schemaCache.get(connectionId);
    }
    
    try {
        const result = await apiFetch(`/api/connections/${connectionId}/schema`);
        if (result.success && result.tables) {
            const schema = {
                tables: result.tables.map(t => ({
                    name: t.name,
                    columns: (t.columns || []).map(c => ({
                        name: c.name,
                        type: c.type,
                        isPrimaryKey: c.is_primary_key,
                        notNull: c.not_null,
                        default: c.default
                    })),
                    foreignKeys: t.foreign_keys || []
                }))
            };
            schemaCache.set(connectionId, schema);
            return schema;
        }
    } catch (error) {
        console.error("Failed to load schema:", error);
    }
    return null;
}

/**
 * Clear schema cache for a connection
 */
function clearSchemaCache(connectionId) {
    schemaCache.delete(connectionId);
}

/**
 * Get autocomplete suggestions based on cursor context
 */
function getAutocompleteSuggestions(editorView, connectionId, schema) {
    if (!schema) return [];
    
    const state = editorView.state;
    const selection = editorView.state.selection.main;
    const beforeCursor = editorView.state.doc.toString().substring(0, selection.from);
    
    // Analyze context before cursor
    const context = analyzeSqlContext(beforeCursor);
    
    let suggestions = [];
    
    switch (context.type) {
        case 'table':
            suggestions = schema.tables.map(t => ({
                label: t.name,
                type: 'table',
                detail: `${t.columns.length} columns`,
                insertText: t.name
            }));
            break;
            
        case 'column':
            if (context.table) {
                const table = schema.tables.find(t => t.name.toLowerCase() === context.table.toLowerCase());
                if (table) {
                    suggestions = table.columns.map(c => ({
                        label: c.name,
                        type: 'column',
                        detail: `${c.type}${c.isPrimaryKey ? ' (PK)' : ''}${c.notNull ? ' NOT NULL' : ''}`,
                        insertText: c.name
                    }));
                }
            }
            break;
            
        case 'keyword':
            suggestions = getKeywordSuggestions(context.keywordContext);
            break;
            
        case 'function':
            suggestions = getFunctionSuggestions();
            break;
            
        case 'alias':
            suggestions = schema.tables.map(t => ({
                label: t.name,
                type: 'table',
                detail: 'table',
                insertText: `${t.name} AS `
            }));
            break;
    }
    
    return suggestions;
}

/**
 * Analyze SQL context before cursor
 */
function analyzeSqlContext(beforeCursor) {
    const sql = beforeCursor.toUpperCase();
    
    // Check for table context (after FROM, JOIN, UPDATE, INTO, etc.)
    const tableKeywords = /\b(FROM|JOIN|UPDATE|INTO|FROM|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|OUTER\s+JOIN|CROSS\s+JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/;
    const tableMatch = beforeCursor.match(tableKeywords);
    if (tableMatch) {
        return { type: 'table' };
    }
    
    // Check for column context (after table name or alias)
    const columnKeywords = /\b(SELECT|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|ON|SET|,)\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)?$/;
    const columnMatch = beforeCursor.match(columnKeywords);
    if (columnMatch) {
        return { 
            type: 'column', 
            table: columnMatch[2],
            prefix: columnMatch[3] || ''
        };
    }
    
    // Check for alias context (after table name)
    const aliasKeywords = /\b(FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(AS\s+)?$/;
    const aliasMatch = beforeCursor.match(aliasKeywords);
    if (aliasMatch) {
        return { type: 'alias', table: aliasMatch[2] };
    }
    
    // Check for keyword context
    const keywordMatch = beforeCursor.match(/\b(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|UPDATE|DELETE|INSERT|INTO|SET|VALUES|CREATE|ALTER|DROP|INDEX|VIEW|UNION|EXCEPT|INTERSECT|LIMIT|OFFSET|GROUP\s+BY|ORDER\s+BY|DISTINCT|AS|ON|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|IS|NULL|CASE|WHEN|THEN|ELSE|END|BEGIN|COMMIT|ROLLBACK)\s*$/);
    if (keywordMatch) {
        return { 
            type: 'keyword', 
            keywordContext: keywordMatch[1]
        };
    }
    
    // Check for function context
    const functionMatch = beforeCursor.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\($/);
    if (functionMatch) {
        return { type: 'function', prefix: functionMatch[1] };
    }
    
    return { type: 'unknown' };
}

/**
 * Get SQL keyword suggestions based on context
 */
function getKeywordSuggestions(context) {
    const keywords = [
        'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING',
        'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'CROSS JOIN',
        'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'NULL',
        'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
        'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT',
        'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
        'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'FROM',
        'CREATE', 'TABLE', 'INDEX', 'VIEW', 'ALTER', 'DROP', 'TRUNCATE',
        'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION',
        'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CASE'
    ];
    
    return keywords.map(kw => ({
        label: kw,
        type: 'keyword',
        detail: 'SQL keyword',
        insertText: kw + ' ',
        apply: (view) => { }
    }));
}

/**
 * Get SQL function suggestions
 */
function getFunctionSuggestions() {
    const functions = [
        'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
        'COALESCE', 'NULLIF', 'IFNULL', 'NVL',
        'UPPER', 'LOWER', 'TRIM', 'LTRIM', 'RTRIM',
        'SUBSTRING', 'SUBSTR', 'LENGTH', 'LEN',
        'CONCAT', '||', 'CONCAT_WS',
        'NOW', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CURRENT_TIME',
        'DATE', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND',
        'DATE_ADD', 'DATE_SUB', 'DATEDIFF', 'DATE_FORMAT',
        'CAST', 'CONVERT', 'CAST',
        'ROUND', 'FLOOR', 'CEIL', 'ABS', 'MOD',
        'RANK', 'ROW_NUMBER', 'DENSE_RANK', 'LAG', 'LEAD'
    ];
    
    return functions.map(f => ({
        label: f,
        type: 'function',
        detail: 'SQL function',
        insertText: f + '(',
        apply: (view) => { }
    }));
}

/**
 * Apply column completion (add table prefix if needed)
 */
function applyColumnCompletion(view, columnName) {
    const state = view.state;
    const selection = view.state.selection.main;
    const beforeCursor = view.state.doc.toString().substring(0, view.state.selection.main.from);
    
    // Check if we need to add table prefix
    const match = beforeCursor.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (match) {
        // Replace the partial with table.column
        view.dispatch({
            changes: { 
                from: view.state.selection.main.from - match[1].length, 
                to: view.state.selection.main.to, 
                insert: match[1] + '.' 
            }
        });
    }
}

/**
 * Initialize autocomplete for a tab
 */
async function initializeAutocomplete(tab) {
    if (!tab || !tab.editorInstance || !tab.connectionIds.size) return;
    
    const connectionId = Array.from(tab.connectionIds)[0];
    const schema = await loadSchemaMetadata(connectionId);
    
    if (!schema) return;
    
    // Store schema reference on tab
    tab.schema = schema;
    
    // Add autocomplete extension to editor
    if (window.CodeMirrorEditor && tab.editorInstance) {
        const instance = tab.editorInstance;
        
        instance.destroy();
        
        window.CodeMirrorEditor.createEditor(tab.id, tab.editorHost, tab.query, {
            ...tab.editorPreferences,
            extensions: [createAutocompleteExtension(tab.id, connectionId)]
        }).then(instance => {
            tab.editorInstance = instance;
            tab.editorView = instance.view;
            if (tab.query) instance.setValue(tab.query);
        });
    }
}

/**
 * Create autocomplete extension for CodeMirror
 */
function createAutocompleteExtension(tabId, connectionId) {
    const EditorViewClass = (typeof window !== "undefined" && window.EditorView) ? window.EditorView : (typeof EditorView !== "undefined" ? EditorView : null);
    if (!EditorViewClass || !EditorViewClass.domEventHandlers) return [];
    return EditorViewClass.domEventHandlers({
        keydown: (event, view) => {
            // Trigger autocomplete on Ctrl+Space
            if (event.key === ' ' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                const tab = (typeof window !== "undefined" && typeof window.getTabById === "function") ? window.getTabById(tabId) : (typeof getTabById === "function" ? getTabById(tabId) : null);
                if (!tab || !tab.schema) return false;
                const suggestions = getAutocompleteSuggestions(view, connectionId, tab.schema);
                if (suggestions.length > 0) {
                    showAutocompletePanel(view, suggestions);
                    return true;
                }
            }
            // Trigger autocomplete on period without blocking the dot from being typed
            if (event.key === '.' && !event.ctrlKey && !event.metaKey) {
                setTimeout(() => {
                    const tab = (typeof window !== "undefined" && typeof window.getTabById === "function") ? window.getTabById(tabId) : (typeof getTabById === "function" ? getTabById(tabId) : null);
                    if (!tab || !tab.schema) return;
                    const suggestions = getAutocompleteSuggestions(view, connectionId, tab.schema);
                    if (suggestions.length > 0) {
                        showAutocompletePanel(view, suggestions);
                    }
                }, 20);
            }
            return false;
        }
    });
}

/**
 * Show autocomplete panel (simplified implementation)
 */
function showAutocompletePanel(view, suggestions) {
    const existing = document.querySelector('.autocomplete-panel');
    if (existing) existing.remove();
    
    if (!suggestions || suggestions.length === 0) return;

    const panel = document.createElement('div');
    panel.className = 'autocomplete-panel';
    panel.style.cssText = `
        position: absolute;
        background: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        max-height: 300px;
        overflow-y: auto;
        z-index: 1000;
        min-width: 250px;
    `;
    
    panel.innerHTML = suggestions.map(s => `
        <div class="autocomplete-item" data-insert="${escapeHtml(s.insertText || s.label)}" 
             style="padding: 0.5rem 1rem; cursor: pointer; display: flex; align-items: center; gap: 0.5rem;">
            <span class="autocomplete-type" style="color: var(--text-muted); font-size: 0.7rem; text-transform: uppercase; min-width: 60px;">${s.type}</span>
            <span class="autocomplete-label">${escapeHtml(s.label)}</span>
            ${s.detail ? `<span class="autocomplete-detail" style="margin-left: auto; color: var(--text-muted); font-size: 0.75rem;">${escapeHtml(s.detail)}</span>` : ''}
        </div>
    `).join('');
    
    // Position near cursor
    const coords = view.coordsAtPos(view.state.selection.main.head);
    if (coords) {
        panel.style.top = `${coords.bottom + 5}px`;
        panel.style.left = `${coords.left}px`;
    } else {
        const rect = view.dom.getBoundingClientRect();
        panel.style.top = `${rect.top + 40}px`;
        panel.style.left = `${rect.left + 20}px`;
    }
    
    document.body.appendChild(panel);
    
    // Handle click
    panel.addEventListener('click', (e) => {
        const item = e.target.closest('.autocomplete-item');
        if (item) {
            const insertText = item.dataset.insert;
            const head = view.state.selection.main.head;
            const before = view.state.doc.sliceString(0, head);
            const tokenMatch = before.match(/[A-Za-z_][A-Za-z0-9_$]*$/);
            const insertPos = tokenMatch ? head - tokenMatch[0].length : view.state.selection.main.from;
            view.dispatch({
                changes: { 
                    from: insertPos, 
                    to: view.state.selection.main.to, 
                    insert: insertText 
                }
            });
            panel.remove();
            view.focus();
        }
    });

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closePanel(e) {
            if (!panel.contains(e.target)) {
                panel.remove();
                document.removeEventListener('click', closePanel);
            }
        });
    }, 0);
}

/**
 * Clear schema cache
 */
function clearSchemaCache(connectionId) {
    schemaCache.delete(connectionId);
}

/**
 * Refresh autocomplete for a tab
 */
async function refreshAutocomplete(tabId) {
    const tabFinder = (typeof window !== "undefined" && typeof window.getTabById === "function") ? window.getTabById : (typeof getTabById === "function" ? getTabById : null);
    const tab = tabFinder ? tabFinder(tabId) : null;
    if (!tab || !tab.connectionIds.size) return;
    
    const connectionId = Array.from(tab.connectionIds)[0];
    clearSchemaCache(connectionId);
    await loadSchemaMetadata(connectionId);
    
    // Reinitialize autocomplete
    const tabObj = tabFinder ? tabFinder(tabId) : null;
    if (tabObj && tabObj.editorInstance) {
        await initializeAutocomplete(tabObj);
    }
}

// Export for global access
window.AutocompleteManager = {
    loadSchemaMetadata,
    clearSchemaCache,
    getAutocompleteSuggestions,
    initializeAutocomplete,
    refreshAutocomplete,
    getKeywordSuggestions,
    getFunctionSuggestions
};

// Export individual functions
window.loadSchemaMetadata = loadSchemaMetadata;
window.clearSchemaCache = clearSchemaCache;
window.getAutocompleteSuggestions = getAutocompleteSuggestions;
window.initializeAutocomplete = initializeAutocomplete;
window.refreshAutocomplete = refreshAutocomplete;
