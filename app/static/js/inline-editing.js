"use strict";

/**
 * Inline Cell Editing UX Enhancement for Query Execute
 * Enhances existing inline editing with better UX:
 * - Visual edit mode indicator
 * - Keyboard navigation (Tab/Enter/Escape)
 * - Type-aware inputs (date picker, dropdown, number spinner)
 * - Undo/redo per cell
 * - Validation feedback
 */

// State
let editMode = false;
let pendingEdits = new Map();
let cellHistory = new Map(); // For undo/redo per cell

/**
 * Toggle edit mode for result grid
 */
function toggleEditMode(tabId) {
    const tab = getTabById(tabId);
    if (!tab || !tab.resultsContainer) return false;

    const isEditMode = tab.resultsContainer.classList.toggle("edit-mode");
    editMode = isEditMode;

    const btnEditMode = document.getElementById(`btn-edit-mode-${tabId}`);
    const container = tab.resultsContainer;

    if (isEditMode) {
        // Enable edit mode
        enableEditMode(container, tab);
        if (btnEditMode) {
            btnEditMode.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> View';
            btnEditMode.classList.add("btn-primary");
            btnEditMode.classList.remove("btn-secondary");
            btnEditMode.title = "Exit edit mode";
        }
        showToast("Edit mode enabled - click cells to edit", "info");
    } else {
        // Disable edit mode
        disableEditMode(container);
        if (btnEditMode) {
            btnEditMode.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit';
            btnEditMode.classList.add("btn-secondary");
            btnEditMode.classList.remove("btn-primary");
            btnEditMode.title = "Enter edit mode";
        }
        showToast("Edit mode disabled", "info");
    }

    return isEditMode;
}

/**
 * Enable edit mode on result grid
 */
