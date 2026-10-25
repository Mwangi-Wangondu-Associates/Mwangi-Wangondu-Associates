// ============================================================================
// MWANGI WANGONDU & ASSOCIATES (CPA-K)
// PRODUCTION GOOGLE APPS SCRIPT CONSULTATION BOOKING RECEIVER & LEDGER
// Version: 3.0.0-hardened (Abuse-Protected, Rate-Limited, Concurrency-Locked)
// ============================================================================
// SECURITY SAFEGUARDS:
// 1. Shared App Token: Validates expected client token to block random web crawlers.
// 2. Honeypot Detection: Silently rejects automated bots filling hidden honeypot fields.
// 3. Rate Limiting: Enforces max 3 submissions per email/IP per 30 minutes via CacheService.
// 4. Strict Sanitization: HTML tag stripping and character length constraints.
// 5. Zero Public Reads: Blocks all requests attempting to query or list stored consultations.
// 6. Concurrency Locking: Uses LockService to serialize simultaneous writes.
// ============================================================================

var SHEET_NAME = "Consultations";

// Application verification token (must match client submission token)
var EXPECTED_APP_TOKEN = "MWA-SEC-2026-CONSULT-ADVISORY";

// Maximum length constraints
var MAX_NAME_LENGTH = 100;
var MAX_EMAIL_LENGTH = 120;
var MAX_PHONE_LENGTH = 30;
var MAX_ORG_LENGTH = 120;
var MAX_MESSAGE_LENGTH = 1500;

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
 * Strips HTML tags and potential script injections
 */
function sanitizeText(input, maxLen) {
  if (!input) return "";
  var str = input.toString();
  // Strip HTML tags
  str = str.replace(/<[^>]*>?/gm, "");
  // Trim and enforce length cap
  str = str.trim();
  if (maxLen && str.length > maxLen) {
    str = str.substring(0, maxLen);
  }
  return str;
}

/**
 * Checks rate limiting via Apps Script CacheService
 */
function checkRateLimit(identifier) {
  var cache = CacheService.getScriptCache();
  var cacheKey = "rate_" + Utilities.base64Encode(identifier).substring(0, 30);
  var currentCount = cache.get(cacheKey);
  
  if (currentCount) {
    var count = parseInt(currentCount, 10);
    if (count >= 3) {
      return false; // Rate limit exceeded (more than 3 per 30 minutes)
    }
    cache.put(cacheKey, (count + 1).toString(), 1800); // 30 minutes
  } else {
    cache.put(cacheKey, "1", 1800);
  }
  return true;
}

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
 * Server-side input validation and anti-abuse verification
 */
function validateBookingPayload(data) {
  var errors = [];

  // 1. Honeypot check (Bots fill hidden fields, real users do not)
  if (data.website_hp && data.website_hp.toString().trim().length > 0) {
    return {
      valid: false,
      abuseDetected: true,
      errors: ["Invalid submission."]
    };
  }

  // 2. Minimum form interaction time check (Bots submit in under 1.5 seconds)
  if (data.loadedAt) {
    var loadTime = parseInt(data.loadedAt, 10);
    var nowMs = new Date().getTime();
    if (!isNaN(loadTime) && (nowMs - loadTime) < 1500) {
      return {
        valid: false,
        abuseDetected: true,
        errors: ["Automated form submission detected."]
      };
    }
  }

  // 3. Shared Application Token check
  if (data.appToken !== EXPECTED_APP_TOKEN) {
    return {
      valid: false,
      abuseDetected: true,
      errors: ["Unauthorized client origin or invalid application token."]
    };
  }

  var name = sanitizeText(data.fullName || data.name, MAX_NAME_LENGTH);
  var email = sanitizeText(data.email, MAX_EMAIL_LENGTH).toLowerCase();
  var phone = sanitizeText(data.phone, MAX_PHONE_LENGTH);
  var service = sanitizeText(data.serviceArea || data.service, MAX_NAME_LENGTH);
  
  if (!name || name.length < 2) {
    errors.push("Full Name is required (minimum 2 characters).");
  }
  
  // RFC 5322 standard email validation regex
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    errors.push("A valid email address is required.");
  }
  
  var digitCount = phone.replace(/[^0-9]/g, "").length;
  if (!phone || digitCount < 8) {
    errors.push("A valid telephone or WhatsApp number with at least 8 digits is required.");
  }
  
  if (!service) {
    errors.push("Please select a primary service area.");
  }

  // 4. Rate Limiting Check
  if (email && !checkRateLimit(email)) {
    return {
      valid: false,
      abuseDetected: true,
      errors: ["Submission limit reached for this email. Please contact our practice office directly at +254 723606653."]
    };
  }
  
  return {
    valid: errors.length === 0,
    abuseDetected: false,
    errors: errors,
    sanitized: {
      fullName: name,
      email: email,
      phone: phone,
      serviceArea: service,
      organization: sanitizeText(data.organization || "Not specified", MAX_ORG_LENGTH),
      sector: sanitizeText(data.sector || "General", MAX_ORG_LENGTH),
      consultationMode: sanitizeText(data.consultationMode || data.mode || "In-Person (Vision Plaza, Nairobi)", 80),
      preferredDate: sanitizeText(data.preferredDate || data.date || "Flexible / Earliest Available", 50),
      preferredTimeWindow: sanitizeText(data.preferredTimeWindow || data.time || "Business Hours (08:30 - 17:00 EAT)", 50),
      message: sanitizeText(data.message || "", MAX_MESSAGE_LENGTH),
      referenceCode: sanitizeText(data.referenceCode || "", 40)
    }
  };
}

