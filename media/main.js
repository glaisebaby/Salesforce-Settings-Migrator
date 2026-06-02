(function () {
  const vscode = acquireVsCodeApi();

  const elements = {
    workspaceTabButton: document.getElementById('workspaceTabButton'),
    readmeTabButton: document.getElementById('readmeTabButton'),
    workspaceView: document.getElementById('workspaceView'),
    readmeView: document.getElementById('readmeView'),
    readmeContent: document.getElementById('readmeContent'),
    developerLinkButton: document.getElementById('developerLinkButton'),
    refreshOrgsButton: document.getElementById('refreshOrgsButton'),
    loadInventoryButton: document.getElementById('loadInventoryButton'),
    migrationKindSelect: document.getElementById('migrationKindSelect'),
    migrationKindHelp: document.getElementById('migrationKindHelp'),
    chooseProjectJsonButton: document.getElementById('chooseProjectJsonButton'),
    clearProjectJsonButton: document.getElementById('clearProjectJsonButton'),
    projectJsonStatus: document.getElementById('projectJsonStatus'),
    sourceOrgSelect: document.getElementById('sourceOrgSelect'),
    targetOrgSelect: document.getElementById('targetOrgSelect'),
    swapOrgsButton: document.getElementById('swapOrgsButton'),
    orgStatus: document.getElementById('orgStatus'),
    orgStatusSpinner: document.getElementById('orgStatusSpinner'),
    orgStatusText: document.getElementById('orgStatusText'),
    orgMeta: document.getElementById('orgMeta'),
    orgWarning: document.getElementById('orgWarning'),
    inventoryStatus: document.getElementById('inventoryStatus'),
    inventoryProgress: document.getElementById('inventoryProgress'),
    inventoryProgressBar: document.getElementById('inventoryProgressBar'),
    inventoryProgressText: document.getElementById('inventoryProgressText'),
    selectionOverview: document.getElementById('selectionOverview'),
    migrationSelectionProgress: document.getElementById('migrationSelectionProgress'),
    inventoryModeNotice: document.getElementById('inventoryModeNotice'),
    inventorySelectionArea: document.getElementById('inventorySelectionArea'),
    settingsCard: document.getElementById('settingsCard'),
    metadataCard: document.getElementById('metadataCard'),
    credentialsCard: document.getElementById('credentialsCard'),
    settingsSummary: document.getElementById('settingsSummary'),
    metadataSummary: document.getElementById('metadataSummary'),
    credentialsSummary: document.getElementById('credentialsSummary'),
    settingsList: document.getElementById('settingsList'),
    metadataList: document.getElementById('metadataList'),
    credentialsList: document.getElementById('credentialsList'),
    settingsFilter: document.getElementById('settingsFilter'),
    metadataFilter: document.getElementById('metadataFilter'),
    credentialsFilter: document.getElementById('credentialsFilter'),
    startRunButton: document.getElementById('startRunButton'),
    cancelInventoryButton: document.getElementById('cancelInventoryButton'),
    cancelRunButton: document.getElementById('cancelRunButton'),
    runStatus: document.getElementById('runStatus'),
    activeRunContainer: document.getElementById('activeRunContainer'),
    runHistory: document.getElementById('runHistory'),
    historyStatus: document.getElementById('historyStatus')
  };

  const state = Object.assign(
    {
      orgs: [],
      orgsLoading: false,
      inventory: null,
      inventoryLoading: false,
      inventoryProgress: null,
      activeRun: null,
      runHistory: [],
      migrationKinds: [],
      selectedMigrationKind: 'settingsMetadata',
      projectJsonFilter: null,
      sourceOrg: '',
      targetOrg: '',
      selectedSettings: [],
      selectedMetadata: [],
      selectedCredentials: [],
      settingsSelectedRecords: {},
      metadataSelectedRecords: {},
      settingsCopyOptions: {},
      metadataCopyOptions: {},
      expandedSettings: {},
      expandedMetadata: {},
      settingsFilter: '',
      metadataFilter: '',
      credentialsFilter: '',
      lastProjectAutoSelectionKey: '',
      lastError: '',
      activeTab: 'workspace',
      readmeContent: ''
    },
    vscode.getState() || {}
  );

  function persist() {
    vscode.setState(state);
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function getProjectJsonFilter() {
    return state.projectJsonFilter || {
      enabled: false,
      sourceType: 'none',
      customSettings: [],
      customMetadata: [],
      credentials: [],
      fileName: ''
    };
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatInlineMarkdown(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-external-link="$2">$1</a>');
  }

  function renderMarkdown(markdown) {
    const source = String(markdown || '').replace(/\r\n/g, '\n');
    if (!source.trim()) {
      return '<div class="empty-state compact">README not available.</div>';
    }

    const lines = source.split('\n');
    const html = [];
    let inList = false;
    let listType = '';
    let inCodeBlock = false;
    let codeBuffer = [];
    let paragraphBuffer = [];

    function flushParagraph() {
      if (!paragraphBuffer.length) {
        return;
      }
      const text = paragraphBuffer.join(' ').trim();
      if (text) {
        html.push(`<p>${formatInlineMarkdown(text)}</p>`);
      }
      paragraphBuffer = [];
    }

    function flushList() {
      if (inList) {
        html.push(listType === 'ol' ? '</ol>' : '</ul>');
        inList = false;
        listType = '';
      }
    }

    function flushCodeBlock() {
      if (inCodeBlock) {
        html.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
        inCodeBlock = false;
        codeBuffer = [];
      }
    }

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('```')) {
        flushParagraph();
        flushList();
        if (inCodeBlock) {
          flushCodeBlock();
        } else {
          inCodeBlock = true;
          codeBuffer = [];
        }
        continue;
      }

      if (inCodeBlock) {
        codeBuffer.push(line);
        continue;
      }

      if (!trimmed) {
        flushParagraph();
        flushList();
        continue;
      }

      const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        flushParagraph();
        flushList();
        const level = Math.min(headingMatch[1].length, 6);
        html.push(`<h${level}>${formatInlineMarkdown(headingMatch[2])}</h${level}>`);
        continue;
      }

      const unorderedListMatch = trimmed.match(/^[-*]\s+(.*)$/);
      const orderedListMatch = trimmed.match(/^\d+\.\s+(.*)$/);
      if (unorderedListMatch || orderedListMatch) {
        flushParagraph();
        const nextListType = orderedListMatch ? 'ol' : 'ul';
        if (!inList || listType !== nextListType) {
          flushList();
          html.push(nextListType === 'ol' ? '<ol>' : '<ul>');
          inList = true;
          listType = nextListType;
        }
        html.push(`<li>${formatInlineMarkdown((unorderedListMatch || orderedListMatch)[1])}</li>`);
        continue;
      }

      flushList();
      paragraphBuffer.push(trimmed);
    }

    flushParagraph();
    flushList();
    flushCodeBlock();
    return html.join('');
  }

  function migrationKindIncludesSettings() {
    return ['customSettings', 'settingsMetadata'].includes(state.selectedMigrationKind);
  }

  function migrationKindIncludesMetadata() {
    return ['customMetadata', 'settingsMetadata'].includes(state.selectedMigrationKind);
  }

  function migrationKindIncludesCredentials() {
    return ['credentials', 'settingsMetadata'].includes(state.selectedMigrationKind);
  }

  function ensureSelectionForInventory() {
    if (!state.inventory) {
      state.selectedSettings = [];
      state.selectedMetadata = [];
      state.selectedCredentials = [];
      state.settingsSelectedRecords = {};
      state.metadataSelectedRecords = {};
      state.settingsCopyOptions = {};
      state.metadataCopyOptions = {};
      state.expandedSettings = {};
      state.expandedMetadata = {};
      return;
    }

    const settingsApi = new Set(state.inventory.customSettings.map((item) => item.apiName));
    const metadataApi = new Set(state.inventory.customMetadata.map((item) => item.apiName));
    const credentialApi = new Set((state.inventory.credentials || []).map((item) => item.apiName));

    state.selectedSettings = state.selectedSettings.filter((apiName) => settingsApi.has(apiName));
    state.selectedMetadata = state.selectedMetadata.filter((apiName) => metadataApi.has(apiName));
    state.selectedCredentials = state.selectedCredentials.filter((apiName) => credentialApi.has(apiName));
    state.settingsSelectedRecords = Object.fromEntries(
      Object.entries(state.settingsSelectedRecords || {}).filter(([apiName]) => settingsApi.has(apiName))
    );
    state.metadataSelectedRecords = Object.fromEntries(
      Object.entries(state.metadataSelectedRecords || {}).filter(([apiName]) => metadataApi.has(apiName))
    );
    state.settingsCopyOptions = Object.fromEntries(
      Object.entries(state.settingsCopyOptions || {}).filter(([apiName]) => settingsApi.has(apiName))
    );
    state.metadataCopyOptions = Object.fromEntries(
      Object.entries(state.metadataCopyOptions || {}).filter(([apiName]) => metadataApi.has(apiName))
    );
    state.expandedSettings = Object.fromEntries(
      Object.entries(state.expandedSettings || {}).filter(([apiName]) => settingsApi.has(apiName))
    );
    state.expandedMetadata = Object.fromEntries(
      Object.entries(state.expandedMetadata || {}).filter(([apiName]) => metadataApi.has(apiName))
    );

    for (const item of state.inventory.customSettings) {
      const validKeys = new Set((item.records || []).map((record) => record.key));
      state.settingsSelectedRecords[item.apiName] = (state.settingsSelectedRecords[item.apiName] || []).filter((key) => validKeys.has(key));
      if (typeof state.settingsCopyOptions[item.apiName] !== 'boolean') {
        state.settingsCopyOptions[item.apiName] = true;
      }
      if (typeof state.expandedSettings[item.apiName] !== 'boolean') {
        state.expandedSettings[item.apiName] = false;
      }
    }
    for (const item of state.inventory.customMetadata) {
      const validKeys = new Set((item.records || []).map((record) => record.key));
      state.metadataSelectedRecords[item.apiName] = (state.metadataSelectedRecords[item.apiName] || []).filter((key) => validKeys.has(key));
      if (typeof state.metadataCopyOptions[item.apiName] !== 'boolean') {
        state.metadataCopyOptions[item.apiName] = true;
      }
      if (typeof state.expandedMetadata[item.apiName] !== 'boolean') {
        state.expandedMetadata[item.apiName] = false;
      }
    }

    state.selectedSettings = state.selectedSettings.filter((apiName) => (state.settingsSelectedRecords[apiName] || []).length > 0);
    state.selectedMetadata = state.selectedMetadata.filter((apiName) => (state.metadataSelectedRecords[apiName] || []).length > 0);
  }

  function getRecordSelectionMap(kind) {
    return kind === 'settings' ? state.settingsSelectedRecords : state.metadataSelectedRecords;
  }

  function getExpandedMap(kind) {
    return kind === 'settings' ? state.expandedSettings : state.expandedMetadata;
  }

  function getOrgByAlias(alias) {
    return (state.orgs || []).find((org) => org.alias === alias) || null;
  }

  function getRiskyOrgSelection() {
    return [state.sourceOrg, state.targetOrg]
      .map((alias) => getOrgByAlias(alias))
      .filter((org) => org && org.looksLikeProduction);
  }

  function resetInventoryState() {
    state.inventory = null;
    state.selectedSettings = [];
    state.selectedMetadata = [];
    state.selectedCredentials = [];
    state.settingsSelectedRecords = {};
    state.metadataSelectedRecords = {};
    state.settingsCopyOptions = {};
    state.metadataCopyOptions = {};
    state.expandedSettings = {};
    state.expandedMetadata = {};
    state.lastProjectAutoSelectionKey = '';
  }

  function totalSelectedRecordCount(kind) {
    const selectionMap = getRecordSelectionMap(kind);
    return Object.values(selectionMap || {}).reduce((sum, items) => sum + items.length, 0);
  }

  function totalRunnableRecordCount(kind) {
    const selectionMap = getRecordSelectionMap(kind);
    const copyOptions = kind === 'settings' ? state.settingsCopyOptions : state.metadataCopyOptions;
    return Object.entries(selectionMap || {}).reduce((sum, [apiName, items]) => {
      if (copyOptions[apiName] === false) {
        return sum;
      }
      return sum + items.length;
    }, 0);
  }

  function getCurrentSelectionObjectCount() {
    const settingsCount = state.selectedSettings.filter((apiName) => (state.settingsCopyOptions[apiName] !== false)).length;
    const metadataCount = state.selectedMetadata.filter((apiName) => (state.metadataCopyOptions[apiName] !== false)).length;
    const credentialCount = state.selectedCredentials.length;
    return settingsCount + metadataCount + credentialCount;
  }

  function getCurrentSelectionRecordCount() {
    return totalRunnableRecordCount('settings') + totalRunnableRecordCount('metadata');
  }

  function getActiveRunSelectionObjectCount() {
    const run = state.activeRun;
    if (!run?.selected) {
      return 0;
    }

    const settingsCount = (run.selected.customSettings || []).filter(
      (item) => item.copyRecords !== false && Array.isArray(item.selectedRecords) && item.selectedRecords.length > 0
    ).length;
    const metadataCount = (run.selected.customMetadata || []).filter(
      (item) => item.copyRecords !== false && Array.isArray(item.selectedRecords) && item.selectedRecords.length > 0
    ).length;
    const credentialCount = (run.selected.credentials || []).length;

    return settingsCount + metadataCount + credentialCount;
  }

  function getActiveRunSelectionRecordCount() {
    const run = state.activeRun;
    if (!run?.selected) {
      return 0;
    }

    const settingsCount = (run.selected.customSettings || []).reduce((sum, item) => {
      if (item.copyRecords === false) {
        return sum;
      }
      return sum + ((item.selectedRecords || []).length || 0);
    }, 0);
    const metadataCount = (run.selected.customMetadata || []).reduce((sum, item) => {
      if (item.copyRecords === false) {
        return sum;
      }
      return sum + ((item.selectedRecords || []).length || 0);
    }, 0);

    return settingsCount + metadataCount;
  }

  function getActiveRunSelectedCredentialCount() {
    return state.activeRun?.selected?.credentials?.length || 0;
  }

  function renderSelectionProgressCard(label, processed, total) {
    const safeTotal = Math.max(Number(total || 0), 0);
    const safeProcessed = Math.min(Math.max(Number(processed || 0), 0), safeTotal || 0);
    const percent = safeTotal > 0 ? Math.round((safeProcessed / safeTotal) * 100) : 0;

    return `
      <article class="selection-progress-card">
        <div class="selection-progress-header">
          <h4>${escapeHtml(label)}</h4>
          <span class="count-badge">${escapeHtml(`${safeProcessed} / ${safeTotal}`)}</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${percent}%"></div></div>
        <div class="help-text">${escapeHtml(`${safeProcessed} processed out of ${safeTotal} total`)}</div>
      </article>
    `;
  }

  function applyInventoryAutoSelectionIfNeeded() {
    const inventory = state.inventory;
    if (!inventory || !['json', 'folder'].includes(inventory.projectSelectionMode)) {
      return;
    }

    const selectionKey = `${inventory.projectSelectionMode}:${inventory.loadedAt || ''}`;
    if (!selectionKey || state.lastProjectAutoSelectionKey === selectionKey) {
      return;
    }

    const matchedSettings = inventory.customSettings || [];
    const matchedMetadata = inventory.customMetadata || [];
    const matchedCredentials = inventory.credentials || [];

    state.selectedSettings = matchedSettings.map((item) => item.apiName).sort();
    state.selectedMetadata = matchedMetadata.map((item) => item.apiName).sort();
    state.selectedCredentials = matchedCredentials.map((item) => item.apiName).sort();
    state.settingsSelectedRecords = Object.fromEntries(
      (inventory.customSettings || []).map((item) => [
        item.apiName,
        (item.records || []).map((record) => record.key)
      ])
    );
    state.metadataSelectedRecords = Object.fromEntries(
      (inventory.customMetadata || []).map((item) => [
        item.apiName,
        (item.records || []).map((record) => record.key)
      ])
    );
    state.settingsCopyOptions = Object.fromEntries(
      (inventory.customSettings || []).map((item) => [item.apiName, true])
    );
    state.metadataCopyOptions = Object.fromEntries(
      (inventory.customMetadata || []).map((item) => [item.apiName, true])
    );
    state.expandedSettings = Object.fromEntries((inventory.customSettings || []).map((item) => [item.apiName, false]));
    state.expandedMetadata = Object.fromEntries((inventory.customMetadata || []).map((item) => [item.apiName, false]));
    state.lastProjectAutoSelectionKey = selectionKey;
  }

  function getRunSelectedTypeCount(run, kind) {
    const items = kind === 'settings' ? run?.selected?.customSettings || [] : run?.selected?.customMetadata || [];
    return items.filter((item) => item.copyRecords !== false && Array.isArray(item.selectedRecords) && item.selectedRecords.length > 0).length;
  }

  function getRunSelectedRecordCount(run, kind) {
    const items = kind === 'settings' ? run?.selected?.customSettings || [] : run?.selected?.customMetadata || [];
    return items.reduce((sum, item) => {
      if (item.copyRecords === false) {
        return sum;
      }
      return sum + ((item.selectedRecords || []).length || 0);
    }, 0);
  }

  function getRunSelectedCredentialCount(run) {
    return run?.selected?.credentials?.length || 0;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
      return '0s';
    }

    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];

    if (hours > 0) {
      parts.push(`${hours}h`);
    }
    if (minutes > 0 || hours > 0) {
      parts.push(`${minutes}m`);
    }
    parts.push(`${seconds}s`);
    return parts.join(' ');
  }

  function formatAverageDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
      return 'n/a';
    }
    if (ms < 1000) {
      return `${Math.round(ms)} ms`;
    }
    return `${(ms / 1000).toFixed(2)} s`;
  }

  function componentMatchesFilter(item, filterText) {
    const term = String(filterText || '').trim().toLowerCase();
    if (!term) {
      return { visible: true, records: item.records || [] };
    }

    const records = (item.records || []).filter((record) => {
      return (
        String(record.label || '').toLowerCase().includes(term) ||
        String(record.subtitle || '').toLowerCase().includes(term) ||
        String(record.key || '').toLowerCase().includes(term)
      );
    });

    const parentMatch =
      item.apiName.toLowerCase().includes(term) ||
      String(item.label || '').toLowerCase().includes(term) ||
      String(item.namespacePrefix || '').toLowerCase().includes(term);

    return {
      visible: parentMatch || records.length > 0,
      records: parentMatch ? item.records || [] : records
    };
  }

  function getInventoryItems(kind) {
    if (!state.inventory) {
      return [];
    }
    return kind === 'settings' ? state.inventory.customSettings : state.inventory.customMetadata;
  }

  function getSelectedKey(kind) {
    return kind === 'settings' ? 'selectedSettings' : 'selectedMetadata';
  }

  function getRecordMapKey(kind) {
    return kind === 'settings' ? 'settingsSelectedRecords' : 'metadataSelectedRecords';
  }

  function getFilterText(kind) {
    return kind === 'settings' ? state.settingsFilter : state.metadataFilter;
  }

  function getVisibleItems(kind) {
    return getInventoryItems(kind)
      .filter((item) => componentMatchesFilter(item, getFilterText(kind)).visible);
  }

  function getExpandableItems(kind) {
    return getInventoryItems(kind).filter((item) => Array.isArray(item.records) && item.records.length > 0);
  }

  function setParentSelection(kind, apiName, checked) {
    const inventoryItems = getInventoryItems(kind);
    const component = inventoryItems.find((item) => item.apiName === apiName);
    if (!component) {
      return;
    }

    const recordMapKey = getRecordMapKey(kind);
    const selectedKey = getSelectedKey(kind);
    const allRecordKeys = (component.records || []).map((record) => record.key);

    if (checked) {
      state[recordMapKey] = {
        ...(state[recordMapKey] || {}),
        [apiName]: allRecordKeys
      };
      if (!state[selectedKey].includes(apiName)) {
        state[selectedKey] = [...state[selectedKey], apiName].sort();
      }
    } else {
      state[recordMapKey] = {
        ...(state[recordMapKey] || {}),
        [apiName]: []
      };
      state[selectedKey] = state[selectedKey].filter((value) => value !== apiName);
    }
  }

  function setChildSelection(kind, apiName, recordKey, checked) {
    const recordMapKey = getRecordMapKey(kind);
    const selectedKey = getSelectedKey(kind);
    const current = new Set(state[recordMapKey][apiName] || []);
    if (checked) {
      current.add(recordKey);
    } else {
      current.delete(recordKey);
    }

    state[recordMapKey] = {
      ...(state[recordMapKey] || {}),
      [apiName]: Array.from(current).sort()
    };

    if (current.size > 0) {
      if (!state[selectedKey].includes(apiName)) {
        state[selectedKey] = [...state[selectedKey], apiName].sort();
      }
    } else {
      state[selectedKey] = state[selectedKey].filter((value) => value !== apiName);
    }
  }

  function setAllExpanded(kind, expanded) {
    const key = kind === 'settings' ? 'expandedSettings' : 'expandedMetadata';
    const nextExpanded = { ...(state[key] || {}) };
    for (const item of getExpandableItems(kind)) {
      nextExpanded[item.apiName] = expanded;
    }
    state[key] = nextExpanded;
  }

  function selectAllVisibleTypes(kind) {
    const items = getVisibleItems(kind);
    const selectedKey = getSelectedKey(kind);
    const recordMapKey = getRecordMapKey(kind);
    const currentSelected = new Set(state[selectedKey] || []);
    const nextRecordMap = { ...(state[recordMapKey] || {}) };

    for (const item of items) {
      if (item.errorMessage) {
        continue;
      }
      const recordKeys = (item.records || []).map((record) => record.key);
      nextRecordMap[item.apiName] = recordKeys;
      if (recordKeys.length > 0) {
        currentSelected.add(item.apiName);
      }
    }

    state[recordMapKey] = nextRecordMap;
    state[selectedKey] = Array.from(currentSelected).sort();
  }

  function selectAllVisibleRecords(kind) {
    selectAllVisibleTypes(kind);
    setAllExpanded(kind, true);
  }

  function getSelectedMigrationKind() {
    return (state.migrationKinds || []).find((item) => item.id === state.selectedMigrationKind) || null;
  }

  function isInventorySupportedKind() {
    return ['customSettings', 'customMetadata', 'credentials', 'settingsMetadata'].includes(state.selectedMigrationKind);
  }

  function showsSettingsCard() {
    return migrationKindIncludesSettings();
  }

  function showsMetadataCard() {
    return migrationKindIncludesMetadata();
  }

  function showsCredentialsCard() {
    return migrationKindIncludesCredentials();
  }

  function updateSelectOptions() {
    const renderOptions = (select, selectedValue) => {
      const options = ['<option value="">Select an org</option>']
        .concat(
          state.orgs.map((org) => {
            const selected = org.alias === selectedValue ? ' selected' : '';
            const tags = [
              org.isSandbox ? 'sandbox' : 'production or developer',
              org.isDefaultUsername ? 'default' : null
            ]
              .filter(Boolean)
              .join(' | ');
            return `<option value="${escapeHtml(org.alias)}"${selected}>${escapeHtml(org.alias)} - ${escapeHtml(
              org.username
            )}${tags ? ` (${escapeHtml(tags)})` : ''}</option>`;
          })
        )
        .join('');

      select.innerHTML = options;
    };

    renderOptions(elements.sourceOrgSelect, state.sourceOrg);
    renderOptions(elements.targetOrgSelect, state.targetOrg);
  }

  function renderMigrationKindOptions() {
    const options = (state.migrationKinds || [])
      .map((kind) => {
        const selected = kind.id === state.selectedMigrationKind ? ' selected' : '';
        const suffix = kind.status === 'planned' ? ' (Coming Soon)' : '';
        return `<option value="${escapeHtml(kind.id)}"${selected}>${escapeHtml(kind.label + suffix)}</option>`;
      })
      .join('');

    elements.migrationKindSelect.innerHTML =
      options || '<option value="settingsMetadata">Settings, Custom Metadata, And Credentials</option>';
  }

  function summarizeInventory(items, selected) {
    const selectedSet = new Set(selected);
    const totalRecords = items.reduce((sum, item) => sum + (item.count || 0), 0);
    const selectedCount = items.filter((item) => selectedSet.has(item.apiName)).length;
    return `${items.length} types | ${totalRecords} records | ${selectedCount} selected`;
  }

  function summarizeCredentials(items, selected) {
    const selectedSet = new Set(selected);
    const selectedCount = items.filter((item) => selectedSet.has(item.apiName)).length;
    return `${items.length} components | ${selectedCount} selected`;
  }

  function renderChecklist(container, items, selectedValues, selectedRecordsMap, filterText, kind, copyOptions, expandedMap) {
    const selected = new Set(selectedValues);
    const filtered = items
      .map((item) => ({ item, match: componentMatchesFilter(item, filterText) }))
      .filter((entry) => entry.match.visible);

    if (!filtered.length) {
      container.innerHTML = '<div class="empty-state">No components match the current filter.</div>';
      return;
    }

    container.innerHTML = filtered
      .map(({ item, match }) => {
        const selectedRecords = new Set(selectedRecordsMap[item.apiName] || []);
        const visibleRecords = match.records || [];
        const allRecordKeys = (item.records || []).map((record) => record.key);
        const selectedCount = selectedRecords.size;
        const allSelected = allRecordKeys.length > 0 && selectedCount === allRecordKeys.length;
        const partial = selectedCount > 0 && !allSelected;
        const checked = allSelected ? 'checked' : '';
        const copyEnabled = copyOptions && copyOptions[item.apiName] !== false;
        const errorLine = item.errorMessage ? `<div class="checklist-item-meta">Count error: ${escapeHtml(item.errorMessage)}</div>` : '';
        const expanded = expandedMap[item.apiName] ? 'true' : 'false';
        const childRows = visibleRecords
          .map((record) => {
            const childChecked = selectedRecords.has(record.key) ? 'checked' : '';
            return `
              <label class="tree-record">
                <input
                  type="checkbox"
                  data-record-kind="${kind}"
                  data-api-name="${escapeHtml(item.apiName)}"
                  data-record-key="${escapeHtml(record.key)}"
                  ${childChecked}
                  ${item.errorMessage ? 'disabled' : ''}
                />
                <div class="tree-record-main">
                  <div class="tree-record-title">${escapeHtml(record.label)}</div>
                  <div class="checklist-item-meta">${escapeHtml(record.subtitle || record.key)}</div>
                </div>
              </label>
            `;
          })
          .join('');
        return `
          <div class="tree-node">
            <div class="checklist-item">
              <button
                type="button"
                class="tree-toggle ${visibleRecords.length ? '' : 'hidden'}"
                data-toggle-kind="${kind}"
                data-api-name="${escapeHtml(item.apiName)}"
                aria-expanded="${expanded}"
                title="${expanded === 'true' ? 'Collapse records' : 'Expand records'}"
              >
                ${expanded === 'true' ? '▾' : '▸'}
              </button>
              <input
                type="checkbox"
                data-kind="${kind}"
                data-api-name="${escapeHtml(item.apiName)}"
                ${checked}
                data-indeterminate="${partial ? 'true' : 'false'}"
                ${item.errorMessage || allRecordKeys.length === 0 ? 'disabled' : ''}
              />
              <div class="checklist-item-main">
                <div class="checklist-item-title">${escapeHtml(item.label || item.apiName)}</div>
                <div class="checklist-item-meta">${escapeHtml(item.apiName)}${
                  item.namespacePrefix ? ` | namespace ${escapeHtml(item.namespacePrefix)}` : ''
                }</div>
                <div class="checklist-item-controls">
                  <label class="inline-toggle">
                    <input
                      type="checkbox"
                      data-copy-kind="${kind}"
                      data-api-name="${escapeHtml(item.apiName)}"
                      ${copyEnabled ? 'checked' : ''}
                      ${item.errorMessage ? 'disabled' : ''}
                    />
                    <span>Copy values</span>
                  </label>
                  <span class="checklist-item-meta">${selectedCount} of ${item.count || 0} records selected</span>
                </div>
                ${errorLine}
              </div>
              <div class="count-badge">${escapeHtml(item.count ?? '-')}</div>
            </div>
            <div class="tree-children ${expanded === 'true' ? '' : 'hidden'}">
              ${childRows || '<div class="empty-state compact">No records available for this component.</div>'}
            </div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('input[data-indeterminate="true"]').forEach((input) => {
      input.indeterminate = true;
    });
  }

  function renderCredentialsChecklist(container, items, selectedValues, filterText) {
    const selected = new Set(selectedValues || []);
    const term = String(filterText || '').trim().toLowerCase();
    const filtered = (items || []).filter((item) => {
      if (!term) {
        return true;
      }
      return (
        String(item.label || '').toLowerCase().includes(term) ||
        String(item.fullName || '').toLowerCase().includes(term) ||
        String(item.metadataType || '').toLowerCase().includes(term) ||
        String(item.namespacePrefix || '').toLowerCase().includes(term)
      );
    });

    if (!filtered.length) {
      container.innerHTML = '<div class="empty-state">No credentials match the current filter.</div>';
      return;
    }

    container.innerHTML = filtered
      .map((item) => {
        const checked = selected.has(item.apiName) ? 'checked' : '';
        const metaParts = [item.metadataType || '', item.fullName || item.apiName];
        if (item.namespacePrefix) {
          metaParts.push(`namespace ${item.namespacePrefix}`);
        }
        if (item.manageableState) {
          metaParts.push(item.manageableState);
        }
        return `
          <label class="checklist-item">
            <input
              type="checkbox"
              data-kind="credentials"
              data-api-name="${escapeHtml(item.apiName)}"
              ${checked}
              ${item.errorMessage ? 'disabled' : ''}
            />
            <div class="checklist-item-main">
              <div class="checklist-item-title">${escapeHtml(item.label || item.fullName || item.apiName)}</div>
              <div class="checklist-item-meta">${escapeHtml(metaParts.filter(Boolean).join(' | '))}</div>
              ${
                item.lastModifiedDate
                  ? `<div class="checklist-item-meta">Last modified: ${escapeHtml(item.lastModifiedDate)}</div>`
                  : ''
              }
              ${item.errorMessage ? `<div class="checklist-item-meta">Load error: ${escapeHtml(item.errorMessage)}</div>` : ''}
            </div>
            <div class="count-badge">${escapeHtml(item.metadataType === 'ExternalCredential' ? 'EXT' : 'NAMED')}</div>
          </label>
        `;
      })
      .join('');
  }

  function renderActiveRun() {
    const run = state.activeRun;
    if (!run) {
      elements.runStatus.textContent = 'No active run';
      elements.activeRunContainer.className = 'active-run empty-state';
      elements.activeRunContainer.textContent = 'Start a run to see live progress, metrics, and logs here.';
      return;
    }

    elements.runStatus.textContent = `${run.status.toUpperCase()} | ${run.runLabel}`;
    const showSettingsSection = getRunSelectedTypeCount(run, 'settings') > 0;
    const showMetadataSection = getRunSelectedTypeCount(run, 'metadata') > 0;
    const showCredentialsSection = getRunSelectedCredentialCount(run) > 0;
    const selectedSettingsRecords = getRunSelectedRecordCount(run, 'settings');
    const selectedMetadataRecords = getRunSelectedRecordCount(run, 'metadata');
    const selectedCredentialComponents = getRunSelectedCredentialCount(run);
    const currentEnd = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
    const currentStart = run.startedAt ? new Date(run.startedAt).getTime() : currentEnd;
    const durationMs = Math.max(currentEnd - currentStart, 0);
    const totalProcessedRecords =
      (run.metrics?.customSettings?.processedRecords || 0) + (run.metrics?.customMetadata?.comparedRecords || 0);
    const averagePerRecordMs = totalProcessedRecords > 0 ? durationMs / totalProcessedRecords : 0;

    const stageDefinitions = (run.stages || []).filter((stage) => {
      if (stage.id === 'settings') {
        return showSettingsSection;
      }
      if (stage.id === 'metadata') {
        return showMetadataSection;
      }
      if (stage.id === 'credentials') {
        return showCredentialsSection;
      }
      return true;
    });

    const stagesHtml = stageDefinitions
      .map(
        (stage) => {
          let countsLine = '';
          if (stage.id === 'settings') {
            countsLine = `${run.metrics.customSettings.processedRecords || 0} / ${selectedSettingsRecords} records processed`;
          } else if (stage.id === 'metadata') {
            countsLine = `${run.metrics.customMetadata.comparedRecords || 0} / ${selectedMetadataRecords} records processed`;
          } else if (stage.id === 'credentials') {
            countsLine = `${run.metrics.credentials.itemsCompleted || 0} / ${selectedCredentialComponents} components processed`;
          }

          return `
          <article class="stage-card">
            <h4>${escapeHtml(stage.label)}</h4>
            <div class="status-pill">${escapeHtml(stage.status)}</div>
            <div class="progress-bar" style="margin-top:10px;"><div class="progress-fill" style="width:${stage.progress || 0}%"></div></div>
            <p class="help-text">${escapeHtml(stage.detail || '')}</p>
            ${countsLine ? `<p class="help-text">${escapeHtml(countsLine)}</p>` : ''}
          </article>
        `;
        }
      )
      .join('');

    const metricsCards = [
      `
      <article class="metric-card">
        <h4>Run Details</h4>
        <div class="metric-list">
          <div>Total selected objects: ${escapeHtml(
            getRunSelectedTypeCount(run, 'settings') + getRunSelectedTypeCount(run, 'metadata') + selectedCredentialComponents
          )}</div>
          <div>New types created: ${escapeHtml((run.metrics?.customSettings?.createdTypes || 0) + (run.metrics?.customMetadata?.createdTypes || 0))}</div>
          <div>Total selected records: ${escapeHtml(selectedSettingsRecords + selectedMetadataRecords)}</div>
          <div>Credential components selected: ${escapeHtml(selectedCredentialComponents)}</div>
          <div>Total processed records: ${escapeHtml(totalProcessedRecords)}</div>
          <div>Total duration: ${escapeHtml(formatDuration(durationMs))}</div>
          <div>Average per record: ${escapeHtml(formatAverageDuration(averagePerRecordMs))}</div>
        </div>
      </article>
      `
    ];

    if (showSettingsSection) {
      metricsCards.push(`
      <article class="metric-card">
        <h4>Custom Settings</h4>
        <div class="metric-list">
          <div>Selected types: ${escapeHtml(getRunSelectedTypeCount(run, 'settings'))}</div>
          <div>Created types: ${escapeHtml(run.metrics.customSettings.createdTypes)}</div>
          <div>Total selected records: ${escapeHtml(selectedSettingsRecords)}</div>
          <div>Source records: ${escapeHtml(run.metrics.customSettings.sourceRecords)}</div>
          <div>Processed: ${escapeHtml(`${run.metrics.customSettings.processedRecords} / ${selectedSettingsRecords}`)}</div>
          <div>Created: ${escapeHtml(run.metrics.customSettings.createdRecords)}</div>
          <div>Updated: ${escapeHtml(run.metrics.customSettings.updatedRecords)}</div>
          <div>Skipped: ${escapeHtml(run.metrics.customSettings.skippedRecords)}</div>
          <div>Unsupported: ${escapeHtml(run.metrics.customSettings.unsupportedRecords)}</div>
          <div>Errors: ${escapeHtml(run.metrics.customSettings.errorRecords)}</div>
        </div>
      </article>`);
    }

    if (showMetadataSection) {
      metricsCards.push(`
      <article class="metric-card">
        <h4>Custom Metadata</h4>
        <div class="metric-list">
          <div>Selected types: ${escapeHtml(getRunSelectedTypeCount(run, 'metadata'))}</div>
          <div>Created types: ${escapeHtml(run.metrics.customMetadata.createdTypes)}</div>
          <div>Total selected records: ${escapeHtml(selectedMetadataRecords)}</div>
          <div>Source records: ${escapeHtml(run.metrics.customMetadata.sourceRecords)}</div>
          <div>Compared: ${escapeHtml(`${run.metrics.customMetadata.comparedRecords} / ${selectedMetadataRecords}`)}</div>
          <div>Queued: ${escapeHtml(run.metrics.customMetadata.queuedRecords)}</div>
          <div>Skipped: ${escapeHtml(run.metrics.customMetadata.skippedRecords)}</div>
          <div>Errors: ${escapeHtml(run.metrics.customMetadata.errorRecords)}</div>
          <div>Generated Apex files: ${escapeHtml(run.metrics.customMetadata.generatedFiles)}</div>
          <div>Executed Apex files: ${escapeHtml(run.metrics.customMetadata.executedFiles)}</div>
        </div>
      </article>`);
    }

    if (showCredentialsSection) {
      metricsCards.push(`
      <article class="metric-card">
        <h4>Credentials</h4>
        <div class="metric-list">
          <div>Selected components: ${escapeHtml(selectedCredentialComponents)}</div>
          <div>Retrieved: ${escapeHtml(run.metrics.credentials.retrievedItems)}</div>
          <div>Deployed: ${escapeHtml(run.metrics.credentials.deployedItems)}</div>
          <div>Skipped: ${escapeHtml(run.metrics.credentials.skippedItems)}</div>
          <div>Errors: ${escapeHtml(run.metrics.credentials.errorItems)}</div>
        </div>
      </article>`);
    }

    const metricsHtml = metricsCards.join('');

    elements.activeRunContainer.className = 'active-run';
    elements.activeRunContainer.innerHTML = `
      <div class="run-stage-grid">${stagesHtml}</div>
      <div class="metric-grid">${metricsHtml}</div>
      <div class="history-actions">
        <button class="button secondary" data-run-action="open-summary" data-run-id="${escapeHtml(run.runId)}">Open Summary</button>
        <button class="button secondary" data-run-action="open-folder" data-run-id="${escapeHtml(run.runId)}">Open Folder</button>
        ${
          run.reportFiles?.csvReportsFolder
            ? `<button class="button ghost" data-run-action="open-csv-reports" data-run-id="${escapeHtml(run.runId)}">Open CSV Reports</button>`
            : ''
        }
        ${
          (run.operation || 'migrate') === 'migrate' && ['failed', 'cancelled'].includes(run.status)
            ? `<button class="button ghost" data-run-action="resume-run" data-run-id="${escapeHtml(run.runId)}">Resume Run</button>`
            : ''
        }
      </div>
      <div class="log-view">${escapeHtml((run.logsTail || []).join('\n') || 'No logs yet.')}</div>
    `;
  }

  function renderRunHistory() {
    const runs = state.runHistory || [];
    elements.historyStatus.textContent = runs.length ? `${runs.length} runs available` : 'No reports loaded';

    if (!runs.length) {
      elements.runHistory.className = 'run-history empty-state';
      elements.runHistory.textContent = 'No run history yet.';
      return;
    }

    elements.runHistory.className = 'run-history run-history-grid';
    elements.runHistory.innerHTML = runs
      .map(
        (run) => `
          <article class="history-card">
            <h4>${escapeHtml(run.runLabel || `${run.sourceOrg} -> ${run.targetOrg}`)}</h4>
            <div class="help-text">Operation: ${escapeHtml((run.operation || 'migrate').toUpperCase())} | Status: ${escapeHtml(run.status)} | Started: ${escapeHtml(run.startedAt)}</div>
            <div class="help-text">Settings processed: ${escapeHtml(
              run.metrics?.customSettings?.processedRecords || 0
            )} | Metadata queued: ${escapeHtml(run.metrics?.customMetadata?.queuedRecords || 0)} | Credentials deployed: ${escapeHtml(
              run.metrics?.credentials?.deployedItems || 0
            )}</div>
            <div class="history-actions">
              <button class="button secondary small" data-run-action="open-summary" data-run-id="${escapeHtml(run.runId)}">Open Summary</button>
              <button class="button ghost small" data-run-action="open-folder" data-run-id="${escapeHtml(run.runId)}">Open Folder</button>
              ${
                run.reportFiles?.csvReportsFolder
                  ? `<button class="button ghost small" data-run-action="open-csv-reports" data-run-id="${escapeHtml(run.runId)}">Open CSV Reports</button>`
                  : ''
              }
              ${
                (run.operation || 'migrate') === 'migrate' && ['failed', 'cancelled'].includes(run.status)
                  ? `<button class="button ghost small" data-run-action="resume-run" data-run-id="${escapeHtml(run.runId)}">Resume Run</button>`
                  : ''
              }
              ${
                (run.operation || 'migrate') === 'migrate'
                  ? `<button class="button danger small" data-run-action="revert-run" data-run-id="${escapeHtml(run.runId)}">Revert Run</button>`
                  : ''
              }
            </div>
          </article>
        `
      )
      .join('');
  }

  function render() {
    const activeTab = state.activeTab === 'readme' ? 'readme' : 'workspace';
    elements.workspaceTabButton.classList.toggle('is-active', activeTab === 'workspace');
    elements.readmeTabButton.classList.toggle('is-active', activeTab === 'readme');
    elements.workspaceView.classList.toggle('hidden', activeTab !== 'workspace');
    elements.readmeView.classList.toggle('hidden', activeTab !== 'readme');
    elements.readmeContent.classList.toggle('empty-state', !String(state.readmeContent || '').trim());
    elements.readmeContent.classList.toggle('compact', !String(state.readmeContent || '').trim());
    elements.readmeContent.innerHTML = renderMarkdown(state.readmeContent);

    updateSelectOptions();
    renderMigrationKindOptions();

    const selectedMigrationKind = getSelectedMigrationKind();

    elements.orgStatusText.textContent = state.orgsLoading ? 'Loading authenticated orgs' : `${state.orgs.length} orgs available`;
    elements.orgStatusSpinner.classList.toggle('hidden', !state.orgsLoading);

    elements.orgMeta.textContent =
      state.sourceOrg && state.targetOrg
        ? `Current selection: ${state.sourceOrg} -> ${state.targetOrg}`
        : 'Choose both a source org and a target org to continue.';

    const riskyOrgs = getRiskyOrgSelection();
    if (riskyOrgs.length > 0) {
      elements.orgWarning.classList.remove('hidden');
      elements.orgWarning.textContent =
        `Caution: ${riskyOrgs.map((org) => org.alias).join(', ')} ` +
        `${riskyOrgs.length === 1 ? 'looks' : 'look'} like production. Review source and target carefully before continuing.`;
    } else {
      elements.orgWarning.classList.add('hidden');
      elements.orgWarning.textContent = '';
    }

    elements.inventoryStatus.textContent = state.inventoryLoading
      ? 'Loading inventory'
      : state.inventory
        ? `Inventory loaded for ${state.inventory.sourceOrg}`
        : 'Inventory not loaded';

    elements.migrationKindHelp.textContent = selectedMigrationKind
      ? selectedMigrationKind.description
      : 'Select a migration type to load the matching inventory.';

    const projectJsonFilter = getProjectJsonFilter();
    const selectedKindLabel = selectedMigrationKind?.label || 'the selected migration type';
    if (projectJsonFilter.enabled) {
      const settingsCount = (projectJsonFilter.customSettings || []).length;
      const metadataCount = (projectJsonFilter.customMetadata || []).length;
      const credentialCount = (projectJsonFilter.credentials || []).length;
      const sourceLabel = projectJsonFilter.sourceType === 'folder' ? 'Folder' : 'JSON';
      elements.projectJsonStatus.textContent =
        `${sourceLabel} selected: ${projectJsonFilter.fileName || 'selected'}. ` +
        `Filter names found: ${settingsCount} custom settings, ${metadataCount} custom metadata types, ${credentialCount} credentials.`;
    } else {
      let objectTypeLabel = 'custom settings, custom metadata types, and credentials';
      if (state.selectedMigrationKind === 'customSettings') {
        objectTypeLabel = 'custom settings';
      } else if (state.selectedMigrationKind === 'customMetadata') {
        objectTypeLabel = 'custom metadata types';
      } else if (state.selectedMigrationKind === 'credentials') {
        objectTypeLabel = 'named credentials and external credentials';
      }
      elements.projectJsonStatus.textContent =
        `Select the project root directory to scan your repository and load only project-related ${objectTypeLabel}.`;
    }

    const inventoryProgress = state.inventoryProgress;
    if (state.inventoryLoading && inventoryProgress) {
      elements.inventoryProgress.classList.remove('hidden');
      const percent = inventoryProgress.total ? Math.round((inventoryProgress.done / inventoryProgress.total) * 100) : 0;
      elements.inventoryProgressBar.style.width = `${percent}%`;
      elements.inventoryProgressText.textContent = `${inventoryProgress.done} of ${inventoryProgress.total} counted | ${
        inventoryProgress.label || ''
      }`;
    } else {
      elements.inventoryProgress.classList.add('hidden');
      elements.inventoryProgressBar.style.width = '0%';
      elements.inventoryProgressText.textContent = '';
    }

    const settings = state.inventory ? state.inventory.customSettings : [];
    const metadata = state.inventory ? state.inventory.customMetadata : [];
    const credentials = state.inventory ? state.inventory.credentials || [] : [];
    elements.settingsSummary.textContent = state.inventory
      ? `${summarizeInventory(settings, state.selectedSettings)} | ${totalSelectedRecordCount('settings')} records selected`
      : 'No inventory loaded yet.';
    elements.metadataSummary.textContent = state.inventory
      ? `${summarizeInventory(metadata, state.selectedMetadata)} | ${totalSelectedRecordCount('metadata')} records selected`
      : 'No inventory loaded yet.';
    elements.credentialsSummary.textContent = state.inventory
      ? summarizeCredentials(credentials, state.selectedCredentials)
      : 'No inventory loaded yet.';

    renderChecklist(
      elements.settingsList,
      settings,
      state.selectedSettings,
      state.settingsSelectedRecords,
      state.settingsFilter,
      'settings',
      state.settingsCopyOptions,
      state.expandedSettings
    );
    renderChecklist(
      elements.metadataList,
      metadata,
      state.selectedMetadata,
      state.metadataSelectedRecords,
      state.metadataFilter,
      'metadata',
      state.metadataCopyOptions,
      state.expandedMetadata
    );
    renderCredentialsChecklist(elements.credentialsList, credentials, state.selectedCredentials, state.credentialsFilter);

    const inventorySupported = isInventorySupportedKind();
    const showSettings = showsSettingsCard();
    const showMetadata = showsMetadataCard();
    const showCredentials = showsCredentialsCard();

    if (state.inventory && inventorySupported) {
      const selectedSettingsTypes = state.selectedSettings.length;
      const selectedMetadataTypes = state.selectedMetadata.length;
      const selectedCredentialTypes = state.selectedCredentials.length;
      const selectedSettingsRecords = totalSelectedRecordCount('settings');
      const selectedMetadataRecords = totalSelectedRecordCount('metadata');

      elements.selectionOverview.classList.remove('hidden');
      elements.selectionOverview.innerHTML = `
        <div class="summary-chip">Mode: ${escapeHtml(selectedMigrationKind?.label || 'Unknown')}</div>
        <div class="summary-chip">Settings types selected: ${escapeHtml(selectedSettingsTypes)}</div>
        <div class="summary-chip">Metadata types selected: ${escapeHtml(selectedMetadataTypes)}</div>
        <div class="summary-chip">Credential components selected: ${escapeHtml(selectedCredentialTypes)}</div>
        <div class="summary-chip">Settings records selected: ${escapeHtml(selectedSettingsRecords)}</div>
        <div class="summary-chip">Metadata records selected: ${escapeHtml(selectedMetadataRecords)}</div>
        <div class="summary-chip">Work items to copy: ${escapeHtml(
          totalRunnableRecordCount('settings') + totalRunnableRecordCount('metadata') + selectedCredentialTypes
        )}</div>
        ${
          ['json', 'folder'].includes(state.inventory.projectSelectionMode)
            ? `<div class="summary-chip">Project filter: ${escapeHtml(state.inventory.jsonFilterFileName || 'selected')}</div>`
            : ''
        }
      `;
    } else {
      elements.selectionOverview.classList.add('hidden');
      elements.selectionOverview.innerHTML = '';
    }

    const useActiveRunProgress = Boolean(state.activeRun);
    const totalObjects = useActiveRunProgress ? getActiveRunSelectionObjectCount() : getCurrentSelectionObjectCount();
    const totalRecords = useActiveRunProgress ? getActiveRunSelectionRecordCount() : getCurrentSelectionRecordCount();
    const processedObjects = useActiveRunProgress
      ? (state.activeRun.metrics?.customSettings?.typesCompleted || 0) +
        (state.activeRun.metrics?.customMetadata?.typesCompleted || 0) +
        (state.activeRun.metrics?.credentials?.itemsCompleted || 0)
      : 0;
    const processedRecords = useActiveRunProgress
      ? (state.activeRun.metrics?.customSettings?.processedRecords || 0) + (state.activeRun.metrics?.customMetadata?.comparedRecords || 0)
      : 0;

    if (state.inventory && inventorySupported) {
      elements.migrationSelectionProgress.classList.remove('hidden');
      elements.migrationSelectionProgress.innerHTML = [
        renderSelectionProgressCard('Objects', processedObjects, totalObjects),
        renderSelectionProgressCard('Records', processedRecords, totalRecords)
      ].join('');
    } else {
      elements.migrationSelectionProgress.classList.add('hidden');
      elements.migrationSelectionProgress.innerHTML = '';
    }

    if (state.inventory && inventorySupported) {
      elements.inventorySelectionArea.classList.remove('hidden');
      elements.inventoryModeNotice.classList.add('hidden');
      elements.inventoryModeNotice.textContent = '';
    } else if (!inventorySupported) {
      elements.inventorySelectionArea.classList.add('hidden');
      elements.inventoryModeNotice.classList.remove('hidden');
      elements.inventoryModeNotice.textContent =
        `${selectedMigrationKind ? selectedMigrationKind.label : 'This migration type'} is planned for a future release. ` +
        'This workspace currently supports settings, custom metadata, and credential migration.';
    } else {
      elements.inventorySelectionArea.classList.add('hidden');
      elements.inventoryModeNotice.classList.remove('hidden');
      elements.inventoryModeNotice.textContent =
        'Load inventory successfully to display custom settings, custom metadata, and credential selectors.';
    }

    elements.settingsCard.classList.toggle('hidden', !showSettings);
    elements.metadataCard.classList.toggle('hidden', !showMetadata);
    elements.credentialsCard.classList.toggle('hidden', !showCredentials);

    renderActiveRun();
    renderRunHistory();

    const selectedWithValueCopy =
      totalRunnableRecordCount('settings') + totalRunnableRecordCount('metadata') + state.selectedCredentials.length;

    const runBusy = state.activeRun && state.activeRun.status === 'running';
    elements.refreshOrgsButton.disabled = state.orgsLoading || state.inventoryLoading || runBusy;
    elements.chooseProjectJsonButton.disabled = state.inventoryLoading || runBusy;
    elements.clearProjectJsonButton.disabled = !projectJsonFilter.enabled || state.inventoryLoading || runBusy;
    elements.swapOrgsButton.disabled = state.inventoryLoading || runBusy || (!state.sourceOrg && !state.targetOrg);
    elements.loadInventoryButton.disabled = !state.sourceOrg || state.inventoryLoading || runBusy || !inventorySupported;
    elements.cancelInventoryButton.classList.toggle('hidden', !state.inventoryLoading);
    elements.cancelInventoryButton.disabled = !state.inventoryLoading || runBusy;
    elements.startRunButton.disabled =
      runBusy ||
      !inventorySupported ||
      !state.sourceOrg ||
      !state.targetOrg ||
      state.sourceOrg === state.targetOrg ||
      selectedWithValueCopy === 0;
    elements.cancelRunButton.disabled = !runBusy;

    persist();
  }

  function updateStateFromHost(payload) {
    state.orgs = payload.orgs || [];
    state.orgsLoading = Boolean(payload.orgsLoading);
    state.inventory = payload.inventory || null;
    state.inventoryLoading = Boolean(payload.inventoryLoading);
    state.inventoryProgress = payload.inventoryProgress || null;
    state.activeRun = payload.activeRun || null;
    state.runHistory = payload.runHistory || [];
    state.migrationKinds = payload.migrationKinds || [];
    state.selectedMigrationKind = payload.selectedMigrationKind || 'settingsMetadata';
    state.projectJsonFilter = payload.projectJsonFilter || null;
    state.lastError = payload.lastError || '';
    state.readmeContent = payload.readmeContent || '';

    if (!state.sourceOrg && payload.suggestedSourceOrg) {
      state.sourceOrg = payload.suggestedSourceOrg;
    }
    if (!state.targetOrg && payload.suggestedTargetOrg) {
      state.targetOrg = payload.suggestedTargetOrg;
    }

    ensureSelectionForInventory();
    applyInventoryAutoSelectionIfNeeded();
    render();
  }

  function setCopyOption(kind, apiName, checked) {
    const key = kind === 'settings' ? 'settingsCopyOptions' : 'metadataCopyOptions';
    state[key] = {
      ...(state[key] || {}),
      [apiName]: checked
    };
    render();
  }

  function selectNonZero(kind) {
    if (!state.inventory) {
      return;
    }
    const items = getVisibleItems(kind);
    const selectedKey = getSelectedKey(kind);
    const recordMapKey = getRecordMapKey(kind);
    const currentSelected = new Set(state[selectedKey] || []);
    const nextRecordMap = { ...(state[recordMapKey] || {}) };
    for (const item of items) {
      if (item.errorMessage || Number(item.count || 0) <= 0) {
        continue;
      }
      nextRecordMap[item.apiName] = (item.records || []).map((record) => record.key);
      if (nextRecordMap[item.apiName].length > 0) {
        currentSelected.add(item.apiName);
      }
    }
    state[selectedKey] = Array.from(currentSelected).sort();
    state[recordMapKey] = nextRecordMap;
    render();
  }

  function getVisibleCredentials() {
    const items = state.inventory?.credentials || [];
    const term = String(state.credentialsFilter || '').trim().toLowerCase();
    if (!term) {
      return items;
    }
    return items.filter((item) => {
      return (
        String(item.label || '').toLowerCase().includes(term) ||
        String(item.fullName || '').toLowerCase().includes(term) ||
        String(item.metadataType || '').toLowerCase().includes(term) ||
        String(item.namespacePrefix || '').toLowerCase().includes(term)
      );
    });
  }

  function setCredentialSelection(apiName, checked) {
    const next = new Set(state.selectedCredentials || []);
    if (checked) {
      next.add(apiName);
    } else {
      next.delete(apiName);
    }
    state.selectedCredentials = Array.from(next).sort();
    render();
  }

  function selectAllVisibleCredentials() {
    const next = new Set(state.selectedCredentials || []);
    for (const item of getVisibleCredentials()) {
      if (!item.errorMessage) {
        next.add(item.apiName);
      }
    }
    state.selectedCredentials = Array.from(next).sort();
    render();
  }

  elements.refreshOrgsButton.addEventListener('click', () => post({ type: 'refreshOrgs' }));
  elements.workspaceTabButton.addEventListener('click', () => {
    state.activeTab = 'workspace';
    render();
  });
  elements.readmeTabButton.addEventListener('click', () => {
    state.activeTab = 'readme';
    render();
  });
  elements.developerLinkButton.addEventListener('click', () => post({ type: 'openDeveloperProfile' }));
  elements.chooseProjectJsonButton.addEventListener('click', () => post({ type: 'chooseProjectJson' }));
  elements.clearProjectJsonButton.addEventListener('click', () => post({ type: 'clearProjectJson' }));
  elements.loadInventoryButton.addEventListener('click', () =>
    post({ type: 'loadInventory', sourceOrg: state.sourceOrg, migrationKind: state.selectedMigrationKind })
  );
  elements.cancelInventoryButton.addEventListener('click', () => post({ type: 'cancelInventory' }));

  elements.migrationKindSelect.addEventListener('change', (event) => {
    state.selectedMigrationKind = event.target.value;
    resetInventoryState();
    post({ type: 'setMigrationKind', migrationKind: state.selectedMigrationKind });
    render();
  });

  elements.sourceOrgSelect.addEventListener('change', (event) => {
    state.sourceOrg = event.target.value;
    resetInventoryState();
    render();
  });

  elements.targetOrgSelect.addEventListener('change', (event) => {
    state.targetOrg = event.target.value;
    resetInventoryState();
    render();
  });

  elements.swapOrgsButton.addEventListener('click', () => {
    const currentSource = state.sourceOrg;
    state.sourceOrg = state.targetOrg;
    state.targetOrg = currentSource;
    resetInventoryState();
    render();
  });

  elements.settingsFilter.addEventListener('input', (event) => {
    state.settingsFilter = event.target.value;
    render();
  });

  elements.metadataFilter.addEventListener('input', (event) => {
    state.metadataFilter = event.target.value;
    render();
  });

  elements.credentialsFilter.addEventListener('input', (event) => {
    state.credentialsFilter = event.target.value;
    render();
  });

  elements.settingsList.addEventListener('change', (event) => {
    const target = event.target;
    if (target && target.matches('input[type="checkbox"][data-kind="settings"]')) {
      setParentSelection('settings', target.dataset.apiName, target.checked);
      render();
    } else if (target && target.matches('input[type="checkbox"][data-record-kind="settings"]')) {
      setChildSelection('settings', target.dataset.apiName, target.dataset.recordKey, target.checked);
      render();
    } else if (target && target.matches('input[type="checkbox"][data-copy-kind="settings"]')) {
      setCopyOption('settings', target.dataset.apiName, target.checked);
    }
  });

  elements.metadataList.addEventListener('change', (event) => {
    const target = event.target;
    if (target && target.matches('input[type="checkbox"][data-kind="metadata"]')) {
      setParentSelection('metadata', target.dataset.apiName, target.checked);
      render();
    } else if (target && target.matches('input[type="checkbox"][data-record-kind="metadata"]')) {
      setChildSelection('metadata', target.dataset.apiName, target.dataset.recordKey, target.checked);
      render();
    } else if (target && target.matches('input[type="checkbox"][data-copy-kind="metadata"]')) {
      setCopyOption('metadata', target.dataset.apiName, target.checked);
    }
  });

  elements.credentialsList.addEventListener('change', (event) => {
    const target = event.target;
    if (target && target.matches('input[type="checkbox"][data-kind="credentials"]')) {
      setCredentialSelection(target.dataset.apiName, target.checked);
    }
  });

  document.body.addEventListener('click', (event) => {
    const toolbarAction = event.target.closest('[data-action]');
    if (toolbarAction) {
      event.preventDefault();
      const action = toolbarAction.dataset.action;
      if (action === 'select-nonzero-settings') {
        selectNonZero('settings');
      } else if (action === 'expand-settings') {
        setAllExpanded('settings', true);
        render();
      } else if (action === 'collapse-settings') {
        setAllExpanded('settings', false);
        render();
      } else if (action === 'select-all-types-settings') {
        selectAllVisibleTypes('settings');
        render();
      } else if (action === 'select-all-records-settings') {
        selectAllVisibleRecords('settings');
        render();
      } else if (action === 'clear-settings') {
        state.selectedSettings = [];
        state.settingsSelectedRecords = {};
        render();
      } else if (action === 'select-nonzero-metadata') {
        selectNonZero('metadata');
      } else if (action === 'expand-metadata') {
        setAllExpanded('metadata', true);
        render();
      } else if (action === 'collapse-metadata') {
        setAllExpanded('metadata', false);
        render();
      } else if (action === 'select-all-types-metadata') {
        selectAllVisibleTypes('metadata');
        render();
      } else if (action === 'select-all-records-metadata') {
        selectAllVisibleRecords('metadata');
        render();
      } else if (action === 'clear-metadata') {
        state.selectedMetadata = [];
        state.metadataSelectedRecords = {};
        render();
      } else if (action === 'select-all-credentials') {
        selectAllVisibleCredentials();
      } else if (action === 'clear-credentials') {
        state.selectedCredentials = [];
        render();
      }
      return;
    }

    const treeToggle = event.target.closest('[data-toggle-kind]');
    if (treeToggle) {
      event.preventDefault();
      const kind = treeToggle.dataset.toggleKind;
      const apiName = treeToggle.dataset.apiName;
      const key = kind === 'settings' ? 'expandedSettings' : 'expandedMetadata';
      state[key] = {
        ...(state[key] || {}),
        [apiName]: !state[key][apiName]
      };
      render();
      return;
    }

    const runAction = event.target.closest('[data-run-action]');
    if (runAction) {
      const actionType =
        runAction.dataset.runAction === 'open-summary'
          ? 'openRunSummary'
          : runAction.dataset.runAction === 'open-folder'
            ? 'openRunFolder'
            : runAction.dataset.runAction === 'open-csv-reports'
              ? 'openRunCsvReports'
              : runAction.dataset.runAction === 'resume-run'
                ? 'resumeRun'
                : 'revertRun';
      post({
        type: actionType,
        runId: runAction.dataset.runId
      });
      return;
    }

    const externalLink = event.target.closest('[data-external-link]');
    if (externalLink) {
      event.preventDefault();
      post({
        type: 'openExternalLink',
        url: externalLink.dataset.externalLink
      });
    }
  });

  elements.startRunButton.addEventListener('click', () => {
    const inventory = state.inventory || { customSettings: [], customMetadata: [], credentials: [] };
    const selectedCustomSettings = inventory.customSettings
      .filter((item) => state.selectedSettings.includes(item.apiName))
      .map((item) => ({
        ...item,
        selectedRecords: state.settingsSelectedRecords[item.apiName] || [],
        copyRecords: state.settingsCopyOptions[item.apiName] !== false
      }));
    const selectedCustomMetadata = inventory.customMetadata
      .filter((item) => state.selectedMetadata.includes(item.apiName))
      .map((item) => ({
        ...item,
        selectedRecords: state.metadataSelectedRecords[item.apiName] || [],
        copyRecords: state.metadataCopyOptions[item.apiName] !== false
      }));
    const selectedCredentials = (inventory.credentials || []).filter((item) => state.selectedCredentials.includes(item.apiName));

    post({
      type: 'startRun',
      migrationKind: state.selectedMigrationKind,
      sourceOrg: state.sourceOrg,
      targetOrg: state.targetOrg,
      selectedCustomSettings,
      selectedCustomMetadata,
      selectedCredentials
    });
  });

  elements.cancelRunButton.addEventListener('click', () => post({ type: 'cancelRun' }));

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'state') {
      updateStateFromHost(message.payload || {});
    }
  });

  render();
  post({ type: 'ready' });
})();