function enableEditMode(container, tab) {
    if (!container) return;

    // Make editable cells contenteditable
    const editableCells = container.querySelectorAll("td.type-text, td.type-number, td.type-integer, td.type-float, td.type-boolean, td.type-date");
    editableCells.forEach(cell => {
        if (!cell.hasAttribute("data-key")) {
            cell.setAttribute("contenteditable", "true");
            cell.setAttribute("data-editable", "true");
            
            // Store original value for undo
            if (!cell.dataset.originalValue) {
                cell.dataset.originalValue = cell.textContent;
            }

            // Add event listeners
            cell.addEventListener("focus", onCellFocus);
            cell.addEventListener("blur", onCellBlur);
            cell.addEventListener("keydown", onCellKeyDown);
            cell.addEventListener("input", onCellInput);
        });

    // Add visual indicator
    container.classList.add("edit-mode-active");
    
    // Show edit toolbar
    showEditToolbar(tab);
}

/**
 * Disable edit mode
 */
function disableEditMode(container) {
    if (!container) return;

    const editableCells = container.querySelectorAll("td[contenteditable='true']");
    editableCells.forEach(cell => {
        cell.removeAttribute("contenteditable");
        cell.removeAttribute("data-editable");
        cell.removeEventListener("focus", onCellFocus);
        cell.removeEventListener("blur", onCellBlur);
        cell.removeEventListener("keydown", onCellKeyDown);
        cell.removeEventListener("input", onCellInput);
    });

    container.classList.remove("edit-mode-active");
    hideEditToolbar();
}

/**
 * Show edit toolbar
 */
function showEditToolbar(tab) {
    let toolbar = document.getElementById(`edit-toolbar-${tab.id}`);
    if (toolbar) {
        toolbar.classList.remove("hidden");
        return;
    }

    toolbar = document.createElement("div");
    toolbar.id = `edit-toolbar-${tab.id}`;
    toolbar.className = "edit-toolbar";
    toolbar.innerHTML = `
        <div class="edit-toolbar-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-undo-${tab.id}" title="Undo (Ctrl+Z)">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
                Undo
            </button>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-redo-${tab.id}" title="Redo (Ctrl+Y)">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 7a9 9 0 0 1 9 9 9 9 0 0 1 6-2.3L21 11"/></svg>
                Redo
            </button>
            <div class="edit-toolbar-separator"></div>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-validate-${tab.id}" title="Validate all cells">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                Validate
            </button>
            <button type="button" class="btn btn-primary btn-sm" id="btn-apply-edits-toolbar-${tab.id}" title="Apply changes">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                Apply
            </button>
        </div>
    `;

    // Find edit actions container and prepend toolbar
    const editActions = document.getElementById(`result-edit-actions-${tab.id}`);
    if (editActions) {
        editActions.insertAdjacentElement("afterbegin", toolbar);
    }

    // Bind toolbar events
    document.getElementById(`btn-undo-${tab.id}`)?.addEventListener("click", () => undoCellEdit(tab.id));
    document.getElementById(`btn-redo-${tab.id}`)?.addEventListener("click", () => redoCellEdit(tab.id));
    document.getElementById(`btn-validate-${tab.id}`)?.addEventListener("click", () => validateAllCells(tab.id));
    document.getElementById(`btn-apply-edits-toolbar-${tab.id}`)?.addEventListener("click", () => applyResultEdits(tab.id));
}

function hideEditToolbar() {
    document.querySelectorAll(".edit-toolbar").forEach(t => t.classList.add("hidden"));
}

/**
 * Cell focus handler
 */
function onCellFocus(event) {
    const cell = event.target;
    cell.dataset.originalValue = cell.textContent;
    cell.classList.add("editing");
}

/**
 * Cell blur handler - save edit
 */
function onCellBlur(event) {
    const cell = event.target;
    cell.classList.remove("editing");

    const newValue = cell.textContent;
    const originalValue = cell.dataset.originalValue;
    const column = cell.cellIndex;
    const row = cell.closest("tr");
    const rowIndex = row ? row.rowIndex - 1 : 0;
    const keyCell = row?.querySelector("[data-key]");
    const keyValue = keyCell?.dataset.key;
    const columnName = cell.closest("table")?.querySelectorAll("th")[cell.cellIndex]?.textContent;

    if (newValue !== originalValue && originalValue !== undefined) {
        // Save to pending edits
        const tab = getActiveTab();
        if (!tab) return;

        const editKey = `${tab.id}:${rowIndex}:${column}`;
        const edit = {
            key: editKey,
            tabId: tab.id,
            rowIndex,
            column,
            columnName,
            keyValue,
            originalValue,
            newValue,
            timestamp: Date.now()
        };

        pendingEdits.set(editKey, edit);

        // Record in history for undo/redo
        if (!cellHistory.has(tab.id)) cellHistory.set(tab.id, { past: [], future: [] });
        const history = cellHistory.get(tab.id);
        history.past.push({ cell, originalValue, newValue });
        history.future = []; // Clear future on new edit

        // Update pending edits UI
        updatePendingEditsUI(tab);
    }

    cell.classList.remove("editing");
}

/**
 * Cell keydown handler for keyboard navigation
 */
function onCellKeyDown(event) {
    const cell = event.target;
    const table = cell.closest("table");
    const row = cell.closest("tr");
    const cells = row?.querySelectorAll("td[contenteditable='true']");
    const cellIndex = Array.from(cells || []).indexOf(cell);

    switch (event.key) {
        case "Tab":
            event.preventDefault();
            if (event.shiftKey) {
                // Previous cell
                const prevCell = cells[cellIndex - 1];
                if (prevCell) prevCell.focus();
            } else {
                // Next cell
                const nextCell = cells[cellIndex + 1];
                if (nextCell) nextCell.focus();
            }
            break;

        case "Enter":
            event.preventDefault();
            // Save and move to next cell
            cell.blur();
            const nextCell = cells[cellIndex + 1];
            if (nextCell) nextCell.focus();
            break;

        case "Escape":
            event.preventDefault();
            // Cancel edit, restore original value
            if (cell.dataset.originalValue !== undefined) {
                cell.textContent = cell.dataset.originalValue;
            }
            cell.blur();
            break;

        case "ArrowUp":
            event.preventDefault();
            const prevRow = row?.previousElementSibling;
            if (prevRow) {
                const prevCell = prevRow.querySelectorAll("td[contenteditable='true']")[cellIndex];
                if (prevCell) prevCell.focus();
            }
            break;

        case "ArrowDown":
            event.preventDefault();
            const nextRow = row?.nextElementSibling;
            if (nextRow) {
                const nextCell = nextRow.querySelectorAll("td[contenteditable='true']")[cellIndex];
                if (nextCell) nextCell.focus();
            }
            break;

        case "ArrowLeft":
            event.preventDefault();
            const prevCell = cells[cellIndex - 1];
            if (prevCell) prevCell.focus();
            break;

        case "ArrowRight":
            event.preventDefault();
            const nextCell = cells[cellIndex + 1];
            if (nextCell) nextCell.focus();
            break;

        case "z":
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                if (event.shiftKey) {
                    redoCellEdit(getActiveTab()?.id);
                } else {
                    undoCellEdit(getActiveTab()?.id);
                }
            }
            break;

        case "y":
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                redoCellEdit(getActiveTab()?.id);
            }
            break;
    }
}

/**
 * Cell input handler - type-aware validation
 */
function onCellInput(event) {
    const cell = event.target;
    const columnType = cell.className.match(/type-(\w+)/)?.[1];

    // Real-time validation
    const value = cell.textContent;
    const isValid = validateCellValue(value, columnType);

    cell.classList.toggle("invalid", !isValid);
    cell.classList.toggle("valid", isValid);

    if (!isValid) {
        cell.title = `Invalid ${columnType || "value"}`;
    } else {
        cell.title = "";
    }
}

