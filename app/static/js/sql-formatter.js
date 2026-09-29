"use strict";

/**
 * SQL Formatter Module for Query Execute
 * Provides SQL formatting/beautification using sql-formatter library
 * Supports multiple SQL dialects with configurable options
 */

// Formatter instance cache
let sqlFormatterInstance = null;
let sqlFormatterLoadPromise = null;

/**
 * Load sql-formatter library from CDN
 */
async function loadSqlFormatter() {
    if (sqlFormatterInstance) return sqlFormatterInstance;
    if (sqlFormatterLoadPromise) return sqlFormatterLoadPromise;

    sqlFormatterLoadPromise = (async () => {
        try {
            // Load sql-formatter from CDN
            const module = await import("https://cdn.jsdelivr.net/npm/sql-formatter@15/+esm");
            sqlFormatterInstance = module.default || module;
            return sqlFormatterInstance;
        } catch (error) {
            console.error("Failed to load sql-formatter:", error);
            throw error;
        }
    })();

    return sqlFormatterLoadPromise;
}

/**
 * Format SQL query with options
 * @param {string} sql - SQL query to format
 * @param {Object} options - Formatting options
 * @returns {Promise<string>} Formatted SQL
 */
async function formatSql(sql, options = {}) {
    if (!sql || !sql.trim()) return sql;

    try {
        const formatter = await loadSqlFormatter();
        if (formatter) {
            const config = {
                language: options.dialect || "sql",
                indent: options.indent || "  ",
                keywordCase: options.keywordCase || "upper",
                linesBetweenQueries: options.linesBetweenQueries || 1,
                tabWidth: options.tabWidth || 2,
                useTabs: options.useTabs || false,
                ...options
            };
            return formatter.format(sql, config);
        }
    } catch (error) {
        console.warn("SQL formatter CDN unavailable, applying basic format:", error);
    }
    return formatSqlSync(sql, options.dialect || "sql");
}

/**
 * Format selected text or entire query
 * @param {string} sql - SQL query
 * @param {number} selectionStart - Selection start position
 * @param {number} selectionEnd - Selection end position
 * @param {Object} options - Formatting options
 * @returns {Promise<{formatted: string, selectionStart: number, selectionEnd: number}>}
 */
async function formatSqlRange(sql, selectionStart, selectionEnd, options = {}) {
    if (selectionStart !== selectionEnd && selectionStart >= 0 && selectionEnd <= sql.length) {
        // Format only selected range
        const before = sql.substring(0, selectionStart);
        const selected = sql.substring(selectionStart, selectionEnd);
        const after = sql.substring(selectionEnd);

        const formattedSelected = await formatSql(selected, options);

        // Calculate new selection positions
        const newSelectionStart = before.length;
        const newSelectionEnd = before.length + formattedSelected.length;

        return {
            formatted: before + formattedSelected + after,
            selectionStart: newSelectionStart,
            selectionEnd: newSelectionEnd
        };
    } else {
        // Format entire query
        const formatted = await formatSql(sql, options);
        return {
            formatted,
            selectionStart: 0,
            selectionEnd: formatted.length
        };
    }
}

/**
 * Detect SQL dialect from query
 */
