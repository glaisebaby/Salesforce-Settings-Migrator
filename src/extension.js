const fsp = require('fs/promises');
const path = require('path');
const vscode = require('vscode');

const { createCliRunner } = require('./salesforceCli');
const { listRunHistory, revertMigrationRun, runMigration } = require('./migrationEngine');
const { getWebviewHtml } = require('./webviewHtml');

const NON_PROD_HINTS = ['dev', 'uat', 'qa', 'test', 'sit', 'stage', 'staging', 'sandbox', 'demo', 'trial', 'train'];
const PROJECT_EXCLUDE_GLOB = '**/{node_modules,.git,.sf,.sfdx}/**';
const INVENTORY_SUPPORTED_KINDS = ['customSettings', 'customMetadata', 'credentials', 'settingsMetadata'];

const MIGRATION_KINDS = [
  {
    id: 'customSettings',
    label: 'Custom Settings Only',
    description: 'Load and migrate only custom settings to reduce inventory and execution load.',
    status: 'available'
  },
  {
    id: 'customMetadata',
    label: 'Custom Metadata Only',
    description: 'Load and migrate only custom metadata records to reduce inventory and execution load.',
    status: 'available'
  },
  {
    id: 'credentials',
    label: 'Credentials Only',
    description: 'Load and deploy named credentials and external credentials between authenticated orgs.',
    status: 'available'
  },
  {
    id: 'settingsMetadata',
    label: 'Settings, Custom Metadata, And Credentials',
    description: 'Migrate custom settings, custom metadata records, and credential metadata between authenticated orgs.',
    status: 'available'
  },
  {
    id: 'objectMetadata',
    label: 'Object Metadata',
    description: 'Planned for future releases: objects, fields, layouts, and related metadata migration.',
    status: 'planned'
  },
  {
    id: 'picklistValues',
    label: 'Picklist Values',
    description: 'Planned for future releases: migrate and compare picklist value sets.',
    status: 'planned'
  },
  {
    id: 'staticResources',
    label: 'Static Resources',
    description: 'Planned for future releases: migrate static resource files and bundles.',
    status: 'planned'
  }
];

function migrationKindIncludesSettings(migrationKind) {
  return ['customSettings', 'settingsMetadata'].includes(migrationKind);
}

function migrationKindIncludesMetadata(migrationKind) {
  return ['customMetadata', 'settingsMetadata'].includes(migrationKind);
}

function migrationKindIncludesCredentials(migrationKind) {
  return ['credentials', 'settingsMetadata'].includes(migrationKind);
}

function toCredentialSelectionKey(metadataType, fullName) {
  return `${metadataType}:${fullName}`;
}

function parseCredentialSelectionKey(value) {
  const [metadataType, ...rest] = String(value || '').split(':');
  return {
    metadataType,
    fullName: rest.join(':')
  };
}

function getSettingsIdentityFields(fieldDefinitions) {
  const names = new Set((fieldDefinitions || []).map((field) => field.QualifiedApiName).filter(Boolean));
  const fields = [];
  if (names.has('Name')) {
    fields.push('Name');
  }
  if (names.has('SetupOwnerId')) {
    fields.push('SetupOwnerId');
  }
  return fields;
}

function getMetadataIdentityFields(fieldDefinitions) {
  const names = new Set((fieldDefinitions || []).map((field) => field.QualifiedApiName).filter(Boolean));
  const fields = [];
  if (names.has('DeveloperName')) {
    fields.push('DeveloperName');
  }
  if (names.has('MasterLabel')) {
    fields.push('MasterLabel');
  }
  return fields;
}

function toSettingsRecordDescriptor(record, identityFields) {
  if (identityFields.includes('SetupOwnerId')) {
    const name = record.Name || '<org-level>';
    const ownerId = record.SetupOwnerId || '<blank>';
    return {
      key: `Name:${String(record.Name || '')}|SetupOwnerId:${String(record.SetupOwnerId || '')}`,
      label: name,
      subtitle: `SetupOwnerId: ${ownerId}`
    };
  }

  return {
    key: `Name:${String(record.Name || '')}`,
    label: record.Name || '<unnamed>',
    subtitle: 'List custom setting record'
  };
}

function toMetadataRecordDescriptor(record) {
  return {
    key: `DeveloperName:${String(record.DeveloperName || '')}`,
    label: record.MasterLabel || record.DeveloperName || '<unnamed>',
    subtitle: record.DeveloperName || ''
  };
}

function toCredentialInventoryItem(metadataType, record) {
  const fullName = record.fullName || record.FullName || '';
  const namespacePrefix = record.namespacePrefix || record.NamespacePrefix || '';
  const manageableState = record.manageableState || record.ManageableState || '';
  const lastModifiedDate = record.lastModifiedDate || record.LastModifiedDate || '';

  return {
    apiName: toCredentialSelectionKey(metadataType, fullName),
    fullName,
    label: fullName,
    metadataType,
    namespacePrefix,
    manageableState,
    lastModifiedDate,
    count: 1,
    errorMessage: ''
  };
}

function findOrgByAlias(orgs, alias) {
  return (orgs || []).find((org) => org.alias === alias) || null;
}

async function confirmRiskyOrgs(orgs, aliases, actionLabel) {
  const riskyOrgs = aliases
    .map((alias) => findOrgByAlias(orgs, alias))
    .filter((org) => org && org.looksLikeProduction);

  if (riskyOrgs.length === 0) {
    return true;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `One or more selected orgs look like production: ${riskyOrgs.map((org) => org.alias).join(', ')}. Continue with ${actionLabel}?`,
    { modal: true },
    'Continue'
  );
  return confirmed === 'Continue';
}

function textHasNonProdHint(value) {
  const normalized = String(value || '').toLowerCase();
  return NON_PROD_HINTS.some((token) => normalized.includes(token));
}

function decorateOrg(org) {
  const searchable = [org.alias, org.username, org.name, org.instanceUrl, org.loginUrl].filter(Boolean);
  const hintsNonProd = searchable.some(textHasNonProdHint);
  const looksLikeProduction = !org.isSandbox && !org.isScratch && !hintsNonProd;

  return {
    ...org,
    environmentLabel: org.isSandbox ? 'Sandbox' : org.isScratch ? 'Scratch Org' : looksLikeProduction ? 'Production-like' : 'Non-sandbox',
    looksLikeProduction,
    riskMessage: looksLikeProduction
      ? 'This org looks like production. Review source and target carefully before loading inventory or starting a run.'
      : ''
  };
}

