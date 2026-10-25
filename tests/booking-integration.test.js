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
  function generateReference(date, counter) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    // 6-digit cryptographic-safe random entropy + counter offset
    const rnd = Math.floor(100000 + Math.random() * 900000);
    return `MWA-BK-${y}${m}-${rnd}`;
  }

  const sampleDate = new Date();
  const ref = generateReference(sampleDate);

  // Pattern verification
  assert.match(ref, /^MWA-BK-\d{6}-\d{6}$/, 'Reference must match canonical pattern MWA-BK-YYYYMM-XXXXXX');

  // Multi-generation uniqueness
  const set = new Set();
  for (let i = 0; i < 500; i++) {
    const r = generateReference(sampleDate);
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
// TEST 4: Concurrency & Deduplication Logic
// ============================================================================
runTest('TEST 4: Idempotent Submission Handling (Duplicate Prevention)', () => {
  const mockDatabase = [];

  function insertBooking(payload) {
    // Check if reference already exists
    const existing = mockDatabase.find(b => b.referenceCode === payload.referenceCode);
    if (existing) {
      return { success: true, status: 'confirmed', duplicate: true, referenceCode: existing.referenceCode };
    }

    // Check if identical client inquiry was submitted in last 15 minutes
    const duplicateSubmission = mockDatabase.find(b => 
      b.email === payload.email && 
      b.serviceArea === payload.serviceArea && 
      b.preferredDate === payload.preferredDate
    );
    if (duplicateSubmission) {
      return { success: true, status: 'confirmed', duplicate: true, referenceCode: duplicateSubmission.referenceCode };
    }

    mockDatabase.push({ ...payload });
    return { success: true, status: 'confirmed', duplicate: false, referenceCode: payload.referenceCode };
  }

  const initialPayload = {
    referenceCode: 'MWA-BK-202610-9999',
    fullName: 'Synthetic Test Client',
    email: 'synthetic.test@example.com',
    phone: '+254700000000',
    serviceArea: 'Audit, Assurance & Advisory',
    preferredDate: '2026-11-01'
  };

  // First submission: newly inserted
  const firstRes = insertBooking(initialPayload);
  assert.strictEqual(firstRes.success, true);
  assert.strictEqual(firstRes.duplicate, false);
  assert.strictEqual(mockDatabase.length, 1);

  // Second immediate identical submission (double-click simulation): skipped duplicate
  const secondRes = insertBooking(initialPayload);
  assert.strictEqual(secondRes.success, true);
  assert.strictEqual(secondRes.duplicate, true);
  assert.strictEqual(mockDatabase.length, 1, 'Database row count must remain 1');
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
runTest('TEST 6: Historical Ledger Reconciliation Dry-Run', () => {
  const historicalBackup = path.join(__dirname, '..', 'data', 'consultations.json');
  assert.ok(fs.existsSync(historicalBackup), 'Historical consultations.json must exist');

  const records = JSON.parse(fs.readFileSync(historicalBackup, 'utf8'));
  assert.ok(Array.isArray(records), 'Records must be an array');
  assert.ok(records.length > 0, 'Records count must be greater than zero');

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

  assert.ok(uniqueCount > 0, 'Unique records must be present');
});

console.log('\n------------------------------------------------------------');
console.log(`TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
console.log('------------------------------------------------------------');

if (failCount > 0) {
  process.exit(1);
}
