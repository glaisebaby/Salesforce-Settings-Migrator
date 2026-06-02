function getWebviewHtml(webview, extensionUri) {
  const scriptUri = webview.asWebviewUri(require('vscode').Uri.joinPath(extensionUri, 'media', 'main.js'));
  const styleUri = webview.asWebviewUri(require('vscode').Uri.joinPath(extensionUri, 'media', 'main.css'));
  const iconUri = webview.asWebviewUri(require('vscode').Uri.joinPath(extensionUri, 'assets', 'icon.png'));
  const nonce = String(Date.now());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Salesforce Settings Migrator</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="app" class="app">
    <header class="hero">
      <div>
        <div class="hero-title">
          <img src="${iconUri}" alt="Salesforce Settings Migrator icon" class="hero-logo" />
          <h1>Salesforce Settings Migrator</h1>
        </div>
        <p class="hero-copy">
          Discover authenticated orgs, compare custom settings, custom metadata, and credential metadata dynamically,
          then run a guided migration with live progress, cancellation, and per-run reports.
        </p>
        <button id="developerLinkButton" class="developer-link" type="button">
          Connect with the developer
        </button>
        <nav class="tab-bar hero-tab-bar" aria-label="Plugin sections">
          <button id="workspaceTabButton" class="tab-button is-active" type="button">Workspace</button>
          <button id="readmeTabButton" class="tab-button" type="button">README</button>
        </nav>
      </div>
      <div class="hero-actions">
        <button id="refreshOrgsButton" class="button secondary">Refresh Orgs</button>
      </div>
    </header>

    <div id="workspaceView">
    <section class="panel org-panel">
      <div class="panel-header">
        <div>
          <p class="panel-kicker">Step 1</p>
          <h2>Select Source And Target Org</h2>
        </div>
        <div id="orgStatus" class="status-pill">
          <span id="orgStatusSpinner" class="inline-spinner hidden" aria-hidden="true"></span>
          <span id="orgStatusText">Waiting for org list</span>
        </div>
      </div>
      <div class="org-grid">
        <label class="field">
          <span>Source Org</span>
          <select id="sourceOrgSelect"></select>
        </label>
        <div class="swap-control">
          <button id="swapOrgsButton" class="button ghost icon-button" type="button" aria-label="Swap source and target orgs" title="Swap source and target orgs">
            <->
          </button>
        </div>
        <label class="field">
          <span>Target Org</span>
          <select id="targetOrgSelect"></select>
        </label>
      </div>
      <div id="orgMeta" class="help-text"></div>
      <div id="orgWarning" class="warning-banner hidden"></div>
    </section>

    <section class="panel inventory-panel">
      <div class="panel-header">
        <div>
          <p class="panel-kicker">Step 2</p>
          <h2>Choose What To Migrate</h2>
        </div>
        <div id="inventoryStatus" class="status-pill muted">Inventory not loaded</div>
      </div>

      <div class="inventory-controls">
        <div class="inventory-control-grid">
          <label class="field">
            <span>Migration Type</span>
            <select id="migrationKindSelect"></select>
          </label>
          <div class="inventory-actions">
            <button id="loadInventoryButton" class="button">Load Inventory</button>
            <button id="cancelInventoryButton" class="button danger hidden" type="button">Stop Inventory Load</button>
          </div>
        </div>
        <div id="migrationKindHelp" class="help-text"></div>
        <div class="project-json-filter">
          <div>
            <div class="filter-title">Optional Project Filter</div>
            <div id="projectJsonStatus" class="help-text">No project folder or JSON selected. Inventory will load all matching settings, metadata, and credentials from the source org.</div>
          </div>
          <div class="toolbar">
            <button id="chooseProjectJsonButton" class="button secondary" type="button">Load Project Folder or JSON</button>
            <button id="clearProjectJsonButton" class="button ghost" type="button">Clear filter</button>
          </div>
        </div>
      </div>

      <div id="inventoryProgress" class="inventory-progress hidden">
        <div class="progress-bar"><div id="inventoryProgressBar" class="progress-fill"></div></div>
        <div id="inventoryProgressText" class="help-text"></div>
      </div>

      <div id="selectionOverview" class="selection-overview hidden"></div>
      <div id="migrationSelectionProgress" class="migration-progress-grid hidden"></div>

      <div id="inventoryModeNotice" class="empty-state hidden"></div>

      <div id="inventorySelectionArea" class="inventory-grid">
        <div id="settingsCard" class="inventory-card">
          <div class="inventory-card-header">
            <div>
              <h3>Custom Settings</h3>
              <p id="settingsSummary" class="help-text">No inventory loaded yet.</p>
            </div>
            <div class="toolbar">
              <button type="button" data-action="select-nonzero-settings" class="button ghost small">Select Non-Empty</button>
              <button type="button" data-action="clear-settings" class="button ghost small">Clear</button>
            </div>
          </div>
          <label class="field search-field">
            <span>Filter</span>
            <input id="settingsFilter" type="search" placeholder="Search custom settings" />
          </label>
          <div class="filter-toolbar">
            <button type="button" data-action="expand-settings" class="button ghost small">Expand All</button>
            <button type="button" data-action="collapse-settings" class="button ghost small">Collapse All</button>
            <button type="button" data-action="select-all-types-settings" class="button ghost small">Select All Types</button>
            <button type="button" data-action="select-all-records-settings" class="button ghost small">Select All Records</button>
          </div>
          <div id="settingsList" class="checklist"></div>
        </div>

        <div id="metadataCard" class="inventory-card">
          <div class="inventory-card-header">
            <div>
              <h3>Custom Metadata Types</h3>
              <p id="metadataSummary" class="help-text">No inventory loaded yet.</p>
            </div>
            <div class="toolbar">
              <button type="button" data-action="select-nonzero-metadata" class="button ghost small">Select Non-Empty</button>
              <button type="button" data-action="clear-metadata" class="button ghost small">Clear</button>
            </div>
          </div>
          <label class="field search-field">
            <span>Filter</span>
            <input id="metadataFilter" type="search" placeholder="Search custom metadata types" />
          </label>
          <div class="filter-toolbar">
            <button type="button" data-action="expand-metadata" class="button ghost small">Expand All</button>
            <button type="button" data-action="collapse-metadata" class="button ghost small">Collapse All</button>
            <button type="button" data-action="select-all-types-metadata" class="button ghost small">Select All Types</button>
            <button type="button" data-action="select-all-records-metadata" class="button ghost small">Select All Records</button>
          </div>
          <div id="metadataList" class="checklist"></div>
        </div>

        <div id="credentialsCard" class="inventory-card">
          <div class="inventory-card-header">
            <div>
              <h3>Named And External Credentials</h3>
              <p id="credentialsSummary" class="help-text">No inventory loaded yet.</p>
            </div>
            <div class="toolbar">
              <button type="button" data-action="select-all-credentials" class="button ghost small">Select Visible</button>
              <button type="button" data-action="clear-credentials" class="button ghost small">Clear</button>
            </div>
          </div>
          <label class="field search-field">
            <span>Filter</span>
            <input id="credentialsFilter" type="search" placeholder="Search named and external credentials" />
          </label>
          <div id="credentialsList" class="checklist"></div>
        </div>
      </div>
    </section>

    <section class="panel execution-panel">
      <div class="panel-header">
        <div>
          <p class="panel-kicker">Step 3</p>
          <h2>Run Migration</h2>
        </div>
        <div id="runStatus" class="status-pill muted">No active run</div>
      </div>

      <div class="run-actions">
        <button id="startRunButton" class="button">Start Migration</button>
        <button id="cancelRunButton" class="button danger">Stop Execution</button>
      </div>

      <div id="activeRunContainer" class="active-run empty-state">
        Start a run to see live progress, metrics, and logs here.
      </div>
    </section>

    <section class="panel history-panel">
      <div class="panel-header">
        <div>
          <p class="panel-kicker">Reports</p>
          <h2>Run History</h2>
        </div>
        <div id="historyStatus" class="status-pill muted">No reports loaded</div>
      </div>
      <div id="runHistory" class="run-history empty-state">No run history yet.</div>
    </section>
    </div>

    <section id="readmeView" class="panel markdown-panel hidden">
      <div class="panel-header">
        <div>
          <p class="panel-kicker">Documentation</p>
          <h2>README</h2>
        </div>
      </div>
      <article id="readmeContent" class="markdown-body empty-state">README not loaded yet.</article>
    </section>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = {
  getWebviewHtml
};
