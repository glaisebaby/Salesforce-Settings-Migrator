#!/usr/bin/env node

const path = require('path');

const { createCliRunner } = require('../src/salesforceCli');

const SYSTEM_FIELDS = new Set([
  'Id',
  'IsDeleted',
  'CreatedById',
  'CreatedDate',
  'LastModifiedById',
  'LastModifiedDate',
  'SystemModstamp',
  'LastViewedDate',
  'LastReferencedDate',
  'OwnerId'
]);

const LOCATION_NAMES = ['CALI', '558-DC', '558-DCBLK', 'VANCOUVER'];
const GROUP_NAME = 'ECOMM_GROUP';

function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function parseArgs(argv) {
  const args = {
    source: '',
    target: '',
    groupName: GROUP_NAME,
    locations: [...LOCATION_NAMES]
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--source' && next) {
      args.source = next;
      index += 1;
    } else if (token === '--target' && next) {
      args.target = next;
      index += 1;
    } else if (token === '--group' && next) {
      args.groupName = next;
      index += 1;
    } else if (token === '--locations' && next) {
      args.locations = next.split(',').map((item) => item.trim()).filter(Boolean);
      index += 1;
    }
  }

  if (!args.source || !args.target) {
    throw new Error('Usage: node scripts/migrate-location-group.js --source <alias> --target <alias> [--group ECOMM_GROUP]');
  }
  if (args.source === args.target) {
    throw new Error('Source and target org aliases must be different.');
  }
  if (!args.locations.length) {
    throw new Error('At least one location name is required.');
  }

  return args;
}

function toComparable(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(toComparable).join(';');
  }
  return String(value);
}

async function getEntityFields(cli, orgAlias, apiName) {
  const fields = await cli.getFieldDefinitions(orgAlias, apiName);
  return (fields || []).filter((field) => {
    const name = field.QualifiedApiName;
    return name && !field.IsCalculated && !SYSTEM_FIELDS.has(name);
  });
}

function getTransferableFields(fields, preferredFirst = []) {
  const available = new Set(fields.map((field) => field.QualifiedApiName).filter(Boolean));
  const orderedPreferred = preferredFirst.filter((name) => available.has(name));
  const rest = fields
    .map((field) => field.QualifiedApiName)
    .filter((name) => name && !preferredFirst.includes(name))
    .sort((left, right) => left.localeCompare(right));
  return [...new Set([...orderedPreferred, ...rest])];
}

async function querySingleByName(cli, orgAlias, apiName, fields, name) {
  const soql = `SELECT ${fields.join(', ')} FROM ${apiName} WHERE Name = ${quote(name)} LIMIT 1`;
  const result = await cli.query(orgAlias, soql);
  return result.records && result.records[0] ? result.records[0] : null;
}

async function detectGroupDeveloperNameField(cli, orgAlias) {
  const fieldNames = new Set((await getEntityFields(cli, orgAlias, 'LocationGroup')).map((field) => field.QualifiedApiName));
  if (fieldNames.has('DeveloperName')) {
    return 'DeveloperName';
  }
  return '';
}

async function detectGroupMembershipShape(cli, orgAlias) {
  const candidates = ['LocationGroupAssignment', 'LocationGroupMember', 'LocationGroupLocation'];

  for (const apiName of candidates) {
    const exists = await cli.entityExists(orgAlias, apiName).catch(() => false);
    if (!exists) {
      continue;
    }

    const fieldNames = new Set((await getEntityFields(cli, orgAlias, apiName)).map((field) => field.QualifiedApiName));
    const locationGroupField = ['LocationGroupId', 'LocationGroup', 'LocationGroupRef'].find((field) => fieldNames.has(field)) || '';
    const locationField = ['LocationId', 'Location', 'RelatedLocationId'].find((field) => fieldNames.has(field)) || '';

    if (locationGroupField && locationField) {
      return { apiName, locationGroupField, locationField };
    }
  }

  throw new Error(
    'Could not detect the location group membership object in this org. Tried LocationGroupAssignment, LocationGroupMember, and LocationGroupLocation.'
  );
}

function buildValuesArg(fields, sourceRecord, targetRecord) {
  const pairs = [];
  const changedFields = [];

  for (const field of fields) {
    if (field === 'Name' || field === 'DeveloperName') {
      continue;
    }
    const nextValue = sourceRecord[field];
    const existingValue = targetRecord ? targetRecord[field] : undefined;
    if (toComparable(nextValue) === toComparable(existingValue)) {
      continue;
    }
    pairs.push(`${field}=${cli.escapeRecordValue(nextValue)}`);
    changedFields.push(field);
  }

  return {
    valuesArg: pairs.join(' '),
    changedFields
  };
}

let cli;

