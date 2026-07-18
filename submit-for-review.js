#!/usr/bin/env node
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const ASC_KEY_ID    = process.env.ASC_KEY_ID;
const ASC_ISSUER_ID = process.env.ASC_ISSUER_ID;
const ASC_KEY_PATH  = process.env.ASC_KEY_PATH;
const BUNDLE_ID     = 'com.innercircle.cowboy';
const BUILD_NUMBER  = process.env.GITHUB_RUN_NUMBER;

function makeJWT() {
  const privKey = fs.readFileSync(ASC_KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg:'ES256', kid:ASC_KEY_ID, typ:'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss:ASC_ISSUER_ID, iat:now, exp:now+1200, aud:'appstoreconnect-v1' })).toString('base64url');
  const toSign  = `${header}.${payload}`;
  const sign    = crypto.createSign('SHA256');
  sign.update(toSign);
  return `${toSign}.${sign.sign({ key:privKey, dsaEncoding:'ieee-p1363' }).toString('base64url')}`;
}

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.appstoreconnect.apple.com',
      path: apiPath, method,
      headers: {
        Authorization: `Bearer ${makeJWT()}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('🔍 Finding app...');
  const appsRes = await api('GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=id,name`);
  const app = appsRes.body.data?.[0];
  if (!app) throw new Error(`App not found: ${BUNDLE_ID}`);
  const appId = app.id;
  console.log(`✅ App ID: ${appId}`);

  // Poll up to 10 minutes for build to be processed
  console.log(`⏳ Waiting for build ${BUILD_NUMBER} to be processed by Apple...`);
  let build = null;
  for (let i = 0; i < 20; i++) {
    const res = await api('GET', `/v1/builds?filter[app]=${appId}&filter[version]=${BUILD_NUMBER}&filter[processingState]=VALID&limit=1`);
    if (res.body.data?.length) { build = res.body.data[0]; break; }
    console.log(`  Still processing... (${(i + 1) * 30}s elapsed)`);
    await sleep(30000);
  }
  if (!build) throw new Error('Build not processed within 10 minutes');
  console.log(`✅ Build ID: ${build.id}`);

  // Find the version in PREPARE_FOR_SUBMISSION state
  console.log('🔍 Finding app store version...');
  const verRes = await api('GET', `/v1/apps/${appId}/appStoreVersions?filter[appVersionState]=PREPARE_FOR_SUBMISSION&filter[platform]=IOS`);
  const version = verRes.body.data?.[0];
  if (!version) throw new Error('No version in PREPARE_FOR_SUBMISSION state. Create one in App Store Connect first.');
  console.log(`✅ Version: ${version.attributes?.versionString} (${version.id})`);

  // Attach build to version
  console.log('🔗 Attaching build to version...');
  const patchRes = await api('PATCH', `/v1/appStoreVersions/${version.id}`, {
    data: {
      type: 'appStoreVersions',
      id: version.id,
      relationships: { build: { data: { type: 'builds', id: build.id } } }
    }
  });
  if (patchRes.status >= 400) throw new Error(`Failed to attach build: ${JSON.stringify(patchRes.body.errors)}`);
  console.log('✅ Build attached');

  // Submit for review
  console.log('🚀 Submitting for App Store review...');
  const submitRes = await api('POST', '/v1/appStoreVersionSubmissions', {
    data: {
      type: 'appStoreVersionSubmissions',
      relationships: {
        appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } }
      }
    }
  });
  if (submitRes.status === 201) {
    console.log('✅ Submitted for App Store review!');
  } else {
    console.error('❌ Submission failed:', JSON.stringify(submitRes.body.errors || submitRes.body, null, 2));
    process.exit(1);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
