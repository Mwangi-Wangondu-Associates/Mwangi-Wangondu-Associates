// ============================================================================
// MWANGI WANGONDU & ASSOCIATES (CPA-K)
// PRODUCTION GOOGLE APPS SCRIPT CONSULTATION BOOKING RECEIVER & LEDGER
// Version: 2.1.0-secure (Concurrency-Locked, Deduplicated, Validated)
// ============================================================================
// SETUP INSTRUCTIONS:
// 1. Open your target Google Sheet (or create one at https://sheets.new).
// 2. Click Extensions > Apps Script.
// 3. Paste this entire code into Code.gs, replacing any previous content.
// 4. Click Save (disk icon).
// 5. Click Deploy > Manage Deployments > Edit (or New Deployment).
//    - Type: Web app
//    - Description: MWA Consultation Booking Production API
//    - Execute as: "Me" (your Google account)
//    - Who has access: "Anyone" (CRITICAL: prevents 302 redirect to login screen)
// 6. Click Deploy, copy the Web App URL (ends in /exec), and configure it in your portal/form.
// ============================================================================

var SHEET_NAME = "Consultations";

var CANONICAL_HEADERS = [
  "Reference Code",
  "Timestamp (UTC+3)",
  "Full Name",
  "Email Address",
  "Telephone / WhatsApp",
  "Company / Organization",
  "Industry Sector",
  "Primary Service Area",
  "Consultation Format",
  "Preferred Date",
  "Time Window",
  "Scope Description",
  "Booking Status",
  "Source Channel"
];

/**
 * Ensures the target worksheet exists, contains canonical headers, and has frozen rows.
 */
function getOrCreateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(CANONICAL_HEADERS);
    var headerRange = sheet.getRange(1, 1, 1, CANONICAL_HEADERS.length);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#001f3f"); // MWA Corporate Navy
    headerRange.setFontColor("#ffffff");
    sheet.setFrozenRows(1);
    
    // Set column formats to plain text for Reference, Phone, and Dates to prevent truncation
    sheet.getRange("A:A").setNumberFormat("@");
    sheet.getRange("E:E").setNumberFormat("@");
    sheet.getRange("J:J").setNumberFormat("@");
  }
  
  return sheet;
}

/**
 * Server-side input validation
 */
function validateBookingPayload(data) {
  var errors = [];
  var name = (data.fullName || data.name || "").toString().trim();
  var email = (data.email || "").toString().trim();
  var phone = (data.phone || "").toString().trim();
  var service = (data.serviceArea || data.service || "").toString().trim();
  
  if (!name || name.length < 2) {
    errors.push("Full Name is required and must be at least 2 characters.");
  }
  if (!email || email.indexOf("@") === -1 || email.indexOf(".") === -1) {
    errors.push("A valid email address is required.");
  }
  var digitCount = phone.replace(/[^0-9]/g, "").length;
  if (!phone || digitCount < 8) {
    errors.push("A valid telephone/WhatsApp number with at least 8 digits is required.");
  }
  if (!service) {
    errors.push("Please select a primary service area.");
  }
  
  return {
    valid: errors.length === 0,
    errors: errors,
    sanitized: {
      fullName: name,
      email: email.toLowerCase(),
      phone: phone,
      serviceArea: service,
      organization: (data.organization || "Not specified").toString().trim(),
      sector: (data.sector || "General").toString().trim(),
      consultationMode: (data.consultationMode || data.mode || "In-Person (Vision Plaza, Nairobi)").toString().trim(),
      preferredDate: (data.preferredDate || data.date || "Flexible / Earliest Available").toString().trim(),
      preferredTimeWindow: (data.preferredTimeWindow || data.time || "Business Hours (08:30 - 17:00 EAT)").toString().trim(),
      message: (data.message || "").toString().trim(),
      referenceCode: (data.referenceCode || "").toString().trim()
    }
  };
}

/**
 * Handles incoming booking registration with concurrency locking and deduplication.
 */