function scoreProjectPath(fsPath) {
  const normalized = String(fsPath || '').replace(/\//g, '\\').toLowerCase();
  let score = 0;

  if (normalized.includes('\\unpackaged\\main\\default\\objects\\') || normalized.includes('\\force-app\\main\\default\\objects\\')) {
    score += 20;
  }
  if (normalized.includes('\\unpackaged\\main\\default\\custommetadata\\') || normalized.includes('\\force-app\\main\\default\\custommetadata\\')) {
    score += 20;
  }
  if (
    normalized.includes('\\unpackaged\\main\\default\\namedcredentials\\') ||
    normalized.includes('\\force-app\\main\\default\\namedcredentials\\')
  ) {
    score += 20;
  }
  if (
    normalized.includes('\\unpackaged\\main\\default\\externalcredentials\\') ||
    normalized.includes('\\force-app\\main\\default\\externalcredentials\\')
  ) {
    score += 20;
  }
  if (normalized.includes('\\tmp_') || normalized.includes('\\tmp-')) {
    score -= 50;
  }

  return score;
}

function choosePreferredProjectEntry(index, apiName, candidate) {
  const existing = index[apiName];
  if (!existing || candidate.score > existing.score || (candidate.score === existing.score && candidate.fsPath.length < existing.fsPath.length)) {
    index[apiName] = candidate;
  }
}

function stripProjectEntryScore(index) {
  return Object.fromEntries(
    Object.entries(index).map(([apiName, entry]) => {
      const { score, ...rest } = entry;
      return [apiName, rest];
    })
  );
}

async function discoverProjectMetadataIndex() {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  if (!workspaceFolders.length) {
    return {
      workspaceDetected: false,
      customSettings: {},
      customMetadata: {},
      credentials: {}
    };
  }

  const customSettings = {};
  const customMetadata = {};
  const credentials = {};
  const objectFiles = await vscode.workspace.findFiles('**/objects/**/*.object-meta.xml', PROJECT_EXCLUDE_GLOB);
  const recordFiles = await vscode.workspace.findFiles('**/customMetadata/*.md-meta.xml', PROJECT_EXCLUDE_GLOB);
  const namedCredentialFiles = await vscode.workspace.findFiles('**/namedCredentials/*.namedCredential-meta.xml', PROJECT_EXCLUDE_GLOB);
  const externalCredentialFiles = await vscode.workspace.findFiles(
    '**/externalCredentials/*.externalCredential-meta.xml',
    PROJECT_EXCLUDE_GLOB
  );

  for (const uri of objectFiles) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      continue;
    }

    const fsPath = uri.fsPath;
    const apiName = path.basename(fsPath).replace(/\.object-meta\.xml$/i, '');
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    const deployPath = path.dirname(fsPath);
    const content = await fsp.readFile(fsPath, 'utf8');
    const entry = {
      apiName,
      fsPath,
      deployPath,
      workspaceRoot: workspaceFolder.uri.fsPath,
      relativePath,
      matchReason: 'Project object definition',
      deployable: true,
      score: scoreProjectPath(fsPath)
    };

    if (/<customSettingsType>/i.test(content)) {
      choosePreferredProjectEntry(customSettings, apiName, entry);
    }
    if (apiName.endsWith('__mdt')) {
      choosePreferredProjectEntry(customMetadata, apiName, entry);
    }
  }

  for (const uri of recordFiles) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      continue;
    }

    const fsPath = uri.fsPath;
    const baseName = path.basename(fsPath).replace(/\.md-meta\.xml$/i, '');
    const typeBaseName = baseName.split('.')[0];
    const apiName = `${typeBaseName}__mdt`;
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    const existing = customMetadata[apiName];
    const entry = {
      apiName,
      fsPath,
      deployPath: existing?.deployPath || '',
      workspaceRoot: workspaceFolder.uri.fsPath,
      relativePath,
      matchReason: 'Project custom metadata record',
      deployable: Boolean(existing?.deployPath),
      score: scoreProjectPath(fsPath) - 5
    };
    choosePreferredProjectEntry(customMetadata, apiName, entry);
  }

  for (const uri of namedCredentialFiles) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      continue;
    }

    const fsPath = uri.fsPath;
    const fullName = path.basename(fsPath).replace(/\.namedcredential-meta\.xml$/i, '');
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    choosePreferredProjectEntry(credentials, toCredentialSelectionKey('NamedCredential', fullName), {
      apiName: toCredentialSelectionKey('NamedCredential', fullName),
      fsPath,
      deployPath: fsPath,
      workspaceRoot: workspaceFolder.uri.fsPath,
      relativePath,
      matchReason: 'Project named credential',
      deployable: true,
      score: scoreProjectPath(fsPath)
    });
  }

  for (const uri of externalCredentialFiles) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      continue;
    }

    const fsPath = uri.fsPath;
    const fullName = path.basename(fsPath).replace(/\.externalcredential-meta\.xml$/i, '');
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    choosePreferredProjectEntry(credentials, toCredentialSelectionKey('ExternalCredential', fullName), {
      apiName: toCredentialSelectionKey('ExternalCredential', fullName),
      fsPath,
      deployPath: fsPath,
      workspaceRoot: workspaceFolder.uri.fsPath,
      relativePath,
      matchReason: 'Project external credential',
      deployable: true,
      score: scoreProjectPath(fsPath)
    });
  }

  return {
    workspaceDetected: true,
    customSettings: stripProjectEntryScore(customSettings),
    customMetadata: stripProjectEntryScore(customMetadata),
    credentials: stripProjectEntryScore(credentials)
  };
}

function createEmptyProjectJsonFilter() {
  return {
    enabled: false,
    sourceType: 'none',
    filePath: '',
    fileName: '',
    customSettings: [],
    customMetadata: [],
    credentials: [],
    rawMatches: 0,
    errorMessage: ''
  };
}