function detectSqlDialect(sql) {
    const upperSql = sql.toUpperCase().trim();

    // PostgreSQL specific
    if (upperSql.includes("ILIKE") || upperSql.includes("::") || upperSql.includes("ARRAY[") ||
        upperSql.match(/\b(SERIAL|BIGSERIAL|UUID|JSONB?|TSVECTOR|TSQUERY)\b/)) {
        return "postgresql";
    }

    // MySQL specific
    if (upperSql.includes("AUTO_INCREMENT") || upperSql.includes("ENGINE=") ||
        upperSql.match(/\b(LIMIT\s+\d+\s*,\s*\d+|BACKTICKS|`[^`]+`)\b/)) {
        return "mysql";
    }

    // SQLite specific
    if (upperSql.includes("AUTOINCREMENT") || upperSql.match(/\b(PRAGMA|ATTACH|DETACH|VACUUM)\b/)) {
        return "sqlite";
    }

    // MSSQL specific
    if (upperSql.includes("TOP ") || upperSql.includes("IDENTITY(") ||
        upperSql.match(/\b(NVARCHAR|NVARCHAR\(MAX\)|UNIQUEIDENTIFIER)\b/)) {
        return "tsql";
    }

    // Default to standard SQL
    return "sql";
}

/**
 * Get formatting options from user preferences
 */
function getFormatterOptions(preferences = {}) {
    return {
        dialect: preferences.sqlDialect || "sql",
        indent: preferences.indent || "  ",
        keywordCase: preferences.keywordCase || "upper",
        tabWidth: preferences.tabWidth || 2,
        useTabs: preferences.useTabs || false,
        linesBetweenQueries: 1
    };
}

/**
 * Format SQL in CodeMirror editor
 */
async function formatEditorSql(tabId, options = {}) {
    const instance = window.CodeMirrorEditor?.getEditorInstance(tabId);
    const tab = (typeof window.getTabById === "function") ? window.getTabById(tabId) : (window.queryTabs || []).find(t => t.id === tabId);

    if (!instance) {
        if (tab?.editorElement) {
            try {
                const textarea = tab.editorElement;
                const fullSql = textarea.value;
                const prefs = window.editorPreferences?.[tabId] || {};
                const options_ = {
                    dialect: detectSqlDialect(fullSql),
                    indent: prefs.indent || "  ",
                    keywordCase: prefs.keywordCase || "upper",
                    ...options
                };
                const formatted = await formatSql(fullSql, options_);
                textarea.value = formatted;
                tab.query = formatted;
                tab.isDirty = true;
                if (window.updateTabName) window.updateTabName(tab);
                if (window.showToast) window.showToast("SQL formatted successfully", "success");
            } catch (err) {
                console.error("Failed to format textarea SQL:", err);
            }
        }
        return;
    }

    const editor = instance.view;
    const state = editor.state;
    const selection = state.selection.main;

    try {
        const fullSql = state.doc.toString();
        const prefs = window.editorPreferences?.[tabId] || {};

        const options_ = {
            dialect: detectSqlDialect(fullSql),
            indent: prefs.indent || "  ",
            keywordCase: prefs.keywordCase || "upper",
            tabWidth: prefs.tabSize || 2,
            useTabs: prefs.useTabs || false,
            ...options
        };

        const formatted = await formatSql(fullSql, options_);

        // Replace entire document
        editor.dispatch({
            changes: { from: 0, to: state.doc.length, insert: formatted }
        });

        // Update tab query
        if (window.queryTabs) {
            const tab = window.queryTabs.find(t => t.id === tabId);
            if (tab) {
                tab.query = formatted;
                tab.isDirty = true;
                if (window.updateTabName) window.updateTabName(tab);
            }
        }

        // Show success toast
        if (window.showToast) {
            window.showToast("SQL formatted successfully", "success");
        }
    } catch (error) {
        console.error("Formatting error:", error);
        if (window.showToast) {
            window.showToast(`Formatting failed: ${error.message}`, "error");
        }
    }
}

/**
 * Format selected text in CodeMirror editor
 */
async function formatEditorSelection(tabId, options = {}) {
    if (!window.CodeMirrorEditor) return;

    const instance = window.CodeMirrorEditor.getEditorInstance(tabId);
    if (!instance) return;

    const editor = instance.view;
    const state = editor.state;
    const selection = state.selection.main;

    if (selection.from === selection.to) {
        // No selection - format entire query
        return formatEditorSql(tabId, options);
    }

    try {
        const fullSql = state.doc.toString();
        const prefs = window.editorPreferences?.[tabId] || {};
        const selectedSql = fullSql.substring(selection.from, selection.to);

        const options_ = {
            dialect: detectSqlDialect(fullSql),
            indent: prefs.indent || "  ",
            keywordCase: prefs.keywordCase || "upper",
            tabWidth: prefs.tabSize || 2,
            useTabs: prefs.useTabs || false,
            ...options
        };

        const formattedSelected = await formatSql(selectedSql, options_);

        // Replace selected text
        editor.dispatch({
            changes: { from: selection.from, to: selection.to, insert: formattedSelected }
        });

        // Update tab query
        if (window.queryTabs) {
            const tab = window.queryTabs.find(t => t.id === tabId);
            if (tab) {
                tab.query = editor.state.doc.toString();
                tab.isDirty = true;
                if (window.updateTabName) window.updateTabName(tab);
            }
        }

        if (window.showToast) {
            window.showToast("Selection formatted successfully", "success");
        }
    } catch (error) {
        console.error("Formatting error:", error);
        if (window.showToast) {
            window.showToast(`Formatting failed: ${error.message}`, "error");
        }
    }
}

/**
 * Backend endpoint handler for SQL formatting
 * Used by /api/query/format endpoint
 */
function formatSqlBackend(sql, dialect = "sql", options = {}) {
    // This would be called from the backend (Python)
    // For now, return the synchronous version
    // The actual backend implementation is in app/main.py
    return formatSql(sql, { dialect, ...options });
}

/**
 * Format SQL for display (synchronous, for simple cases)
 */
function formatSqlSync(sql, dialect = "sql") {
    // Simple synchronous formatting for basic cases
    // This is a fallback when async is not available
    try {
        let formatted = sql.trim();

        // Basic keyword capitalization
        const keywords = [
            'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
            'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'NULL',
            'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT',
            'EXCEPT', 'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
            'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'FROM',
            'CREATE', 'TABLE', 'INDEX', 'VIEW', 'ALTER', 'DROP', 'TRUNCATE',
            'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION'
        ];

        let result = formatted;
        for (const kw of keywords) {
            const regex = new RegExp(`\\b${kw}\\b`, 'gi');
            result = result.replace(regex, kw.toUpperCase());
        }

        // Basic indentation for common patterns
        result = result
            .replace(/,/g, ',\n  ')
            .replace(/\bFROM\b/gi, '\nFROM')
            .replace(/\bJOIN\b/gi, '\n  JOIN')
            .replace(/\bWHERE\b/gi, '\nWHERE')
            .replace(/\bGROUP BY\b/gi, '\nGROUP BY')
            .replace(/\bORDER BY\b/gi, '\nORDER BY')
            .replace(/\bHAVING\b/gi, '\nHAVING')
            .replace(/\bUNION\b/gi, '\nUNION')
            .replace(/\(/g, '(\n  ')
            .replace(/\)/g, '\n)');

        return result;
    } catch (error) {
        return sql;
    }
}

// Export for global access
window.SqlFormatter = {
    formatSql,
    formatSqlRange,
    formatSqlSync,
    detectSqlDialect,
    getFormatterOptions,
    formatEditorSql,
    formatEditorSelection,
    formatSqlBackend,
    loadSqlFormatter
};

// Export individual functions
window.formatSql = formatSql;
window.formatSqlRange = formatSqlRange;
window.formatSqlSync = formatSqlSync;
window.detectSqlDialect = detectSqlDialect;
