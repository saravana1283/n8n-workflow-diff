"use strict";

let beforeWorkflow = null;
let afterWorkflow = null;
let diffResult = null;
let currentFilter = "all";
let selectedNodeKey = null;

/* -------------------------------------------------------
Utilities
------------------------------------------------------- */

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function stableStringify(obj) {
    return JSON.stringify(sortObject(obj));
}

function sortObject(obj) {
    if (Array.isArray(obj)) {
        return obj.map(sortObject);
    }
    if (obj && typeof obj === "object") {
        return Object.keys(obj)
            .sort()
            .reduce((out, key) => {
                out[key] = sortObject(obj[key]);
                return out;
            }, {});
    }
    return obj;
}

function pathGet(obj, path) {
    let cur = obj;
    for (const p of path) {
        if (cur == null) return undefined;
        cur = cur[p];
    }
    return cur;
}

function isObject(v) {
    return v && typeof v === "object" && !Array.isArray(v);
}

/* -------------------------------------------------------
File handling
------------------------------------------------------- */

function setupDropzone(id, fileInput, textarea, nameEl) {
    const zone = document.getElementById(id);
    const input = document.getElementById(fileInput);

    zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("drag");
    });

    zone.addEventListener("dragleave", () => {
        zone.classList.remove("drag");
    });

    zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("drag");
        const file = e.dataTransfer.files[0];
        if (file) {
            readFile(file, textarea, nameEl);
        }
    });

    input.addEventListener("change", () => {
        if (input.files[0]) {
            readFile(input.files[0], textarea, nameEl);
        }
    });
}

function readFile(file, textareaId, nameId) {
    const reader = new FileReader();

    reader.onload = () => {
        document.getElementById(textareaId).value = reader.result;
        document.getElementById(nameId).textContent = "✓ " + file.name;
    };

    reader.onerror = () => {
        showError("Could not read file.");
    };

    reader.readAsText(file);
}

setupDropzone("dropBefore", "fileBefore", "jsonBefore", "nameBefore");

setupDropzone("dropAfter", "fileAfter", "jsonAfter", "nameAfter");

/* -------------------------------------------------------
n8n normalization
------------------------------------------------------- */

function extractWorkflow(raw) {
/*
    n8n exports normally look like:
    
    {
    "name": "...",
    "nodes": [],
    "connections": {},
    "settings": {},
    ...
    }
    
    Some users may instead paste an array.
*/

    if (Array.isArray(raw)) {
        return {
            name: "Workflow",
            nodes: raw,
            connections: {},
        };
    }

    if (!raw || typeof raw !== "object") {
        throw new Error("Invalid JSON workflow.");
    }

    if (!Array.isArray(raw.nodes)) {
        throw new Error("This JSON does not appear to be an n8n workflow: missing 'nodes' array.");
    }

    return raw;
}

function normalizeNode(node) {
    const copy = deepClone(node);
    const ignorePosition = document.getElementById("ignorePosition").checked;
    const ignoreMeta = document.getElementById("ignoreMeta").checked;
    const maskCredentials = document.getElementById("ignoreCredentials").checked;

    if (ignorePosition) {
        delete copy.position;
    }

    if (ignoreMeta) {
        delete copy.id;
        delete copy.webhookId;
        delete copy.notesInFlow;
        delete copy.alwaysOutputData;
        delete copy.executeOnce;
        delete copy.retryOnFail;
        delete copy.maxTries;
        delete copy.waitBetweenTries;

        /*
        These are often UI/editor related.
        We deliberately do not remove parameters.
        */
    }

    if (maskCredentials) {
        delete copy.credentials;
    }

    return copy;
}

function maskSecrets(obj) {
    if (Array.isArray(obj)) {
        return obj.map(maskSecrets);
    }

    if (!isObject(obj)) {
        return obj;
    }

    const out = {};

    for (const [key, value] of Object.entries(obj)) {
        const lower = key.toLowerCase();

        if (
            lower.includes("password") ||
            lower.includes("token") ||
            lower.includes("secret") ||
            lower.includes("apikey") ||
            lower.includes("api_key") ||
            lower.includes("accesskey") ||
            lower.includes("privatekey")
        ) {
            out[key] = "••••••••";
        } else {
            out[key] = maskSecrets(value);
        }
    }

    return out;
}

/* -------------------------------------------------------
Node matching
------------------------------------------------------- */

function nodeKey(node) {
    /*
    Prefer name because n8n users often duplicate/export/import
    workflows where internal IDs change.
    */

    if (node.name) {
        return "name:" + node.name;
    }

    if (node.id) {
        return "id:" + node.id;
    }

    return "anon:" + node.type + ":" + JSON.stringify(node.position || "");
}

function buildNodeMap(nodes) {
    const map = new Map();

    for (const node of nodes) {
        const key = nodeKey(node);

        if (!map.has(key)) {
            map.set(key, node);
        } else {
            /*
            Handle duplicate names.
            */
            let i = 2;
            let newKey = key + "#" + i;

            while (map.has(newKey)) {
                i++;
                newKey = key + "#" + i;
            }

            map.set(newKey, node);
        }
    }
    return map;
}

/* -------------------------------------------------------
JSON diff
------------------------------------------------------- */

function diffValues(before, after, path = []) {
    const changes = [];

    if (stableStringify(before) === stableStringify(after)) {
        return changes;
    }

    if (isObject(before) && isObject(after)) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

        for (const key of [...keys].sort()) {
            const nextPath = [...path, key];

            if (!(key in before)) {
                changes.push({
                    type: "add",
                    path: nextPath,
                    before: undefined,
                    after: after[key],
                });
            } else if (!(key in after)) {
                changes.push({
                    type: "remove",
                    path: nextPath,
                    before: before[key],
                    after: undefined,
                });
            } else {
                changes.push(...diffValues(before[key], after[key], nextPath));
            }
        }

        return changes;
    }

    if (Array.isArray(before) && Array.isArray(after)) {
        const max = Math.max(before.length, after.length);

        for (let i = 0; i < max; i++) {
            const p = [...path, String(i)];

            if (i >= before.length) {
                changes.push({
                    type: "add",
                    path: p,
                    after: after[i],
                });
            } else if (i >= after.length) {
                changes.push({
                    type: "remove",
                    path: p,
                    before: before[i],
                });
            } else if (stableStringify(before[i]) !== stableStringify(after[i])) {
                changes.push(...diffValues(before[i], after[i], p));
            }
        }

        return changes;
    }

    changes.push({
        type: "change",
        path,
        before,
        after,
    });

    return changes;
}