async function discoverProjectMetadataIndexForPath(rootPath) {
  const customSettings = {};
  const customMetadata = {};
  const credentials = {};
  const excludedNames = new Set(['node_modules', '.git', '.sf', '.sfdx']);

  async function scanFolder(folderPath) {
    const entries = await fsp.readdir(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (excludedNames.has(entry.name)) {
        continue;
      }

      const entryPath = path.join(folderPath, entry.name);
      if (entry.isDirectory()) {
        await scanFolder(entryPath);
        continue;
      }

      if (entry.isFile()) {
        if (/\.object-meta\.xml$/i.test(entry.name)) {
          const apiName = entry.name.replace(/\.object-meta\.xml$/i, '');
          const relativePath = path.relative(rootPath, entryPath);
          const deployPath = path.dirname(entryPath);
          const content = await fsp.readFile(entryPath, 'utf8');
          const entryData = {
            apiName,
            fsPath: entryPath,
            deployPath,
            workspaceRoot: rootPath,
            relativePath,
            matchReason: 'Project object definition',
            deployable: true,
            score: scoreProjectPath(entryPath)
          };

          if (/<customSettingsType>/i.test(content)) {
            choosePreferredProjectEntry(customSettings, apiName, entryData);
          }
          if (apiName.toLowerCase().endsWith('__mdt')) {
            choosePreferredProjectEntry(customMetadata, apiName, entryData);
          }
        } else if (/\.md-meta\.xml$/i.test(entry.name)) {
          const baseName = entry.name.replace(/\.md-meta\.xml$/i, '');
          const typeBaseName = baseName.split('.')[0];
          const apiName = `${typeBaseName}__mdt`;
          const relativePath = path.relative(rootPath, entryPath);
          const deployPath = path.dirname(entryPath);
          const entryData = {
            apiName,
            fsPath: entryPath,
            deployPath,
            workspaceRoot: rootPath,
            relativePath,
            matchReason: 'Project custom metadata record',
            deployable: true,
            score: scoreProjectPath(entryPath) - 5
          };
          choosePreferredProjectEntry(customMetadata, apiName, entryData);
        } else if (/\.namedcredential-meta\.xml$/i.test(entry.name)) {
          const fullName = entry.name.replace(/\.namedcredential-meta\.xml$/i, '');
          choosePreferredProjectEntry(credentials, toCredentialSelectionKey('NamedCredential', fullName), {
            apiName: toCredentialSelectionKey('NamedCredential', fullName),
            fsPath: entryPath,
            deployPath: entryPath,
            workspaceRoot: rootPath,
            relativePath: path.relative(rootPath, entryPath),
            matchReason: 'Project named credential',
            deployable: true,
            score: scoreProjectPath(entryPath)
          });
        } else if (/\.externalcredential-meta\.xml$/i.test(entry.name)) {
          const fullName = entry.name.replace(/\.externalcredential-meta\.xml$/i, '');
          choosePreferredProjectEntry(credentials, toCredentialSelectionKey('ExternalCredential', fullName), {
            apiName: toCredentialSelectionKey('ExternalCredential', fullName),
            fsPath: entryPath,
            deployPath: entryPath,
            workspaceRoot: rootPath,
            relativePath: path.relative(rootPath, entryPath),
            matchReason: 'Project external credential',
            deployable: true,
            score: scoreProjectPath(entryPath)
          });
        }
      }
    }
  }

  await scanFolder(rootPath);
  return {
    customSettings: stripProjectEntryScore(customSettings),
    customMetadata: stripProjectEntryScore(customMetadata),
    credentials: stripProjectEntryScore(credentials)
  };
}

function normalizeMetadataTypeName(value) {
  const trimmed = String(value || '').trim().replace(/\.md-meta\.xml$/i, '');
  if (!trimmed) {
    return '';
  }

  const typeName = trimmed.includes('.') ? trimmed.split('.')[0] : trimmed;
  return typeName.endsWith('__mdt') ? typeName : `${typeName}__mdt`;
}

function normalizeCredentialComponentName(value, explicitType = '') {
  const trimmed = String(value || '').trim().replace(/-meta\.xml$/i, '');
  if (!trimmed) {
    return '';
  }

  const parsed = parseCredentialSelectionKey(trimmed);
  if (parsed.metadataType && parsed.fullName && ['NamedCredential', 'ExternalCredential'].includes(parsed.metadataType)) {
    return toCredentialSelectionKey(parsed.metadataType, parsed.fullName);
  }

  if (/\.namedcredential$/i.test(trimmed)) {
    return toCredentialSelectionKey('NamedCredential', trimmed.replace(/\.namedcredential$/i, ''));
  }
  if (/\.externalcredential$/i.test(trimmed)) {
    return toCredentialSelectionKey('ExternalCredential', trimmed.replace(/\.externalcredential$/i, ''));
  }

  if (explicitType && ['NamedCredential', 'ExternalCredential'].includes(explicitType)) {
    return toCredentialSelectionKey(explicitType, trimmed);
  }

  return '';
}

function collectJsonFilterString(value, keyPath, settings, metadata, credentials, rawMatches) {
  const text = String(value || '');
  const lowerPath = keyPath.join('.').toLowerCase();
  const explicitMetadataContext = /metadata|custommetadata|custom_metadata/.test(lowerPath);
  const explicitSettingsContext = /setting|customsetting|custom_setting/.test(lowerPath);
  const explicitNamedCredentialContext = /namedcredential|named_credentials|namedcredentials/.test(lowerPath);
  const explicitExternalCredentialContext = /externalcredential|external_credentials|externalcredentials/.test(lowerPath);

  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9_]*__(?:c|mdt)\b/g)) {
    const apiName = match[0];
    if (apiName.endsWith('__mdt')) {
      metadata.add(apiName);
    } else {
      settings.add(apiName);
    }
    rawMatches.count += 1;
  }

  for (const match of text.matchAll(/\b(?:NamedCredential|ExternalCredential):[A-Za-z][A-Za-z0-9_]*\b/g)) {
    credentials.add(match[0]);
    rawMatches.count += 1;
  }

  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9_]*(?:__mdt)?\.[A-Za-z][A-Za-z0-9_]*\b/g)) {
    metadata.add(normalizeMetadataTypeName(match[0]));
    rawMatches.count += 1;
  }

  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9_]*\.(?:namedCredential|externalCredential)(?:-meta\.xml)?\b/gi)) {
    const normalized = normalizeCredentialComponentName(match[0]);
    if (normalized) {
      credentials.add(normalized);
      rawMatches.count += 1;
    }
  }

  const tokens = text.split(/[\s,;|\[\]{}"']+/).map((item) => item.trim()).filter(Boolean);
  for (const token of tokens) {
    const cleanToken = token.replace(/\.md-meta\.xml$/i, '');
    if (explicitMetadataContext && /^[A-Za-z][A-Za-z0-9_]*(?:__mdt)?(?:\.[A-Za-z][A-Za-z0-9_]*)?$/.test(cleanToken)) {
      metadata.add(normalizeMetadataTypeName(cleanToken));
      rawMatches.count += 1;
    } else if (explicitSettingsContext && /^[A-Za-z][A-Za-z0-9_]*__c$/.test(cleanToken)) {
      settings.add(cleanToken);
      rawMatches.count += 1;
    } else if (explicitNamedCredentialContext) {
      const normalized = normalizeCredentialComponentName(cleanToken, 'NamedCredential');
      if (normalized) {
        credentials.add(normalized);
        rawMatches.count += 1;
      }
    } else if (explicitExternalCredentialContext) {
      const normalized = normalizeCredentialComponentName(cleanToken, 'ExternalCredential');
      if (normalized) {
        credentials.add(normalized);
        rawMatches.count += 1;
      }
    }
  }
}

function extractProjectJsonFilter(jsonValue, filePath) {
  const settings = new Set();
  const metadata = new Set();
  const credentials = new Set();
  const rawMatches = { count: 0 };

  const visit = (value, keyPath = []) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, keyPath.concat(String(index))));
      return;
    }

    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, entry]) => visit(entry, keyPath.concat(key)));
      return;
    }

    if (typeof value === 'string') {
      collectJsonFilterString(value, keyPath, settings, metadata, credentials, rawMatches);
    }
  };

  visit(jsonValue);

  return {
    enabled: true,
    sourceType: 'json',
    filePath,
    fileName: path.basename(filePath),
    customSettings: Array.from(settings).sort(),
    customMetadata: Array.from(metadata).sort(),
    credentials: Array.from(credentials).sort(),
    rawMatches: rawMatches.count,
    errorMessage: ''
  };
}

