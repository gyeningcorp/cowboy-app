#!/usr/bin/env node
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const KEY_ID     = process.env.ASC_KEY_ID;
const ISSUER_ID  = process.env.ASC_ISSUER_ID;
const KEY_PATH   = process.env.ASC_KEY_PATH;
const APP_ID     = '6789995023';
const BUILD_NUM  = process.env.GITHUB_RUN_NUMBER;
const NEW_VERSION = '1.0.1';
const PUBLIC_BETA_GROUP_ID = 'ba702019-ed93-4ffe-aab3-9bf07da265a1';
const INTERNAL_GROUP_ID = '69edc09a-d6a2-4b6a-8eb7-c40fefd292ab';

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

const SUBMITTABLE = ['PREPARE_FOR_SUBMISSION','INVALID_BINARY','REJECTED','METADATA_REJECTED','DEVELOPER_REJECTED'];

async function main() {
  // 1. Wait for build
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

  // 1.5. Set export compliance FIRST — a build cannot be assigned to any beta group
  //      until encryption compliance is declared (otherwise the group-add returns
  //      422 "Build is not in an externally assignable state").
  console.log('🔒 Setting export compliance (usesNonExemptEncryption=false)...');
  const compR = await api('PATCH', `/v1/builds/${build.id}`, {
    data: { type:'builds', id:build.id, attributes:{ usesNonExemptEncryption:false } }
  });
  if (compR.status < 400) {
    console.log('✅ Export compliance set.');
  } else {
    console.log('⚠️  Could not set export compliance:', JSON.stringify(compR.body));
  }
  await sleep(3000);

  // 1.6. Add to TestFlight groups (compliance is now set, so the build is assignable).
  //      Internal group = instant, no review. Public Beta = external, needs beta review.
  //      Retry each add a few times since compliance can take a moment to propagate.
  async function addToGroup(name, groupId) {
    for (let i = 0; i < 4; i++) {
      const r = await api('POST', `/v1/betaGroups/${groupId}/relationships/builds`, {
        data: [{ type: 'builds', id: build.id }]
      });
      if (r.status === 204 || r.status === 200) { console.log(`✅ Build added to ${name}.`); return; }
      console.log(`  ${name} add status ${r.status}: ${JSON.stringify(r.body?.errors?.[0]?.detail ?? r.body)} — retry ${i+1}/4`);
      await sleep(15000);
    }
    console.log(`⚠️  Gave up adding build to ${name}.`);
  }
  console.log('📱 Adding build to TestFlight groups...');
  await addToGroup('Internal Testers', INTERNAL_GROUP_ID);
  await addToGroup('Public Beta', PUBLIC_BETA_GROUP_ID);

  // 1.7. Submit for external beta app review so external testers actually receive the build.
  //      Adding to an external group alone does NOT start review — this does.
  console.log('🧪 Submitting build for beta app review...');
  const betaR = await api('POST', '/v1/betaAppReviewSubmissions', {
    data: { type:'betaAppReviewSubmissions', relationships:{ build:{ data:{ type:'builds', id:build.id } } } }
  });
  if (betaR.status < 400) {
    console.log('✅ Beta review submitted. State:', betaR.body?.data?.attributes?.betaReviewState);
  } else {
    const detail = betaR.body?.errors?.[0]?.detail ?? '';
    // A duplicate submission (already in/awaiting review) is not a failure.
    console.log(`⚠️  Beta review submit status ${betaR.status}: ${detail || JSON.stringify(betaR.body)}`);
  }
  await sleep(2000);

  // 2. Cancel existing submissions
  console.log('🧹 Cancelling existing submissions...');
  const existingR = await api('GET', `/v1/reviewSubmissions?filter[app]=${APP_ID}&filter[platform]=IOS`);
  for (const s of (existingR.body.data || [])) {
    if (['WAITING_FOR_REVIEW','READY_FOR_REVIEW','DRAFT','UNRESOLVED_ISSUES'].includes(s.attributes.state)) {
      const cr = await api('PATCH', `/v1/reviewSubmissions/${s.id}`, {
        data: { type:'reviewSubmissions', id:s.id, attributes:{ canceled:true } }
      });
      console.log(`  ${cr.status < 400 ? '✅' : '⚠️'} Submission ${s.id} (${s.attributes.state})`);
    }
  }

  // 3. Get or create a submittable version
  const versR = await api('GET', `/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=5`);
  const versions = versR.body.data || [];
  console.log('Versions:', versions.map(v => `${v.attributes.versionString}:${v.attributes.appVersionState ?? v.attributes.appStoreState}`).join(', '));

  let version = versions.find(v => SUBMITTABLE.includes(v.attributes.appVersionState ?? v.attributes.appStoreState));

  // A version already in Apple's review pipeline (or awaiting release) is a DONE state,
  // not a failure: you cannot create or submit a new version while one is in flight, and
  // TestFlight distribution above already succeeded. Skip App Store submission and exit green.
  const IN_FLIGHT = ['WAITING_FOR_REVIEW','IN_REVIEW','PENDING_DEVELOPER_RELEASE',
    'PENDING_APPLE_RELEASE','PROCESSING_FOR_DISTRIBUTION','READY_FOR_REVIEW'];
  if (!version) {
    const inFlight = versions.find(v => IN_FLIGHT.includes(v.attributes.appVersionState ?? v.attributes.appStoreState));
    if (inFlight) {
      const st = inFlight.attributes.appVersionState ?? inFlight.attributes.appStoreState;
      console.log(`ℹ️  App Store version ${inFlight.attributes.versionString} is already ${st} — nothing to submit. TestFlight build is live for testers. Done.`);
      return;
    }
    console.log(`📦 No submittable version — creating ${NEW_VERSION}...`);
    const createR = await api('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform:'IOS', versionString: NEW_VERSION },
        relationships: { app: { data: { type:'apps', id:APP_ID } } }
      }
    });
    if (!createR.body.data) throw new Error(`Version create failed: ${JSON.stringify(createR.body.errors)}`);
    version = createR.body.data;
    console.log(`✅ Created version ${NEW_VERSION}: ${version.id}`);
    await sleep(2000);
  }

  // 4. Attach build
  console.log(`🔗 Attaching build to version ${version.attributes.versionString}...`);
  const patch = await api('PATCH', `/v1/appStoreVersions/${version.id}`, {
    data: { type:'appStoreVersions', id:version.id, relationships:{ build:{ data:{ type:'builds', id:build.id } } } }
  });
  if (patch.status >= 400) throw new Error(`Attach failed (${patch.status}): ${JSON.stringify(patch.body.errors)}`);
  console.log('✅ Build attached. State:', patch.body.data?.attributes?.appVersionState ?? patch.body.data?.attributes?.appStoreState);
  await sleep(3000);

  // 5. Create submission
  console.log('📋 Creating review submission...');
  const subR = await api('POST', '/v1/reviewSubmissions', {
    data: { type:'reviewSubmissions', attributes:{ platform:'IOS' }, relationships:{ app:{ data:{ type:'apps', id:APP_ID } } } }
  });
  if (!subR.body.data?.id) throw new Error(`Submission create failed: ${JSON.stringify(subR.body.errors)}`);
  const submissionId = subR.body.data.id;

  // 6. Add version item
  console.log('➕ Adding version to submission...');
  const itemR = await api('POST', '/v1/reviewSubmissionItems', {
    data: { type:'reviewSubmissionItems', relationships:{
      reviewSubmission:{ data:{ type:'reviewSubmissions', id:submissionId } },
      appStoreVersion:{ data:{ type:'appStoreVersions', id:version.id } }
    }}
  });
  if (itemR.status >= 400) throw new Error(`Add item failed: ${JSON.stringify(itemR.body.errors)}`);

  // 7. Submit
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
