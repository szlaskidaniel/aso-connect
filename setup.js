#!/usr/bin/env node
// setup.js - Interactive setup for ASO Connect with App Store Connect credentials

import { readdirSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { createInterface } from 'readline';
import { execSync } from 'child_process';

const PROJECT_DIR = resolve(import.meta.dirname || '.');

function ask(rl, question) {
  return new Promise(r => rl.question(question, r));
}

function findP8Files() {
  try {
    return readdirSync(PROJECT_DIR)
      .filter(f => f.endsWith('.p8'))
      .map(f => ({
        path: resolve(PROJECT_DIR, f),
        filename: f,
        keyId: f.match(/^AuthKey_(.+)\.p8$/)?.[1] || null,
      }));
  } catch {
    return [];
  }
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  ASO Connect - Setup\n');

  // Step 1: Look for p8 files in the project root
  const p8Files = findP8Files();
  let privateKeyPath = null;
  let keyId = null;

  if (p8Files.length === 1) {
    const f = p8Files[0];
    console.log(`  Found p8 key: ${f.filename}`);
    if (f.keyId) {
      console.log(`  Extracted Key ID: ${f.keyId}`);
    }
    const use = await ask(rl, `  Use this file? (Y/n) `);
    if (!use || use.toLowerCase() === 'y') {
      privateKeyPath = f.path;
      keyId = f.keyId;
    }
  } else if (p8Files.length > 1) {
    console.log('  Found multiple p8 files:');
    p8Files.forEach((f, i) => console.log(`    ${i + 1}) ${f.filename}${f.keyId ? ` (Key ID: ${f.keyId})` : ''}`));
    const choice = await ask(rl, `  Which one? (1-${p8Files.length}) `);
    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < p8Files.length) {
      privateKeyPath = p8Files[idx].path;
      keyId = p8Files[idx].keyId;
    }
  }

  if (!privateKeyPath) {
    console.log('  No p8 file found in the project root.');
    console.log('  Download your key from App Store Connect and place the .p8 file here.');
    console.log('  Then re-run: node setup.js\n');
    rl.close();
    process.exit(1);
  }

  // Step 2: Confirm or ask for Key ID
  if (keyId) {
    const confirm = await ask(rl, `  Key ID [${keyId}]: `);
    if (confirm.trim()) keyId = confirm.trim();
  } else {
    keyId = (await ask(rl, '  Key ID: ')).trim();
    if (!keyId) {
      console.log('  Key ID is required.\n');
      rl.close();
      process.exit(1);
    }
  }

  // Step 3: Ask for Issuer ID
  const issuerId = (await ask(rl, '  Issuer ID: ')).trim();
  if (!issuerId) {
    console.log('  Issuer ID is required.\n');
    rl.close();
    process.exit(1);
  }

  rl.close();

  // Step 4: Register MCP server
  console.log('\n  Registering MCP server with Claude Code...\n');

  // Remove existing registration (ignore errors if not registered)
  try {
    execSync('claude mcp remove aso-connect', { stdio: 'ignore' });
  } catch {}

  const serverPath = resolve(PROJECT_DIR, 'mcp-server.js');
  const cmd = [
    'claude', 'mcp', 'add', 'aso-connect',
    '-e', `ASC_KEY_ID=${keyId}`,
    '-e', `ASC_ISSUER_ID=${issuerId}`,
    '-e', `ASC_PRIVATE_KEY_PATH=${privateKeyPath}`,
    '--', 'node', serverPath,
  ];

  try {
    execSync(cmd.join(' '), { stdio: 'inherit' });
    console.log('\n  Done! ASO Connect is registered with App Store Connect credentials.');
    console.log('  Restart Claude Code to use the new configuration.\n');
  } catch (e) {
    console.error('\n  Failed to register MCP server:', e.message);
    console.log('\n  You can register manually:\n');
    console.log(`  claude mcp add aso-connect \\`);
    console.log(`    -e ASC_KEY_ID=${keyId} \\`);
    console.log(`    -e ASC_ISSUER_ID=${issuerId} \\`);
    console.log(`    -e ASC_PRIVATE_KEY_PATH=${privateKeyPath} \\`);
    console.log(`    -- node ${serverPath}\n`);
    process.exit(1);
  }
}

main();