/* -------------------------------------------------------
Connections
------------------------------------------------------- */

function getConnections(workflow) {
    const result = new Set();
    const connections = workflow.connections || {};

    for (const [source, outputs] of Object.entries(connections)) {
        if (!outputs || typeof outputs !== "object") continue;

        for (const [outputType, branches] of Object.entries(outputs)) {
            if (!Array.isArray(branches)) continue;

            branches.forEach((branch, index) => {
                if (!Array.isArray(branch)) return;

                branch.forEach((connection) => {
                    if (!connection || !connection.node) return;

                    result.add(
                        JSON.stringify({
                            source,
                            outputType,
                            index,
                            target: connection.node,
                            input: connection.type || "main",
                            inputIndex: connection.index ?? 0,
                        })
                    );
                });
            });
        }
    }

    return result;
}

function connectionDiff(before, after) {
    const b = getConnections(before);
    const a = getConnections(after);

    const added = [...a].filter((x) => !b.has(x)).map(JSON.parse);
    const removed = [...b].filter((x) => !a.has(x)).map(JSON.parse);

    return { added, removed };
}

/* -------------------------------------------------------
Rename detection
------------------------------------------------------- */

function detectRenames(added, removed) {
    const renames = [];

    const usedAdded = new Set();
    const usedRemoved = new Set();

    for (let r = 0; r < removed.length; r++) {
        const oldNode = removed[r];

        for (let a = 0; a < added.length; a++) {
            if (usedAdded.has(a)) continue;

            const newNode = added[a];

            /*
            Same node type + very similar configuration
            = probably renamed.
            */

            if (oldNode.type && newNode.type && oldNode.type === newNode.type) {
                const oldNorm = normalizeNode(oldNode);
                const newNorm = normalizeNode(newNode);

                delete oldNorm.name;
                delete newNorm.name;

                if (stableStringify(oldNorm) === stableStringify(newNorm)) {
                    renames.push({
                        before: oldNode,
                        after: newNode,
                    });

                    usedRemoved.add(r);
                    usedAdded.add(a);

                    break;
                }
            }
        }
    }

    return {
        renames,
        usedAdded,
        usedRemoved,
    };
}

/* -------------------------------------------------------
Main comparison
------------------------------------------------------- */

function compare() {
    hideError();

    try {
        const beforeText = document.getElementById("jsonBefore").value.trim();
        const afterText = document.getElementById("jsonAfter").value.trim();

        if (!beforeText || !afterText) {
            throw new Error("Please provide both BEFORE and AFTER workflows.");
        }

        const beforeRaw = JSON.parse(beforeText);
        const afterRaw = JSON.parse(afterText);

        beforeWorkflow = extractWorkflow(beforeRaw);
        afterWorkflow = extractWorkflow(afterRaw);

        const beforeMap = buildNodeMap(beforeWorkflow.nodes || []);
        const afterMap = buildNodeMap(afterWorkflow.nodes || []);

        const nodes = [];
        const added = [];
        const removed = [];
        const modified = [];
        const unchanged = [];

        /*
        First: exact keys.
        */

        for (const [key, node] of afterMap) {
            if (!beforeMap.has(key)) {
                added.push(node);
            } else {
                const oldNode = beforeMap.get(key);
                const changes = diffValues(normalizeNode(oldNode), normalizeNode(node));

                if (changes.length) {
                    modified.push({
                        key,
                        before: oldNode,
                        after: node,
                        changes,
                    });
                } else {
                    unchanged.push({
                        key,
                        before: oldNode,
                        after: node,
                    });
                }
            }
        }

        for (const [key, node] of beforeMap) {
            if (!afterMap.has(key)) {
                removed.push(node);
            }
        }

        /*
        Detect renames among add/remove.
        */

        const renameInfo = detectRenames(added, removed);
        const renamed = renameInfo.renames;
        const addedFinal = added.filter((_, i) => !renameInfo.usedAdded.has(i));
        const removedFinal = removed.filter((_, i) => !renameInfo.usedRemoved.has(i));

        /*
        Build display records.
        */

        for (const node of addedFinal) {
            nodes.push({
                status: "added",
                key: "added:" + nodeKey(node),
                name: node.name || "(unnamed)",
                type: node.type || "",
                before: null,
                after: node,
                changes: [],
            });
        }

        for (const node of removedFinal) {
            nodes.push({
                status: "removed",
                key: "removed:" + nodeKey(node),
                name: node.name || "(unnamed)",
                type: node.type || "",
                before: node,
                after: null,
                changes: [],
            });
        }

        for (const item of modified) {
            nodes.push({
                status: "modified",
                key: item.key,
                name: item.after.name || item.before.name || "(unnamed)",
                type: item.after.type || item.before.type || "",
                before: item.before,
                after: item.after,
                changes: item.changes,
            });
        }

        for (const item of renamed) {
            nodes.push({
                status: "renamed",
                key: "rename:" + nodeKey(item.after),
                name: item.after.name || "(unnamed)",
                type: item.after.type || "",
                before: item.before,
                after: item.after,
                changes: [
                    {
                        type: "change",
                        path: ["name"],
                        before: item.before.name,
                        after: item.after.name,
                    },
                ],
            });
        }

        for (const item of unchanged) {
            nodes.push({
                status: "unchanged",
                key: item.key,
                name: item.after.name || "(unnamed)",
                type: item.after.type || "",
                before: item.before,
                after: item.after,
                changes: [],
            });
        }

        const connections = connectionDiff(beforeWorkflow, afterWorkflow);

        diffResult = {
            nodes,
            connections,
            before: beforeWorkflow,
            after: afterWorkflow,
        };

        updateStats();
        renderNodeList();
        renderGraph();

        document.getElementById("status").textContent = "Comparison complete";
        document.getElementById("output").style.display = "block";

        document.getElementById("mainContainer").style.display = "none";
        document.getElementById("compareButton").style.display = "none";

        const firstChanged = nodes.find((n) => n.status !== "unchanged");

        if (firstChanged) {
            selectedNodeKey = firstChanged.key;
            selectNode(firstChanged.key);
        } else {
            selectedNodeKey = null;
            document.getElementById("detail").innerHTML = `
                <div class="empty">
                    No node changes detected.
                </div>
            `;
        }
    } catch (error) {
        showError(error.message);
    }
}

