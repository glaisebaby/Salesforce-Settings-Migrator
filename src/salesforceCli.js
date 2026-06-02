const cp = require('child_process');
const os = require('os');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLineEndings(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function escapeSoqlLiteral(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function escapeRecordValue(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function extractJsonPayload(text) {
  const normalized = normalizeLineEndings(text).trim();
  if (!normalized) {
    return normalized;
  }
  if (normalized.startsWith('{') || normalized.startsWith('[')) {
    return normalized;
  }

  const objectIndex = normalized.indexOf('{');
  const arrayIndex = normalized.indexOf('[');
  let startIndex = -1;

  if (objectIndex >= 0 && arrayIndex >= 0) {
    startIndex = Math.min(objectIndex, arrayIndex);
  } else if (objectIndex >= 0) {
    startIndex = objectIndex;
  } else if (arrayIndex >= 0) {
    startIndex = arrayIndex;
  }

  if (startIndex < 0) {
    throw new Error(`Could not find JSON payload in Salesforce CLI output.\n${normalized}`);
  }

  return normalized.slice(startIndex);
}

function toPowerShellLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function createCliRunner(baseOptions = {}) {
  const defaultCwd = baseOptions.cwd || os.homedir();
  const isWindows = process.platform === 'win32';

  async function runSf(args, options = {}) {
    const cwd = options.cwd || defaultCwd;
    const expectJson = Boolean(options.expectJson);
    const onLine = typeof options.onLine === 'function' ? options.onLine : null;
    const onStart = typeof options.onStart === 'function' ? options.onStart : null;
    const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false;

    if (isCancelled()) {
      throw new Error('Operation cancelled before Salesforce CLI command started.');
    }

    return new Promise((resolve, reject) => {
      const spawnCommand = isWindows ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'sf';
      const spawnArgs = isWindows
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `& sf @(${args.map(toPowerShellLiteral).join(', ')})`
          ]
        : args;
      const child = cp.spawn(spawnCommand, spawnArgs, {
        cwd,
        shell: false,
        windowsHide: true,
        env: process.env
      });

      if (onStart) {
        onStart(child);
      }

      let stdout = '';
      let stderr = '';
      let combined = '';
      let killedForCancel = false;

      const forwardChunk = (chunk) => {
        const text = chunk.toString();
        combined += text;
        const lines = normalizeLineEndings(text).split('\n');
        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line) {
            continue;
          }
          if (onLine) {
            onLine(line);
          }
        }
      };

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        forwardChunk(chunk);
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        forwardChunk(chunk);
      });

      child.on('error', (error) => {
        reject(error);
      });

      const cancelTimer = setInterval(() => {
        if (!killedForCancel && isCancelled()) {
          killedForCancel = true;
          try {
            child.kill();
          } catch (error) {
            clearInterval(cancelTimer);
            reject(error);
          }
        }
      }, 200);

      child.on('close', (code) => {
        clearInterval(cancelTimer);

        if (killedForCancel || isCancelled()) {
          reject(new Error('Operation cancelled.'));
          return;
        }

        if (code !== 0) {
          reject(
            new Error(
              `Salesforce CLI command failed with exit code ${code}: sf ${args.join(' ')}\n${combined || stderr || stdout}`
            )
          );
          return;
        }

        if (!expectJson) {
          resolve({
            code,
            stdout,
            stderr,
            output: combined
          });
          return;
        }

        try {
          const parsed = JSON.parse(extractJsonPayload(combined || stdout || stderr));
          resolve({
            code,
            stdout,
            stderr,
            output: combined,
            json: parsed
          });
        } catch (error) {
          reject(
            new Error(
              `Salesforce CLI JSON parsing failed for command: sf ${args.join(' ')}\n${combined || stdout || stderr}\n${error.message}`
            )
          );
        }
      });
    });
  }

  async function runSfJson(args, options = {}) {
    const response = await runSf([...args, '--json'], { ...options, expectJson: true });
    if (response.json && response.json.status && response.json.status !== 0) {
      throw new Error(response.output || JSON.stringify(response.json));
    }
    return response.json;
  }

  async function query(orgAlias, soql, options = {}) {
    const args = ['data', 'query', '--target-org', orgAlias, '--query', soql];
    if (options.tooling) {
      args.push('--use-tooling-api');
    }
    const result = await runSfJson(args, options);
    return result.result || { records: [], totalSize: 0 };
  }

  async function listOrgs(options = {}) {
    const payload = await runSfJson(['org', 'list'], options);
    const nonScratch = payload.result && Array.isArray(payload.result.nonScratchOrgs) ? payload.result.nonScratchOrgs : [];

    return nonScratch
      .map((org) => ({
        alias: org.alias || org.username,
        username: org.username,
        orgId: org.orgId,
        instanceUrl: org.instanceUrl,
        isSandbox: Boolean(org.isSandbox),
        isScratch: Boolean(org.isScratch),
        isDefaultUsername: Boolean(org.isDefaultUsername),
        isDefaultDevHubUsername: Boolean(org.isDefaultDevHubUsername),
        connectedStatus: org.connectedStatus,
        name: org.name || '',
        tracksSource: Boolean(org.tracksSource),
        lastUsed: org.lastUsed || '',
        apiVersion: org.instanceApiVersion || '',
        loginUrl: org.loginUrl || ''
      }))
      .sort((left, right) => left.alias.localeCompare(right.alias));
  }

  async function listMetadata(orgAlias, metadataType, options = {}) {
    const payload = await runSfJson(
      ['org', 'list', 'metadata', '--target-org', orgAlias, '--metadata-type', metadataType],
      options
    );
    return Array.isArray(payload.result) ? payload.result : [];
  }

  async function getOrgId(orgAlias, options = {}) {
    const result = await query(orgAlias, 'SELECT Id FROM Organization LIMIT 1', options);
    return result.records && result.records[0] ? result.records[0].Id : null;
  }

  async function getCustomSettings(orgAlias, options = {}) {
    const soql = [
      'SELECT QualifiedApiName, Label, NamespacePrefix',
      'FROM EntityDefinition',
      'WHERE IsCustomSetting = true',
      'ORDER BY QualifiedApiName'
    ].join(' ');

    const result = await query(orgAlias, soql, { ...options, tooling: true });
    return result.records || [];
  }

  async function getCustomMetadataTypes(orgAlias, options = {}) {
    const queries = [
      [
        'SELECT QualifiedApiName, Label, NamespacePrefix',
        'FROM EntityDefinition',
        "WHERE QualifiedApiName LIKE '%mdt'",
        'ORDER BY QualifiedApiName'
      ].join(' '),
      [
        'SELECT QualifiedApiName, Label, NamespacePrefix',
        'FROM EntityDefinition',
        "WHERE KeyPrefix = 'm00'",
        'ORDER BY QualifiedApiName'
      ].join(' ')
    ];

    let lastError = null;
    for (const soql of queries) {
      try {
        const result = await query(orgAlias, soql, { ...options, tooling: true });
        const records = (result.records || []).filter((item) => String(item.QualifiedApiName || '').endsWith('__mdt'));
        if (records.length > 0) {
          return records;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return [];
  }

  async function getFieldDefinitions(orgAlias, apiName, options = {}) {
    const soql = [
      'SELECT QualifiedApiName, DataType, IsCalculated, IsNillable',
      'FROM FieldDefinition',
      `WHERE EntityDefinition.QualifiedApiName = '${escapeSoqlLiteral(apiName)}'`,
      'ORDER BY QualifiedApiName'
    ].join(' ');

    const result = await query(orgAlias, soql, { ...options, tooling: true });
    return result.records || [];
  }

  async function entityExists(orgAlias, apiName, options = {}) {
    const soql = [
      'SELECT QualifiedApiName',
      'FROM EntityDefinition',
      `WHERE QualifiedApiName = '${escapeSoqlLiteral(apiName)}'`,
      'LIMIT 1'
    ].join(' ');
    const result = await query(orgAlias, soql, { ...options, tooling: true });
    return Boolean(result.records && result.records[0]);
  }

  async function countRecords(orgAlias, apiName, options = {}) {
    const result = await query(orgAlias, `SELECT count() FROM ${apiName}`, options);
    return Number(result.totalSize || 0);
  }

  async function queryAllRecords(orgAlias, apiName, fields, options = {}) {
    const uniqueFields = [...new Set(fields.filter(Boolean))];
    const soql = `SELECT ${uniqueFields.join(', ')} FROM ${apiName}`;
    const result = await query(orgAlias, soql, options);
    return result.records || [];
  }

  async function createRecord(orgAlias, apiName, valuesArg, options = {}) {
    return runSf(
      ['data', 'create', 'record', '--target-org', orgAlias, '--sobject', apiName, '--values', valuesArg],
      options
    );
  }

  async function updateRecord(orgAlias, apiName, recordId, valuesArg, options = {}) {
    return runSf(
      ['data', 'update', 'record', '--target-org', orgAlias, '--sobject', apiName, '--record-id', recordId, '--values', valuesArg],
      options
    );
  }

  async function runApexFile(orgAlias, filePath, options = {}) {
    return runSf(['apex', 'run', '--target-org', orgAlias, '--file', filePath], options);
  }

  async function retrieveMetadataComponents(orgAlias, metadataComponents, options = {}) {
    const uniqueComponents = [...new Set((metadataComponents || []).filter(Boolean))];
    if (!uniqueComponents.length) {
      throw new Error('No metadata components were provided for retrieval.');
    }

    const args = ['project', 'retrieve', 'start', '--target-org', orgAlias, '--ignore-conflicts'];
    for (const componentName of uniqueComponents) {
      args.push('--metadata', componentName);
    }

    const payload = await runSfJson(args, options);
    return payload.result || payload;
  }

  async function deploySourcePaths(orgAlias, sourcePaths, options = {}) {
    const uniquePaths = [...new Set((sourcePaths || []).filter(Boolean))];
    if (!uniquePaths.length) {
      throw new Error('No source paths were provided for deployment.');
    }

    const args = ['project', 'deploy', 'start', '--target-org', orgAlias, '--wait', String(options.waitMinutes || 30)];
    for (const sourcePath of uniquePaths) {
      args.push('--source-dir', sourcePath);
    }

    const payload = await runSfJson(args, options);
    return payload.result || payload;
  }

  return {
    delay,
    runSf,
    runSfJson,
    query,
    listOrgs,
    listMetadata,
    getOrgId,
    getCustomSettings,
    getCustomMetadataTypes,
    getFieldDefinitions,
    entityExists,
    countRecords,
    queryAllRecords,
    createRecord,
    updateRecord,
    runApexFile,
    retrieveMetadataComponents,
    deploySourcePaths,
    escapeSoqlLiteral,
    escapeRecordValue
  };
}

module.exports = {
  createCliRunner,
  escapeSoqlLiteral,
  escapeRecordValue,
  extractJsonPayload,
  delay
};
