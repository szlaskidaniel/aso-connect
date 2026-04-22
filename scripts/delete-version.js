#!/usr/bin/env node
// One-off: delete a pending App Store version by bundleId + versionString.
// Usage: node scripts/delete-version.js <bundleId> <versionString> [--confirm]

import { AppStoreConnectClient } from '../appstore-connect.js';

const [, , bundleId, versionString, confirmFlag] = process.argv;
if (!bundleId || !versionString) {
  console.error('Usage: node scripts/delete-version.js <bundleId> <versionString> [--confirm]');
  process.exit(1);
}
const confirm = confirmFlag === '--confirm';

const client = new AppStoreConnectClient({
  keyId: process.env.ASC_KEY_ID,
  issuerId: process.env.ASC_ISSUER_ID,
  privateKeyPath: process.env.ASC_PRIVATE_KEY_PATH,
});

const app = await client.lookupAppByBundleId(bundleId);
console.log(`App: ${app.name} (${app.bundleId}) id=${app.id}`);

const versions = await client.getAppVersions(app.id, { platform: 'IOS' });
console.log('iOS versions:');
for (const v of versions) console.log(`  ${v.versionString}  ${v.state}  id=${v.id}`);

const target = versions.find(v => v.versionString === versionString);
if (!target) {
  console.error(`\nNo iOS version "${versionString}" found.`);
  process.exit(2);
}
if (target.state !== 'PREPARE_FOR_SUBMISSION') {
  console.error(`\nVersion ${versionString} is in state ${target.state}, not PREPARE_FOR_SUBMISSION. Refusing to delete.`);
  process.exit(3);
}

if (!confirm) {
  console.log(`\nDry run. Would DELETE /v1/appStoreVersions/${target.id}. Re-run with --confirm.`);
  process.exit(0);
}

// Reuse the client's token path via a minimal fetch (client #request is private).
const now = Math.floor(Date.now() / 1000);
const { importPKCS8, SignJWT } = await import('jose');
const { readFileSync } = await import('fs');
const key = await importPKCS8(readFileSync(process.env.ASC_PRIVATE_KEY_PATH, 'utf8'), 'ES256');
const token = await new SignJWT({})
  .setProtectedHeader({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' })
  .setIssuer(process.env.ASC_ISSUER_ID)
  .setIssuedAt(now)
  .setExpirationTime(now + 600)
  .setAudience('appstoreconnect-v1')
  .sign(key);

const res = await fetch(`https://api.appstoreconnect.apple.com/v1/appStoreVersions/${target.id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${token}` },
});

if (res.status === 204) {
  console.log(`\nDeleted version ${versionString} (id=${target.id}).`);
} else {
  const body = await res.text();
  console.error(`\nDELETE failed: ${res.status} ${body}`);
  process.exit(4);
}