/* -------------------------------------------------------
UI
------------------------------------------------------- */

function updateStats() {
    const n = diffResult.nodes;

    document.getElementById("statAdded").textContent = n.filter((x) => x.status === "added").length;
    document.getElementById("statRemoved").textContent = n.filter((x) => x.status === "removed").length;
    document.getElementById("statModified").textContent = n.filter((x) => x.status === "modified").length;
    document.getElementById("statRenamed").textContent = n.filter((x) => x.status === "renamed").length;
    document.getElementById("statConnections").textContent =
        diffResult.connections.added.length + diffResult.connections.removed.length;
    document.getElementById("statTotal").textContent = n.length;
}

function setFilter(button, filter) {
    currentFilter = filter;
    document.querySelectorAll(".filter").forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    renderNodeList();
}

function renderNodeList() {
    if (!diffResult) return;

    const search = document.getElementById("nodeSearch").value.toLowerCase();

    let list = diffResult.nodes.filter((node) => {
        if (currentFilter !== "all" && node.status !== currentFilter) {
            return false;
        }
        if (!search) return true;
        return node.name.toLowerCase().includes(search) || node.type.toLowerCase().includes(search);
    });

    const order = {
        added: 0,
        removed: 1,
        renamed: 2,
        modified: 3,
        unchanged: 4,
    };

    list.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));

    const nodeList = document.getElementById("nodeList");

    nodeList.innerHTML = "";
    if (!list.length) {
        nodeList.innerHTML = `
            <div style="padding:20px;color:var(--muted)">
                No matching nodes.
            </div>
        `;
        return;
    }

    list.forEach((node) => {
        const item = document.createElement("div");

        item.className = "node-item" + (node.key === selectedNodeKey ? " selected" : "");
        // Store the key safely instead of putting it inside onclick=""
        item.dataset.nodeKey = node.key;
        item.innerHTML = `
            <span class="dot ${node.status}"></span>
            <div class="node-info">
                <div class="node-name">
                    ${escapeHtml(node.name)}
                </div>
                <div class="node-type">
                    ${escapeHtml(node.type)}
                </div>
            </div>
        `;
        // Proper JavaScript event listener
        item.addEventListener("click", () => {
            selectNode(node.key);
        });
        nodeList.appendChild(item);
    });
}

function selectNode(key) {
    selectedNodeKey = key;
    const node = diffResult.nodes.find((n) => n.key === key);
    if (!node) return;
    renderNodeList();
    renderDetail(node);
}

function renderDetail(node) {
    let summary = "";
    if (node.status === "added") {
        summary = `
            <div class="change add">
                + Entire node added
            </div>
            `;
    } else if (node.status === "removed") {
        summary = `
            <div class="change remove">
                − Entire node removed
            </div>
        `;
    } else {
        summary = node.changes
            .map((change) => {
                const path = change.path.join(".");
                const before = formatValue(change.before);
                const after = formatValue(change.after);

                if (change.type === "add") {
                    return `
                        <div class="change add">
                            + ${escapeHtml(path)} = ${escapeHtml(after)}
                        </div>
                    `;
                }

                if (change.type === "remove") {
                    return `
                        <div class="change remove">
                            − ${escapeHtml(path)} = ${escapeHtml(before)}
                        </div>
                    `;
                }

                return `
                    <div class="change change">
                        ~ ${escapeHtml(path)}
                        <br>
                            <span style="color:#ff929c">
                                − ${escapeHtml(before)}
                            </span>
                        <br>
                        <span style="color:#7ae8a8">
                            + ${escapeHtml(after)}
                        </span>
                    </div>
                `;
            })
            .join("");
    }

    /*
    Connection changes involving this node.
    */
    const connectionHtml = renderConnectionChanges(node);
    document.getElementById("detail").innerHTML = `
        <div class="detail-header">
            <h2>
                ${escapeHtml(node.name)}
                <span class="badge ${node.status}">
                ${node.status}
                </span>
            </h2>
            <div style="color:var(--muted);font-size:12px;margin-top:6px">
                ${escapeHtml(node.type)}
            </div>
        </div>
        <div class="detail-body">
            <div class="summary-box">
                <h3>What changed?</h3>
                ${summary ||
                `<div style="color:var(--muted)">
                    No parameter changes.
                </div>`
                }
            </div>
            ${connectionHtml}
            <div class="columns">
                <div>
                    <div class="code-title">
                        BEFORE
                    </div>
                    <pre>${escapeHtml(node.before ? JSON.stringify(node.before, null, 2) : "— node did not exist —")}</pre>
                </div>
                <div>
                    <div class="code-title">
                        AFTER
                    </div>
                    <pre>${escapeHtml(node.after ? JSON.stringify(node.after, null, 2) : "— node was removed —")}</pre>
                </div>
            </div>
        </div>
    `;
}

function renderConnectionChanges(node) {
    const name = node.name;
    const added = diffResult.connections.added.filter((c) => c.source === name || c.target === name);
    const removed = diffResult.connections.removed.filter((c) => c.source === name || c.target === name);

    if (!added.length && !removed.length) {
        return "";
    }

    let html = `
        <div class="summary-box">
        <h3>🔗 Connection changes</h3>
    `;

    removed.forEach((c) => {
        html += `
            <div class="change remove">
                − ${escapeHtml(c.source)}
                → ${escapeHtml(c.target)}
            </div>
        `;
    });

    added.forEach((c) => {
        html += `
            <div class="change add">
                + ${escapeHtml(c.source)}
                → ${escapeHtml(c.target)}
            </div>
        `;
    });

    html += "</div>";
    return html;
}

