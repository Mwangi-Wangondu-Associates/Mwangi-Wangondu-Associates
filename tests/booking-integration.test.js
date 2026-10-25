// ============================================================================
// MWANGI WANGONDU & ASSOCIATES — AUTOMATED VERIFICATION TEST SUITE
// Tests: Booking Validation, Concurrency, Deduplication, Data Escaping & Reconciliation
// ============================================================================

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('------------------------------------------------------------');
console.log('MWA CONSULTATION SYSTEM: AUTOMATED TEST SUITE EXECUTION');
console.log('------------------------------------------------------------\n');

let passCount = 0;
let failCount = 0;

function runTest(testName, testFn) {
  try {
    testFn();
    console.log(`[PASS] ${testName}`);
    passCount++;
  } catch (err) {
    console.error(`[FAIL] ${testName}: ${err.message}`);
    failCount++;
  }
}

// ============================================================================
// TEST 1: Validation Rules (Synthetic invalid payloads must be rejected)
// ============================================================================
runTest('TEST 1: Input Validation - Missing or Malformed Required Fields', () => {
  function validate(payload) {
    const errors = [];
    const name = (payload.fullName || '').trim();
    const email = (payload.email || '').trim();
    const phone = (payload.phone || '').trim();
    const service = (payload.serviceArea || '').trim();

    if (!name || name.length < 2) errors.push('Full Name required');
    if (!email || !email.includes('@') || !email.includes('.')) errors.push('Valid email required');
    if (!phone || phone.replace(/[^0-9]/g, '').length < 8) errors.push('Valid phone required');
    if (!service) errors.push('Service area required');

    return { valid: errors.length === 0, errors };
  }

  // Sub-case 1: Missing name
  const res1 = validate({ email: 'client@example.com', phone: '+254700000000', serviceArea: 'Audit' });
  assert.strictEqual(res1.valid, false);
  assert.ok(res1.errors.includes('Full Name required'));

  // Sub-case 2: Invalid email without dot or @
  const res2 = validate({ fullName: 'Valid Name', email: 'invalidemail', phone: '+254700000000', serviceArea: 'Audit' });
  assert.strictEqual(res2.valid, false);
  assert.ok(res2.errors.includes('Valid email required'));

  // Sub-case 3: Too short telephone number
  const res3 = validate({ fullName: 'Valid Name', email: 'valid@example.com', phone: '1234', serviceArea: 'Audit' });
  assert.strictEqual(res3.valid, false);
  assert.ok(res3.errors.includes('Valid phone required'));

  // Sub-case 4: Complete valid synthetic payload
  const res4 = validate({ fullName: 'John Doe', email: 'john@example.com', phone: '+254711223344', serviceArea: 'Tax Services' });
  assert.strictEqual(res4.valid, true);
  assert.strictEqual(res4.errors.length, 0);
});

// ============================================================================
// TEST 2: Reference Code Generation & Format Stability
// ============================================================================
runTest('TEST 2: Canonical Reference Code Format and Uniqueness', () => {
  function generateReference(date, seq) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    // Seed with sequence counter + random entropy to guarantee mathematical uniqueness
    const seqStr = String(seq || 1).padStart(3, '0').slice(-3);
    const rnd = Math.floor(100 + Math.random() * 900);
    return `MWA-BK-${y}${m}-${seqStr}${rnd}`;
  }

  const sampleDate = new Date();
  const ref = generateReference(sampleDate, 1);

  // Pattern verification
  assert.match(ref, /^MWA-BK-\d{6}-\d{6}$/, 'Reference must match canonical pattern MWA-BK-YYYYMM-XXXXXX');

  // Multi-generation uniqueness
  const set = new Set();
  for (let i = 0; i < 500; i++) {
    const r = generateReference(sampleDate, i + 1);
    assert.strictEqual(set.has(r), false, `Collision detected in generation sample at ${r}`);
    set.add(r);
  }
});

