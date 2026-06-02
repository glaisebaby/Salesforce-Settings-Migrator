const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

class CancellationError extends Error {
  constructor(message = 'Migration cancelled.') {
    super(message);
    this.name = 'CancellationError';
  }
}

function toTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '_' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('');
}

function sanitizeNamePart(value) {
  return String(value || 'org').replace(/[^A-Za-z0-9_-]+/g, '-');
}

function toDisplayValue(value) {
  if (value === null || value === undefined) {
    return '<null>';
  }
  if (Array.isArray(value)) {
    return value.map(toDisplayValue).join('; ');
  }
  return String(value);
}

function toComparableValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return Array.isArray(value) ? value.map(toComparableValue).join(';') : String(value);
}

function convertToApexLiteral(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }

  const text = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');

  return `'${text}'`;
}

function normalizeSelectedComponents(components) {
  return Array.isArray(components)
    ? components.map((item) => (typeof item === 'string' ? { apiName: item } : item)).filter((item) => item && item.apiName)
    : [];
}

function getCustomSettingFields(fieldDefinitions) {
  const excluded = new Set([
    'Id',
    'CreatedById',
    'CreatedDate',
    'IsDeleted',
    'LastModifiedById',
    'LastModifiedDate',
    'RecordVisibilityId',
    'SystemModstamp',
    'UserRecordAccessId'
  ]);

  const base = [];
  const custom = [];

  for (const field of fieldDefinitions || []) {
    const apiName = field.QualifiedApiName;
    if (!apiName || field.IsCalculated || excluded.has(apiName)) {
      continue;
    }
    if (apiName === 'SetupOwnerId' || apiName === 'Name') {
      base.push(apiName);
      continue;
    }
    custom.push(apiName);
  }

  return [...new Set([...base, ...custom.sort((a, b) => a.localeCompare(b))])];
}

function getCustomMetadataFields(fieldDefinitions) {
  const excluded = new Set([
    'Id',
    'Label',
    'Language',
    'ManageableState',
    'MasterLabelNorm',
    'NamespacePrefix',
    'QualifiedApiName',
    'SystemModstamp'
  ]);

  const required = [];
  const custom = [];

  for (const field of fieldDefinitions || []) {
    const apiName = field.QualifiedApiName;
    if (!apiName || field.IsCalculated || excluded.has(apiName)) {
      continue;
    }
    if (apiName === 'DeveloperName' || apiName === 'MasterLabel') {
      required.push(apiName);
      continue;
    }
    custom.push(apiName);
  }

  const orderedRequired = ['DeveloperName', 'MasterLabel'].filter((name) => required.includes(name));
  return [...new Set([...orderedRequired, ...custom.sort((a, b) => a.localeCompare(b))])];
}

function buildCustomSettingSelectionKey(fields, record) {
  if (fields.includes('SetupOwnerId')) {
    return `Name:${String(record.Name || '')}|SetupOwnerId:${String(record.SetupOwnerId || '')}`;
  }
  return `Name:${String(record.Name || '')}`;
}

function buildCustomMetadataSelectionKey(record) {
  return `DeveloperName:${String(record.DeveloperName || '')}`;
}

function buildStages() {
  return [
    { id: 'prepare', label: 'Prepare Run', status: 'pending', progress: 0, detail: '' },
    { id: 'settings', label: 'Custom Settings', status: 'pending', progress: 0, detail: '' },
    { id: 'metadata', label: 'Custom Metadata', status: 'pending', progress: 0, detail: '' },
    { id: 'credentials', label: 'Credentials', status: 'pending', progress: 0, detail: '' },
    { id: 'reporting', label: 'Write Reports', status: 'pending', progress: 0, detail: '' }
  ];
}

function createEmptyMetrics(selectedSettings, selectedMetadata, selectedCredentials) {
  return {
    customSettings: {
      selectedTypes: selectedSettings.length,
      createdTypes: 0,
      typesCompleted: 0,
      sourceRecords: 0,
      processedRecords: 0,
      createdRecords: 0,
      updatedRecords: 0,
      skippedRecords: 0,
      unsupportedRecords: 0,
      errorRecords: 0
    },
    customMetadata: {
      selectedTypes: selectedMetadata.length,
      createdTypes: 0,
      typesCompleted: 0,
      sourceRecords: 0,
      comparedRecords: 0,
      queuedRecords: 0,
      skippedRecords: 0,
      errorRecords: 0,
      generatedFiles: 0,
      executedFiles: 0
    },
    credentials: {
      selectedItems: selectedCredentials.length,
      retrievedItems: 0,
      deployedItems: 0,
      skippedItems: 0,
      errorItems: 0,
      itemsCompleted: 0
    }
  };
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, value, 'utf8');
}

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    return '';
  }
}

async function ensureTemporarySfProject(projectRoot) {
  await ensureDir(path.join(projectRoot, 'force-app'));
  await writeJson(path.join(projectRoot, 'sfdx-project.json'), {
    packageDirectories: [{ path: 'force-app', default: true }],
    namespace: '',
    sfdcLoginUrl: 'https://login.salesforce.com',
    sourceApiVersion: '66.0'
  });
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

async function writeCsv(filePath, rows) {
  await ensureDir(path.dirname(filePath));
  if (!rows.length) {
    await fsp.writeFile(filePath, '', 'utf8');
    return;
  }

  const headers = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row || {}).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );

  const lines = [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header])).join(','))
  ];

  await fsp.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function getUpdatableCustomSettingDiffs(diffs) {
  return (diffs || []).filter((item) => !['Name', 'SetupOwnerId'].includes(item.field));
}

function getBucketName(row) {
  if (row.status === 'created') {
    return 'create';
  }
  if (row.status === 'updated' || row.status === 'restored') {
    return 'update';
  }
  if (row.status === 'error' || row.status === 'failed') {
    return 'error';
  }
  return 'edit';
}

function toBucketCsvRow(summary, componentType, apiName, row, componentStatus, reportedAt, change) {
  return {
    bucket: getBucketName(row),
    operation: summary.operation || 'migrate',
    runId: summary.runId || '',
    sourceOrg: summary.sourceOrg || '',
    targetOrg: summary.targetOrg || '',
    componentType,
    apiName: apiName || '',
    componentStatus: componentStatus || '',
    recordKey: row.recordKey || '',
    action: row.action || '',
    status: row.status || '',
    reason: row.reason || '',
    errorMessage: row.errorMessage || '',
    fieldName: change?.field || '',
    oldValue: change ? change.oldValue : '',
    newValue: change ? change.newValue : '',
    totalChangedFields: Array.isArray(row.changes) ? row.changes.length : 0,
    revertSupported: row.revert && typeof row.revert.supported === 'boolean' ? String(row.revert.supported) : '',
    revertReason: row.revert?.reason || '',
    reportedAt
  };
}

function flattenComponentReportRows(reportEntries, summary, componentType, reportedAt) {
  return (reportEntries || []).flatMap((entry) => {
    const rows = Array.isArray(entry.rows) ? entry.rows : [];
    if (rows.length === 0) {
      return [];
    }

    return rows.flatMap((row) => {
      const changes = Array.isArray(row.changes) ? row.changes : [];
      if (!changes.length) {
        return [toBucketCsvRow(summary, componentType, entry.apiName, row, entry.status, reportedAt, null)];
      }
      return changes.map((change) => toBucketCsvRow(summary, componentType, entry.apiName, row, entry.status, reportedAt, change));
    });
  });
}

function flattenFlatReportRows(rows, summary, componentType, reportedAt) {
  return (rows || []).map((row) => toBucketCsvRow(summary, componentType, row.apiName, row, row.componentStatus || '', reportedAt));
}

function buildBucketCsvFiles(csvReportsFolder, stamp) {
  return {
    csvReportsFolder,
    editCsv: path.join(csvReportsFolder, `report_edit_${stamp}.csv`),
    updateCsv: path.join(csvReportsFolder, `report_update_${stamp}.csv`),
    createCsv: path.join(csvReportsFolder, `report_create_${stamp}.csv`),
    errorCsv: path.join(csvReportsFolder, `report_error_${stamp}.csv`)
  };
}

async function writeBucketedCsvReports(reportFiles, summary, rows, stamp) {
  const csvReportsFolder = reportFiles.csvReportsFolder || path.join(summary.folderPath, 'csv-reports');
  const csvFiles = buildBucketCsvFiles(csvReportsFolder, stamp);
  Object.assign(reportFiles, csvFiles);

  const buckets = {
    edit: rows.filter((row) => row.bucket === 'edit'),
    update: rows.filter((row) => row.bucket === 'update'),
    create: rows.filter((row) => row.bucket === 'create'),
    error: rows.filter((row) => row.bucket === 'error')
  };

  await writeCsv(csvFiles.editCsv, buckets.edit);
  await writeCsv(csvFiles.updateCsv, buckets.update);
  await writeCsv(csvFiles.createCsv, buckets.create);
  await writeCsv(csvFiles.errorCsv, buckets.error);
}

function buildSummaryCsvRows(summary) {
  return [
    { section: 'run', metric: 'operation', value: summary.operation || 'migrate' },
    { section: 'run', metric: 'status', value: summary.status || '' },
    { section: 'run', metric: 'sourceOrg', value: summary.sourceOrg || '' },
    { section: 'run', metric: 'targetOrg', value: summary.targetOrg || '' },
    { section: 'run', metric: 'startedAt', value: summary.startedAt || '' },
    { section: 'run', metric: 'finishedAt', value: summary.finishedAt || '' },
    { section: 'run', metric: 'folderPath', value: summary.folderPath || '' },
    { section: 'run', metric: 'errorMessage', value: summary.errorMessage || '' },
    ...Object.entries(summary.metrics.customSettings || {}).map(([metric, value]) => ({
      section: 'customSettings',
      metric,
      value
    })),
    ...Object.entries(summary.metrics.customMetadata || {}).map(([metric, value]) => ({
      section: 'customMetadata',
      metric,
      value
    })),
    ...Object.entries(summary.metrics.credentials || {}).map(([metric, value]) => ({
      section: 'credentials',
      metric,
      value
    }))
  ];
}

