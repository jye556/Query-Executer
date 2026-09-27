"use strict";

/**
 * Query Snippets Library for Query Execute
 * Provides CRUD operations for query snippets with categories, tags, and sharing
 */

// State
let snippets = [];
let snippetCategories = [];
let snippetsLoaded = false;

// API base
const SNIPPETS_API = "/api/snippets";

/**
 * Load all snippets for current user
 */
async function loadSnippets() {
    try {
        const response = await apiFetch(SNIPPETS_API);
        snippets = response.snippets || [];
        snippetCategories = [...new Set(snippets.map(s => s.category).filter(Boolean))];
        snippetsLoaded = true;
        return snippets;
    } catch (error) {
        console.error("Failed to load snippets:", error);
        return [];
    }
}

/**
 * Get snippets by category
 */
function getSnippetsByCategory(category) {
    if (category === "all") return snippets;
    if (category === "favorites") return snippets.filter(s => s.is_favorite);
    if (category === "shared") return snippets.filter(s => s.is_shared);
    return snippets.filter(s => s.category === category);
}

/**
 * Create a new snippet
 */
async function createSnippet(snippetData) {
    try {
        const response = await apiFetch(SNIPPETS_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(snippetData)
        });
        const snippet = response.snippet || response;
        snippets.push(snippet);
        if (snippet.category && !snippetCategories.includes(snippet.category)) {
            snippetCategories.push(snippet.category);
        }
        renderSnippetsPanel();
        return snippet;
    } catch (error) {
        showToast(`Failed to create snippet: ${error.message}`, "error");
        throw error;
    }
}

/**
 * Update an existing snippet
 */
