#!/usr/bin/env node
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const KEY_ID     = process.env.ASC_KEY_ID;
const ISSUER_ID  = process.env.ASC_ISSUER_ID;
const KEY_PATH   = process.env.ASC_KEY_PATH;
const APP_ID     = '6789995023';
const BUILD_NUM  = process.env.GITHUB_RUN_NUMBER;

function makeJWT() {
  const privKey = fs.readFileSync(KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg:'ES256', kid:KEY_ID, typ:'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss:ISSUER_ID, iat:now, exp:now+1200, aud:'appstoreconnect-v1' })).toString('base64url');
  const s = crypto.createSign('SHA256'); s.update(h+'.'+p);
  return `${h}.${p}.${s.sign({ key:privKey, dsaEncoding:'ieee-p1363' }).toString('base64url')}`;
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.appstoreconnect.apple.com',
      path, method,
      headers: {
        Authorization: `Bearer ${makeJWT()}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
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
  // Poll up to 10 minutes for the build to be VALID
  console.log(`⏳ Waiting for build ${BUILD_NUM} to be processed...`);
  let build = null;
  for (let i = 0; i < 20; i++) {
    const r = await api('GET', `/v1/builds?filter[app]=${APP_ID}&filter[version]=${BUILD_NUM}&filter[processingState]=VALID&limit=1`);
    if (r.body.data?.length) { build = r.body.data[0]; break; }
    console.log(`  Still processing... (${(i+1)*30}s)`);
    await sleep(30000);
  }
  if (!build) throw new Error('Build not processed within 10 minutes');
  console.log(`✅ Build ${BUILD_NUM} ready: ${build.id}`);

  // Get the iOS version in PREPARE_FOR_SUBMISSION or INVALID_BINARY (we'll reset it)
  const versR = await api('GET', `/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=5`);
  const versions = versR.body.data || [];
  const version = versions.find(v =>
    ['PREPARE_FOR_SUBMISSION','INVALID_BINARY','REJECTED','METADATA_REJECTED'].includes(v.attributes.appVersionState)
  );
  if (!version) throw new Error(`No submittable iOS version found. States: ${versions.map(v => v.attributes.appVersionState).join(', ')}`);
  console.log(`✅ Version: ${version.attributes.versionString} (${version.attributes.appVersionState}) — ${version.id}`);

  // Attach build (resets INVALID_BINARY → PREPARE_FOR_SUBMISSION)
  console.log('🔗 Attaching build to version...');
  const patch = await api('PATCH', `/v1/appStoreVersions/${version.id}`, {
    data: { type:'appStoreVersions', id:version.id, relationships:{ build:{ data:{ type:'builds', id:build.id } } } }
  });
  if (patch.status >= 400) throw new Error(`Attach failed: ${JSON.stringify(patch.body.errors)}`);
  console.log('✅ Build attached. State:', patch.body.data?.attributes?.appVersionState);

  // Cancel any UNRESOLVED_ISSUES or stale submissions
  const existingR = await api('GET', `/v1/reviewSubmissions?filter[app]=${APP_ID}&filter[platform]=IOS`);
  for (const s of (existingR.body.data || [])) {
    if (['UNRESOLVED_ISSUES','READY_FOR_REVIEW','DRAFT'].includes(s.attributes.state)) {
      console.log(`🧹 Cancelling stale submission ${s.id} (${s.attributes.state})...`);
      await api('PATCH', `/v1/reviewSubmissions/${s.id}`, {
        data: { type:'reviewSubmissions', id:s.id, attributes:{ canceled:true } }
      });
    }
  }

  // Create fresh reviewSubmission
  console.log('📋 Creating review submission...');
  const subR = await api('POST', '/v1/reviewSubmissions', {
    data: { type:'reviewSubmissions', attributes:{ platform:'IOS' }, relationships:{ app:{ data:{ type:'apps', id:APP_ID } } } }
  });
  if (!subR.body.data?.id) throw new Error(`Submission create failed: ${JSON.stringify(subR.body.errors)}`);
  const submissionId = subR.body.data.id;
  console.log(`✅ Submission: ${submissionId}`);

  // Add version to submission
  console.log('➕ Adding version to submission...');
  const itemR = await api('POST', '/v1/reviewSubmissionItems', {
    data: { type:'reviewSubmissionItems', relationships:{
      reviewSubmission:{ data:{ type:'reviewSubmissions', id:submissionId } },
      appStoreVersion:{ data:{ type:'appStoreVersions', id:version.id } }
    }}
  });
  if (itemR.status >= 400) throw new Error(`Add item failed: ${JSON.stringify(itemR.body.errors)}`);
  console.log('✅ Item added:', itemR.body.data?.id);

  // Submit
  console.log('🚀 Submitting for App Store review...');
  const result = await api('PATCH', `/v1/reviewSubmissions/${submissionId}`, {
    data: { type:'reviewSubmissions', id:submissionId, attributes:{ submitted:true } }
  });
  if (result.body.data) {
    console.log(`✅ Submitted! State: ${result.body.data.attributes?.state}`);
  } else {
    throw new Error(`Submit failed: ${JSON.stringify(result.body.errors)}`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