function formatValue(value) {
    if (value === undefined) return "undefined";
    if (typeof value === "string") {
        /*
        Keep strings readable while preventing huge output.
        */
        if (value.length > 500) {
            return value.substring(0, 500) + "…";
        }
        return value;
    }
    return JSON.stringify(value);
}

/* -------------------------------------------------------
Graph
------------------------------------------------------- */

function getGraphThemePalette() {
    const isLight = document.body.dataset.theme === "light";

    return {
        nodeFill: isLight ? "#f3f7fb" : "#131c25",
        nodeStroke: isLight ? "#d8e1ec" : "#42505e",
        nodeNameFill: isLight ? "#1b2430" : "#e8edf3",
        nodeTypeFill: isLight ? "#5c6c7d" : "#81909f",
        addedFill: isLight ? "rgba(52, 211, 153, 0.14)" : "#10291d",
        addedStroke: "#35d07f",
        removedFill: isLight ? "rgba(255, 92, 108, 0.14)" : "#30151b",
        removedStroke: "#ff5c6c",
        modifiedFill: isLight ? "rgba(245, 196, 81, 0.18)" : "#302813",
        modifiedStroke: "#f5c451",
        renamedFill: isLight ? "rgba(88, 166, 255, 0.14)" : "#12263d",
        renamedStroke: "#58a6ff",
        legendFill: isLight ? "#5c6c7d" : "#81909f",
    };
}