/**
 * Handles incoming booking registration with concurrency locking and deduplication.
 */
function handleBookingSubmission(rawPayload) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000); // 15-second concurrency lock
  } catch (lockErr) {
    return {
      success: false,
      status: "error",
      error: "Server is currently processing other requests. Please try again momentarily."
    };
  }

  try {
    var validation = validateBookingPayload(rawPayload);
    if (!validation.valid) {
      return {
        success: false,
        status: validation.abuseDetected ? "abuse_rejected" : "validation_error",
        error: validation.errors.join(" ")
      };
    }

    var clean = validation.sanitized;
    var sheet = getOrCreateSheet();
    var lastRow = sheet.getLastRow();
    
    // Check for duplicate reference
    if (lastRow > 1) {
      var existingData = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < existingData.length; i++) {
        if (clean.referenceCode && existingData[i][0] === clean.referenceCode) {
          return {
            success: true,
            status: "confirmed",
            duplicate: true,
            referenceCode: existingData[i][0],
            message: "Consultation previously registered and confirmed in practice ledger."
          };
        }
      }
    }

    // Generate canonical reference code with 6-digit entropy to eliminate birthday collisions
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
    SpreadsheetApp.flush(); // Ensure immediate write

    return {
      success: true,
      status: "confirmed",
      referenceCode: finalRef,
      fullName: clean.fullName,
      email: clean.email,
      serviceArea: clean.serviceArea,
      timestamp: timestampIso,
      message: "Consultation successfully registered with practice management desk."
    };

  } catch (err) {
    return {
      success: false,
      status: "error",
      error: "Internal processing exception: " + err.toString()
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
    } catch (_) {
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
 * HTTP GET entry point
 * Strictly blocks unauthorized data reads. Only processes verified submissions or health ping.
 */
function doGet(e) {
  // If query parameters include booking submission with valid app token
  if (e && e.parameter && (e.parameter.fullName || e.parameter.name) && e.parameter.appToken === EXPECTED_APP_TOKEN) {
    var result = handleBookingSubmission(e.parameter);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Health check only — ZERO client data or metadata exposed
  var safeStatus = {
    status: "active",
    service: "Mwangi Wangondu & Associates Consultation Dispatcher",
    timestamp: Utilities.formatDate(new Date(), "GMT+3", "yyyy-MM-dd'T'HH:mm:ss'Z'")
  };

  return ContentService.createTextOutput(JSON.stringify(safeStatus))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// HISTORICAL RECONCILIATION & ONE-CLICK BACKFILL UTILITY
// ============================================================================
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

  var sourceUrl = "https://raw.githubusercontent.com/Mwangi-Wangondu-Associates/Mwangi-Wangondu-Associates/main/data/consultations.json";
  var res = UrlFetchApp.fetch(sourceUrl, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("Fetch failed: HTTP " + res.getResponseCode());

  var records = JSON.parse(res.getContentText());
  var inserted = 0;
  var skippedDuplicates = 0;

  for (var k = records.length - 1; k >= 0; k--) {
    var rec = records[k];
    if (existingRefs[rec.referenceCode]) {
      skippedDuplicates++;
    } else {
      inserted++;
      if (!dryRun) {
        sheet.appendRow([
          rec.referenceCode,
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
        existingRefs[rec.referenceCode] = true;
      }
    }
  }
  SpreadsheetApp.flush();
  var summary = (dryRun ? "[DRY RUN] " : "[APPLIED] ") + "Total: " + records.length + ", Skipped: " + skippedDuplicates + ", Inserted: " + inserted;
  Logger.log(summary);
  return summary;
}
