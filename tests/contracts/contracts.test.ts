import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'node:fs';
import path from 'node:path';

const CONTRACTS_DIR = path.join(import.meta.dirname, '..', '..', 'contracts');
const EXAMPLES_DIR = path.join(CONTRACTS_DIR, 'examples');

const ajv = new Ajv({ strict: false });
addFormats(ajv);

function loadJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

describe('PolarProcess contracts', () => {
  it('process-api.schema.json is valid JSON Schema', () => {
    const schema = loadJson(path.join(CONTRACTS_DIR, 'process-api.schema.json'));
    const validate = ajv.compile(schema);
    expect(typeof validate).toBe('function');
  });

  it('scheduler-api.schema.json is valid JSON Schema', () => {
    const schema = loadJson(path.join(CONTRACTS_DIR, 'scheduler-api.schema.json'));
    const validate = ajv.compile(schema);
    expect(typeof validate).toBe('function');
  });

  it('services-list example validates against ProcessStatus definition', () => {
    const schema = loadJson(path.join(CONTRACTS_DIR, 'process-api.schema.json'));
    const example = loadJson(path.join(EXAMPLES_DIR, 'services-list.example.json'));
    const processStatusDef = schema.definitions?.ProcessStatus;
    const validate = ajv.compile(processStatusDef);
    for (const item of example.response) {
      expect(validate(item)).toBe(true);
    }
  });

  it('service-action example validates against ServiceActionResult definition', () => {
    const schema = loadJson(path.join(CONTRACTS_DIR, 'process-api.schema.json'));
    const example = loadJson(path.join(EXAMPLES_DIR, 'service-action.example.json'));
    const resultDef = schema.definitions?.ServiceActionResult;
    const validate = ajv.compile(resultDef);
    expect(validate(example.response)).toBe(true);
  });

  it('tasks-list example validates against HeavyTask definition', () => {
    const schema = loadJson(path.join(CONTRACTS_DIR, 'scheduler-api.schema.json'));
    const example = loadJson(path.join(EXAMPLES_DIR, 'tasks-list.example.json'));
    const taskDef = schema.definitions?.HeavyTask;
    const validate = ajv.compile(taskDef);
    for (const item of example.response) {
      expect(validate(item)).toBe(true);
    }
  });

  it('scheduler-status example validates against SchedulerStatus definition', () => {
    const schema = loadJson(path.join(CONTRACTS_DIR, 'scheduler-api.schema.json'));
    const example = loadJson(path.join(EXAMPLES_DIR, 'scheduler-status.example.json'));
    const statusDef = schema.definitions?.SchedulerStatus;
    const validate = ajv.compile(statusDef);
    expect(validate(example.response)).toBe(true);
  });
});