async function extractProjectFolderFilter(folderPath) {
  const projectIndex = await discoverProjectMetadataIndexForPath(folderPath);
  const customSettings = Object.keys(projectIndex.customSettings).sort();
  const customMetadata = Object.keys(projectIndex.customMetadata).sort();
  const credentials = Object.keys(projectIndex.credentials || {}).sort();

  return {
    enabled: true,
    sourceType: 'folder',
    filePath: folderPath,
    fileName: path.basename(folderPath),
    customSettings,
    customMetadata,
    credentials,
    rawMatches: 0,
    errorMessage: ''
  };
}

async function readJsonFileIfExists(filePath, fallback = []) {
  if (!filePath) {
    return fallback;
  }
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return fallback;
  }
}

function isCompletedMigrationRowStatus(status) {
  return ['created', 'updated', 'skipped'].includes(String(status || '').toLowerCase());
}

function shouldResumeComponent(component, reportEntries) {
  if (!component || !component.apiName) {
    return false;
  }

  const reportEntry = (reportEntries || []).find((entry) => entry.apiName === component.apiName);
  if (!reportEntry) {
    return true;
  }
  if (reportEntry.status === 'empty') {
    return false;
  }

  const rows = Array.isArray(reportEntry.rows) ? reportEntry.rows : [];
  if (!rows.length) {
    return true;
  }

  return !rows.every((row) => isCompletedMigrationRowStatus(row.status));
}

class SfSettingsMigratorController {
  constructor(context, panel) {
    this.context = context;
    this.panel = panel;
    this.cli = createCliRunner({ cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd() });
    this.runsRoot = path.join(context.globalStorageUri.fsPath, 'runs');
    this.state = {
      orgs: [],
      orgsLoading: false,
      inventory: null,
      inventoryLoading: false,
      inventoryProgress: null,
      activeRun: null,
      runHistory: [],
      migrationKinds: MIGRATION_KINDS,
      selectedMigrationKind: 'settingsMetadata',
      projectJsonFilter: createEmptyProjectJsonFilter(),
      readmeContent: '',
      lastError: '',
      suggestedSourceOrg: '',
      suggestedTargetOrg: ''
    };
    this.projectMetadataIndex = {
      workspaceDetected: false,
      customSettings: {},
      customMetadata: {},
      credentials: {}
    };
    this.inventoryCancellation = { cancelled: false, child: null };
    this.runCancellation = { cancelled: false, child: null };
    this.disposed = false;
  }