function renderGraph() {
    if (!diffResult) return;

    const svg = document.getElementById("graphSvg");
    const palette = getGraphThemePalette();

    // Clear graph
    svg.innerHTML = "";

    const workflow = diffResult.after;
    const workflowNodes = workflow.nodes || [];
    const workflowConnections = workflow.connections || {};

    /*
     * --------------------------------------------------
     * SVG setup
     * --------------------------------------------------
     */

    const NS = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(NS, "defs");
    const marker = document.createElementNS(NS, "marker");

    marker.setAttribute("id", "arrow");
    marker.setAttribute("markerWidth", "10");
    marker.setAttribute("markerHeight", "10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    marker.setAttribute("markerUnits", "strokeWidth");

    const arrowPath = document.createElementNS(NS, "path");

    arrowPath.setAttribute("d", "M0,0 L0,6 L9,3 z");
    arrowPath.setAttribute("fill", "#596777");

    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    /*
     * --------------------------------------------------
     * Node dimensions
     * --------------------------------------------------
     */

    const NODE_WIDTH = 180;
    const NODE_HEIGHT = 65;

    const PADDING = 100;

    /*
     * --------------------------------------------------
     * Create lookup of changed nodes
     * --------------------------------------------------
     */

    const changedMap = new Map();

    diffResult.nodes.forEach((item) => {
        changedMap.set(item.name, item.status);
    });

    /*
     * --------------------------------------------------
     * Find positions
     *
     * n8n stores position as:
     *
     * [x, y]
     * --------------------------------------------------
     */

    const positions = new Map();

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    workflowNodes.forEach((node) => {
        let x = 0;
        let y = 0;

        if (Array.isArray(node.position) && node.position.length >= 2) {
            x = Number(node.position[0]) || 0;
            y = Number(node.position[1]) || 0;
        }

        positions.set(node.name, {
            x,
            y,
            node,
        });

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + NODE_WIDTH);
        maxY = Math.max(maxY, y + NODE_HEIGHT);
    });

    /*
     * --------------------------------------------------
     * Normalize coordinates
     * --------------------------------------------------
     */

    positions.forEach((pos) => {
        pos.x = pos.x - minX + PADDING;
        pos.y = pos.y - minY + PADDING;
    });

    const graphWidth = Math.max(1200, maxX - minX + PADDING * 2);
    const graphHeight = Math.max(600, maxY - minY + PADDING * 2);

    svg.setAttribute("viewBox", `0 0 ${graphWidth} ${graphHeight}`);

    /*
     * --------------------------------------------------
     * Draw ALL connections
     * --------------------------------------------------
     */

    for (const [sourceName, connectionTypes] of Object.entries(workflowConnections)) {
        const source = positions.get(sourceName);
        if (!source) continue;
        /*
         * n8n normally has:
         *
         * connections: {
         *   "Node A": {
         *      "main": [
         *         [
         *            {
         *              "node": "Node B",
         *              "type": "main",
         *              "index": 0
         *            }
         *         ]
         *      ]
         *   }
         * }
         */

        for (const [connectionType, outputs] of Object.entries(connectionTypes || {})) {
            if (!Array.isArray(outputs)) {
                continue;
            }

            outputs.forEach((outputArray, outputIndex) => {
                if (!Array.isArray(outputArray)) {
                    return;
                }

                outputArray.forEach((connection) => {
                    if (!connection || !connection.node) {
                        return;
                    }

                    const target = positions.get(connection.node);

                    if (!target) {
                        return;
                    }

                    /*
                     * ------------------------------------------------
                     * Determine whether this connection changed
                     * ------------------------------------------------
                     */

                    const isAdded = diffResult.connections.added.some(
                        (c) => c.source === sourceName && c.target === connection.node
                    );

                    const isRemoved = diffResult.connections.removed.some(
                        (c) => c.source === sourceName && c.target === connection.node
                    );

                    /*
                     * Normal connection
                     */

                    let color = "#596777";
                    let width = "2";
                    let dash = "";

                    if (isAdded) {
                        color = "#35d07f";

                        width = "3";
                    }

                    /*
                     * ------------------------------------------------
                     * Draw curved connection
                     * ------------------------------------------------
                     */

                    const x1 = source.x + NODE_WIDTH;
                    const y1 = source.y + NODE_HEIGHT / 2;
                    const x2 = target.x;
                    const y2 = target.y + NODE_HEIGHT / 2;
                    const distance = Math.abs(x2 - x1);
                    const curve = Math.max(50, distance * 0.45);
                    const path = document.createElementNS(NS, "path");

                    path.setAttribute(
                        "d",
                        `
                            M ${x1} ${y1}
                            C
                            ${x1 + curve} ${y1},
                            ${x2 - curve} ${y2},
                            ${x2} ${y2}
                        `
                    );
                    path.setAttribute("fill", "none");
                    path.setAttribute("stroke", color);
                    path.setAttribute("stroke-width", width);
                    path.setAttribute("marker-end", "url(#arrow)");

                    if (isRemoved) {
                        path.setAttribute("stroke", "#ff5c6c");
                        path.setAttribute("stroke-dasharray", "8 5");
                        path.setAttribute("stroke-width", "3");
                    }

                    /*
                     * Tooltip
                     */

                    const title = document.createElementNS(NS, "title");
                    title.textContent = `${sourceName} → ${connection.node}`;
                    path.appendChild(title);
                    svg.appendChild(path);
                });
            });
        }
    }

    /*
     * --------------------------------------------------
     * Draw nodes ON TOP of connections
     * --------------------------------------------------
     */

    workflowNodes.forEach((node) => {
        const position = positions.get(node.name);
        if (!position) return;
        const group = document.createElementNS(NS, "g");

        /*
         * Determine node status
         */
        const status = changedMap.get(node.name) || "unchanged";
        group.setAttribute("class", `graph-node ${status}`);
        group.setAttribute("transform", `translate(${position.x},${position.y})`);

        /*
         * Make cursor clickable
         */

        group.style.cursor = "pointer";

        /*
         * ------------------------------------------------
         * Node background
         * ------------------------------------------------
         */

        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("width", NODE_WIDTH);
        rect.setAttribute("height", NODE_HEIGHT);
        rect.setAttribute("rx", "9");

        /*
         * Node colors
         */

        if (status === "added") {
            rect.setAttribute("fill", palette.addedFill);
            rect.setAttribute("stroke", palette.addedStroke);
        } else if (status === "removed") {
            rect.setAttribute("fill", palette.removedFill);
            rect.setAttribute("stroke", palette.removedStroke);
        } else if (status === "modified") {
            rect.setAttribute("fill", palette.modifiedFill);
            rect.setAttribute("stroke", palette.modifiedStroke);
        } else if (status === "renamed") {
            rect.setAttribute("fill", palette.renamedFill);
            rect.setAttribute("stroke", palette.renamedStroke);
        } else {
            rect.setAttribute("fill", palette.nodeFill);
            rect.setAttribute("stroke", palette.nodeStroke);
        }

        rect.setAttribute("stroke-width", "2");
        group.appendChild(rect);

        /*
         * ------------------------------------------------
         * Node name
         * ------------------------------------------------
         */

        const nameText = document.createElementNS(NS, "text");
        nameText.setAttribute("x", "14");
        nameText.setAttribute("y", "26");
        nameText.setAttribute("fill", palette.nodeNameFill);
        nameText.setAttribute("font-size", "13");
        nameText.setAttribute("font-weight", "600");
        nameText.textContent = node.name.length > 25 ? node.name.substring(0, 25) + "…" : node.name;
        group.appendChild(nameText);

        /*
         * ------------------------------------------------
         * Node type
         * ------------------------------------------------
         */

        const typeText = document.createElementNS(NS, "text");
        typeText.setAttribute("x", "14");
        typeText.setAttribute("y", "47");
        typeText.setAttribute("fill", palette.nodeTypeFill);
        typeText.setAttribute("font-size", "10");
        typeText.textContent = node.type || "";
        group.appendChild(typeText);

        /*
         * ------------------------------------------------
         * Status indicator
         * ------------------------------------------------
         */

        if (status !== "unchanged") {
            const statusText = document.createElementNS(NS, "text");
            statusText.setAttribute("x", NODE_WIDTH - 12);
            statusText.setAttribute("y", "17");
            statusText.setAttribute("text-anchor", "end");
            statusText.setAttribute("font-size", "9");
            statusText.setAttribute("font-weight", "700");
            if (status === "added") {
                statusText.setAttribute("fill", "#35d07f");
                statusText.textContent = "ADDED";
            } else if (status === "removed") {
                statusText.setAttribute("fill", "#ff5c6c");
                statusText.textContent = "REMOVED";
            } else if (status === "modified") {
                statusText.setAttribute("fill", "#f5c451");
                statusText.textContent = "MODIFIED";
            } else if (status === "renamed") {
                statusText.setAttribute("fill", "#58a6ff");
                statusText.textContent = "RENAMED";
            }
            group.appendChild(statusText);
        }

        /*
         * ------------------------------------------------
         * Click node
         * ------------------------------------------------
         */

        group.addEventListener("click", () => {
            selectByName(node.name);
        });

        /*
         * Tooltip
         */

        const title = document.createElementNS(NS, "title");
        title.textContent = `${node.name}\n${node.type}`;
        group.appendChild(title);
        svg.appendChild(group);
    });

    /*
     * --------------------------------------------------
     * Draw a small legend
     * --------------------------------------------------
     */

    const legend = document.createElementNS(NS, "g");
    legend.setAttribute("transform", `translate(20,20)`);

    const legendText = document.createElementNS(NS, "text");
    legendText.setAttribute("fill", palette.legendFill);
    legendText.setAttribute("font-size", "11");
    legendText.textContent = "Click any node to view changes";

    legend.appendChild(legendText);
    svg.appendChild(legend);
}
function selectByName(name) {
    const node = diffResult.nodes.find((n) => n.name === name);
    if (node) {
        selectNode(node.key);
    }
}

/* -------------------------------------------------------
Example
------------------------------------------------------- */