function summaryToMarkdown(summary) {
  const lines = [
    '# Salesforce Settings Migrator Run Summary',
    '',
    `- Status: ${summary.status}`,
    `- Source Org: ${summary.sourceOrg}`,
    `- Target Org: ${summary.targetOrg}`,
    `- Started: ${summary.startedAt}`,
    `- Finished: ${summary.finishedAt || ''}`,
    `- Run Folder: ${summary.folderPath}`,
    '',
    '## Custom Settings',
    '',
    `- Selected Types: ${summary.metrics.customSettings.selectedTypes}`,
    `- Created Types: ${summary.metrics.customSettings.createdTypes}`,
    `- Source Records: ${summary.metrics.customSettings.sourceRecords}`,
    `- Processed Records: ${summary.metrics.customSettings.processedRecords}`,
    `- Created: ${summary.metrics.customSettings.createdRecords}`,
    `- Updated: ${summary.metrics.customSettings.updatedRecords}`,
    `- Skipped: ${summary.metrics.customSettings.skippedRecords}`,
    `- Unsupported: ${summary.metrics.customSettings.unsupportedRecords}`,
    `- Errors: ${summary.metrics.customSettings.errorRecords}`,
    '',
    '## Custom Metadata',
    '',
    `- Selected Types: ${summary.metrics.customMetadata.selectedTypes}`,
    `- Created Types: ${summary.metrics.customMetadata.createdTypes}`,
    `- Source Records: ${summary.metrics.customMetadata.sourceRecords}`,
    `- Compared Records: ${summary.metrics.customMetadata.comparedRecords}`,
    `- Queued Records: ${summary.metrics.customMetadata.queuedRecords}`,
    `- Skipped: ${summary.metrics.customMetadata.skippedRecords}`,
    `- Errors: ${summary.metrics.customMetadata.errorRecords}`,
    `- Generated Apex Files: ${summary.metrics.customMetadata.generatedFiles}`,
    `- Executed Apex Files: ${summary.metrics.customMetadata.executedFiles}`,
    '',
    '## Credentials',
    '',
    `- Selected Components: ${summary.metrics.credentials.selectedItems}`,
    `- Retrieved Components: ${summary.metrics.credentials.retrievedItems}`,
    `- Deployed Components: ${summary.metrics.credentials.deployedItems}`,
    `- Skipped: ${summary.metrics.credentials.skippedItems}`,
    `- Errors: ${summary.metrics.credentials.errorItems}`,
    ''
  ];

  if (summary.errorMessage) {
    lines.push('## Error', '', '```text', summary.errorMessage, '```', '');
  }

  return lines.join('\n');
}

function buildActiveRunPublicState(state) {
  return {
    operation: state.operation || 'migrate',
    runId: state.runId,
    runLabel: state.runLabel,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    sourceOrg: state.sourceOrg,
    targetOrg: state.targetOrg,
    folderPath: state.folderPath,
    reportFiles: state.reportFiles,
    stages: state.stages,
    metrics: state.metrics,
    logsTail: state.logsTail,
    selected: state.selected,
    errorMessage: state.errorMessage || ''
  };
}

async function listRunHistory(runsRoot) {
  try {
    await ensureDir(runsRoot);
    const entries = await fsp.readdir(runsRoot, { withFileTypes: true });
    const runs = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const summaryPath = path.join(runsRoot, entry.name, 'run-summary.json');
      if (!fs.existsSync(summaryPath)) {
        continue;
      }
      const raw = await fsp.readFile(summaryPath, 'utf8');
      const summary = JSON.parse(raw);
      runs.push(summary);
    }

    return runs.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
  } catch (error) {
    return [];
  }
}