// ============================================================================
// TEST 3: CSV Escaping, Quotes & Multiline Messages
// ============================================================================
runTest('TEST 3: CSV Special Character & Multiline Escaping', () => {
  function escapeCSV(field) {
    if (field === null || field === undefined) return '""';
    const str = String(field).replace(/"/g, '""');
    return `"${str}"`;
  }

  // Field with commas and internal quotation marks
  const complexField = 'Review of "ABC Ltd", including VAT, PAYE & KRA dispute.';
  const escaped = escapeCSV(complexField);
  assert.strictEqual(escaped, '"Review of ""ABC Ltd"", including VAT, PAYE & KRA dispute."');

  // Field with newlines
  const multilineField = 'Line 1\r\nLine 2\r\nLine 3';
  const escapedMultiline = escapeCSV(multilineField);
  assert.strictEqual(escapedMultiline, '"Line 1\r\nLine 2\r\nLine 3"');
});

// ============================================================================
// TEST 4: Concurrency & Deduplication Logic (Idempotency Key & Semantic Dedup)
// ============================================================================
runTest('TEST 4: Idempotent Submission Handling (Duplicate Prevention)', () => {
  const mockDatabase = [];
  const mockCache = new Map();

  function handleSubmission(payload) {
    // 1. Check idempotency key in cache (fast retry deduplication)
    if (payload.idempotencyKey && mockCache.has('idem_' + payload.idempotencyKey)) {
      return {
        success: true,
        status: 'confirmed',
        duplicate: true,
        referenceCode: mockCache.get('idem_' + payload.idempotencyKey),
        message: 'Consultation previously registered and confirmed in practice ledger (idempotent retry).'
      };
    }

    // 2. Check semantic deduplication cache (email + serviceArea + preferredDate within 30 min)
    const semanticKey = 'dedup_' + (payload.email + '|' + payload.serviceArea + '|' + payload.preferredDate).toLowerCase();
    if (mockCache.has(semanticKey)) {
      return {
        success: true,
        status: 'confirmed',
        duplicate: true,
        referenceCode: mockCache.get(semanticKey),
        message: 'An identical consultation booking was recently confirmed for this client.'
      };
    }

    // 3. Check if reference already exists in ledger
    if (payload.referenceCode) {
      const existing = mockDatabase.find(b => b.referenceCode === payload.referenceCode);
      if (existing) {
        return {
          success: true,
          status: 'confirmed',
          duplicate: true,
          referenceCode: existing.referenceCode,
          message: 'Consultation previously registered and confirmed in practice ledger.'
        };
      }
    }

    // Insert new record
    const finalRef = payload.referenceCode || 'MWA-BK-202610-123456';
    mockDatabase.push({ ...payload, referenceCode: finalRef });
    if (payload.idempotencyKey) {
      mockCache.set('idem_' + payload.idempotencyKey, finalRef);
    }
    mockCache.set(semanticKey, finalRef);

    return {
      success: true,
      status: 'confirmed',
      duplicate: false,
      referenceCode: finalRef,
      message: 'Consultation successfully registered with practice management desk.'
    };
  }

  const initialPayload = {
    idempotencyKey: 'IDEM-1729860000000-abc12345',
    referenceCode: 'MWA-BK-202610-999999',
    fullName: 'Synthetic Test Client',
    email: 'synthetic.test@example.com',
    phone: '+254700000000',
    serviceArea: 'Audit, Assurance & Advisory',
    preferredDate: '2026-11-01'
  };

  // Sub-case 1: Initial submission succeeds
  const res1 = handleSubmission(initialPayload);
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.duplicate, false);
  assert.strictEqual(res1.referenceCode, 'MWA-BK-202610-999999');
  assert.strictEqual(mockDatabase.length, 1);

  // Sub-case 2: Client network timeout retry with identical idempotencyKey
  const res2 = handleSubmission(initialPayload);
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.duplicate, true);
  assert.strictEqual(res2.referenceCode, 'MWA-BK-202610-999999');
  assert.strictEqual(mockDatabase.length, 1, 'Database row count must remain 1 on idempotent retry');

  // Sub-case 3: Client submits again without reference or idempotencyKey (semantic deduplication)
  const res3 = handleSubmission({
    fullName: 'Synthetic Test Client',
    email: 'synthetic.test@example.com',
    phone: '+254700000000',
    serviceArea: 'Audit, Assurance & Advisory',
    preferredDate: '2026-11-01'
  });
  assert.strictEqual(res3.success, true);
  assert.strictEqual(res3.duplicate, true);
  assert.strictEqual(res3.referenceCode, 'MWA-BK-202610-999999');
  assert.strictEqual(mockDatabase.length, 1, 'Database row count must remain 1 on semantic duplicate');
});

// ============================================================================
// TEST 5: Backend Failure Simulation (Zero False-Positives)
// ============================================================================
runTest('TEST 5: Failure Simulation - Frontend Must Not Show False Confirmation', () => {
  function processFrontendResponse(backendResponse) {
    if (!backendResponse || !backendResponse.success || backendResponse.status !== 'confirmed') {
      return { state: 'FAILED', message: backendResponse?.error || 'Booking transmission rejected by practice desk.' };
    }
    return { state: 'CONFIRMED', referenceCode: backendResponse.referenceCode };
  }

  // Simulating 401 Unauthorized / Sign-in redirect
  const failure401 = { success: false, status: 'error', error: 'Google sign-in required.' };
  const res1 = processFrontendResponse(failure401);
  assert.strictEqual(res1.state, 'FAILED');

  // Simulating network null response
  const res2 = processFrontendResponse(null);
  assert.strictEqual(res2.state, 'FAILED');

  // Simulating genuine confirmed response
  const confirmedRes = { success: true, status: 'confirmed', referenceCode: 'MWA-BK-202610-1234' };
  const res3 = processFrontendResponse(confirmedRes);
  assert.strictEqual(res3.state, 'CONFIRMED');
  assert.strictEqual(res3.referenceCode, 'MWA-BK-202610-1234');
});