function handleBookingSubmission(rawPayload) {
  var lock = LockService.getScriptLock();
  try {
    // Wait up to 15 seconds for concurrent writes to finish
    lock.waitLock(15000);
  } catch (lockErr) {
    return {
      success: false,
      status: "error",
      error: "Server busy. Another booking is being registered. Please try again in a few moments."
    };
  }

  try {
    var validation = validateBookingPayload(rawPayload);
    if (!validation.valid) {
      return {
        success: false,
        status: "validation_error",
        error: validation.errors.join(" ")
      };
    }

    var clean = validation.sanitized;
    var sheet = getOrCreateSheet();
    var lastRow = sheet.getLastRow();
    
    // Check for existing duplicates if sheet has data
    if (lastRow > 1) {
      var existingData = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
      for (var i = 0; i < existingData.length; i++) {
        var existingRef = existingData[i][0];
        var existingEmail = existingData[i][3];
        
        // Exact reference match check
        if (clean.referenceCode && existingRef === clean.referenceCode) {
          return {
            success: true,
            status: "confirmed",
            duplicate: true,
            referenceCode: existingRef,
            message: "Consultation was previously registered and confirmed in the ledger."
          };
        }
      }
    }

    // Generate unique server reference if not provided or to ensure canonical pattern
    var now = new Date();
    var datePrefix = Utilities.formatDate(now, "GMT+3", "yyyyMM");
    var finalRef = clean.referenceCode;
    if (!finalRef || !finalRef.startsWith("MWA-BK-")) {
      var randomSuffix = Math.floor(100000 + Math.random() * 900000);
      finalRef = "MWA-BK-" + datePrefix + "-" + randomSuffix;
    }

    var timestampIso = Utilities.formatDate(now, "GMT+3", "yyyy-MM-dd'T'HH:mm:ss'Z'");

    var rowValues = [
      finalRef,
      timestampIso,
      clean.fullName,
      clean.email,
      clean.phone,
      clean.organization,
      clean.sector,
      clean.serviceArea,
      clean.consultationMode,
      clean.preferredDate,
      clean.preferredTimeWindow,
      clean.message,
      "Received",
      rawPayload.source || "Website Booking Form"
    ];

    sheet.appendRow(rowValues);
    SpreadsheetApp.flush(); // Enforce immediate durable disk write

    return {
      success: true,
      status: "confirmed",
      referenceCode: finalRef,
      fullName: clean.fullName,
      email: clean.email,
      serviceArea: clean.serviceArea,
      preferredSchedule: clean.preferredDate + " (" + clean.preferredTimeWindow + ")",
      timestamp: timestampIso,
      message: "Consultation successfully saved in authoritative practice ledger."
    };

  } catch (err) {
    return {
      success: false,
      status: "error",
      error: "Internal processing error: " + err.toString()
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * HTTP POST entry point
 */
function doPost(e) {
  var payload = {};
  if (e && e.postData && e.postData.contents) {
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      // Fallback for url-encoded form body
      payload = e.parameter || {};
    }
  } else if (e && e.parameter) {
    payload = e.parameter;
  }

  var result = handleBookingSubmission(payload);
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * HTTP GET entry point (allows direct browser testing, beacons, and health checks)
 */
function doGet(e) {
  // If query parameters include booking details, process as registration
  if (e && e.parameter && (e.parameter.fullName || e.parameter.name || e.parameter.email)) {
    var result = handleBookingSubmission(e.parameter);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Otherwise return status and API health
  var statusInfo = {
    status: "online",
    service: "Mwangi Wangondu & Associates Consultation API",
    timestamp: Utilities.formatDate(new Date(), "GMT+3", "yyyy-MM-dd'T'HH:mm:ss'Z'"),
    instructions: "POST JSON or GET query parameters with fullName, email, phone, and serviceArea."
  };

  return ContentService.createTextOutput(JSON.stringify(statusInfo))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// HISTORICAL RECONCILIATION & ONE-CLICK BACKFILL UTILITY
// ============================================================================
/**
 * Run this function inside Google Apps Script to safely import all past records
 * from a verified backup source without creating duplicates.
 * 
 * @param {boolean} isDryRun - When true, tests without appending rows.
 */
function reconcileHistoricalLedger(isDryRun) {
  var dryRun = (isDryRun === true);
  var sheet = getOrCreateSheet();
  var lastRow = sheet.getLastRow();
  
  var existingRefs = {};
  if (lastRow > 1) {
    var refs = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < refs.length; i++) {
      if (refs[i][0]) existingRefs[refs[i][0].toString().trim()] = true;
    }
  }

  // Load from the repository data source
  var sourceUrl = "https://raw.githubusercontent.com/Mwangi-Wangondu-Associates/Mwangi-Wangondu-Associates/main/data/consultations.json";
  var res = UrlFetchApp.fetch(sourceUrl, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error("Unable to fetch historical records: HTTP " + res.getResponseCode());
  }

  var records = JSON.parse(res.getContentText());
  var inserted = 0;
  var skippedDuplicates = 0;

  for (var k = records.length - 1; k >= 0; k--) {
    var rec = records[k];
    var ref = rec.referenceCode;
    if (existingRefs[ref]) {
      skippedDuplicates++;
    } else {
      inserted++;
      if (!dryRun) {
        sheet.appendRow([
          ref,
          rec.receivedAt || "",
          rec.fullName || rec.name || "",
          rec.email || "",
          rec.phone || "",
          rec.organization || "Not specified",
          rec.sector || "General",
          rec.serviceArea || rec.service || "",
          rec.consultationMode || "In-Person",
          rec.preferredDate || rec.date || "Flexible",
          rec.preferredTimeWindow || rec.time || "Business Hours",
          rec.message || "",
          rec.status || "Received",
          "Historical Migration"
        ]);
        existingRefs[ref] = true;
      }
    }
  }

  SpreadsheetApp.flush();
  var summary = (dryRun ? "[DRY RUN] " : "[APPLIED] ") +
    "Source records: " + records.length + 
    ", Duplicates skipped: " + skippedDuplicates + 
    ", Inserted: " + inserted;

  Logger.log(summary);
  if (!dryRun) {
    SpreadsheetApp.getUi().alert("Reconciliation Complete:\n" + summary);
  }
  return summary;
}

function dryRunMigration() {
  return reconcileHistoricalLedger(true);
}

function executeMigration() {
  return reconcileHistoricalLedger(false);
}