async function runMigration(options) {
  const cli = options.cli;
  const sourceOrg = options.sourceOrg;
  const targetOrg = options.targetOrg;
  const projectMetadataIndex = options.projectMetadataIndex || { customSettings: {}, customMetadata: {}, credentials: {} };
  const selectedSettings = normalizeSelectedComponents(options.selectedCustomSettings);
  const selectedMetadata = normalizeSelectedComponents(options.selectedCustomMetadata);
  const selectedCredentials = normalizeSelectedComponents(options.selectedCredentials);
  const settingsToCopy = selectedSettings.filter((item) => item.copyRecords !== false);
  const metadataToCopy = selectedMetadata.filter((item) => item.copyRecords !== false);
  const credentialsToCopy = selectedCredentials;
  const runsRoot = options.runsRoot;
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false;
  const setActiveProcess = typeof options.setActiveProcess === 'function' ? options.setActiveProcess : () => {};

  const runId = `${toTimestamp()}_${sanitizeNamePart(sourceOrg)}_to_${sanitizeNamePart(targetOrg)}`;
  const runFolder = path.join(runsRoot, runId);
  const reportFiles = {
    summaryJson: path.join(runFolder, 'run-summary.json'),
    summaryMarkdown: path.join(runFolder, 'run-summary.md'),
    log: path.join(runFolder, 'activity.log'),
    config: path.join(runFolder, 'run-config.json'),
    selection: path.join(runFolder, 'inventory-selection.json'),
    settingsReport: path.join(runFolder, 'custom-settings-report.json'),
    metadataReport: path.join(runFolder, 'custom-metadata-report.json'),
    credentialsReport: path.join(runFolder, 'credentials-report.json'),
    csvReportsFolder: path.join(runFolder, 'csv-reports'),
    apexFolder: path.join(runFolder, 'generated-apex'),
    credentialsProjectFolder: path.join(runFolder, 'credential-temp-project'),
    sourceMetadataProjectFolder: path.join(runFolder, 'source-metadata-temp-project')
  };

  const state = {
    operation: 'migrate',
    runId,
    runLabel: `${sourceOrg} -> ${targetOrg}`,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    sourceOrg,
    targetOrg,
    folderPath: runFolder,
    reportFiles,
    errorMessage: '',
    stages: buildStages(),
    metrics: createEmptyMetrics(settingsToCopy, metadataToCopy, credentialsToCopy),
    logsTail: [],
    selected: {
      customSettings: selectedSettings,
      customMetadata: selectedMetadata,
      credentials: selectedCredentials
    }
  };

  const settingsReport = [];
  const metadataReport = [];
  const credentialsReport = [];
  const retrievedObjectDefinitions = new Set();

  function publish() {
    onUpdate(buildActiveRunPublicState(state));
  }

  async function appendLog(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    state.logsTail = [...state.logsTail.slice(-249), line];
    await ensureDir(runFolder);
    await fsp.appendFile(reportFiles.log, `${line}\n`, 'utf8');
    publish();
  }

  function findStage(stageId) {
    return state.stages.find((stage) => stage.id === stageId);
  }

  async function updateStage(stageId, patch) {
    const stage = findStage(stageId);
    if (!stage) {
      return;
    }
    Object.assign(stage, patch);
    publish();
  }

  function throwIfCancelled() {
    if (isCancelled()) {
      throw new CancellationError();
    }
  }

  async function sfQuery(orgAlias, soql, extra = {}) {
    throwIfCancelled();
    return cli.query(orgAlias, soql, {
      ...extra,
      isCancelled,
      onStart: setActiveProcess
    });
  }

  async function sfFieldDefinitions(orgAlias, apiName) {
    throwIfCancelled();
    return cli.getFieldDefinitions(orgAlias, apiName, {
      isCancelled,
      onStart: setActiveProcess
    });
  }

  async function loadAllSourceRecords(orgAlias, apiName, fields) {
    throwIfCancelled();
    return cli.queryAllRecords(orgAlias, apiName, fields, {
      isCancelled,
      onStart: setActiveProcess
    });
  }

  async function ensureTargetTypeAvailable(kind, apiName) {
    throwIfCancelled();
    const exists = await cli.entityExists(targetOrg, apiName, {
      isCancelled,
      onStart: setActiveProcess
    });
    if (exists) {
      return { available: true, created: false };
    }

    const projectEntry = getProjectEntry(kind, apiName);
    let deployedFromPath = '';
    let deployedWorkspaceRoot = '';
    if (projectEntry?.deployable && projectEntry.deployPath) {
      await appendLog(`Target is missing ${apiName}. Deploying project definition from ${projectEntry.relativePath || projectEntry.deployPath}`);
      await cli.deploySourcePaths(targetOrg, [projectEntry.deployPath], {
        cwd: projectEntry.workspaceRoot || undefined,
        isCancelled,
        onStart: setActiveProcess
      });
      deployedFromPath = projectEntry.deployPath;
      deployedWorkspaceRoot = projectEntry.workspaceRoot || '';
    } else {
      try {
        const sourceDeploy = await retrieveAndDeploySourceObjectDefinition(apiName);
        deployedFromPath = sourceDeploy.deployPath;
        deployedWorkspaceRoot = sourceDeploy.workspaceRoot;
      } catch (error) {
        return {
          available: false,
          created: false,
          errorMessage: `Target org is missing ${apiName}, and automatic source retrieval/deploy failed: ${error.message}`
        };
      }
    }

    const existsAfterDeploy = await cli.entityExists(targetOrg, apiName, {
      isCancelled,
      onStart: setActiveProcess
    });
    if (!existsAfterDeploy) {
      return {
        available: false,
        created: false,
        errorMessage: `Deployment completed, but ${apiName} is still not available in the target org.`
      };
    }

    return {
      available: true,
      created: true,
      deployPath: deployedFromPath,
      workspaceRoot: deployedWorkspaceRoot
    };
  }

  function getProjectEntry(kind, apiName) {
    if (kind === 'customSettings') {
      return projectMetadataIndex.customSettings?.[apiName] || null;
    }
    if (kind === 'customMetadata') {
      return projectMetadataIndex.customMetadata?.[apiName] || null;
    }
    return null;
  }

  async function retrieveAndDeploySourceObjectDefinition(apiName) {
    throwIfCancelled();
    await ensureTemporarySfProject(reportFiles.sourceMetadataProjectFolder);

    if (!retrievedObjectDefinitions.has(apiName)) {
      await appendLog(`Retrieving source definition for ${apiName} from ${sourceOrg}`);
      await cli.retrieveMetadataComponents(sourceOrg, [`CustomObject:${apiName}`], {
        cwd: reportFiles.sourceMetadataProjectFolder,
        isCancelled,
        onStart: setActiveProcess
      });
      retrievedObjectDefinitions.add(apiName);
    }

    const deployPath = path.join(reportFiles.sourceMetadataProjectFolder, 'force-app', 'main', 'default', 'objects', apiName);
    await appendLog(`Deploying retrieved source definition for ${apiName} to ${targetOrg}`);
    await cli.deploySourcePaths(targetOrg, [deployPath], {
      cwd: reportFiles.sourceMetadataProjectFolder,
      isCancelled,
      onStart: setActiveProcess
    });

    return {
      deployPath,
      workspaceRoot: reportFiles.sourceMetadataProjectFolder
    };
  }

  async function getTargetExternalCredentialNames() {
    throwIfCancelled();
    const items = await cli.listMetadata(targetOrg, 'ExternalCredential', {
      isCancelled,
      onStart: setActiveProcess
    });
    return new Set(items.map((item) => item.fullName || item.FullName).filter(Boolean));
  }

  async function getTargetExternalAuthIdentityProviderNames() {
    throwIfCancelled();
    const items = await cli.listMetadata(targetOrg, 'ExternalAuthIdentityProvider', {
      isCancelled,
      onStart: setActiveProcess
    });
    return new Set(items.map((item) => item.fullName || item.FullName).filter(Boolean));
  }

  async function getNamedCredentialDependency(filePath) {
    const xml = await readTextIfExists(filePath);
    if (!xml) {
      return '';
    }
    const match = xml.match(/<externalCredential>([^<]+)<\/externalCredential>/i);
    return match ? match[1].trim() : '';
  }

  async function getExternalCredentialIdentityProviderDependency(filePath) {
    const xml = await readTextIfExists(filePath);
    if (!xml) {
      return '';
    }
    const match = xml.match(/<externalAuthIdentityProvider>([^<]+)<\/externalAuthIdentityProvider>/i);
    return match ? match[1].trim() : '';
  }

  async function ensureTargetFieldsAvailable(kind, apiName, desiredFields) {
    throwIfCancelled();
    const requestedFields = [...new Set((desiredFields || []).filter(Boolean))];
    let targetDefinitions = await sfFieldDefinitions(targetOrg, apiName);
    let targetFieldNames = new Set((targetDefinitions || []).map((field) => field.QualifiedApiName).filter(Boolean));
    let missingFields = requestedFields.filter((field) => !targetFieldNames.has(field));

    if (missingFields.length > 0) {
      const projectEntry = getProjectEntry(kind, apiName);
      if (projectEntry?.deployable && projectEntry.deployPath) {
        await appendLog(
          `Target ${apiName} is missing field(s) ${missingFields.join(', ')}. Deploying project definition from ${
            projectEntry.relativePath || projectEntry.deployPath
          }`
        );
        await cli.deploySourcePaths(targetOrg, [projectEntry.deployPath], {
          cwd: projectEntry.workspaceRoot || undefined,
          isCancelled,
          onStart: setActiveProcess
        });
        targetDefinitions = await sfFieldDefinitions(targetOrg, apiName);
        targetFieldNames = new Set((targetDefinitions || []).map((field) => field.QualifiedApiName).filter(Boolean));
        missingFields = requestedFields.filter((field) => !targetFieldNames.has(field));
      } else {
        try {
          await retrieveAndDeploySourceObjectDefinition(apiName);
          targetDefinitions = await sfFieldDefinitions(targetOrg, apiName);
          targetFieldNames = new Set((targetDefinitions || []).map((field) => field.QualifiedApiName).filter(Boolean));
          missingFields = requestedFields.filter((field) => !targetFieldNames.has(field));
        } catch (error) {
          await appendLog(`Automatic source retrieval/deploy for ${apiName} failed while reconciling fields: ${error.message}`);
        }
      }
    }

    return {
      targetDefinitions,
      availableFields: requestedFields.filter((field) => targetFieldNames.has(field)),
      missingFields
    };
  }

  function buildSettingsValuesArg(fields, record, sourceOrgId, targetOrgId) {
    const valuePairs = [];

    for (const field of fields) {
      let value = record[field];
      if (field === 'SetupOwnerId') {
        if (!value || value !== sourceOrgId) {
          return {
            supported: false,
            reason: 'Only org-level hierarchy custom settings are migrated automatically. User/profile scoped SetupOwnerId values are skipped.'
          };
        }
        value = targetOrgId;
      }

      if (value === null || value === undefined) {
        continue;
      }

      valuePairs.push(`${field}=${cli.escapeRecordValue(value)}`);
    }

    return {
      supported: true,
      valuesArg: valuePairs.join(' ')
    };
  }

  function buildSettingsLookup(fields, record, sourceOrgId, targetOrgId) {
    if (fields.includes('SetupOwnerId')) {
      const sourceValue = record.SetupOwnerId;
      if (!sourceValue || sourceValue !== sourceOrgId) {
        return {
          supported: false,
          reason: 'Only org-level hierarchy custom settings are migrated automatically. User/profile scoped SetupOwnerId values are skipped.'
        };
      }
      return {
        supported: true,
        recordKey: `${record.Name || '<org-level>'} | SetupOwnerId=${targetOrgId}`,
        whereClause: `SetupOwnerId = '${cli.escapeSoqlLiteral(targetOrgId)}'`
      };
    }

    if (fields.includes('Name')) {
      return {
        supported: true,
        recordKey: `Name=${toDisplayValue(record.Name)}`,
        whereClause: `Name = '${cli.escapeSoqlLiteral(record.Name || '')}'`
      };
    }

    return {
      supported: false,
      reason: 'No safe lookup key is available for this custom setting.'
    };
  }

  function getFieldDiffs(fields, sourceRecord, targetRecord, sourceOrgId, targetOrgId) {
    const diffs = [];

    for (const field of fields) {
      const sourceValue = field === 'SetupOwnerId' && sourceRecord[field] === sourceOrgId ? targetOrgId : sourceRecord[field];
      const targetValue = targetRecord ? targetRecord[field] : null;
    if (toComparableValue(sourceValue) !== toComparableValue(targetValue)) {
      diffs.push({
        field,
        oldValue: toDisplayValue(targetValue),
        oldRawValue: targetValue,
        newValue: toDisplayValue(sourceValue),
        rawValue: sourceValue
      });
    }
    }

    return diffs;
  }

  function buildMetadataBlocks(operations) {
    const blocks = [];
    let index = 0;

    for (const operation of operations) {
      const lines = [];
      const containerVar = `cmdtContainer${index}`;
      const recordVar = `cmdtRec${index}`;
      const deployJobVar = `cmdtDeployJobId${index}`;

      lines.push(`Metadata.DeployContainer ${containerVar} = new Metadata.DeployContainer();`);
      lines.push(`Metadata.CustomMetadata ${recordVar} = new Metadata.CustomMetadata();`);
      lines.push(`${recordVar}.fullName = '${operation.apiName}.${String(operation.record.DeveloperName).replace(/'/g, "\\'")}';`);
      lines.push(`${recordVar}.label = ${convertToApexLiteral(operation.record.MasterLabel || operation.record.DeveloperName)};`);

      for (const field of operation.fields) {
        if (field === 'DeveloperName' || field === 'MasterLabel') {
          continue;
        }
        const valueVar = `cmdtValue${index}${field.replace(/[^A-Za-z0-9]/g, '')}`;
        lines.push(`Metadata.CustomMetadataValue ${valueVar} = new Metadata.CustomMetadataValue();`);
        lines.push(`${valueVar}.field = '${field}';`);
        lines.push(`${valueVar}.value = ${convertToApexLiteral(operation.record[field])};`);
        lines.push(`${recordVar}.values.add(${valueVar});`);
      }

      lines.push(`${containerVar}.addMetadata(${recordVar});`);
      lines.push(`Id ${deployJobVar} = Metadata.Operations.enqueueDeployment(${containerVar}, null);`);
      lines.push(
        `System.debug('Queued custom metadata ${operation.action}: ' + ${deployJobVar} + ' for ${operation.apiName}.${operation.record.DeveloperName}');`
      );
      lines.push('');

      blocks.push({
        operation,
        text: lines.join('\n')
      });
      index += 1;
    }

    return blocks;
  }

  async function writeApexChunks(operations) {
    const header = [
      `// Generated by Salesforce Settings Migrator`,
      `// Source org: ${sourceOrg}`,
      `// Target org: ${targetOrg}`,
      `// Run id: ${runId}`,
      ''
    ].join('\n');

    const maxChars = 28000;
    const blocks = buildMetadataBlocks(operations);
    const chunks = [];
    let currentText = `${header}\n`;
    let currentOperations = [];

    for (const block of blocks) {
      const candidate = `${currentText}${block.text}`;
      if (candidate.length > maxChars && currentOperations.length > 0) {
        chunks.push({ text: currentText, operations: currentOperations });
        currentText = `${header}\n${block.text}`;
        currentOperations = [block.operation];
      } else {
        currentText = candidate;
        currentOperations.push(block.operation);
      }
    }

    if (currentOperations.length > 0) {
      chunks.push({ text: currentText, operations: currentOperations });
    }

    await ensureDir(reportFiles.apexFolder);
    const writtenFiles = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const filePath = path.join(reportFiles.apexFolder, `custom-metadata-${String(index + 1).padStart(3, '0')}.apex`);
      await writeText(filePath, chunks[index].text);
      writtenFiles.push({
        filePath,
        operations: chunks[index].operations
      });
    }

    return writtenFiles;
  }

  async function finalize(status, error) {
    state.status = status;
    state.finishedAt = new Date().toISOString();
    state.errorMessage = error ? String(error.message || error) : '';
    const reportStamp = toTimestamp(new Date());

    if (status === 'failed') {
      await updateStage('reporting', { status: 'running', progress: 60, detail: 'Writing failure reports' });
    } else if (status === 'cancelled') {
      await updateStage('reporting', { status: 'running', progress: 60, detail: 'Writing cancellation reports' });
    } else {
      await updateStage('reporting', { status: 'running', progress: 60, detail: 'Writing reports' });
    }

    const summary = {
      operation: state.operation,
      runId: state.runId,
      runLabel: state.runLabel,
      status: state.status,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      sourceOrg: state.sourceOrg,
      targetOrg: state.targetOrg,
      folderPath: state.folderPath,
      reportFiles: state.reportFiles,
      selected: state.selected,
      metrics: state.metrics,
      errorMessage: state.errorMessage
    };

    await writeJson(reportFiles.settingsReport, settingsReport);
    await writeJson(reportFiles.metadataReport, metadataReport);
    await writeJson(reportFiles.credentialsReport, credentialsReport);
    const bucketRows = [
      ...flattenComponentReportRows(settingsReport, summary, 'CustomSetting', reportStamp),
      ...flattenComponentReportRows(metadataReport, summary, 'CustomMetadata', reportStamp),
      ...flattenComponentReportRows(credentialsReport, summary, 'CredentialMetadata', reportStamp)
    ];
    await writeBucketedCsvReports(reportFiles, summary, bucketRows, reportStamp);
    await writeJson(reportFiles.summaryJson, summary);
    await writeText(reportFiles.summaryMarkdown, summaryToMarkdown(summary));
    await updateStage('reporting', {
      status: status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed',
      progress: 100,
      detail: 'Reports written'
    });
    publish();
    return summary;
  }

  await ensureDir(runFolder);
  await writeJson(reportFiles.config, {
    operation: state.operation,
    runId,
    sourceOrg,
    targetOrg,
    startedAt: state.startedAt
  });
  await writeJson(reportFiles.selection, {
    customSettings: selectedSettings,
    customMetadata: selectedMetadata,
    credentials: selectedCredentials
  });
  publish();

  try {
    await appendLog(`Starting migration from ${sourceOrg} to ${targetOrg}`);
    await updateStage('prepare', { status: 'running', progress: 10, detail: 'Loading organization ids' });

    const sourceOrgId = await cli.getOrgId(sourceOrg, { isCancelled, onStart: setActiveProcess });
    const targetOrgId = await cli.getOrgId(targetOrg, { isCancelled, onStart: setActiveProcess });

    await appendLog(`Resolved source org id ${sourceOrgId} and target org id ${targetOrgId}`);
    await updateStage('prepare', { status: 'completed', progress: 100, detail: 'Run prepared' });

    await updateStage('settings', {
      status: settingsToCopy.length ? 'running' : 'completed',
      progress: settingsToCopy.length ? 0 : 100,
      detail: settingsToCopy.length ? 'Loading selected custom settings' : 'No custom settings selected for value copy'
    });

    for (let index = 0; index < settingsToCopy.length; index += 1) {
      throwIfCancelled();
      const component = settingsToCopy[index];
      const apiName = component.apiName;
      await appendLog(`Inspecting custom setting ${apiName}`);

      const fieldDefinitions = await sfFieldDefinitions(sourceOrg, apiName);
      const fields = getCustomSettingFields(fieldDefinitions);
      const sourceIdentityFields = fields.filter((field) => ['Name', 'SetupOwnerId'].includes(field));
      const selectedRecordKeys = new Set(Array.isArray(component.selectedRecords) ? component.selectedRecords : []);
      const loadedSourceRecords = await loadAllSourceRecords(sourceOrg, apiName, fields);
      const sourceRecords = loadedSourceRecords.filter((record) => {
        if (selectedRecordKeys.size === 0) {
          return true;
        }
        return selectedRecordKeys.has(buildCustomSettingSelectionKey(fields, record));
      });
      state.metrics.customSettings.sourceRecords += sourceRecords.length;

      if (sourceRecords.length === 0) {
        settingsReport.push({
          apiName,
          status: 'empty',
          message: 'No records found in source org.',
          rows: []
        });
        state.metrics.customSettings.typesCompleted += 1;
        await updateStage('settings', {
          progress: Math.round(((index + 1) / settingsToCopy.length) * 100),
          detail: `${index + 1} of ${settingsToCopy.length} custom setting types processed`
        });
        publish();
        continue;
      }

      const componentRows = [];
      const targetAvailability = await ensureTargetTypeAvailable('customSettings', apiName);
      if (!targetAvailability.available) {
        state.metrics.customSettings.errorRecords += 1;
        componentRows.push({
          apiName,
          recordKey: apiName,
          status: 'error',
          action: 'CreateType',
          errorMessage: targetAvailability.errorMessage
        });
        settingsReport.push({
          apiName,
          status: 'processed',
          rows: componentRows
        });
        await appendLog(`Unable to prepare target custom setting ${apiName}: ${targetAvailability.errorMessage}`);
        state.metrics.customSettings.typesCompleted += 1;
        await updateStage('settings', {
          progress: Math.round(((index + 1) / settingsToCopy.length) * 100),
          detail: `${index + 1} of ${settingsToCopy.length} custom setting types processed`
        });
        publish();
        continue;
      }
      if (targetAvailability.created) {
        state.metrics.customSettings.createdTypes += 1;
        await appendLog(`Created missing custom setting definition ${apiName} in target org.`);
      }

      const targetFieldAvailability = await ensureTargetFieldsAvailable('customSettings', apiName, fields);
      const transferableFields = targetFieldAvailability.availableFields;
      const missingTargetFields = targetFieldAvailability.missingFields.filter((field) => !sourceIdentityFields.includes(field));
      const missingIdentityFields = sourceIdentityFields.filter((field) => !transferableFields.includes(field));

      if (missingIdentityFields.length > 0) {
        state.metrics.customSettings.errorRecords += sourceRecords.length;
        componentRows.push({
          apiName,
          recordKey: apiName,
          status: 'error',
          action: 'ValidateFields',
          errorMessage: `Target org is missing required identity field(s): ${missingIdentityFields.join(', ')}`
        });
        settingsReport.push({
          apiName,
          status: 'processed',
          rows: componentRows
        });
        await appendLog(`Unable to compare ${apiName}: target org is missing identity field(s) ${missingIdentityFields.join(', ')}`);
        state.metrics.customSettings.typesCompleted += 1;
        await updateStage('settings', {
          progress: Math.round(((index + 1) / settingsToCopy.length) * 100),
          detail: `${index + 1} of ${settingsToCopy.length} custom setting types processed`
        });
        publish();
        continue;
      }

      if (missingTargetFields.length > 0) {
        await appendLog(
          `Target ${apiName} is missing source field(s) ${missingTargetFields.join(', ')}. Migration will continue with supported fields only.`
        );
      }

      for (const record of sourceRecords) {
        throwIfCancelled();
        const lookup = buildSettingsLookup(transferableFields, record, sourceOrgId, targetOrgId);
        const recordKey = `${apiName} | ${lookup.recordKey || record.Name || '<unknown>'}`;

        if (!lookup.supported) {
          state.metrics.customSettings.processedRecords += 1;
          state.metrics.customSettings.skippedRecords += 1;
          state.metrics.customSettings.unsupportedRecords += 1;
          componentRows.push({
            apiName,
            recordKey,
            status: 'skipped',
            action: 'Skip',
            reason: lookup.reason
          });
          await appendLog(`Skipping ${recordKey}: ${lookup.reason}`);
          continue;
        }

        const existingResult = await sfQuery(
          targetOrg,
          `SELECT Id, ${transferableFields.join(', ')} FROM ${apiName} WHERE ${lookup.whereClause} LIMIT 1`
        );
        const existingRecord = existingResult.records && existingResult.records[0] ? existingResult.records[0] : null;
        const valuesBuild = buildSettingsValuesArg(transferableFields, record, sourceOrgId, targetOrgId);

        if (!valuesBuild.supported) {
          state.metrics.customSettings.processedRecords += 1;
          state.metrics.customSettings.skippedRecords += 1;
          state.metrics.customSettings.unsupportedRecords += 1;
          componentRows.push({
            apiName,
            recordKey,
            status: 'skipped',
            action: 'Skip',
            reason: valuesBuild.reason
          });
          await appendLog(`Skipping ${recordKey}: ${valuesBuild.reason}`);
          continue;
        }

        const diffs = getFieldDiffs(transferableFields, record, existingRecord, sourceOrgId, targetOrgId);
        const updatableDiffs = getUpdatableCustomSettingDiffs(diffs);
        const missingFieldReason = missingTargetFields.length
          ? `Target is missing field(s): ${missingTargetFields.join(', ')}. Only supported fields were copied.`
          : '';

        if (!existingRecord) {
          if (updatableDiffs.length === 0) {
            state.metrics.customSettings.processedRecords += 1;
            state.metrics.customSettings.skippedRecords += 1;
            componentRows.push({
              apiName,
              recordKey,
              status: 'skipped',
              action: 'Skip',
              reason: missingFieldReason || 'No supported field values were available to create in the target org.',
              revert: {
                supported: false,
                reason: 'No target changes were made by the original run.'
              }
            });
            await appendLog(`Skipping ${recordKey}: ${missingFieldReason || 'No supported field values were available to create.'}`);
            publish();
            continue;
          }
          try {
            await cli.createRecord(targetOrg, apiName, valuesBuild.valuesArg, {
              isCancelled,
              onStart: setActiveProcess
            });
            state.metrics.customSettings.processedRecords += 1;
            state.metrics.customSettings.createdRecords += 1;
            componentRows.push({
              apiName,
              recordKey,
              status: 'created',
              action: 'Create',
              changes: diffs,
              reason: missingFieldReason,
              revert: {
                supported: false,
                reason: 'This record was created by the migration. Revert will not delete created records.'
              }
            });
            await appendLog(`Created custom setting record ${recordKey}`);
          } catch (error) {
            state.metrics.customSettings.processedRecords += 1;
            state.metrics.customSettings.errorRecords += 1;
            componentRows.push({
              apiName,
              recordKey,
              status: 'error',
              action: 'Create',
              errorMessage: error.message
            });
            await appendLog(`Error creating ${recordKey}: ${error.message}`);
          }
          publish();
          continue;
        }

        if (updatableDiffs.length === 0) {
          state.metrics.customSettings.processedRecords += 1;
          state.metrics.customSettings.skippedRecords += 1;
          componentRows.push({
            apiName,
            recordKey,
            status: 'skipped',
            action: 'Skip',
            reason: missingFieldReason || 'No updatable field changes detected.',
            revert: {
              supported: false,
              reason: 'No target changes were made by the original run.'
            }
          });
          await appendLog(`No changes for ${recordKey}`);
          publish();
          continue;
        }

        const updateValuesArg = updatableDiffs.map((item) => `${item.field}=${cli.escapeRecordValue(item.rawValue)}`).join(' ');

        try {
          await cli.updateRecord(targetOrg, apiName, existingRecord.Id, updateValuesArg, {
            isCancelled,
            onStart: setActiveProcess
          });
          state.metrics.customSettings.processedRecords += 1;
          state.metrics.customSettings.updatedRecords += 1;
          componentRows.push({
            apiName,
            recordKey,
            status: 'updated',
            action: 'Update',
            changes: updatableDiffs,
            reason: missingFieldReason,
            revert: {
              supported: true,
              kind: 'customSettings',
              lookupWhereClause: lookup.whereClause,
              previousValues: Object.fromEntries(updatableDiffs.map((item) => [item.field, item.oldRawValue]))
            }
          });
          await appendLog(`Updated custom setting record ${recordKey}`);
        } catch (error) {
          state.metrics.customSettings.processedRecords += 1;
          state.metrics.customSettings.errorRecords += 1;
          componentRows.push({
            apiName,
            recordKey,
            status: 'error',
            action: 'Update',
            errorMessage: error.message
          });
          await appendLog(`Error updating ${recordKey}: ${error.message}`);
        }

        publish();
      }

      settingsReport.push({
        apiName,
        status: 'processed',
        rows: componentRows
      });
      state.metrics.customSettings.typesCompleted += 1;
      await updateStage('settings', {
        progress: Math.round(((index + 1) / settingsToCopy.length) * 100),
        detail: `${index + 1} of ${settingsToCopy.length} custom setting types processed`
      });
    }

    await updateStage('settings', {
      status: state.metrics.customSettings.errorRecords > 0 ? 'failed' : 'completed',
      progress: 100,
      detail: 'Custom settings stage finished'
    });

    await updateStage('metadata', {
      status: metadataToCopy.length ? 'running' : 'completed',
      progress: metadataToCopy.length ? 0 : 100,
      detail: metadataToCopy.length ? 'Comparing selected custom metadata' : 'No custom metadata selected for value copy'
    });

    const metadataOperations = [];

    for (let index = 0; index < metadataToCopy.length; index += 1) {
      throwIfCancelled();
      const component = metadataToCopy[index];
      const apiName = component.apiName;
      await appendLog(`Inspecting custom metadata type ${apiName}`);

      const fieldDefinitions = await sfFieldDefinitions(sourceOrg, apiName);
      const fields = getCustomMetadataFields(fieldDefinitions);
      const sourceIdentityFields = fields.filter((field) => ['DeveloperName', 'MasterLabel'].includes(field));
      const selectedRecordKeys = new Set(Array.isArray(component.selectedRecords) ? component.selectedRecords : []);
      const loadedSourceRecords = await loadAllSourceRecords(sourceOrg, apiName, fields);
      const sourceRecords = loadedSourceRecords.filter((record) => {
        if (selectedRecordKeys.size === 0) {
          return true;
        }
        return selectedRecordKeys.has(buildCustomMetadataSelectionKey(record));
      });

      state.metrics.customMetadata.sourceRecords += sourceRecords.length;
      state.metrics.customMetadata.comparedRecords += sourceRecords.length;

      const componentRows = [];
      const targetAvailability = await ensureTargetTypeAvailable('customMetadata', apiName);
      if (!targetAvailability.available) {
        state.metrics.customMetadata.errorRecords += 1;
        componentRows.push({
          apiName,
          recordKey: apiName,
          status: 'error',
          action: 'CreateType',
          errorMessage: targetAvailability.errorMessage
        });
        metadataReport.push({
          apiName,
          status: 'processed',
          rows: componentRows
        });
        await appendLog(`Unable to prepare target custom metadata type ${apiName}: ${targetAvailability.errorMessage}`);
        state.metrics.customMetadata.typesCompleted += 1;
        await updateStage('metadata', {
          progress: Math.round(((index + 1) / metadataToCopy.length) * 60),
          detail: `${index + 1} of ${metadataToCopy.length} custom metadata types compared`
        });
        publish();
        continue;
      }
      if (targetAvailability.created) {
        state.metrics.customMetadata.createdTypes += 1;
        await appendLog(`Created missing custom metadata type ${apiName} in target org.`);
      }

      const targetFieldAvailability = await ensureTargetFieldsAvailable('customMetadata', apiName, fields);
      const transferableFields = targetFieldAvailability.availableFields;
      const missingTargetFields = targetFieldAvailability.missingFields.filter((field) => !sourceIdentityFields.includes(field));
      const missingIdentityFields = sourceIdentityFields.filter((field) => !transferableFields.includes(field));

      if (missingIdentityFields.length > 0) {
        state.metrics.customMetadata.errorRecords += sourceRecords.length;
        componentRows.push({
          apiName,
          recordKey: apiName,
          status: 'error',
          action: 'ValidateFields',
          errorMessage: `Target org is missing required identity field(s): ${missingIdentityFields.join(', ')}`
        });
        metadataReport.push({
          apiName,
          status: 'processed',
          rows: componentRows
        });
        await appendLog(`Unable to compare ${apiName}: target org is missing identity field(s) ${missingIdentityFields.join(', ')}`);
        state.metrics.customMetadata.typesCompleted += 1;
        await updateStage('metadata', {
          progress: Math.round(((index + 1) / metadataToCopy.length) * 60),
          detail: `${index + 1} of ${metadataToCopy.length} custom metadata types compared`
        });
        publish();
        continue;
      }

      if (missingTargetFields.length > 0) {
        await appendLog(
          `Target ${apiName} is missing source field(s) ${missingTargetFields.join(', ')}. Migration will continue with supported fields only.`
        );
      }

      const targetRecords = await loadAllSourceRecords(targetOrg, apiName, transferableFields);

      const targetByDeveloperName = new Map();
      for (const targetRecord of targetRecords) {
        targetByDeveloperName.set(String(targetRecord.DeveloperName), targetRecord);
      }

      for (const record of sourceRecords) {
        throwIfCancelled();
        const existingRecord = targetByDeveloperName.get(String(record.DeveloperName));
        const recordKey = `${apiName}.${record.DeveloperName}`;
        const diffs = getFieldDiffs(transferableFields, record, existingRecord, null, null).filter(
          (item) => item.field !== 'DeveloperName'
        );
        const missingFieldReason = missingTargetFields.length
          ? `Target is missing field(s): ${missingTargetFields.join(', ')}. Only supported fields were copied.`
          : '';

        if (!existingRecord) {
          if (!diffs.length) {
            componentRows.push({
              apiName,
              recordKey,
              status: 'skipped',
              action: 'Skip',
              reason: missingFieldReason || 'No supported field values were available to create in the target org.',
              revert: {
                supported: false,
                reason: 'No target changes were made by the original run.'
              }
            });
            state.metrics.customMetadata.skippedRecords += 1;
            continue;
          }
          metadataOperations.push({
            apiName,
            fields: transferableFields,
            action: 'Create',
            record,
            recordKey
          });
          componentRows.push({
              apiName,
              recordKey,
              status: 'queued',
              action: 'Create',
              changes: diffs,
              reason: missingFieldReason,
              revert: {
                supported: false,
                reason: 'This metadata record was created by the migration. Revert will not delete created records.'
            }
          });
          state.metrics.customMetadata.queuedRecords += 1;
          continue;
        }

        if (diffs.length === 0) {
          componentRows.push({
            apiName,
            recordKey,
            status: 'skipped',
            action: 'Skip',
            reason: missingFieldReason || 'No field changes detected.',
            revert: {
              supported: false,
              reason: 'No target changes were made by the original run.'
            }
          });
          state.metrics.customMetadata.skippedRecords += 1;
          continue;
        }

        metadataOperations.push({
          apiName,
          fields: transferableFields,
          action: 'Update',
          record,
          recordKey
        });
        componentRows.push({
          apiName,
          recordKey,
          status: 'queued',
          action: 'Update',
          changes: diffs,
          reason: missingFieldReason,
          revert: {
            supported: true,
            kind: 'customMetadata',
            previousValues: Object.fromEntries(transferableFields.map((field) => [field, existingRecord ? existingRecord[field] : null]))
          }
        });
        state.metrics.customMetadata.queuedRecords += 1;
      }

      metadataReport.push({
        apiName,
        status: 'processed',
        rows: componentRows
      });
      state.metrics.customMetadata.typesCompleted += 1;
      await updateStage('metadata', {
        progress: Math.round(((index + 1) / metadataToCopy.length) * 60),
        detail: `${index + 1} of ${metadataToCopy.length} custom metadata types compared`
      });
      publish();
    }

    if (metadataOperations.length > 0) {
      await appendLog(`Generating ${metadataOperations.length} custom metadata operations`);
      const writtenFiles = await writeApexChunks(metadataOperations);
      state.metrics.customMetadata.generatedFiles = writtenFiles.length;
      await updateStage('metadata', {
        status: 'running',
        progress: 75,
        detail: `Generated ${writtenFiles.length} Apex file(s)`
      });

      for (let index = 0; index < writtenFiles.length; index += 1) {
        throwIfCancelled();
        const item = writtenFiles[index];
        await appendLog(`Executing Apex file ${path.basename(item.filePath)}`);

        try {
          await cli.runApexFile(targetOrg, item.filePath, {
            isCancelled,
            onStart: setActiveProcess,
            onLine: async () => {}
          });
          state.metrics.customMetadata.executedFiles += 1;
          await appendLog(`Executed Apex file ${path.basename(item.filePath)}`);
          for (const operation of item.operations) {
            const reportEntry = metadataReport.find((entry) => entry.apiName === operation.apiName);
            const row = reportEntry?.rows.find((candidate) => candidate.recordKey === operation.recordKey);
            if (row) {
              row.status = operation.action === 'Create' ? 'created' : 'updated';
            }
          }
        } catch (error) {
          state.metrics.customMetadata.errorRecords += item.operations.length;
          await appendLog(`Error executing ${path.basename(item.filePath)}: ${error.message}`);
          for (const operation of item.operations) {
            const reportEntry = metadataReport.find((entry) => entry.apiName === operation.apiName);
            if (!reportEntry) {
              continue;
            }
            const row = reportEntry.rows.find((candidate) => candidate.recordKey === operation.recordKey);
            if (row) {
              row.status = 'error';
              row.errorMessage = error.message;
            }
          }
        }

        await updateStage('metadata', {
          progress: 75 + Math.round(((index + 1) / writtenFiles.length) * 25),
          detail: `${index + 1} of ${writtenFiles.length} Apex files executed`
        });
        publish();
      }
    } else {
      await appendLog('No custom metadata create/update operations were required.');
    }

    await updateStage('metadata', {
      status: state.metrics.customMetadata.errorRecords > 0 ? 'failed' : 'completed',
      progress: 100,
      detail: 'Custom metadata stage finished'
    });

    await updateStage('credentials', {
      status: credentialsToCopy.length ? 'running' : 'completed',
      progress: credentialsToCopy.length ? 0 : 100,
      detail: credentialsToCopy.length ? 'Retrieving selected credential metadata' : 'No credential metadata selected'
    });

    if (credentialsToCopy.length > 0) {
      await ensureTemporarySfProject(reportFiles.credentialsProjectFolder);
      const retrievalKeys = credentialsToCopy.map((item) => item.apiName).filter(Boolean);
      const credentialRowsByKey = new Map();

      for (const component of credentialsToCopy) {
        credentialRowsByKey.set(component.apiName, {
          apiName: component.apiName,
          recordKey: component.fullName || component.label || component.apiName,
          status: 'pending',
          action: 'Deploy',
          metadataType: component.metadataType || '',
          revert: {
            supported: false,
            reason: 'Credential metadata deployments are not reverted automatically.'
          }
        });
      }

      await appendLog(`Retrieving ${retrievalKeys.length} credential metadata component(s) from ${sourceOrg}`);
      const retrieveResult = await cli.retrieveMetadataComponents(sourceOrg, retrievalKeys, {
        cwd: reportFiles.credentialsProjectFolder,
        isCancelled,
        onStart: setActiveProcess
      });

      const retrievedFiles = Array.isArray(retrieveResult.files) ? retrieveResult.files.filter((item) => item.filePath) : [];
      const retrievedByKey = new Map(
        retrievedFiles.map((item) => [`${item.type}:${item.fullName}`, item.filePath])
      );
      state.metrics.credentials.retrievedItems = retrievedFiles.length;

      for (const key of retrievalKeys) {
        if (!retrievedByKey.has(key)) {
          const row = credentialRowsByKey.get(key);
          if (row) {
            row.status = 'skipped';
            row.reason = 'The selected component was not returned by the metadata retrieve operation.';
            state.metrics.credentials.skippedItems += 1;
          }
        }
      }

      await updateStage('credentials', {
        status: 'running',
        progress: 35,
        detail: `${state.metrics.credentials.retrievedItems} of ${retrievalKeys.length} credential components retrieved`
      });
      publish();

      const requiredIdentityProviders = new Set();
      for (const item of credentialsToCopy) {
        if (item.metadataType !== 'ExternalCredential' || !retrievedByKey.has(item.apiName)) {
          continue;
        }
        const dependencyName = await getExternalCredentialIdentityProviderDependency(retrievedByKey.get(item.apiName));
        if (dependencyName) {
          requiredIdentityProviders.add(dependencyName);
        }
      }

      let availableExternalAuthIdentityProviders = null;
      if (requiredIdentityProviders.size > 0) {
        availableExternalAuthIdentityProviders = await getTargetExternalAuthIdentityProviderNames();
        const missingIdentityProviders = Array.from(requiredIdentityProviders).filter(
          (name) => !availableExternalAuthIdentityProviders.has(name)
        );

        if (missingIdentityProviders.length > 0) {
          await appendLog(
            `Retrieving ${missingIdentityProviders.length} external auth identity provider dependency item(s) from ${sourceOrg}`
          );
          const dependencyRetrieveResult = await cli.retrieveMetadataComponents(
            sourceOrg,
            missingIdentityProviders.map((name) => `ExternalAuthIdentityProvider:${name}`),
            {
              cwd: reportFiles.credentialsProjectFolder,
              isCancelled,
              onStart: setActiveProcess
            }
          );

          const dependencyFiles = Array.isArray(dependencyRetrieveResult.files)
            ? dependencyRetrieveResult.files.filter((item) => item.filePath)
            : [];
          const dependencyPathsByName = new Map(
            dependencyFiles
              .filter((item) => String(item.type || '').toLowerCase() === 'externalauthidentityprovider')
              .map((item) => [item.fullName, item.filePath])
          );

          for (const dependencyName of missingIdentityProviders) {
            const dependencyPath = dependencyPathsByName.get(dependencyName);
            if (!dependencyPath) {
              await appendLog(
                `Dependency ExternalAuthIdentityProvider ${dependencyName} was not returned by the source retrieve operation.`
              );
              continue;
            }

            try {
              await appendLog(`Deploying ExternalAuthIdentityProvider ${dependencyName} to ${targetOrg}`);
              await cli.deploySourcePaths(targetOrg, [dependencyPath], {
                cwd: reportFiles.credentialsProjectFolder,
                isCancelled,
                onStart: setActiveProcess
              });
              availableExternalAuthIdentityProviders.add(dependencyName);
              await appendLog(`Deployed ExternalAuthIdentityProvider ${dependencyName}`);
            } catch (error) {
              await appendLog(
                `Failed deploying ExternalAuthIdentityProvider ${dependencyName}: ${error.message}`
              );
            }
          }
        }
      }

      const deployGroups = [
        {
          label: 'external credentials',
          items: credentialsToCopy.filter((item) => item.metadataType === 'ExternalCredential' && retrievedByKey.has(item.apiName))
        },
        {
          label: 'named credentials',
          items: credentialsToCopy.filter((item) => item.metadataType === 'NamedCredential' && retrievedByKey.has(item.apiName))
        }
      ];

      let processedCredentialItems = state.metrics.credentials.skippedItems;
      state.metrics.credentials.itemsCompleted = processedCredentialItems;
      for (const group of deployGroups) {
        if (!group.items.length) {
          continue;
        }

        await appendLog(`Deploying ${group.items.length} ${group.label} to ${targetOrg}`);
        let availableExternalCredentials = null;
        if (group.label === 'named credentials') {
          availableExternalCredentials = await getTargetExternalCredentialNames();
        }

        for (const item of group.items) {
          const row = credentialRowsByKey.get(item.apiName);
          const deployPath = retrievedByKey.get(item.apiName);
          if (!row || !deployPath) {
            continue;
          }

          if (group.label === 'external credentials') {
            const dependencyName = await getExternalCredentialIdentityProviderDependency(deployPath);
            if (
              dependencyName &&
              availableExternalAuthIdentityProviders &&
              !availableExternalAuthIdentityProviders.has(dependencyName)
            ) {
              row.status = 'skipped';
              row.reason = `Required external auth identity provider ${dependencyName} is not available in the target org.`;
              state.metrics.credentials.skippedItems += 1;
              processedCredentialItems += 1;
              await appendLog(
                `Skipping external credential ${row.recordKey}: missing external auth identity provider ${dependencyName}`
              );
              state.metrics.credentials.itemsCompleted = processedCredentialItems;
              continue;
            }
          }

          if (group.label === 'named credentials') {
            const dependencyName = await getNamedCredentialDependency(deployPath);
            if (dependencyName && !availableExternalCredentials.has(dependencyName)) {
              row.status = 'skipped';
              row.reason = `Required external credential ${dependencyName} is not available in the target org.`;
              state.metrics.credentials.skippedItems += 1;
              processedCredentialItems += 1;
              await appendLog(`Skipping named credential ${row.recordKey}: missing external credential ${dependencyName}`);
              state.metrics.credentials.itemsCompleted = processedCredentialItems;
              continue;
            }
          }

          try {
            await cli.deploySourcePaths(targetOrg, [deployPath], {
              cwd: reportFiles.credentialsProjectFolder,
              isCancelled,
              onStart: setActiveProcess
            });
            row.status = 'created';
            state.metrics.credentials.deployedItems += 1;
            processedCredentialItems += 1;
            await appendLog(`Deployed ${item.metadataType} ${row.recordKey}`);

            if (group.label === 'external credentials' && availableExternalCredentials) {
              availableExternalCredentials.add(item.fullName || row.recordKey);
            }
          } catch (error) {
            row.status = 'error';
            row.errorMessage = error.message;
            state.metrics.credentials.errorItems += 1;
            processedCredentialItems += 1;
            await appendLog(`Failed deploying ${item.metadataType} ${row.recordKey}: ${error.message}`);
          }
        }

        state.metrics.credentials.itemsCompleted = processedCredentialItems;
        await updateStage('credentials', {
          status: 'running',
          progress: Math.min(95, 35 + Math.round((processedCredentialItems / retrievalKeys.length) * 60)),
          detail: `${processedCredentialItems} of ${retrievalKeys.length} credential components processed`
        });
        publish();
      }

      for (const component of credentialsToCopy) {
        const row = credentialRowsByKey.get(component.apiName);
        if (!row) {
          continue;
        }
        credentialsReport.push({
          apiName: component.apiName,
          status: 'processed',
          rows: [row]
        });
      }
      state.metrics.credentials.itemsCompleted =
        state.metrics.credentials.deployedItems + state.metrics.credentials.skippedItems + state.metrics.credentials.errorItems;
    } else {
      await appendLog('No credential metadata deployment was required.');
    }

    await updateStage('credentials', {
      status: state.metrics.credentials.errorItems > 0 ? 'failed' : 'completed',
      progress: 100,
      detail: 'Credential metadata stage finished'
    });

    const finalStatus =
      state.metrics.customSettings.errorRecords > 0 ||
      state.metrics.customMetadata.errorRecords > 0 ||
      state.metrics.credentials.errorItems > 0
        ? 'failed'
        : 'completed';

    return finalize(finalStatus, finalStatus === 'failed' ? new Error('One or more migration actions failed.') : null);
  } catch (error) {
    if (error instanceof CancellationError) {
      await appendLog('Migration cancelled by user.');
      await updateStage('settings', { status: 'cancelled', detail: 'Cancelled', progress: findStage('settings').progress });
      await updateStage('metadata', { status: 'cancelled', detail: 'Cancelled', progress: findStage('metadata').progress });
      await updateStage('credentials', { status: 'cancelled', detail: 'Cancelled', progress: findStage('credentials').progress });
      return finalize('cancelled', error);
    }

    await appendLog(`Migration failed: ${error.message}`);
    return finalize('failed', error);
  }
}