function loadExample() {
    const before = {
        name: "Demo Workflow",
        nodes: [
            {
                id: "1",
                name: "Webhook",
                type: "n8n-nodes-base.webhook",
                position: [200, 300],
                parameters: {
                    path: "orders",
                    httpMethod: "POST",
                },
            },
            {
                id: "2",
                name: "HTTP Request",
                type: "n8n-nodes-base.httpRequest",
                position: [500, 300],
                parameters: {
                    url: "https://example.com/orders",
                    method: "POST",
                },
            },
            {
                id: "3",
                name: "Respond",
                type: "n8n-nodes-base.respondToWebhook",
                position: [800, 300],
                parameters: {},
            },
        ],
        connections: {
            Webhook: {
                main: [
                    [
                        {
                            node: "HTTP Request",
                            type: "main",
                            index: 0,
                        },
                    ],
                ],
            },
            "HTTP Request": {
                main: [
                    [
                        {
                            node: "Respond",
                            type: "main",
                            index: 0,
                        },
                    ],
                ],
            },
        },
    };

    const after = {
        name: "Demo Workflow",
        nodes: [
            {
                id: "abc",
                name: "Webhook",
                type: "n8n-nodes-base.webhook",
                position: [220, 300],
                parameters: {
                    path: "orders-v2",
                    httpMethod: "POST",
                },
            },
            {
                id: "def",
                name: "API Request",
                type: "n8n-nodes-base.httpRequest",
                position: [600, 300],
                parameters: {
                    url: "https://api.example.com/orders",
                    method: "POST",
                    timeout: 30000,
                },
            },
            {
                id: "4",
                name: "Log Result",
                type: "n8n-nodes-base.code",
                position: [800, 500],
                parameters: {
                    jsCode: "return items;",
                },
            },
            {
                id: "ghi",
                name: "Respond",
                type: "n8n-nodes-base.respondToWebhook",
                position: [1000, 300],
                parameters: {},
            },
        ],
        connections: {
            Webhook: {
                main: [
                    [
                        {
                            node: "API Request",
                            type: "main",
                            index: 0,
                        },
                    ],
                ],
            },
            "API Request": {
                main: [
                    [
                        {
                            node: "Log Result",
                            type: "main",
                            index: 0,
                        },
                    ],
                ],
            },
            "Log Result": {
                main: [
                    [
                        {
                            node: "Respond",
                            type: "main",
                            index: 0,
                        },
                    ],
                ],
            },
        },
    };

    document.getElementById("jsonBefore").value = JSON.stringify(before, null, 2);
    document.getElementById("jsonAfter").value = JSON.stringify(after, null, 2);
    document.getElementById("nameBefore").textContent = "✓ Example workflow";
    document.getElementById("nameAfter").textContent = "✓ Example workflow";

    compare();
}

/* -------------------------------------------------------
Clear
------------------------------------------------------- */

function resetComparison() {
    document.getElementById("jsonBefore").value = "";
    document.getElementById("jsonAfter").value = "";

    document.getElementById("nameBefore").textContent = "";
    document.getElementById("nameAfter").textContent = "";

    document.getElementById("mainContainer").style.display = "block";
    document.getElementById("compareButton").style.display = "inline-block";
    document.getElementById("output").style.display = "none";
    document.getElementById("status").textContent = "Waiting for workflows...";

    hideError();

    beforeWorkflow = null;
    afterWorkflow = null;
    diffResult = null;
    selectedNodeKey = null;
}

function clearAll() {
    resetComparison();
}

/* -------------------------------------------------------
Error handling
------------------------------------------------------- */

function showError(message) {
    const box = document.getElementById("error");
    box.textContent = "⚠ " + message;
    box.style.display = "block";
    document.getElementById("output").style.display = "none";
}

function hideError() {
    document.getElementById("error").style.display = "none";
}

/* -------------------------------------------------------
Export standalone report
------------------------------------------------------- */

function getCurrentTheme() {
    return document.body.dataset.theme === "light" ? "light" : "dark";
}