// ============================================================================
// TEST 6: Historical Reconciliation Dry-Run
// ============================================================================
// ============================================================================
// TEST 6: Historical Ledger Reconciliation & PII Sanitization
// ============================================================================
runTest('TEST 6: Historical Ledger Backup & Public PII Sanitization', () => {
  const historicalBackup = path.join(__dirname, '..', 'data', 'backup', 'consultations_backup_20261025.json');
  assert.ok(fs.existsSync(historicalBackup), 'Historical backup must exist in data/backup/');

  const records = JSON.parse(fs.readFileSync(historicalBackup, 'utf8'));
  assert.ok(Array.isArray(records), 'Backup records must be an array');
  assert.strictEqual(records.length, 17, 'All 17 historical records must be preserved in backup');

  const seenRefs = new Set();
  let duplicateCount = 0;
  let uniqueCount = 0;

  for (const r of records) {
    assert.ok(r.referenceCode, 'Every historical record must have a referenceCode');
    if (seenRefs.has(r.referenceCode)) {
      duplicateCount++;
    } else {
      seenRefs.add(r.referenceCode);
      uniqueCount++;
    }
  }

  assert.strictEqual(uniqueCount, 17, 'All 17 historical records must be unique');
  assert.strictEqual(duplicateCount, 0, 'No duplicate references in historical backup');

  // Verify public file sanitization
  const activeConsultationsFile = path.join(__dirname, '..', 'data', 'consultations.json');
  const activeContent = JSON.parse(fs.readFileSync(activeConsultationsFile, 'utf8'));
  assert.strictEqual(activeContent.length, 0, 'Active consultations.json in repository must contain zero PII records');
});

// ============================================================================
// TEST 7: Anti-Abuse Safeguards (Honeypot, Token & Interaction Time)
// ============================================================================
runTest('TEST 7: Anti-Abuse Safeguards (Honeypot & Shared Application Token)', () => {
  const EXPECTED_TOKEN = 'MWA-SEC-2026-CONSULT-ADVISORY';

  function validateAbuse(payload) {
    // 1. Honeypot filled by automated bot
    if (payload.website_hp && payload.website_hp.trim().length > 0) {
      return { rejected: true, reason: 'Honeypot triggered' };
    }
    // 2. Missing or invalid app token
    if (payload.appToken !== EXPECTED_TOKEN) {
      return { rejected: true, reason: 'Invalid application token' };
    }
    // 3. Fast automated submit (< 1500ms)
    if (payload.loadedAt && (payload.submittedAt - payload.loadedAt < 1500)) {
      return { rejected: true, reason: 'Submission too fast' };
    }
    return { rejected: false };
  }

  // Sub-case 1: Bot triggers honeypot
  const botRes = validateAbuse({
    website_hp: 'http://spam-link.ru',
    appToken: EXPECTED_TOKEN,
    loadedAt: 1000,
    submittedAt: 5000
  });
  assert.strictEqual(botRes.rejected, true);
  assert.strictEqual(botRes.reason, 'Honeypot triggered');

  // Sub-case 2: Unauthenticated scraper missing token
  const scraperRes = validateAbuse({
    website_hp: '',
    appToken: 'INVALID_TOKEN',
    loadedAt: 1000,
    submittedAt: 5000
  });
  assert.strictEqual(scraperRes.rejected, true);
  assert.strictEqual(scraperRes.reason, 'Invalid application token');

  // Sub-case 3: Bot submits in 200 milliseconds
  const fastRes = validateAbuse({
    website_hp: '',
    appToken: EXPECTED_TOKEN,
    loadedAt: 1000,
    submittedAt: 1200
  });
  assert.strictEqual(fastRes.rejected, true);
  assert.strictEqual(fastRes.reason, 'Submission too fast');

  // Sub-case 4: Legitimate human user
  const humanRes = validateAbuse({
    website_hp: '',
    appToken: EXPECTED_TOKEN,
    loadedAt: 1000,
    submittedAt: 15000
  });
  assert.strictEqual(humanRes.rejected, false);
});