async function revertMigrationRun(options) {
  const cli = options.cli;
  const runToRevert = options.runToRevert;
  const targetOrg = runToRevert.targetOrg;
  const runsRoot = options.runsRoot;
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false;
  const setActiveProcess = typeof options.setActiveProcess === 'function' ? options.setActiveProcess : () => {};

  const settingsRows = fs.existsSync(runToRevert.reportFiles?.settingsReport) ? await readJson(runToRevert.reportFiles.settingsReport) : [];
  const metadataRows = fs.existsSync(runToRevert.reportFiles?.metadataReport) ? await readJson(runToRevert.reportFiles.metadataReport) : [];

  const reversibleSettings = settingsRows.flatMap((entry) =>
    (entry.rows || []).filter((row) => row.revert?.supported === true).map((row) => ({ apiName: entry.apiName, row }))
  );
  const reversibleMetadata = metadataRows.flatMap((entry) =>
    (entry.rows || []).filter((row) => row.revert?.supported === true).map((row) => ({ apiName: entry.apiName, row }))
  );
  const nonReversibleSettings = settingsRows.flatMap((entry) =>
    (entry.rows || []).filter((row) => row.revert?.supported === false).map((row) => ({ apiName: entry.apiName, row }))
  );
  const nonReversibleMetadata = metadataRows.flatMap((entry) =>
    (entry.rows || []).filter((row) => row.revert?.supported === false).map((row) => ({ apiName: entry.apiName, row }))
  );

  if (reversibleSettings.length + reversibleMetadata.length + nonReversibleSettings.length + nonReversibleMetadata.length === 0) {
    throw new Error('This run does not contain reversible update data. Revert is available only for runs that stored previous values.');
  }

  const runId = `${toTimestamp()}_revert_${sanitizeNamePart(runToRevert.runId)}`;
  const runFolder = path.join(runsRoot, runId);
  const reportFiles = {
    summaryJson: path.join(runFolder, 'run-summary.json'),
    summaryMarkdown: path.join(runFolder, 'run-summary.md'),
    log: path.join(runFolder, 'activity.log'),
    config: path.join(runFolder, 'run-config.json'),
    selection: path.join(runFolder, 'revert-selection.json'),
    settingsReport: path.join(runFolder, 'custom-settings-report.json'),
    metadataReport: path.join(runFolder, 'custom-metadata-report.json'),
    credentialsReport: path.join(runFolder, 'credentials-report.json'),
    csvReportsFolder: path.join(runFolder, 'csv-reports'),
    apexFolder: path.join(runFolder, 'generated-apex')
  };

  const state = {
    operation: 'revert',
    runId,
    runLabel: `Revert ${runToRevert.runLabel}`,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    sourceOrg: runToRevert.sourceOrg,
    targetOrg,
    folderPath: runFolder,
    reportFiles,
    errorMessage: '',
    stages: buildStages(),
    metrics: createEmptyMetrics(
      [...new Set(reversibleSettings.map((item) => item.apiName))],
      [...new Set(reversibleMetadata.map((item) => item.apiName))],
      []
    ),
    logsTail: [],
    selected: {
      revertOfRunId: runToRevert.runId
    }
  };

  const revertedSettingsReport = [];
  const revertedMetadataReport = [];
  const revertedCredentialsReport = [];
  state.metrics.customMetadata.queuedRecords = reversibleMetadata.length;
  state.metrics.customMetadata.comparedRecords = reversibleMetadata.length;
  state.metrics.customSettings.skippedRecords = nonReversibleSettings.length;
  state.metrics.customMetadata.skippedRecords = nonReversibleMetadata.length;

  function publish() {
    onUpdate(buildActiveRunPublicState(state));
  }

  async function appendLog(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    state.logsTail = [...state.logsTail.slice(-249), line];
    await ensureDir(runFolder);
    await fsp.appendFile(reportFiles.log, `${line}\n`, 'utf8');
    publish();
  }

  function findStage(stageId) {
    return state.stages.find((stage) => stage.id === stageId);
  }

  async function updateStage(stageId, patch) {
    const stage = findStage(stageId);
    if (!stage) {
      return;
    }
    Object.assign(stage, patch);
    publish();
  }

  function throwIfCancelled() {
    if (isCancelled()) {
      throw new CancellationError('Revert cancelled.');
    }
  }

  async function finalize(status, error) {
    state.status = status;
    state.finishedAt = new Date().toISOString();
    state.errorMessage = error ? String(error.message || error) : '';
    const reportStamp = toTimestamp(new Date());

    await updateStage('reporting', {
      status: 'running',
      progress: 60,
      detail: status === 'failed' ? 'Writing failure reports' : status === 'cancelled' ? 'Writing cancellation reports' : 'Writing reports'
    });

    const summary = {
      operation: state.operation,
      runId: state.runId,
      runLabel: state.runLabel,
      status: state.status,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      sourceOrg: state.sourceOrg,
      targetOrg: state.targetOrg,
      folderPath: state.folderPath,
      reportFiles: state.reportFiles,
      selected: state.selected,
      metrics: state.metrics,
      errorMessage: state.errorMessage
    };

    await writeJson(reportFiles.settingsReport, revertedSettingsReport);
    await writeJson(reportFiles.metadataReport, revertedMetadataReport);
    await writeJson(reportFiles.credentialsReport, revertedCredentialsReport);
    const bucketRows = [
      ...flattenFlatReportRows(revertedSettingsReport, summary, 'CustomSetting', reportStamp),
      ...flattenFlatReportRows(revertedMetadataReport, summary, 'CustomMetadata', reportStamp)
    ];
    await writeBucketedCsvReports(reportFiles, summary, bucketRows, reportStamp);
    await writeJson(reportFiles.summaryJson, summary);
    await writeText(reportFiles.summaryMarkdown, summaryToMarkdown(summary));
    await updateStage('reporting', {
      status: status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed',
      progress: 100,
      detail: 'Reports written'
    });
    publish();
    return summary;
  }

  try {
    await ensureDir(runFolder);
    await writeJson(reportFiles.config, {
      operation: state.operation,
      runId,
      revertOfRunId: runToRevert.runId,
      targetOrg,
      startedAt: state.startedAt
    });
    await writeJson(reportFiles.selection, {
      reversibleSettings: reversibleSettings.map((item) => ({ apiName: item.apiName, recordKey: item.row.recordKey })),
      reversibleMetadata: reversibleMetadata.map((item) => ({ apiName: item.apiName, recordKey: item.row.recordKey }))
    });
    publish();

    for (const item of nonReversibleSettings) {
      revertedSettingsReport.push({
        apiName: item.apiName,
        recordKey: item.row.recordKey,
        status: 'skipped',
        reason: item.row.revert?.reason || 'This setting row cannot be reverted safely.'
      });
    }

    for (const item of nonReversibleMetadata) {
      revertedMetadataReport.push({
        apiName: item.apiName,
        recordKey: item.row.recordKey,
        status: 'skipped',
        reason: item.row.revert?.reason || 'This metadata row cannot be reverted safely.'
      });
    }

    await appendLog(`Starting revert for original run ${runToRevert.runId}`);
    await updateStage('prepare', { status: 'completed', progress: 100, detail: `Loaded report data from ${runToRevert.runId}` });

    await updateStage('settings', {
      status: reversibleSettings.length ? 'running' : 'completed',
      progress: reversibleSettings.length ? 0 : 100,
      detail: reversibleSettings.length ? 'Restoring custom settings values' : 'No reversible custom settings updates found'
    });

    const settingsByType = new Map();
    for (const item of reversibleSettings) {
      if (!settingsByType.has(item.apiName)) {
        settingsByType.set(item.apiName, []);
      }
      settingsByType.get(item.apiName).push(item.row);
    }

    let settingsDone = 0;
    for (const [apiName, rows] of settingsByType.entries()) {
      for (const row of rows) {
        throwIfCancelled();
        const previousValues = row.revert?.previousValues || {};
        const fields = Object.keys(previousValues).filter((field) => previousValues[field] !== undefined);
        if (!fields.length) {
          state.metrics.customSettings.skippedRecords += 1;
          revertedSettingsReport.push({ apiName, recordKey: row.recordKey, status: 'skipped', reason: 'No previous values were stored.' });
          continue;
        }

        const result = await cli.query(targetOrg, `SELECT Id FROM ${apiName} WHERE ${row.revert.lookupWhereClause} LIMIT 1`, {
          isCancelled,
          onStart: setActiveProcess
        });
        const existing = result.records && result.records[0] ? result.records[0] : null;

        if (!existing) {
          state.metrics.customSettings.skippedRecords += 1;
          revertedSettingsReport.push({
            apiName,
            recordKey: row.recordKey,
            status: 'skipped',
            reason: 'Target record was not found. Revert does not recreate deleted records.'
          });
          continue;
        }

        const valuesArg = fields.map((field) => `${field}=${cli.escapeRecordValue(previousValues[field])}`).join(' ');
        try {
          await cli.updateRecord(targetOrg, apiName, existing.Id, valuesArg, {
            isCancelled,
            onStart: setActiveProcess
          });
          state.metrics.customSettings.processedRecords += 1;
          state.metrics.customSettings.updatedRecords += 1;
          revertedSettingsReport.push({ apiName, recordKey: row.recordKey, status: 'restored', fields });
          await appendLog(`Restored custom setting ${row.recordKey}`);
        } catch (error) {
          state.metrics.customSettings.processedRecords += 1;
          state.metrics.customSettings.errorRecords += 1;
          revertedSettingsReport.push({ apiName, recordKey: row.recordKey, status: 'error', errorMessage: error.message });
          await appendLog(`Failed to restore custom setting ${row.recordKey}: ${error.message}`);
        }
      }

      settingsDone += 1;
      state.metrics.customSettings.typesCompleted = settingsDone;
      await updateStage('settings', {
        progress: Math.round((settingsDone / settingsByType.size) * 100),
        detail: `${settingsDone} of ${settingsByType.size} custom setting types restored`
      });
    }

    await updateStage('settings', {
      status: state.metrics.customSettings.errorRecords > 0 ? 'failed' : 'completed',
      progress: 100,
      detail: 'Custom settings revert stage finished'
    });

    await updateStage('metadata', {
      status: reversibleMetadata.length ? 'running' : 'completed',
      progress: reversibleMetadata.length ? 0 : 100,
      detail: reversibleMetadata.length ? 'Restoring custom metadata values' : 'No reversible custom metadata updates found'
    });

    const metadataOperations = reversibleMetadata.map(({ apiName, row }) => ({
      apiName,
      action: 'Update',
      recordKey: row.recordKey,
      fields: Object.keys(row.revert.previousValues || {}),
      record: row.revert.previousValues || {}
    }));

    if (metadataOperations.length > 0) {
      const buildBlocks = (operations) => {
        return operations.map((operation, index) => {
          const lines = [];
          const containerVar = `revertCmdtContainer${index}`;
          const recordVar = `revertCmdtRec${index}`;
          const deployJobVar = `revertDeployJobId${index}`;

          lines.push(`Metadata.DeployContainer ${containerVar} = new Metadata.DeployContainer();`);
          lines.push(`Metadata.CustomMetadata ${recordVar} = new Metadata.CustomMetadata();`);
          lines.push(`${recordVar}.fullName = '${operation.apiName}.${String(operation.record.DeveloperName).replace(/'/g, "\\'")}';`);
          lines.push(`${recordVar}.label = ${convertToApexLiteral(operation.record.MasterLabel || operation.record.DeveloperName)};`);

          for (const field of operation.fields) {
            if (field === 'DeveloperName' || field === 'MasterLabel') {
              continue;
            }
            const valueVar = `revertCmdtValue${index}${field.replace(/[^A-Za-z0-9]/g, '')}`;
            lines.push(`Metadata.CustomMetadataValue ${valueVar} = new Metadata.CustomMetadataValue();`);
            lines.push(`${valueVar}.field = '${field}';`);
            lines.push(`${valueVar}.value = ${convertToApexLiteral(operation.record[field])};`);
            lines.push(`${recordVar}.values.add(${valueVar});`);
          }

          lines.push(`${containerVar}.addMetadata(${recordVar});`);
          lines.push(`Id ${deployJobVar} = Metadata.Operations.enqueueDeployment(${containerVar}, null);`);
          lines.push(
            `System.debug('Queued custom metadata revert: ' + ${deployJobVar} + ' for ${operation.apiName}.${operation.record.DeveloperName}');`
          );
          lines.push('');

          return { operation, text: lines.join('\n') };
        });
      };

      const header = [`// Generated by Salesforce Settings Migrator`, `// Revert of run: ${runToRevert.runId}`, `// Target org: ${targetOrg}`, ''].join('\n');
      const blocks = buildBlocks(metadataOperations);
      const maxChars = 28000;
      const files = [];
      let currentText = `${header}\n`;
      let currentOperations = [];

      for (const block of blocks) {
        const candidate = `${currentText}${block.text}`;
        if (candidate.length > maxChars && currentOperations.length > 0) {
          files.push({ text: currentText, operations: currentOperations });
          currentText = `${header}\n${block.text}`;
          currentOperations = [block.operation];
        } else {
          currentText = candidate;
          currentOperations.push(block.operation);
        }
      }
      if (currentOperations.length > 0) {
        files.push({ text: currentText, operations: currentOperations });
      }

      await ensureDir(reportFiles.apexFolder);
      state.metrics.customMetadata.generatedFiles = files.length;

      for (let index = 0; index < files.length; index += 1) {
        const filePath = path.join(reportFiles.apexFolder, `custom-metadata-revert-${String(index + 1).padStart(3, '0')}.apex`);
        await writeText(filePath, files[index].text);

        try {
          await cli.runApexFile(targetOrg, filePath, {
            isCancelled,
            onStart: setActiveProcess,
            onLine: async () => {}
          });
          state.metrics.customMetadata.executedFiles += 1;
          for (const operation of files[index].operations) {
            revertedMetadataReport.push({ apiName: operation.apiName, recordKey: operation.recordKey, status: 'restored' });
          }
          await appendLog(`Executed metadata revert file ${path.basename(filePath)}`);
        } catch (error) {
          for (const operation of files[index].operations) {
            state.metrics.customMetadata.errorRecords += 1;
            revertedMetadataReport.push({
              apiName: operation.apiName,
              recordKey: operation.recordKey,
              status: 'error',
              errorMessage: error.message
            });
          }
          await appendLog(`Failed metadata revert file ${path.basename(filePath)}: ${error.message}`);
        }

        state.metrics.customMetadata.typesCompleted = [...new Set(reversibleMetadata.map((item) => item.apiName))].length;
        await updateStage('metadata', {
          progress: Math.round(((index + 1) / files.length) * 100),
          detail: `${index + 1} of ${files.length} metadata revert files executed`
        });
      }
    }

    await updateStage('metadata', {
      status: state.metrics.customMetadata.errorRecords > 0 ? 'failed' : 'completed',
      progress: 100,
      detail: 'Custom metadata revert stage finished'
    });

    const finalStatus =
      state.metrics.customSettings.errorRecords > 0 || state.metrics.customMetadata.errorRecords > 0 ? 'failed' : 'completed';

    return finalize(finalStatus, finalStatus === 'failed' ? new Error('One or more revert actions failed.') : null);
  } catch (error) {
    if (error instanceof CancellationError) {
      await appendLog('Revert cancelled by user.');
      await updateStage('settings', { status: 'cancelled', detail: 'Cancelled', progress: findStage('settings').progress });
      await updateStage('metadata', { status: 'cancelled', detail: 'Cancelled', progress: findStage('metadata').progress });
      return finalize('cancelled', error);
    }

    await appendLog(`Revert failed: ${error.message}`);
    return finalize('failed', error);
  }
}

module.exports = {
  CancellationError,
  listRunHistory,
  revertMigrationRun,
  runMigration,
  getCustomSettingFields,
  getCustomMetadataFields
};