  async initialize() {
    console.log('[Salesforce Settings Migrator] Initializing webview controller');
    this.panel.webview.html = getWebviewHtml(this.panel.webview, this.context.extensionUri);
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.inventoryCancellation.cancelled = true;
      this.runCancellation.cancelled = true;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      try {
        await this.handleMessage(message);
      } catch (error) {
        console.error('[Salesforce Settings Migrator] Webview message handling failed', error);
        this.state.lastError = error.message;
        void vscode.window.showErrorMessage(error.message);
        this.postState();
      }
    });

    await this.refreshRunHistory();
    await this.loadReadme();
    await this.refreshOrgs();
  }

  postState() {
    if (this.disposed) {
      return;
    }
    this.panel.webview.postMessage({
      type: 'state',
      payload: this.state
    });
  }

  async handleMessage(message) {
    switch (message.type) {
      case 'ready':
        this.postState();
        return;
      case 'refreshOrgs':
        await this.refreshOrgs();
        return;
      case 'openDeveloperProfile':
        await vscode.env.openExternal(vscode.Uri.parse('https://www.linkedin.com/in/glaisebaby'));
        return;
      case 'openExternalLink':
        if (message.url) {
          await vscode.env.openExternal(vscode.Uri.parse(String(message.url)));
        }
        return;
      case 'loadInventory':
        await this.loadInventory(message.sourceOrg, message.migrationKind);
        return;
      case 'setMigrationKind':
        this.setMigrationKind(message.migrationKind);
        return;
      case 'chooseProjectJson':
        await this.chooseProjectJson();
        return;
      case 'clearProjectJson':
        this.clearProjectJson();
        return;
      case 'cancelInventory':
        this.cancelInventory();
        return;
      case 'startRun':
        await this.startRun(message);
        return;
      case 'cancelRun':
        this.cancelRun();
        return;
      case 'openRunSummary':
        await this.openRunSummary(message.runId);
        return;
      case 'openRunFolder':
        await this.openRunFolder(message.runId);
        return;
      case 'openRunCsvReports':
        await this.openRunCsvReports(message.runId);
        return;
      case 'revertRun':
        await this.revertRun(message.runId);
        return;
      case 'resumeRun':
        await this.resumeRun(message.runId);
        return;
      default:
        return;
    }
  }

  async loadReadme() {
    try {
      const readmePath = path.join(this.context.extensionPath, 'README.md');
      this.state.readmeContent = await fsp.readFile(readmePath, 'utf8');
    } catch (error) {
      console.warn('[Salesforce Settings Migrator] README could not be loaded', error);
      this.state.readmeContent = '# README unavailable\n\nThe local README could not be loaded.';
    }
  }

  async refreshOrgs() {
    console.log('[Salesforce Settings Migrator] Refreshing authenticated orgs');
    this.state.orgsLoading = true;
    this.state.lastError = '';
    this.postState();

    try {
      const orgs = (await this.cli.listOrgs()).map(decorateOrg);
      this.state.orgs = orgs;
      console.log(`[Salesforce Settings Migrator] Loaded ${orgs.length} authenticated org(s)`);
      this.state.suggestedSourceOrg = orgs.find((org) => org.isSandbox)?.alias || orgs[0]?.alias || '';
      this.state.suggestedTargetOrg =
        orgs.find((org) => org.alias !== this.state.suggestedSourceOrg && org.isSandbox)?.alias ||
        orgs.find((org) => org.alias !== this.state.suggestedSourceOrg)?.alias ||
        '';
    } finally {
      this.state.orgsLoading = false;
      this.postState();
    }
  }

  async refreshRunHistory() {
    this.state.runHistory = await listRunHistory(this.runsRoot);
    this.postState();
  }

  async chooseProjectJson() {
    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const selectedUris = (await vscode.window.showOpenDialog({
      title: 'Choose project folder or JSON filter file',
      defaultUri,
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      filters: {
        'JSON files': ['json'],
        'All files': ['*']
      }
    })) || [];
    const selectedUri = selectedUris[0];

    if (!selectedUri) {
      return;
    }

    const stats = await fsp.stat(selectedUri.fsPath);
    let filter;

    if (stats.isDirectory()) {
      filter = await extractProjectFolderFilter(selectedUri.fsPath);
    } else {
      const fileContent = await fsp.readFile(selectedUri.fsPath, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(fileContent);
      } catch (error) {
        throw new Error(`Could not parse selected JSON file: ${error.message}`);
      }
      filter = extractProjectJsonFilter(parsed, selectedUri.fsPath);
    }

    if (filter.customSettings.length === 0 && filter.customMetadata.length === 0 && filter.credentials.length === 0) {
      void vscode.window.showWarningMessage(
        'The selected project path did not contain custom setting, custom metadata, or credential component names. Inventory will not be filtered by this selection.'
      );
    }

    this.state.projectJsonFilter = filter;
    this.state.inventory = null;
    this.state.inventoryProgress = null;
    this.state.lastError = '';
    this.postState();
  }

  clearProjectJson() {
    this.state.projectJsonFilter = createEmptyProjectJsonFilter();
    this.state.inventory = null;
    this.state.inventoryProgress = null;
    this.state.lastError = '';
    this.postState();
  }

  async loadRecordInventory(kind, sourceOrg, apiName, options) {
    const fieldDefinitions = await this.cli.getFieldDefinitions(sourceOrg, apiName, options);

    if (kind === 'customSettings') {
      const identityFields = getSettingsIdentityFields(fieldDefinitions);
      if (!identityFields.length) {
        return [];
      }

      const records = await this.cli.queryAllRecords(sourceOrg, apiName, identityFields, options);
      return records
        .map((record) => toSettingsRecordDescriptor(record, identityFields))
        .sort((left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
    }

    const identityFields = getMetadataIdentityFields(fieldDefinitions);
    if (!identityFields.length) {
      return [];
    }

    const records = await this.cli.queryAllRecords(sourceOrg, apiName, identityFields, options);
    return records
      .map((record) => toMetadataRecordDescriptor(record))
      .sort((left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
  }

  setMigrationKind(migrationKind) {
    const selected = MIGRATION_KINDS.find((item) => item.id === migrationKind);
    this.state.selectedMigrationKind = selected ? selected.id : 'settingsMetadata';
    this.state.inventory = null;
    this.state.inventoryProgress = null;
    this.state.lastError = '';
    this.postState();
  }

  async loadInventory(sourceOrg, migrationKind) {
    console.log(`[Salesforce Settings Migrator] Loading inventory for source org ${sourceOrg}`);
    if (!sourceOrg) {
      throw new Error('Please choose a source org before loading inventory.');
    }
    const selectedMigrationKind = migrationKind || this.state.selectedMigrationKind;
    if (!INVENTORY_SUPPORTED_KINDS.includes(selectedMigrationKind)) {
      throw new Error('Inventory loading is not available for the selected migration type yet.');
    }
    if (!(await confirmRiskyOrgs(this.state.orgs, [sourceOrg], 'inventory loading'))) {
      throw new Error('Inventory loading was cancelled because the production-style org selection was not confirmed.');
    }

    this.inventoryCancellation = { cancelled: false, child: null };
    this.state.inventoryLoading = true;
    this.state.inventory = null;
    this.state.inventoryProgress = { done: 0, total: 0, label: 'Loading entity definitions' };
    this.state.lastError = '';
    this.postState();

    const onStart = (child) => {
      this.inventoryCancellation.child = child;
    };
    const isCancelled = () => this.inventoryCancellation.cancelled;

    try {
      this.projectMetadataIndex = await discoverProjectMetadataIndex();
      let customSettings = [];
      let customMetadata = [];
      let credentials = [];

      const inventoryTasks = [];
      if (migrationKindIncludesSettings(selectedMigrationKind)) {
        inventoryTasks.push(
          this.cli.getCustomSettings(sourceOrg, { isCancelled, onStart }).then((items) => {
            customSettings = items;
          })
        );
      }
      if (migrationKindIncludesMetadata(selectedMigrationKind)) {
        inventoryTasks.push(
          this.cli.getCustomMetadataTypes(sourceOrg, { isCancelled, onStart }).then((items) => {
            customMetadata = items;
          })
        );
      }
      if (migrationKindIncludesCredentials(selectedMigrationKind)) {
        inventoryTasks.push(
          Promise.all([
            this.cli.listMetadata(sourceOrg, 'NamedCredential', { isCancelled, onStart }),
            this.cli.listMetadata(sourceOrg, 'ExternalCredential', { isCancelled, onStart })
          ]).then(([namedCredentials, externalCredentials]) => {
            credentials = [
              ...namedCredentials.map((item) => toCredentialInventoryItem('NamedCredential', item)),
              ...externalCredentials.map((item) => toCredentialInventoryItem('ExternalCredential', item))
            ];
          })
        );
      }

      await Promise.all(inventoryTasks);

      const projectJsonFilter = this.state.projectJsonFilter || createEmptyProjectJsonFilter();
      const jsonSettingsAllowlist = new Set(projectJsonFilter.customSettings || []);
      const jsonMetadataAllowlist = new Set(projectJsonFilter.customMetadata || []);
      const jsonCredentialAllowlist = new Set(projectJsonFilter.credentials || []);
      const hasJsonAllowlist =
        Boolean(projectJsonFilter.enabled) &&
        (jsonSettingsAllowlist.size > 0 || jsonMetadataAllowlist.size > 0 || jsonCredentialAllowlist.size > 0);

      let typedItems = [
        ...customSettings.map((item) => ({ kind: 'customSettings', ...item })),
        ...customMetadata.map((item) => ({ kind: 'customMetadata', ...item })),
        ...credentials.map((item) => ({ kind: 'credentials', ...item }))
      ];

      if (hasJsonAllowlist) {
        typedItems = typedItems.filter((item) => {
          if (item.kind === 'customSettings') {
            return jsonSettingsAllowlist.has(item.QualifiedApiName);
          }
          if (item.kind === 'customMetadata') {
            return jsonMetadataAllowlist.has(item.QualifiedApiName);
          }
          return jsonCredentialAllowlist.has(item.apiName);
        });
      }

      this.state.inventoryProgress = {
        done: 0,
        total: typedItems.length,
        label: 'Loading source inventory'
      };
      this.postState();

      const countedSettings = [];
      const countedMetadata = [];
      const countedCredentials = [];

      for (let index = 0; index < typedItems.length; index += 1) {
        if (isCancelled()) {
          throw new Error('Inventory loading cancelled.');
        }

        const item = typedItems[index];
        const shaped =
          item.kind === 'credentials'
            ? {
                apiName: item.apiName,
                fullName: item.fullName,
                label: item.label || item.fullName || item.apiName,
                metadataType: item.metadataType,
                namespacePrefix: item.namespacePrefix || '',
                manageableState: item.manageableState || '',
                lastModifiedDate: item.lastModifiedDate || '',
                count: 1,
                records: [],
                errorMessage: ''
              }
            : {
                apiName: item.QualifiedApiName,
                label: item.Label || item.QualifiedApiName,
                namespacePrefix: item.NamespacePrefix || '',
                count: 0,
                records: [],
                errorMessage: ''
              };

        const projectEntry =
          item.kind === 'customSettings'
            ? this.projectMetadataIndex.customSettings[shaped.apiName]
            : item.kind === 'customMetadata'
              ? this.projectMetadataIndex.customMetadata[shaped.apiName]
              : this.projectMetadataIndex.credentials[shaped.apiName];
        if (projectEntry) {
          shaped.projectMatched = true;
          shaped.projectMatchReason = projectEntry.matchReason;
          shaped.projectDeployPath = projectEntry.deployPath || '';
          shaped.projectWorkspaceRoot = projectEntry.workspaceRoot || '';
          shaped.projectRelativePath = projectEntry.relativePath || '';
        } else {
          shaped.projectMatched = false;
          shaped.projectMatchReason = '';
          shaped.projectDeployPath = '';
          shaped.projectWorkspaceRoot = '';
          shaped.projectRelativePath = '';
        }

        shaped.projectJsonMatched =
          hasJsonAllowlist &&
          (item.kind === 'customSettings'
            ? jsonSettingsAllowlist.has(shaped.apiName)
            : item.kind === 'customMetadata'
              ? jsonMetadataAllowlist.has(shaped.apiName)
              : jsonCredentialAllowlist.has(shaped.apiName));

        if (item.kind !== 'credentials') {
          try {
            shaped.records = await this.loadRecordInventory(item.kind, sourceOrg, shaped.apiName, { isCancelled, onStart });
            shaped.count = shaped.records.length;
          } catch (error) {
            shaped.errorMessage = error.message;
          }
        }

        if (item.kind === 'customSettings') {
          countedSettings.push(shaped);
        } else if (item.kind === 'customMetadata') {
          countedMetadata.push(shaped);
        } else {
          countedCredentials.push(shaped);
        }

        this.state.inventoryProgress = {
          done: index + 1,
          total: typedItems.length,
          label: shaped.apiName
        };
        this.postState();
      }

      const byCountThenName = (left, right) => {
        const countDiff = Number(right.count || 0) - Number(left.count || 0);
        return countDiff !== 0 ? countDiff : left.apiName.localeCompare(right.apiName);
      };
      const byCredentialTypeThenName = (left, right) => {
        const typeDiff = String(left.metadataType || '').localeCompare(String(right.metadataType || ''));
        return typeDiff !== 0 ? typeDiff : left.apiName.localeCompare(right.apiName);
      };

      this.state.inventory = {
        sourceOrg,
        migrationKind: selectedMigrationKind,
        loadedAt: new Date().toISOString(),
        projectSelectionMode: hasJsonAllowlist ? projectJsonFilter.sourceType : 'none',
        jsonFilterEnabled: hasJsonAllowlist,
        jsonFilterFileName: projectJsonFilter.fileName || '',
        jsonFilterSettingsCount: jsonSettingsAllowlist.size,
        jsonFilterMetadataCount: jsonMetadataAllowlist.size,
        jsonFilterCredentialCount: jsonCredentialAllowlist.size,
        jsonMatchedSettingsCount: countedSettings.filter((item) => item.projectJsonMatched).length,
        jsonMatchedMetadataCount: countedMetadata.filter((item) => item.projectJsonMatched).length,
        jsonMatchedCredentialCount: countedCredentials.filter((item) => item.projectJsonMatched).length,
        projectMatchedSettingsCount: countedSettings.filter((item) => item.projectMatched).length,
        projectMatchedMetadataCount: countedMetadata.filter((item) => item.projectMatched).length,
        projectMatchedCredentialCount: countedCredentials.filter((item) => item.projectMatched).length,
        customSettings: countedSettings.sort(byCountThenName),
        customMetadata: countedMetadata.sort(byCountThenName),
        credentials: countedCredentials.sort(byCredentialTypeThenName)
      };
      console.log(
        `[Salesforce Settings Migrator] Inventory loaded: ${this.state.inventory.customSettings.length} custom settings, ` +
          `${this.state.inventory.customMetadata.length} custom metadata types, ` +
          `${this.state.inventory.credentials.length} credential components`
      );
    } finally {
      this.state.inventoryLoading = false;
      this.state.inventoryProgress = null;
      this.postState();
    }
  }

  cancelInventory() {
    this.inventoryCancellation.cancelled = true;
    if (this.inventoryCancellation.child) {
      try {
        this.inventoryCancellation.child.kill();
      } catch (error) {
        // Best effort cancellation.
      }
    }
  }

  cancelRun() {
    this.runCancellation.cancelled = true;
    if (this.runCancellation.child) {
      try {
        this.runCancellation.child.kill();
      } catch (error) {
        // Best effort cancellation.
      }
    }
  }

  async startRun(message) {
    const selectedSettingsRecordCount = (message.selectedCustomSettings || []).reduce(
      (sum, item) => sum + ((item.copyRecords !== false ? item.selectedRecords : []) || []).length,
      0
    );
    const selectedMetadataRecordCount = (message.selectedCustomMetadata || []).reduce(
      (sum, item) => sum + ((item.copyRecords !== false ? item.selectedRecords : []) || []).length,
      0
    );
    const selectedCredentialCount = (message.selectedCredentials || []).length;
    console.log(
      `[Salesforce Settings Migrator] Starting run from ${message.sourceOrg} to ${message.targetOrg} with ` +
        `${selectedSettingsRecordCount} selected custom setting record(s), ` +
        `${selectedMetadataRecordCount} selected custom metadata record(s), and ` +
        `${selectedCredentialCount} selected credential component(s)`
    );
    if (!message.sourceOrg || !message.targetOrg) {
      throw new Error('Please select both a source org and a target org.');
    }
    if (!INVENTORY_SUPPORTED_KINDS.includes(message.migrationKind || this.state.selectedMigrationKind)) {
      throw new Error('The selected migration type is not available in this version.');
    }
    if (message.sourceOrg === message.targetOrg) {
      throw new Error('Source org and target org must be different.');
    }
    const selectedWithValueCopy = selectedSettingsRecordCount + selectedMetadataRecordCount + selectedCredentialCount;
    if (selectedWithValueCopy === 0) {
      throw new Error('Select at least one setting record, metadata record, or credential component before starting.');
    }
    if (this.state.activeRun && this.state.activeRun.status === 'running') {
      throw new Error('A migration is already running.');
    }

    if (!(await confirmRiskyOrgs(this.state.orgs, [message.sourceOrg, message.targetOrg], 'this migration'))) {
      throw new Error('Migration cancelled before start because the production-style org selection was not confirmed.');
    }

    this.runCancellation = { cancelled: false, child: null };
    this.state.lastError = '';
    this.postState();

    const summary = await runMigration({
      cli: this.cli,
      sourceOrg: message.sourceOrg,
      targetOrg: message.targetOrg,
      selectedCustomSettings: message.selectedCustomSettings,
      selectedCustomMetadata: message.selectedCustomMetadata,
      selectedCredentials: message.selectedCredentials,
      projectMetadataIndex: this.projectMetadataIndex,
      runsRoot: this.runsRoot,
      isCancelled: () => this.runCancellation.cancelled,
      setActiveProcess: (child) => {
        this.runCancellation.child = child;
      },
      onUpdate: (activeRun) => {
        this.state.activeRun = activeRun;
        this.postState();
      }
    });

    await this.refreshRunHistory();
    console.log(`[Salesforce Settings Migrator] Run finished with status ${summary.status}`);

    if (summary.status === 'completed') {
      void vscode.window.showInformationMessage(`Salesforce Settings Migrator run completed: ${summary.runLabel}`);
    } else if (summary.status === 'cancelled') {
      void vscode.window.showWarningMessage(`Salesforce Settings Migrator run cancelled: ${summary.runLabel}`);
    } else {
      void vscode.window.showErrorMessage(`Salesforce Settings Migrator run finished with errors: ${summary.runLabel}`);
    }
  }

  async revertRun(runId) {
    const run = this.getRunById(runId);
    if (!run) {
      throw new Error('Run history entry not found.');
    }
    if ((run.operation || 'migrate') !== 'migrate') {
      throw new Error('Only migration runs can be reverted.');
    }
    if (this.state.activeRun && this.state.activeRun.status === 'running') {
      throw new Error('A migration or revert is already running.');
    }
    if (!(await confirmRiskyOrgs(this.state.orgs, [run.targetOrg], 'this revert'))) {
      throw new Error('Revert cancelled because the production-style org selection was not confirmed.');
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Revert run ${run.runLabel}? This restores previous values for updated records only. Records that were created by the original run will not be deleted.`,
      { modal: true },
      'Revert Run'
    );
    if (confirmed !== 'Revert Run') {
      return;
    }

    this.runCancellation = { cancelled: false, child: null };
    this.state.lastError = '';
    this.postState();

    const summary = await revertMigrationRun({
      cli: this.cli,
      runToRevert: run,
      runsRoot: this.runsRoot,
      isCancelled: () => this.runCancellation.cancelled,
      setActiveProcess: (child) => {
        this.runCancellation.child = child;
      },
      onUpdate: (activeRun) => {
        this.state.activeRun = activeRun;
        this.postState();
      }
    });

    await this.refreshRunHistory();

    if (summary.status === 'completed') {
      void vscode.window.showInformationMessage(`Revert completed: ${summary.runLabel}`);
    } else if (summary.status === 'cancelled') {
      void vscode.window.showWarningMessage(`Revert cancelled: ${summary.runLabel}`);
    } else {
      void vscode.window.showErrorMessage(`Revert finished with errors: ${summary.runLabel}`);
    }
  }

  async resumeRun(runId) {
    const run = this.getRunById(runId);
    if (!run) {
      throw new Error('Run history entry not found.');
    }
    if ((run.operation || 'migrate') !== 'migrate') {
      throw new Error('Only migration runs can be resumed.');
    }
    if (!['failed', 'cancelled'].includes(run.status)) {
      throw new Error('Resume is available only for failed or cancelled migration runs.');
    }
    if (this.state.activeRun && this.state.activeRun.status === 'running') {
      throw new Error('A migration or revert is already running.');
    }
    if (!(await confirmRiskyOrgs(this.state.orgs, [run.sourceOrg, run.targetOrg], 'this resumed migration'))) {
      throw new Error('Resume cancelled before start because the production-style org selection was not confirmed.');
    }

    const settingsReport = await readJsonFileIfExists(run.reportFiles?.settingsReport, []);
    const metadataReport = await readJsonFileIfExists(run.reportFiles?.metadataReport, []);
    const credentialsReport = await readJsonFileIfExists(run.reportFiles?.credentialsReport, []);

    const selectedCustomSettings = (run.selected?.customSettings || []).filter((item) => shouldResumeComponent(item, settingsReport));
    const selectedCustomMetadata = (run.selected?.customMetadata || []).filter((item) => shouldResumeComponent(item, metadataReport));
    const selectedCredentials = (run.selected?.credentials || []).filter((item) => shouldResumeComponent(item, credentialsReport));

    const totalPending =
      selectedCustomSettings.length +
      selectedCustomMetadata.length +
      selectedCredentials.length;
    if (totalPending === 0) {
      void vscode.window.showInformationMessage(`Nothing remains to resume for run ${run.runLabel}.`);
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Resume run ${run.runLabel}? Completed components will be skipped and unfinished components will be retried.`,
      { modal: true },
      'Resume Run'
    );
    if (confirmed !== 'Resume Run') {
      return;
    }

    this.projectMetadataIndex = await discoverProjectMetadataIndex();
    this.runCancellation = { cancelled: false, child: null };
    this.state.lastError = '';
    this.postState();

    const summary = await runMigration({
      cli: this.cli,
      sourceOrg: run.sourceOrg,
      targetOrg: run.targetOrg,
      selectedCustomSettings,
      selectedCustomMetadata,
      selectedCredentials,
      projectMetadataIndex: this.projectMetadataIndex,
      runsRoot: this.runsRoot,
      isCancelled: () => this.runCancellation.cancelled,
      setActiveProcess: (child) => {
        this.runCancellation.child = child;
      },
      onUpdate: (activeRun) => {
        this.state.activeRun = activeRun;
        this.postState();
      }
    });

    await this.refreshRunHistory();

    if (summary.status === 'completed') {
      void vscode.window.showInformationMessage(`Resume completed: ${summary.runLabel}`);
    } else if (summary.status === 'cancelled') {
      void vscode.window.showWarningMessage(`Resume cancelled: ${summary.runLabel}`);
    } else {
      void vscode.window.showErrorMessage(`Resume finished with errors: ${summary.runLabel}`);
    }
  }

  getRunById(runId) {
    return this.state.runHistory.find((run) => run.runId === runId) || null;
  }

  async openRunSummary(runId) {
    const run = this.getRunById(runId) || this.state.activeRun;
    if (!run || !run.reportFiles?.summaryMarkdown) {
      throw new Error('Run summary not found.');
    }
    const uri = vscode.Uri.file(run.reportFiles.summaryMarkdown);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async openRunFolder(runId) {
    const run = this.getRunById(runId) || this.state.activeRun;
    if (!run || !run.folderPath) {
      throw new Error('Run folder not found.');
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(run.folderPath));
  }

  async openRunCsvReports(runId) {
    const run = this.getRunById(runId) || this.state.activeRun;
    const csvReportsFolder = run?.reportFiles?.csvReportsFolder;
    if (!csvReportsFolder) {
      throw new Error('CSV reports folder not found for this run.');
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(csvReportsFolder));
  }
}

class SfSettingsMigratorSidebarProvider {
  constructor(context) {
    this.context = context;
  }

  resolveWebviewView(webviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'assets')]
    };

    const iconUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'icon.png'));
    const nonce = String(Date.now());

    webviewView.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webviewView.webview.cspSource} https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      padding: 14px;
      background:
        radial-gradient(circle at top right, color-mix(in srgb, var(--vscode-button-background) 18%, transparent), transparent 40%),
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 94%, black 6%), var(--vscode-editor-background));
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }
    .card {
      display: grid;
      gap: 14px;
      padding: 16px;
      border-radius: 18px;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
    }
    .eyebrow {
      margin: 0;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--vscode-descriptionForeground);
    }
    .title {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .title img {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      flex: 0 0 auto;
    }
    h2 {
      margin: 0;
      font-size: 16px;
    }
    p {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    button {
      appearance: none;
      border: none;
      border-radius: 999px;
      padding: 8px 12px;
      font: inherit;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button.secondary {
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">
      <img src="${iconUri}" alt="Salesforce Settings Migrator icon" />
      <h2>Salesforce Settings Migrator</h2>
    </div>
    <div class="actions">
      <button id="openButton" type="button">Open Workspace</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('openButton').addEventListener('click', () => {
      vscode.postMessage({ type: 'openWorkspace' });
    });
  </script>
</body>
</html>`;

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'openWorkspace') {
        await vscode.commands.executeCommand('sfSettingsMigrator.open');
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
      }
    });
  }
}

function openPanel(context) {
  console.log('[Salesforce Settings Migrator] Opening panel');
  const existing = openPanel.currentPanel;
  if (existing) {
    existing.reveal(vscode.ViewColumn.One);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'sfSettingsMigrator',
    'Salesforce Settings Migrator',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'assets')]
    }
  );

  const controller = new SfSettingsMigratorController(context, panel);
  openPanel.currentPanel = panel;
  openPanel.currentController = controller;
  panel.onDidDispose(() => {
    openPanel.currentPanel = null;
    openPanel.currentController = null;
  });
  void controller.initialize();
}

function activate(context) {
  console.log('[Salesforce Settings Migrator] activate() called');
  const sidebarProvider = new SfSettingsMigratorSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('sfSettingsMigrator.sidebarView', sidebarProvider),
    vscode.commands.registerCommand('sfSettingsMigrator.open', () => {
      console.log('[Salesforce Settings Migrator] Command received: sfSettingsMigrator.open');
      openPanel(context);
    }),
    vscode.commands.registerCommand('sfSettingsMigrator.openFromSidebar', () => {
      console.log('[Salesforce Settings Migrator] Command received: sfSettingsMigrator.openFromSidebar');
      openPanel(context);
    }),
    vscode.commands.registerCommand('sfSettingsMigrator.refresh', async () => {
      console.log('[Salesforce Settings Migrator] Command received: sfSettingsMigrator.refresh');
      if (openPanel.currentPanel) {
        openPanel.currentPanel.reveal(vscode.ViewColumn.One);
        if (openPanel.currentController) {
          await openPanel.currentController.refreshOrgs();
        }
      } else {
        openPanel(context);
      }
    })
  );
  console.log('[Salesforce Settings Migrator] Commands registered');

  if (context.extensionMode === vscode.ExtensionMode.Development) {
    console.log('[Salesforce Settings Migrator] Development mode detected, auto-opening panel');
    setTimeout(() => {
      try {
        openPanel(context);
      } catch (error) {
        console.error('[Salesforce Settings Migrator] Failed to auto-open panel in development mode', error);
      }
    }, 300);
  }
}

function deactivate() {
  console.log('[Salesforce Settings Migrator] deactivate() called');
}

module.exports = {
  activate,
  deactivate
};