async function upsertLocation(sourceOrg, targetOrg, locationName) {
  const sourceFields = await getEntityFields(cli, sourceOrg, 'Location');
  const targetFields = await getEntityFields(cli, targetOrg, 'Location');
  const targetFieldSet = new Set(targetFields.map((field) => field.QualifiedApiName));
  const transferableFields = getTransferableFields(
    sourceFields.filter((field) => targetFieldSet.has(field.QualifiedApiName)),
    ['Name']
  );

  const sourceRecord = await querySingleByName(cli, sourceOrg, 'Location', transferableFields, locationName);
  if (!sourceRecord) {
    throw new Error(`Source location ${locationName} was not found in ${sourceOrg}.`);
  }

  const targetRecord = await querySingleByName(cli, targetOrg, 'Location', ['Id', ...transferableFields], locationName);
  const { valuesArg, changedFields } = buildValuesArg(transferableFields, sourceRecord, targetRecord);

  if (!targetRecord) {
    const createValuesArg = transferableFields
      .filter((field) => sourceRecord[field] !== null && sourceRecord[field] !== undefined)
      .map((field) => `${field}=${cli.escapeRecordValue(sourceRecord[field])}`)
      .join(' ');

    if (!createValuesArg) {
      throw new Error(`Location ${locationName} has no supported values to create in ${targetOrg}.`);
    }

    await cli.createRecord(targetOrg, 'Location', createValuesArg);
    const created = await querySingleByName(cli, targetOrg, 'Location', ['Id', 'Name'], locationName);
    if (!created?.Id) {
      throw new Error(`Location ${locationName} was created but could not be re-queried in ${targetOrg}.`);
    }
    return { action: 'created', id: created.Id, changedFields: transferableFields.filter((field) => field !== 'Id') };
  }

  if (!valuesArg) {
    return { action: 'unchanged', id: targetRecord.Id, changedFields: [] };
  }

  await cli.updateRecord(targetOrg, 'Location', targetRecord.Id, valuesArg);
  return { action: 'updated', id: targetRecord.Id, changedFields };
}

async function upsertLocationGroup(sourceOrg, targetOrg, groupName) {
  const sourceFields = await getEntityFields(cli, sourceOrg, 'LocationGroup');
  const targetFields = await getEntityFields(cli, targetOrg, 'LocationGroup');
  const targetFieldSet = new Set(targetFields.map((field) => field.QualifiedApiName));
  const transferableFields = getTransferableFields(
    sourceFields.filter((field) => targetFieldSet.has(field.QualifiedApiName)),
    ['Name', 'DeveloperName']
  );
  const developerNameField = await detectGroupDeveloperNameField(cli, sourceOrg);

  const sourceRecord = await querySingleByName(cli, sourceOrg, 'LocationGroup', transferableFields, groupName);
  if (!sourceRecord) {
    throw new Error(`Source location group ${groupName} was not found in ${sourceOrg}.`);
  }

  const targetRecord = await querySingleByName(cli, targetOrg, 'LocationGroup', ['Id', ...transferableFields], groupName);
  const { valuesArg, changedFields } = buildValuesArg(transferableFields, sourceRecord, targetRecord);

  if (!targetRecord) {
    const createFields = transferableFields.filter((field) => sourceRecord[field] !== null && sourceRecord[field] !== undefined);
    const createValuesArg = createFields.map((field) => `${field}=${cli.escapeRecordValue(sourceRecord[field])}`).join(' ');

    if (!createValuesArg) {
      throw new Error(`Location group ${groupName} has no supported values to create in ${targetOrg}.`);
    }

    await cli.createRecord(targetOrg, 'LocationGroup', createValuesArg);
    const created = await querySingleByName(cli, targetOrg, 'LocationGroup', ['Id', 'Name', ...(developerNameField ? [developerNameField] : [])], groupName);
    if (!created?.Id) {
      throw new Error(`Location group ${groupName} was created but could not be re-queried in ${targetOrg}.`);
    }
    return {
      action: 'created',
      id: created.Id,
      name: created.Name,
      developerName: developerNameField ? created[developerNameField] || '' : ''
    };
  }

  if (valuesArg) {
    await cli.updateRecord(targetOrg, 'LocationGroup', targetRecord.Id, valuesArg);
  }

  return {
    action: valuesArg ? 'updated' : 'unchanged',
    id: targetRecord.Id,
    name: targetRecord.Name,
    developerName: developerNameField ? targetRecord[developerNameField] || sourceRecord[developerNameField] || '' : '',
    changedFields
  };
}

async function ensureMembership(targetOrg, membershipShape, locationGroupId, locationId) {
  const soql =
    `SELECT Id FROM ${membershipShape.apiName} ` +
    `WHERE ${membershipShape.locationGroupField} = ${quote(locationGroupId)} ` +
    `AND ${membershipShape.locationField} = ${quote(locationId)} LIMIT 1`;
  const existing = await cli.query(targetOrg, soql);
  if (existing.records && existing.records[0]) {
    return 'unchanged';
  }

  await cli.createRecord(
    targetOrg,
    membershipShape.apiName,
    `${membershipShape.locationGroupField}=${cli.escapeRecordValue(locationGroupId)} ${membershipShape.locationField}=${cli.escapeRecordValue(locationId)}`
  );
  return 'created';
}

async function main() {
  const args = parseArgs(process.argv);
  cli = createCliRunner({ cwd: path.resolve(__dirname, '..') });

  console.log(`Copying Location and LocationGroup data from ${args.source} to ${args.target}`);
  console.log(`Location group: ${args.groupName}`);
  console.log(`Locations: ${args.locations.join(', ')}`);

  const membershipShape = await detectGroupMembershipShape(cli, args.target);
  const locationResults = [];

  for (const locationName of args.locations) {
    const result = await upsertLocation(args.source, args.target, locationName);
    locationResults.push({ name: locationName, ...result });
    console.log(`Location ${locationName}: ${result.action}`);
    if (result.changedFields?.length) {
      console.log(`  Fields: ${result.changedFields.join(', ')}`);
    }
  }

  const groupResult = await upsertLocationGroup(args.source, args.target, args.groupName);
  console.log(`LocationGroup ${args.groupName}: ${groupResult.action}`);
  if (groupResult.changedFields?.length) {
    console.log(`  Fields: ${groupResult.changedFields.join(', ')}`);
  }

  for (const locationResult of locationResults) {
    const membershipResult = await ensureMembership(args.target, membershipShape, groupResult.id, locationResult.id);
    console.log(`Membership ${args.groupName} -> ${locationResult.name}: ${membershipResult}`);
  }

  console.log('Migration complete.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