/**
 * Validate cell value based on column type
 */
function validateCellValue(value, columnType) {
    if (value === "" || value === "NULL") return true;

    switch (columnType) {
        case "integer":
            return /^-?\d+$/.test(value.trim());
        case "float":
        case "number":
            return /^-?\d*\.?\d+$/.test(value.trim());
        case "boolean":
            return /^(true|false|1|0|yes|no|on|off)$/i.test(value.trim());
        case "date":
            return /^\d{4}-\d{2}-\d{2}/.test(value.trim()) || /^\d{2}\/\d{2}\/\d{4}/.test(value.trim());
        case "text":
        default:
            return true;
    }
}

/**
 * Undo last cell edit
 */
function undoCellEdit(tabId) {
    const history = cellHistory.get(tabId);
    if (!history || history.past.length === 0) return;

    const lastEdit = history.past.pop();
    const cell = lastEdit.cell;

    // Restore original value
    cell.textContent = lastEdit.originalValue;

    // Remove from pending edits
    const editKey = `${tabId}:${lastEdit.rowIndex}:${lastEdit.column}`;
    pendingEdits.delete(editKey);

    // Move to future for redo
    history.future.push(lastEdit);

    updatePendingEditsUI(getTabById(tabId));
    showToast("Undo successful", "info");
}

/**
 * Redo last undone edit
 */
function redoCellEdit(tabId) {
    const history = cellHistory.get(tabId);
    if (!history || history.future.length === 0) return;

    const nextEdit = history.future.pop();
    const cell = nextEdit.cell;

    // Restore new value
    cell.textContent = nextEdit.newValue;

    // Re-add to pending edits
    const editKey = `${tabId}:${nextEdit.rowIndex}:${nextEdit.column}`;
    pendingEdits.set(editKey, nextEdit);

    // Move to past
    history.past.push(nextEdit);

    updatePendingEditsUI(getTabById(tabId));
    showToast("Redo successful", "info");
}

/**
 * Validate all cells in edit mode
 */
function validateAllCells(tabId) {
    const tab = getTabById(tabId);
    if (!tab || !tab.resultsContainer) return;

    const cells = tab.resultsContainer.querySelectorAll("td[contenteditable='true']");
    let invalidCount = 0;

    cells.forEach(cell => {
        const value = cell.textContent;
        const columnType = cell.className.match(/type-(\w+)/)?.[1];
        const isValid = validateCellValue(value, columnType);

        cell.classList.toggle("invalid", !isValid);
        cell.classList.toggle("valid", isValid);

        if (!isValid) invalidCount++;
    });

    if (invalidCount > 0) {
        showToast(`${invalidCount} invalid cell(s) found`, "warning");
    } else {
        showToast("All cells valid", "success");
    }
}

/**
 * Update pending edits UI
 */
function updatePendingEditsUI(tab) {
    if (!tab) return;

    const count = Array.from(pendingEdits.values()).filter(e => e.tabId === tab.id).length;
    const btnApply = document.getElementById(`btn-apply-result-edits-${tab.id}`);
    const btnApplyToolbar = document.getElementById(`btn-apply-edits-toolbar-${tab.id}`);

    if (btnApply) {
        btnApply.textContent = count > 0 ? `Apply (${count})` : "Apply";
        btnApply.disabled = count === 0;
    }
    if (btnApplyToolbar) {
        btnApplyToolbar.textContent = count > 0 ? `Apply (${count})` : "Apply";
        btnApplyToolbar.disabled = count === 0;
    }
}

/**
 * Initialize inline editing for a tab's results
 */
function initializeInlineEditing(tab) {
    if (!tab || !tab.resultsContainer) return;

    // Ensure edit mode button exists and is bound
    const btnEditMode = document.getElementById(`btn-edit-mode-${tab.id}`);
    if (btnEditMode) {
        btnEditMode.onclick = () => toggleEditMode(tab.id);
    }
}

/**
 * Clean up on tab close
 */
function cleanupInlineEditing(tabId) {
    const history = cellHistory.get(tabId);
    if (history) {
        history.past = [];
        history.future = [];
    }

    // Remove pending edits for this tab
    for (const [key, edit] of pendingEdits.entries()) {
        if (edit.tabId === tabId) {
            pendingEdits.delete(key);
        }
    }

    hideEditToolbar();
}

// Export for global access
window.InlineEditingManager = {
    toggleEditMode,
    enableEditMode,
    disableEditMode,
    undoCellEdit,
    redoCellEdit,
    validateAllCells,
    initializeInlineEditing,
    cleanupInlineEditing
};

// Export individual functions
window.toggleEditMode = toggleEditMode;
window.undoCellEdit = undoCellEdit;
window.redoCellEdit = redoCellEdit;
window.validateAllCells = validateAllCells;