function toggleTheme() {
    const nextTheme = getCurrentTheme() === "dark" ? "light" : "dark";
    document.body.dataset.theme = nextTheme;
    localStorage.setItem("n8n-diff-theme", nextTheme);

    const btn = document.getElementById("themeToggle");

    if (btn) {
        btn.textContent = nextTheme === "dark" ? "☾" : "☀️";
        btn.setAttribute("aria-label", nextTheme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    }

    if (diffResult) {
        renderGraph();
    }
}

function exportReport() {
    if (!diffResult) {
        alert("Run a comparison before exporting.");

        return;
    }

    const changedNodes = diffResult.nodes.filter((node) => node.status !== "unchanged");
    const summary = [
        ["Added", diffResult.nodes.filter((node) => node.status === "added").length],
        ["Removed", diffResult.nodes.filter((node) => node.status === "removed").length],
        ["Modified", diffResult.nodes.filter((node) => node.status === "modified").length],
        ["Renamed", diffResult.nodes.filter((node) => node.status === "renamed").length],
        ["Connection changes", diffResult.connections.added.length + diffResult.connections.removed.length],
    ];

    const formatReportValue = (value) => {
        if (value === undefined) {
            return "undefined";
        }

        if (typeof value === "string") {
            return escapeHtml(value);
        }

        return escapeHtml(JSON.stringify(value, null, 2));
    };
    const connectionRows = [
        ...diffResult.connections.removed.map(
            (connection) => `
                <div class="change-row removed-change">
                    <span class="change-symbol">−</span>
                    <span>${escapeHtml(connection.source)} → ${escapeHtml(connection.target)}</span>
                    <span class="change-label">Removed</span>
                </div>
            `
        ),
        ...diffResult.connections.added.map(
            (connection) => `
                <div class="change-row added-change">
                    <span class="change-symbol">+</span>
                    <span>${escapeHtml(connection.source)} → ${escapeHtml(connection.target)}</span>
                    <span class="change-label">Added</span>
                </div>
            `
        ),
    ].join("");

    const connectionSection = `
        <section class="connection-block">
            <h2>Connection changes</h2>
            ${connectionRows || '<p class="empty-change">No connection changes detected.</p>'}
        </section>
    `;

    const nodeRows = changedNodes
        .map((node) => {
            const before = node.before ? JSON.stringify(node.before, null, 2) : "— node did not exist —";
            const after = node.after ? JSON.stringify(node.after, null, 2) : "— node was removed —";
            let changes = "";

            if (node.status === "added") {
                changes = '<div class="change-row added-change"><span class="change-symbol">+</span><span>Entire node added</span></div>';
            } else if (node.status === "removed") {
                changes = '<div class="change-row removed-change"><span class="change-symbol">−</span><span>Entire node removed</span></div>';
            } else {
                changes = node.changes
                    .map((change) => {
                        const path = escapeHtml(change.path.join("."));

                        if (change.type === "add") {
                            return `<div class="change-row added-change"><span class="change-symbol">+</span><span>${path} = ${formatReportValue(change.after)}</span></div>`;
                        }

                        if (change.type === "remove") {
                            return `<div class="change-row removed-change"><span class="change-symbol">−</span><span>${path} = ${formatReportValue(change.before)}</span></div>`;
                        }

                        return `
                            <div class="change-row modified-change">
                                <span class="change-symbol">~</span>
                                <span>${path}<br><span class="old-value">− ${formatReportValue(change.before)}</span><br><span class="new-value">+ ${formatReportValue(change.after)}</span></span>
                            </div>
                        `;
                    })
                    .join("");
            }

            return `
            <section class="node-block">
                <h3>${escapeHtml(node.name)} <span class="tag ${node.status}">${node.status}</span></h3>
                <p class="node-type">${escapeHtml(node.type)}</p>
                <div class="changes">
                    <h4>What changed?</h4>
                    ${changes || '<p class="empty-change">No parameter changes.</p>'}
                </div>
                <div class="compare-columns">
                    <div>
                        <h4>Before</h4>
                        <pre>${escapeHtml(before)}</pre>
                    </div>
                    <div>
                        <h4>After</h4>
                        <pre>${escapeHtml(after)}</pre>
                    </div>
                </div>
            </section>
        `;
        })
        .join("");

    const report = `<!doctype html>
        <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>n8n Workflow Diff Report</title>
            <style>
            :root {
                --bg: #ffffff;
                --panel: #f8fafc;
                --border: #dfe7ef;
                --text: #111827;
                --muted: #5f6b7a;
                --green: #1d9b5d;
                --red: #d92d4d;
                --yellow: #c68b00;
                --blue: #1f6feb;
                --purple: #7b61ff;
                --code-bg: #f3f6f9;
            }
            * { box-sizing: border-box; }
            body {
                margin: 0;
                background: var(--bg);
                color: var(--text);
                font-family: Inter, "Segoe UI", sans-serif;
                line-height: 1.5;
            }
            .wrap {
                max-width: 1200px;
                margin: 0 auto;
                padding: 20px 24px 40px;
            }
            .header {
                padding: 20px 22px;
                border: 1px solid var(--border);
                border-radius: 14px;
                background: var(--panel);
                margin-bottom: 18px;
            }
            h1 { margin: 0 0 6px; font-size: 28px; }
            .subtitle { color: var(--muted); font-size: 12px; }
            .stats {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 12px;
                margin-bottom: 18px;
            }
            .stat {
                background: var(--panel);
                border: 1px solid var(--border);
                border-radius: 12px;
                padding: 12px 14px;
            }
            .stat .value {
                font-size: 26px;
                font-weight: 700;
                margin-bottom: 4px;
            }
            .label { color: var(--muted); font-size: 12px; }
            .node-block {
                background: var(--panel);
                border: 1px solid var(--border);
                padding: 18px;
                border-radius: 14px;
                margin-bottom: 18px;
            }
            .node-block h3 {
                margin: 0 0 6px;
                font-size: 20px;
            }
            .node-type { color: var(--muted); margin: 0 0 12px; font-size: 12px; }
            .changes, .connection-block {
                border: 1px solid var(--border);
                border-radius: 10px;
                background: #ffffff;
                padding: 12px;
                margin: 0 0 14px;
            }
            .changes h4, .connection-block h2 {
                margin: 0 0 8px;
                font-size: 13px;
            }
            .connection-block h2 { font-size: 18px; }
            .change-row {
                display: flex;
                align-items: flex-start;
                gap: 8px;
                padding: 6px 8px;
                border-radius: 6px;
                font-size: 12px;
                overflow-wrap: anywhere;
            }
            .change-row > span:not(.change-symbol):not(.change-label) {
                white-space: pre-wrap;
                overflow-wrap: anywhere;
                word-break: break-word;
            }
            .change-symbol { font-weight: 700; min-width: 12px; }
            .added-change { color: var(--green); }
            .removed-change { color: var(--red); }
            .modified-change { color: var(--yellow); }
            .change-label {
                margin-left: auto;
                color: var(--muted);
                font-size: 10px;
                text-transform: uppercase;
                white-space: nowrap;
            }
            .old-value { color: var(--red); }
            .new-value { color: var(--green); }
            .empty-change { color: var(--muted); margin: 0; font-size: 12px; }
            .tag {
                display: inline-block;
                padding: 4px 8px;
                border-radius: 999px;
                font-size: 10px;
                letter-spacing: 0.08em;
                text-transform: uppercase;
                margin-left: 8px;
                vertical-align: middle;
            }
            .tag.added { background: rgba(29,155,93,0.12); color: var(--green); }
            .tag.removed { background: rgba(217,45,77,0.12); color: var(--red); }
            .tag.modified { background: rgba(198,139,0,0.12); color: var(--yellow); }
            .tag.renamed { background: rgba(31,111,235,0.12); color: var(--blue); }
            .compare-columns {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 14px;
            }
            .compare-columns h4 {
                margin: 0 0 8px;
                color: var(--muted);
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 0.08em;
            }
            pre {
                margin: 0;
                background: var(--code-bg);
                border: 1px solid var(--border);
                border-radius: 10px;
                padding: 12px;
                white-space: pre-wrap;
                word-break: break-word;
                overflow-wrap: anywhere;
                font-size: 11px;
                line-height: 1.5;
            }
            @page {
                size: A4 portrait;
                margin: 12mm;
            }
            @media print {
                body {
                    background: #fff;
                    color: #111827;
                }
                .node-block {
                    break-inside: avoid;
                    page-break-inside: avoid;
                }
                .compare-columns {
                    grid-template-columns: 1fr 1fr;
                }
            }
            @media (max-width: 700px) {
                .compare-columns { grid-template-columns: 1fr; }
                .wrap { padding: 16px 16px 30px; }
            }
            </style>
        </head>
        <body>
            <div class="wrap">
                <div class="header">
                    <h1>n8n Workflow Diff Report</h1>
                    <div class="subtitle">Generated on ${new Date().toLocaleString()}</div>
                </div>
                <div class="stats">
                    ${summary
                        .map(
                            ([label, value]) => `
                                <div class="stat">
                                    <div class="value">${value}</div>
                                    <div class="label">${label}</div>
                                </div>
                            `
                        )
                        .join("")}
                </div>
                    ${connectionSection}
                ${nodeRows || '<div class="node-block">No changes detected.</div>'}
            </div>
        </body>
        </html>
    `;

    const printWindow = window.open("", "_blank", "width=1200,height=900");

    if (!printWindow) {
        alert("Please allow pop-ups so the report can be saved as a PDF.");
        return;
    }

    printWindow.document.open();
    printWindow.document.write(report);
    printWindow.document.close();
    printWindow.focus();

    setTimeout(() => {
        printWindow.print();
    }, 500);
}

const savedTheme = localStorage.getItem("n8n-diff-theme") || "dark";

document.body.dataset.theme = savedTheme;
const themeButton = document.getElementById("themeToggle");

if (themeButton) {
    themeButton.textContent = savedTheme === "dark" ? "☾" : "☀️";
    themeButton.setAttribute("aria-label", savedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme");
}

/* -------------------------------------------------------
                    Keyboard shortcut
------------------------------------------------------- */

document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        compare();
    }
});
/* =========================================
Workflow graph zoom / pan
========================================= */

