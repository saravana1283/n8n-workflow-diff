# n8n Workflow Diff

A lightweight, offline browser tool for comparing two exported n8n workflow JSON files. It highlights node additions, removals, modifications, renames, and connection changes without sending workflow data to a server.

## Features

- Compare a **Before** and **After** n8n workflow.
- Load JSON by drag and drop, file picker, or paste.
- Detect:
  - Added nodes
  - Removed nodes
  - Modified node parameters
  - Likely node renames
  - Added and removed connections
- Ignore node position changes.
- Ignore common metadata and editor-only fields.
- Mask credential values while displaying node details.
- Search and filter changed nodes.
- View the resulting workflow graph with changed nodes highlighted.
- Switch between light and dark themes.
- Export the comparison report as a PDF.

## Quick Start

1. Open [`index.html`](index.html) in a modern browser.
2. Add the older workflow to **Before workflow**.
3. Add the newer workflow to **After workflow**.
4. Choose the comparison options.
5. Select **Compare Workflows**.

The tool accepts standard n8n workflow exports containing a `nodes` array and `connections` object. A JSON array of nodes is also accepted.

## Run With a Local Server

Opening the HTML file directly is sufficient for normal use. To serve it locally instead:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

## How Comparison Works

- Nodes are matched by `name` when available, then by `id`, then by a fallback based on type and position.
- Node objects are compared recursively, including nested parameters and arrays.
- Position, metadata, and credentials can be excluded before comparison using the checkboxes.
- A node removed from the Before workflow and added to the After workflow is reported as renamed when both nodes have the same type and equivalent configuration apart from `name`.
- Connections are compared using their source, target, output type, and input indexes.

## Privacy and Security

All file reading, parsing, comparison, and rendering happen in the browser. The application does not include a backend or make network requests for workflow data.

Even though credential fields are masked in the comparison view when the option is enabled, treat workflow exports as sensitive files. Do not publish exports containing real credentials.

## Project Structure

```text
|-- index.html              Application shell
|-- static/
|   |-- css/style.css       Layout and theme styles
|   `-- js/script.js        File handling, diff logic, graph, and export
`-- images/                 Static image assets
```

## Limitations

- Matching depends on node names. Renaming a node and changing its configuration at the same time may appear as separate add/remove changes.
- Duplicate node names are supported with an internal suffix, but unique names produce the most reliable results.
- The tool compares exported JSON; it does not connect to an n8n instance or retrieve workflows through the n8n API.
- Browser support for PDF export and modern JavaScript features depends on the browser version.

## License

No license file is currently included in this directory.