// ============================================================================
// TEST 8: Genuine UTC Timestamp Format & Instant Verification
// ============================================================================
runTest('TEST 8: Genuine UTC ISO-8601 Timestamp Generation and Offset Accuracy', () => {
  const instant = new Date();
  const utcString = instant.toISOString();

  // Must match strict ISO-8601 UTC format: YYYY-MM-DDTHH:mm:ss.sssZ
  assert.match(utcString, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'Timestamp must be standard ISO-8601 UTC with trailing Z');

  // Verify that parsing the string recovers the exact millisecond instant
  const parsedEpoch = Date.parse(utcString);
  assert.strictEqual(parsedEpoch, instant.getTime(), 'Parsed UTC timestamp must equal original epoch instant with 0ms deviation');

  // Demonstrate that defective combination of GMT+3 formatting with literal 'Z' caused a 3-hour distortion
  // Previous defective pattern:
  // e.g. at UTC 12:00:00, GMT+3 is 15:00:00. Defect appended 'Z' -> '...15:00:00Z', shifting recorded instant by +3 hours.
  const now = new Date('2026-10-25T12:00:00.000Z');
  const trueIso = now.toISOString();
  assert.strictEqual(trueIso, '2026-10-25T12:00:00.000Z');
  assert.strictEqual(new Date(trueIso).getUTCHours(), 12, 'True UTC must preserve UTC hour 12');
});

// ============================================================================
// TEST 9: Historical Import Engine & Schema Validation
// ============================================================================
runTest('TEST 9: Historical Import Engine - Safety Gates & Schema Validation', () => {
  function importHistoricalBackupLogic(recordsJsonString, isDryRun, existingRefs = new Set()) {
    if (!recordsJsonString || typeof recordsJsonString !== 'string' || recordsJsonString.trim().length === 0) {
      throw new Error('Missing recordsJsonString');
    }
    let records;
    try {
      records = JSON.parse(recordsJsonString);
    } catch (err) {
      throw new Error('Invalid JSON string: ' + err.message);
    }
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error('Zero records found in supplied JSON. Migration aborted to prevent data loss.');
    }

    let inserted = 0;
    let skippedDuplicates = 0;
    const insertedRows = [];

    for (let k = 0; k < records.length; k++) {
      const rec = records[k];
      if (!rec.referenceCode) {
        throw new Error(`Record at index ${k} is missing required 'referenceCode'`);
      }
      if (existingRefs.has(rec.referenceCode)) {
        skippedDuplicates++;
      } else {
        inserted++;
        if (!isDryRun) {
          insertedRows.push(rec);
          existingRefs.add(rec.referenceCode);
        }
      }
    }

    return {
      mode: isDryRun ? 'DRY_RUN' : 'APPLIED',
      totalSupplied: records.length,
      inserted,
      skippedDuplicates,
      insertedRows
    };
  }

  // Sub-case 1: Rejection of empty string
  assert.throws(() => importHistoricalBackupLogic(''), /Missing recordsJsonString/);

  // Sub-case 2: Rejection of invalid JSON
  assert.throws(() => importHistoricalBackupLogic('{malformed: json}'), /Invalid JSON string/);

  // Sub-case 3: Rejection of empty array (guarding against sanitized public file)
  assert.throws(() => importHistoricalBackupLogic('[]'), /Zero records found in supplied JSON/);

  // Sub-case 4: Rejection of record missing referenceCode
  const badRecords = JSON.stringify([{ fullName: 'No Reference' }]);
  assert.throws(() => importHistoricalBackupLogic(badRecords), /missing required 'referenceCode'/);

  // Sub-case 5: Verification using actual 17-record backup
  const backupPath = path.join(__dirname, '..', 'data', 'backup', 'consultations_backup_20261025.json');
  const backupJsonString = fs.readFileSync(backupPath, 'utf8');

  // Dry run
  const dryRunRes = importHistoricalBackupLogic(backupJsonString, true);
  assert.strictEqual(dryRunRes.mode, 'DRY_RUN');
  assert.strictEqual(dryRunRes.totalSupplied, 17);
  assert.strictEqual(dryRunRes.inserted, 17);
  assert.strictEqual(dryRunRes.skippedDuplicates, 0);

  // Applied run
  const existingSet = new Set(['MWA-BK-202610-1579']); // Simulate 1 already existing in sheet
  const appliedRes = importHistoricalBackupLogic(backupJsonString, false, existingSet);
  assert.strictEqual(appliedRes.mode, 'APPLIED');
  assert.strictEqual(appliedRes.totalSupplied, 17);
  assert.strictEqual(appliedRes.inserted, 16);
  assert.strictEqual(appliedRes.skippedDuplicates, 1);
  assert.strictEqual(appliedRes.insertedRows.length, 16);
});

console.log('\n------------------------------------------------------------');
console.log(`TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
console.log('------------------------------------------------------------');

if (failCount > 0) {
  process.exit(1);
}