async function updateSnippet(snippetId, updates) {
    try {
        const response = await apiFetch(`${SNIPPETS_API}/${snippetId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updates)
        });
        const index = snippets.findIndex(s => s.id === snippetId);
        if (index !== -1) {
            snippets[index] = { ...snippets[index], ...updates };
            if (updates.category && !snippetCategories.includes(updates.category)) {
                snippetCategories.push(updates.category);
            }
        }
        renderSnippetsPanel();
        return response.snippet || response;
    } catch (error) {
        showToast(`Failed to update snippet: ${error.message}`, "error");
        throw error;
    }
}

/**
 * Delete a snippet
 */
async function deleteSnippet(snippetId) {
    if (!confirm("Delete this snippet?")) return;
    try {
        await apiFetch(`${SNIPPETS_API}/${snippetId}`, { method: "DELETE" });
        snippets = snippets.filter(s => s.id !== snippetId);
        renderSnippetsPanel();
        showToast("Snippet deleted", "success");
    } catch (error) {
        showToast(`Failed to delete snippet: ${error.message}`, "error");
    }
}

/**
 * Toggle favorite status
 */
async function toggleSnippetFavorite(snippetId) {
    const snippet = snippets.find(s => s.id === snippetId);
    if (!snippet) return;
    await updateSnippet(snippetId, { is_favorite: !snippet.is_favorite });
}

/**
 * Toggle shared status
 */
async function toggleSnippetShared(snippetId) {
    const snippet = snippets.find(s => s.id === snippetId);
    if (!snippet) return;
    await updateSnippet(snippetId, { is_shared: !snippet.is_shared });
}

/**
 * Insert snippet into editor
 */
function insertSnippet(snippetId) {
    const snippet = snippets.find(s => s.id === snippetId);
    if (!snippet) return;

    const activeTab = getActiveTab();
    if (!activeTab) return;

    // Replace variables in snippet
    let sql = snippet.sql;
    
    // Replace {{variable}} placeholders
    sql = sql.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
        const value = prompt(`Enter value for ${varName}:`);
        return value !== null ? value : match;
    });

    // Insert at cursor position in CodeMirror editor
    if (activeTab.editorInstance && window.CodeMirrorEditor) {
        const instance = window.CodeMirrorEditor.getEditorInstance(activeTab.id);
        if (instance) {
            const view = instance.view;
            const state = view.state;
            const selection = state.selection.main;
            
            // Insert at cursor position
            view.dispatch({
                changes: { from: selection.from, to: selection.to, insert: sql }
            });
            
            // Update tab query
            activeTab.query = view.state.doc.toString();
            activeTab.isDirty = true;
            updateTabName(activeTab);
            updateQueryCheckForTab(activeTab);
        }
    } else if (activeTab.editorElement) {
        // Fallback for textarea
        const editor = activeTab.editorElement;
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const before = editor.value.substring(0, start);
        const after = editor.value.substring(end);
        editor.value = before + sql + after;
        const newPos = start + sql.length;
        editor.setSelectionRange(newPos, newPos);
        activeTab.query = editor.value;
        activeTab.isDirty = true;
        updateTabName(activeTab);
        updateQueryCheckForTab(activeTab);
    }
    
    showToast(`Inserted snippet: ${snippet.name}`, "success");
}

/**
 * Render snippets panel in left sidebar
 */
function renderSnippetsPanel() {
    const container = document.getElementById("snippets-panel");
    if (!container) return;

    const activeCategory = container.dataset.activeCategory || "all";
    const searchTerm = (document.getElementById("snippets-search")?.value || "").toLowerCase();
    
    let filteredSnippets = getSnippetsByCategory(activeCategory);
    if (searchTerm) {
        filteredSnippets = filteredSnippets.filter(s => 
            s.name.toLowerCase().includes(searchTerm) ||
            s.sql.toLowerCase().includes(searchTerm) ||
            (s.description || "").toLowerCase().includes(searchTerm)
        );
    }

    container.innerHTML = `
        <div class="snippets-toolbar">
            <input type="search" id="snippets-search" class="connection-search-input" 
                   placeholder="Search snippets..." value="${escapeHtml(document.getElementById("snippets-search")?.value || "")}"
                   autocomplete="off">
            <select id="snippets-category" class="connection-group-filter" style="max-width: 150px;">
                <option value="all">All</option>
                <option value="favorites" ${activeCategory === "favorites" ? "selected" : ""}>⭐ Favorites</option>
                <option value="shared" ${activeCategory === "shared" ? "selected" : ""}>🔗 Shared</option>
                ${snippetCategories.map(cat => `<option value="${escapeHtml(cat)}" ${activeCategory === cat ? "selected" : ""}>${escapeHtml(cat)}</option>`).join("")}
                <option value="uncategorized" ${activeCategory === "uncategorized" ? "selected" : ""}>Uncategorized</option>
            </select>
        </div>
        <div id="snippets-list" class="snippets-list">
            ${filteredSnippets.length === 0 ? 
                '<p class="panel-empty">No snippets found. Create your first snippet!</p>' :
                filteredSnippets.map(snippet => `
                    <div class="snippet-item${snippet.is_favorite ? " favorite" : ""}${snippet.is_shared ? " shared" : ""}" data-id="${snippet.id}">
                        <div class="snippet-header">
                            <span class="snippet-name">${escapeHtml(snippet.name)}</span>
                            <div class="snippet-badges">
                                ${snippet.is_favorite ? '<span class="badge favorite" title="Favorite">⭐</span>' : ''}
                                ${snippet.is_shared ? '<span class="badge shared" title="Shared">🔗</span>' : ''}
                                ${snippet.category ? `<span class="badge category">${escapeHtml(snippet.category)}</span>` : ''}
                            </div>
                        </div>
                        ${snippet.description ? `<div class="snippet-description">${escapeHtml(snippet.description)}</div>` : ''}
                        <div class="snippet-preview">${escapeHtml(snippet.sql.substring(0, 100))}${snippet.sql.length > 100 ? "..." : ""}</div>
                        <div class="snippet-actions">
                            <button type="button" class="btn btn-icon btn-sm" data-action="insert" title="Insert into editor">➕</button>
                            ${currentUser?.role === "admin" || snippet.user_id === currentUser?.id ? `
                                <button type="button" class="btn btn-icon btn-sm" data-action="edit" title="Edit snippet">✏️</button>
                                <button type="button" class="btn btn-icon btn-sm ${snippet.is_favorite ? "active" : ""}" data-action="favorite" title="${snippet.is_favorite ? "Remove from favorites" : "Add to favorites"}">⭐</button>
                                <button type="button" class="btn btn-icon btn-sm ${snippet.is_shared ? "active" : ""}" data-action="share" title="${snippet.is_shared ? "Unshare" : "Share"}">🔗</button>
                                <button type="button" class="btn btn-icon btn-sm danger" data-action="delete" title="Delete">🗑️</button>
                            ` : ''}
                        </div>
                    </div>
                `).join("")}
        </div>
    `;

    // Bind events
    const searchInput = document.getElementById("snippets-search");
    if (searchInput) {
        searchInput.addEventListener("input", debounce(() => {
            renderSnippetsPanel();
        }, 300));
    }

    const categorySelect = document.getElementById("snippets-category");
    if (categorySelect) {
        categorySelect.addEventListener("change", () => {
            container.dataset.activeCategory = categorySelect.value;
            renderSnippetsPanel();
        });
    }

    container.querySelectorAll("[data-action]").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const action = btn.dataset.action;
            const item = btn.closest(".snippet-item");
            const snippetId = item?.dataset.id;
            if (!snippetId) return;

            switch (action) {
                case "insert": insertSnippet(snippetId); break;
                case "edit": showSnippetForm(snippetId); break;
                case "favorite": toggleSnippetFavorite(snippetId); break;
                case "share": toggleSnippetShared(snippetId); break;
                case "delete": deleteSnippet(snippetId); break;
            }
        });
    });
}

/**
 * Show snippet form for create/edit
 */
function showSnippetForm(snippet = null) {
    const container = document.getElementById("snippet-form-container");
    if (!container) return;

    container.classList.remove("hidden");
    container.dataset.editId = snippet?.id || "";

    const form = document.getElementById("snippet-form");
    if (!form) return;

    form.reset();
    document.getElementById("snippet-form-title").textContent = snippet ? "Edit Snippet" : "New Snippet";
    document.getElementById("btn-submit-snippet").textContent = snippet ? "Update Snippet" : "Save Snippet";

    if (snippet) {
        document.getElementById("snippet-name").value = snippet.name;
        document.getElementById("snippet-category").value = snippet.category || "";
        document.getElementById("snippet-description").value = snippet.description || "";
        document.getElementById("snippet-sql").value = snippet.sql;
        document.getElementById("snippet-favorite").checked = snippet.is_favorite;
        document.getElementById("snippet-shared").checked = snippet.is_shared;
    }
}

async function saveSnippetForm(event) {
    event.preventDefault();
    
    const snippetId = document.getElementById("snippet-form-container").dataset.editId;
    const name = document.getElementById("snippet-name").value.trim();
    const category = document.getElementById("snippet-category").value.trim();
    const description = document.getElementById("snippet-description").value.trim();
    const sql = document.getElementById("snippet-sql").value.trim();
    const is_favorite = document.getElementById("snippet-favorite").checked;
    const is_shared = document.getElementById("snippet-shared").checked;

    if (!name) return showToast("Snippet name is required", "warning");
    if (!sql) return showToast("SQL is required", "warning");

    const data = { name, category, description, sql, is_favorite, is_shared };

    try {
        if (snippetId) {
            await updateSnippet(snippetId, data);
            showToast("Snippet updated", "success");
        } else {
            await createSnippet(data);
            showToast("Snippet created", "success");
        }
        document.getElementById("snippet-form-container").classList.add("hidden");
    } catch (error) {
        showToast(error.message, "error");
    }
}

function cancelSnippetForm() {
    document.getElementById("snippet-form-container").classList.add("hidden");
    document.getElementById("snippet-form").reset();
}

function debounce(fn, delay) {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(this, args), delay);
    }
}

// Export for global access
window.SnippetsManager = {
    loadSnippets,
    getSnippetsByCategory,
    createSnippet,
    updateSnippet,
    deleteSnippet,
    toggleSnippetFavorite,
    toggleSnippetShared,
    insertSnippet,
    renderSnippetsPanel,
    showSnippetForm,
    saveSnippetForm,
    cancelSnippetForm
};

// Export individual functions
window.loadSnippets = loadSnippets;
window.renderSnippetsPanel = renderSnippetsPanel;
window.insertSnippet = insertSnippet;
window.showSnippetForm = showSnippetForm;
window.saveSnippetForm = saveSnippetForm;
window.cancelSnippetForm = cancelSnippetForm;