let graphScale = 1;

let graphOffsetX = 0;
let graphOffsetY = 0;

let graphDragging = false;

let graphDragStartX = 0;
let graphDragStartY = 0;

let graphStartOffsetX = 0;
let graphStartOffsetY = 0;

/* -----------------------------------------
Apply transform
----------------------------------------- */

function applyGraphView() {
    const svg = document.getElementById("graphSvg");
    if (!svg) return;
    svg.style.transform = `translate(${graphOffsetX}px, ${graphOffsetY}px) scale(${graphScale})`;
    svg.style.transformOrigin = "0 0";
}

/* -----------------------------------------
Zoom
----------------------------------------- */

function changeGraphZoom(amount, mouseX = null, mouseY = null) {
    const canvas = document.querySelector(".graph-canvas");
    if (!canvas) return;

    const oldScale = graphScale;
    const newScale = Math.max(0.2, Math.min(10, graphScale + amount));

    /*
     * If there is no mouse position,
     * simply zoom normally.
     */

    if (mouseX === null || mouseY === null) {
        graphScale = newScale;
        applyGraphView();
        return;
    }

    /*
     * Mouse position relative to canvas.
     */

    const rect = canvas.getBoundingClientRect();
    const x = mouseX - rect.left;
    const y = mouseY - rect.top;

    /*
     * Find the graph point currently
     * underneath the mouse.
     */

    const graphX = (x - graphOffsetX) / oldScale;
    const graphY = (y - graphOffsetY) / oldScale;

    /*
     * Apply new zoom.
     */

    graphScale = newScale;

    /*
     * Move the graph so that the SAME
     * graph point stays underneath the
     * mouse.
     */

    graphOffsetX = x - graphX * graphScale;
    graphOffsetY = y - graphY * graphScale;

    applyGraphView();
}

/* -----------------------------------------
Reset
----------------------------------------- */

function resetGraphZoom() {
    graphScale = 1;
    graphOffsetX = 0;
    graphOffsetY = 0;
    applyGraphView();
}

/* -----------------------------------------
Initialize graph controls
----------------------------------------- */

function setupGraphControls() {
    const canvas = document.querySelector(".graph-canvas");
    const zoomIn = document.getElementById("graphZoomIn");
    const zoomOut = document.getElementById("graphZoomOut");
    const reset = document.getElementById("graphReset");

    if (!canvas) return;

    /* Buttons */

    if (zoomIn) {
        zoomIn.addEventListener("click", () => {
            const canvas = document.querySelector(".graph-canvas");
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            changeGraphZoom(0.25, rect.left + rect.width / 2, rect.top + rect.height / 2);
        });
    }

    if (zoomOut) {
        zoomOut.addEventListener("click", () => {
            const canvas = document.querySelector(".graph-canvas");
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            changeGraphZoom(-0.25, rect.left + rect.width / 2, rect.top + rect.height / 2);
        });
    }

    if (reset) {
        reset.addEventListener("click", resetGraphZoom);
    }

    /* -------------------------------------
Mouse wheel
------------------------------------- */

    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            /*
             * Zoom around the exact position
             * where the mouse currently is.
             */

            const zoomAmount = event.deltaY < 0 ? 0.25 : -0.25;
            changeGraphZoom(zoomAmount, event.clientX, event.clientY);
        },
        {
            passive: false,
        }
    );

    /* -------------------------------------
Start dragging
------------------------------------- */

    canvas.addEventListener("mousedown", (event) => {
        /*
         * Don't drag when clicking buttons.
         */

        if (event.target.closest(".graph-controls")) {
            return;
        }

        graphDragging = true;
        graphDragStartX = event.clientX;
        graphDragStartY = event.clientY;
        graphStartOffsetX = graphOffsetX;
        graphStartOffsetY = graphOffsetY;
    });

    /* -------------------------------------
Drag
------------------------------------- */

    window.addEventListener("mousemove", (event) => {
        if (!graphDragging) return;
        graphOffsetX = graphStartOffsetX + (event.clientX - graphDragStartX);
        graphOffsetY = graphStartOffsetY + (event.clientY - graphDragStartY);
        applyGraphView();
    });

    /* -------------------------------------
Stop dragging
------------------------------------- */

    window.addEventListener("mouseup", () => {
        graphDragging = false;
    });

    /* -------------------------------------
Double-click = reset
------------------------------------- */

    canvas.addEventListener("dblclick", (event) => {
        if (event.target.closest(".graph-controls")) {
            return;
        }
        resetGraphZoom();
    });
}

/* -----------------------------------------
Start controls
----------------------------------------- */

document.addEventListener("DOMContentLoaded", setupGraphControls);