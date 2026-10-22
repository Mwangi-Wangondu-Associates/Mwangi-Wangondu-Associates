import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

// Load environment variables from .env if present
const envFilePath = path.join(__dirname, '.env');
if (fs.existsSync(envFilePath)) {
  try {
    process.loadEnvFile(envFilePath);
  } catch (err) {
    console.warn('Notice: .env file present but failed to parse with process.loadEnvFile:', err.message);
  }
}

// Ensure data directory exists for persistent form storage
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const consultationsFile = path.join(dataDir, 'consultations.json');
const contactsFile = path.join(dataDir, 'contacts.json');
const configFile = path.join(dataDir, 'config.json');

// Initialize data files if they don't exist
if (!fs.existsSync(consultationsFile)) {
  fs.writeFileSync(consultationsFile, JSON.stringify([], null, 2), 'utf-8');
}
if (!fs.existsSync(contactsFile)) {
  fs.writeFileSync(contactsFile, JSON.stringify([], null, 2), 'utf-8');
}
if (!fs.existsSync(configFile)) {
  fs.writeFileSync(configFile, JSON.stringify({
    googleSheetsWebhookUrl: '',
    autoSyncEnabled: true,
    lastSyncAttempt: null,
    lastSyncResult: null
  }, null, 2), 'utf-8');
}

// Helper to safely read and write JSON files
function readJSON(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content || '[]');
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
    return filePath.endsWith('config.json') ? {} : [];
  }
}

function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err);
    return false;
  }
}

// Retrieve Google Sheets Webhook URL prioritizing GOOGLE_SHEETS_WEBHOOK env var
function getWebhookUrl() {
  const envUrl = process.env.GOOGLE_SHEETS_WEBHOOK || process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (envUrl && envUrl.trim()) {
    return envUrl.trim();
  }
  const config = readJSON(configFile) || {};
  return (config.googleSheetsWebhookUrl || '').trim();
}

let activeGoogleSession = {
  accessToken: null,
  spreadsheetId: null,
  userEmail: null
};

// Automatically mirror a consultation booking to Google Sheets Webhook or Direct Sheets API
async function mirrorToGoogleSheets(booking) {
  const config = readJSON(configFile) || {};
  const isEnabled = config.autoSyncEnabled !== false;

  if (!isEnabled) {
    console.log(`[Google Sheets Sync] Sync skipped for ${booking.referenceCode}: Auto-sync is currently paused.`);
    return {
      success: false,
      saved: false,
      error: 'Auto-sync is currently disabled in system settings.',
      details: 'Enable automatic synchronization in the Practice Portal.'
    };
  }

  // Check if Direct Google Sheets API session is active with valid token & spreadsheet ID
  const targetSpreadsheetId = activeGoogleSession.spreadsheetId || config.spreadsheetId;
  if (activeGoogleSession.accessToken && targetSpreadsheetId) {
    try {
      console.log(`[Google Sheets Direct] Appending ${booking.referenceCode} to spreadsheet ${targetSpreadsheetId} via Google Sheets API v4...`);
      const range = 'Consultations!A1:append';
      const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(targetSpreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
      const rowValues = [
        booking.referenceCode,
        booking.receivedAt || new Date().toISOString(),
        booking.fullName || booking.name || '',
        booking.email || '',
        booking.phone || '',
        booking.organization || 'Not specified',
        booking.sector || 'General',
        booking.serviceArea || booking.service || '',
        booking.consultationMode || '',
        booking.preferredDate || booking.date || '',
        booking.preferredTimeWindow || booking.time || '',
        booking.message || '',
        booking.status || 'Received'
      ];

      const sheetController = new AbortController();
      const sheetTimeout = setTimeout(() => sheetController.abort(), 3500);

      const sheetRes = await fetch(appendUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${activeGoogleSession.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: [rowValues] }),
        signal: sheetController.signal
      });
      clearTimeout(sheetTimeout);

      if (sheetRes.ok) {
        console.log(`[Google Sheets Direct] Appended successfully: ${booking.referenceCode}`);
        const bookings = readJSON(consultationsFile);
        const target = bookings.find(b => b.referenceCode === booking.referenceCode);
        if (target) {
          target.syncedToGoogleSheets = true;
          target.syncedAt = new Date().toISOString();
          target.syncResponse = 'Direct Google Sheets API v4 (HTTP 200)';
          writeJSON(consultationsFile, bookings);
        }
        return {
          success: true,
          saved: true,
          status: 200,
          statusText: 'OK',
          method: 'google_sheets_v4',
          details: 'Direct Google Sheets API v4 Verified'
        };
      }
    } catch (directErr) {
      console.warn('[Google Sheets Direct Attempt Note]', directErr.message);
    }
  }

  const webhookUrl = getWebhookUrl();
  if (!webhookUrl || !webhookUrl.trim()) {
    console.log(`[Google Sheets Sync] Sync skipped for ${booking.referenceCode}: Neither direct Google OAuth nor Webhook URL configured.`);
    return {
      success: false,
      saved: false,
      error: 'Google Sheets sync is not yet connected.',
      details: 'Connect your Google account in the Practice Portal or provide a Webhook URL.'
    };
  }

  // Exact fields matching requirements: name, email, phone, service, date, time, message
  const payload = {
    name: booking.name || booking.fullName || '',
    email: booking.email || '',
    phone: booking.phone || '',
    service: booking.service || booking.serviceArea || '',
    date: booking.date || booking.preferredDate || '',
    time: booking.time || booking.preferredTimeWindow || '',
    message: booking.message || '',
    // Additional metadata for robust sheets schemas
    referenceCode: booking.referenceCode,
    fullName: booking.fullName || booking.name || '',
    serviceArea: booking.serviceArea || booking.service || '',
    preferredDate: booking.preferredDate || booking.date || '',
    preferredTimeWindow: booking.preferredTimeWindow || booking.time || '',
    organization: booking.organization || '',
    sector: booking.sector || '',
    consultationMode: booking.consultationMode || '',
    timestamp: booking.receivedAt || new Date().toISOString(),
    status: booking.status || 'Received'
  };

  try {
    // Construct dispatch URL: include query parameters so Google Apps Script
    // can access via e.parameter if programmed as GET/POST parameters
    let targetUrl;
    try {
      targetUrl = new URL(webhookUrl.trim());
      targetUrl.searchParams.set('name', payload.name);
      targetUrl.searchParams.set('email', payload.email);
      targetUrl.searchParams.set('phone', payload.phone);
      targetUrl.searchParams.set('service', payload.service);
      targetUrl.searchParams.set('date', payload.date);
      targetUrl.searchParams.set('time', payload.time);
      if (payload.message) targetUrl.searchParams.set('message', payload.message);
      targetUrl.searchParams.set('referenceCode', payload.referenceCode);
    } catch {
      targetUrl = webhookUrl.trim();
    }

    console.log(`[Google Sheets Sync] Dispatching booking ${booking.referenceCode} to Apps Script Webhook...`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const response = await fetch(targetUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'MwangiWangonduAssociates-SheetsSync/1.0'
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timeout);

    let responseBodyText = '';
    try {
      responseBodyText = await response.text();
    } catch {
      responseBodyText = '';
    }

    const finalUrl = response.url || '';
    const isGoogleAuthRedirect = finalUrl.includes('accounts.google.com') ||
                                 finalUrl.includes('google.com/accounts') ||
                                 responseBodyText.includes('accounts.google.com') ||
                                 (responseBodyText.includes('<!DOCTYPE html>') && (responseBodyText.includes('Sign in') || responseBodyText.includes('ServiceLogin')));

    let saved = false;
    let errorReason = '';
    let confirmedDetails = '';

    if (response.status === 401 || response.status === 403 || isGoogleAuthRedirect) {
      saved = false;
      errorReason = 'Google Apps Script Webhook returned 401/403 Unauthorized (Google Sign-In required). In your Google Apps Script project, navigate to Deploy > Manage Deployments, click Edit, and ensure "Who has access" is set to "Anyone".';
    } else if (response.status >= 400) {
      saved = false;
      errorReason = `Google Apps Script returned HTTP ${response.status} ${response.statusText}.`;
    } else if (responseBodyText.includes('Unable to open the file') || responseBodyText.includes('Page not found')) {
      saved = false;
      errorReason = 'Google Drive was unable to open the Apps Script file or the web app deployment ID is invalid.';
    } else {
      // Analyze response body
      try {
        const json = JSON.parse(responseBodyText);
        if (json.status === 'error' || json.result === 'error' || json.error) {
          saved = false;
          errorReason = json.error || json.message || 'Google Apps Script reported an execution error while appending row.';
        } else {
          saved = true;
          confirmedDetails = json.message || 'Confirmed saved in Google Sheet.';
        }
      } catch {
        if (responseBodyText.toLowerCase().includes('error') || responseBodyText.toLowerCase().includes('exception')) {
          saved = false;
          errorReason = 'Google Apps Script script returned error: ' + responseBodyText.slice(0, 160);
        } else {
          // Response followed redirect and returned 200 without error
          saved = true;
          confirmedDetails = 'Confirmed saved by Google Apps Script web app.';
        }
      }
    }

    const statusMsg = saved ? `Confirmed (HTTP ${response.status})` : `Failed: ${errorReason}`;
    console.log(`[Google Sheets Sync Result] ${booking.referenceCode} -> ${statusMsg}`);

    // Update config sync log
    config.lastSyncAttempt = new Date().toISOString();
    config.lastSyncResult = {
      referenceCode: booking.referenceCode,
      success: saved,
      status: response.status,
      statusText: response.statusText,
      error: saved ? null : errorReason,
      timestamp: new Date().toISOString()
    };
    writeJSON(configFile, config);

    // Update booking record in consultations.json
    const bookings = readJSON(consultationsFile);
    const target = bookings.find(b => b.referenceCode === booking.referenceCode);
    if (target) {
      target.syncedToGoogleSheets = saved;
      target.syncedAt = saved ? new Date().toISOString() : null;
      target.syncResponse = statusMsg;
      writeJSON(consultationsFile, bookings);
    }

    return {
      success: saved,
      saved,
      status: response.status,
      statusText: response.statusText,
      error: saved ? null : errorReason,
      details: confirmedDetails
    };

  } catch (err) {
    const errorMsg = err.name === 'AbortError' ? 'Google Apps Script Webhook timed out after 15 seconds.' : err.message;
    console.error(`[Google Sheets Sync Failed] ${booking.referenceCode}:`, errorMsg);

    config.lastSyncAttempt = new Date().toISOString();
    config.lastSyncResult = {
      referenceCode: booking.referenceCode,
      success: false,
      error: errorMsg,
      timestamp: new Date().toISOString()
    };
    writeJSON(configFile, config);

    const bookings = readJSON(consultationsFile);
    const target = bookings.find(b => b.referenceCode === booking.referenceCode);
    if (target) {
      target.syncedToGoogleSheets = false;
      target.syncedAt = null;
      target.syncResponse = `Failed: ${errorMsg}`;
      writeJSON(consultationsFile, bookings);
    }

    return {
      success: false,
      saved: false,
      error: errorMsg
    };
  }
}

// CORS & Preflight handling & Cache Buster
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.header('Pragma', 'no-cache');
  res.header('Expires', '0');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Request parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Specific canonical page routes (case-insensitive & clean aliases)
app.get(['/book-a-consultation', '/bookaconsultation', '/BOOKACONSULTATION', '/consultation'], (req, res) => {
  res.sendFile(path.join(__dirname, 'BOOKACONSULTATION.html'));
});

app.get(['/about', '/about-us', '/aboutthefirm'], (req, res) => {
  res.sendFile(path.join(__dirname, 'aboutthefirm.html'));
});

app.get(['/services', '/our-services'], (req, res) => {
  res.sendFile(path.join(__dirname, 'services.html'));
});

app.get(['/contact', '/contact-us', '/contactpage'], (req, res) => {
  res.sendFile(path.join(__dirname, 'contactpage.html'));
});

app.get(['/portal', '/dashboard', '/admin', '/consultations-list'], (req, res) => {
  res.sendFile(path.join(__dirname, 'portal.html'));
});

// Helper to determine if request expects JSON
function expectsJson(req) {
  const accept = req.headers.accept || '';
  const contentType = req.headers['content-type'] || '';
  return req.xhr || accept.includes('application/json') || contentType.includes('application/json');
}

// ============================================
// BACKEND FORM RECEIVER API ENDPOINTS
// ============================================

// Consultation Booking Receiver (Synchronizes with Google Sheets Webhook)
app.post('/api/consultation', async (req, res) => {
  try {
    const isJsonClient = expectsJson(req);

    // Extract fields with full support for both naming conventions
    const name = (req.body.name || req.body.fullName || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const phone = (req.body.phone || '').trim();
    const service = (req.body.service || req.body.serviceArea || '').trim();
    const date = (req.body.date || req.body.preferredDate || '').trim();
    const time = (req.body.time || req.body.preferredTimeWindow || '').trim();
    const message = (req.body.message || '').trim();
    const organization = (req.body.organization || '').trim();
    const sector = (req.body.sector || '').trim();
    const consultationMode = (req.body.consultationMode || '').trim();

    // Validation of required fields
    if (!name) {
      const err = 'Full Name is required.';
      if (isJsonClient) return res.status(400).json({ success: false, confirmed: false, error: err });
      return res.redirect(`/BOOKACONSULTATION.html?status=error&message=${encodeURIComponent(err)}`);
    }
    if (!email || !email.includes('@')) {
      const err = 'A valid email address is required.';
      if (isJsonClient) return res.status(400).json({ success: false, confirmed: false, error: err });
      return res.redirect(`/BOOKACONSULTATION.html?status=error&message=${encodeURIComponent(err)}`);
    }
    if (!phone || phone.length < 8) {
      const err = 'A valid telephone number is required.';
      if (isJsonClient) return res.status(400).json({ success: false, confirmed: false, error: err });
      return res.redirect(`/BOOKACONSULTATION.html?status=error&message=${encodeURIComponent(err)}`);
    }
    if (!service) {
      const err = 'Please select a primary service area of interest.';
      if (isJsonClient) return res.status(400).json({ success: false, confirmed: false, error: err });
      return res.redirect(`/BOOKACONSULTATION.html?status=error&message=${encodeURIComponent(err)}`);
    }

    const timestamp = new Date().toISOString();
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const referenceCode = `MWA-BK-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${randomSuffix}`;

    const newBooking = {
      referenceCode,
      name,
      fullName: name,
      email,
      phone,
      organization: organization || 'Not specified',
      sector: sector || 'General',
      service,
      serviceArea: service,
      consultationMode: consultationMode || 'In-Person (Vision Plaza, Nairobi)',
      date: date || 'Flexible / Earliest Available',
      preferredDate: date || 'Flexible / Earliest Available',
      time: time || 'Business Hours (08:30 - 17:00 EAT)',
      preferredTimeWindow: time || 'Business Hours (08:30 - 17:00 EAT)',
      message,
      status: 'Received',
      receivedAt: timestamp,
      clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1'
    };

    const bookings = readJSON(consultationsFile);
    bookings.unshift(newBooking);
    writeJSON(consultationsFile, bookings);

    console.log(`[Form Receiver] Consultation received and registered: ${referenceCode} for ${newBooking.name}`);

    // Attempt synchronization to Google Sheets without failing or delaying the client's confirmation
    let syncResult = null;
    try {
      syncResult = await mirrorToGoogleSheets(newBooking);
    } catch (syncErr) {
      console.warn(`[Google Sheets Sync] Sync attempt note for ${referenceCode}:`, syncErr.message);
      syncResult = { success: false, saved: false, error: syncErr.message };
    }

    // Always confirm success to the client - booking is permanently registered in the firm's database
    if (isJsonClient) {
      return res.status(201).json({
        success: true,
        confirmed: true,
        referenceCode,
        message: 'Your consultation request has been successfully registered.',
        googleSheets: {
          synced: !!(syncResult && syncResult.saved),
          status: syncResult && syncResult.status ? syncResult.status : (syncResult && syncResult.saved ? 200 : 'pending'),
          details: syncResult && syncResult.saved ? 'Synchronized to Google Sheets' : (syncResult ? (syncResult.error || 'Pending mirror to Google Sheets') : 'Queued in register')
        },
        bookingSummary: {
          name: newBooking.name,
          fullName: newBooking.name,
          email: newBooking.email,
          phone: newBooking.phone,
          organization: newBooking.organization,
          sector: newBooking.sector,
          service: newBooking.service,
          serviceArea: newBooking.service,
          consultationMode: newBooking.consultationMode,
          date: newBooking.date,
          preferredDate: newBooking.date,
          time: newBooking.time,
          preferredTimeWindow: newBooking.time,
          message: newBooking.message,
          receivedAt: newBooking.receivedAt
        }
      });
    }

    const redirectUrl = `/BOOKACONSULTATION.html?status=success&ref=${encodeURIComponent(referenceCode)}&name=${encodeURIComponent(newBooking.name)}&service=${encodeURIComponent(newBooking.service)}&mode=${encodeURIComponent(newBooking.consultationMode)}&date=${encodeURIComponent(newBooking.date)}&time=${encodeURIComponent(newBooking.time)}`;
    return res.redirect(303, redirectUrl);

  } catch (err) {
    console.error('Error processing consultation submission:', err);
    const errMsg = 'An internal server error occurred while processing your consultation request. Please reach us directly at mwangiemmah2023@gmail.com or +254 723606653.';
    if (expectsJson(req)) {
      return res.status(500).json({ success: false, confirmed: false, error: errMsg });
    }
    return res.redirect(`/BOOKACONSULTATION.html?status=error&message=${encodeURIComponent(errMsg)}`);
  }
});

// General Contact Form Receiver
app.post('/api/contact', (req, res) => {
  try {
    const { fullName, email, phone, subject, message } = req.body;
    const isJsonClient = expectsJson(req);

    if (!fullName || !fullName.trim()) {
      const err = 'Full Name is required.';
      if (isJsonClient) return res.status(400).json({ success: false, error: err });
      return res.redirect(`/contactpage.html?status=error&message=${encodeURIComponent(err)}`);
    }
    if (!email || !email.trim() || !email.includes('@')) {
      const err = 'A valid email address is required.';
      if (isJsonClient) return res.status(400).json({ success: false, error: err });
      return res.redirect(`/contactpage.html?status=error&message=${encodeURIComponent(err)}`);
    }
    if (!message || message.trim().length < 5) {
      const err = 'Message must be at least 5 characters.';
      if (isJsonClient) return res.status(400).json({ success: false, error: err });
      return res.redirect(`/contactpage.html?status=error&message=${encodeURIComponent(err)}`);
    }

    const timestamp = new Date().toISOString();
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const referenceCode = `MWA-MSG-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${randomSuffix}`;

    const newContact = {
      referenceCode,
      fullName: fullName.trim(),
      email: email.trim().toLowerCase(),
      phone: phone ? phone.trim() : 'Not provided',
      subject: subject ? subject.trim() : 'General Inquiry',
      message: message.trim(),
      status: 'Received',
      receivedAt: timestamp,
      clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1'
    };

    const contacts = readJSON(contactsFile);
    contacts.unshift(newContact);
    writeJSON(contactsFile, contacts);

    console.log(`[Form Receiver] New Contact Message: ${referenceCode} from ${newContact.fullName}`);

    if (isJsonClient) {
      return res.status(201).json({
        success: true,
        message: 'Thank you for contacting Mwangi Wangondu & Associates. We have received your message.',
        referenceCode,
        receivedAt: newContact.receivedAt
      });
    }

    return res.redirect(303, `/contactpage.html?status=success&ref=${encodeURIComponent(referenceCode)}&name=${encodeURIComponent(newContact.fullName)}`);

  } catch (err) {
    console.error('Error processing contact form submission:', err);
    const errMsg = 'An error occurred while transmitting your message. Please reach us at mwangiemmah2023@gmail.com or call +254 723606653.';
    if (expectsJson(req)) {
      return res.status(500).json({ success: false, error: errMsg });
    }
    return res.redirect(`/contactpage.html?status=error&message=${encodeURIComponent(errMsg)}`);
  }
});

// Consultation & Inquiries JSON query endpoint
app.get('/api/consultations', (req, res) => {
  const consultations = readJSON(consultationsFile);
  res.json({
    success: true,
    count: consultations.length,
    consultations
  });
});

app.get('/api/contacts', (req, res) => {
  const contacts = readJSON(contactsFile);
  res.json({
    success: true,
    count: contacts.length,
    contacts
  });
});

// Google Sheets / Webhook Configuration Endpoints
app.get('/api/config', (req, res) => {
  const webhookUrl = getWebhookUrl();
  const isConfigured = !!(webhookUrl && webhookUrl.trim());
  const config = readJSON(configFile) || {};
  res.json({
    success: true,
    configured: isConfigured,
    maskedWebhookUrl: isConfigured ? (webhookUrl.slice(0, 34) + '...' + webhookUrl.slice(-6)) : '',
    autoSyncEnabled: config.autoSyncEnabled !== false,
    lastSyncAttempt: config.lastSyncAttempt || null,
    lastSyncResult: config.lastSyncResult || null
  });
});

app.post('/api/config', (req, res) => {
  const { googleSheetsWebhookUrl, autoSyncEnabled } = req.body;
  const config = readJSON(configFile) || {};

  if (typeof googleSheetsWebhookUrl === 'string') {
    config.googleSheetsWebhookUrl = googleSheetsWebhookUrl.trim();
  }
  if (typeof autoSyncEnabled === 'boolean') {
    config.autoSyncEnabled = autoSyncEnabled;
  }

  writeJSON(configFile, config);
  console.log(`[Google Sheets Config Updated] AutoSync: ${config.autoSyncEnabled}`);

  res.json({
    success: true,
    message: 'Google Sheets sync configuration saved successfully.',
    configured: !!(getWebhookUrl())
  });
});

// Provide Firebase Config for client-side Google Sheets OAuth
app.get('/api/firebase-config', (req, res) => {
  const firebaseConfigFile = path.join(__dirname, 'firebase-applet-config.json');
  try {
    if (fs.existsSync(firebaseConfigFile)) {
      const fbConfig = JSON.parse(fs.readFileSync(firebaseConfigFile, 'utf8'));
      return res.json({ success: true, config: fbConfig });
    }
  } catch (err) {
    console.error('Error reading firebase-applet-config.json:', err);
  }
  res.status(404).json({ success: false, error: 'Firebase configuration not found' });
});

// Direct Google Sheets Active Session endpoints
app.get('/api/google-sheets/session', (req, res) => {
  const config = readJSON(configFile) || {};
  res.json({
    success: true,
    connected: !!activeGoogleSession.accessToken,
    spreadsheetId: activeGoogleSession.spreadsheetId || config.spreadsheetId || null,
    userEmail: activeGoogleSession.userEmail || null
  });
});

app.post('/api/google-sheets/session', (req, res) => {
  const { accessToken, spreadsheetId, userEmail } = req.body;
  if (accessToken) activeGoogleSession.accessToken = accessToken;
  if (spreadsheetId) {
    activeGoogleSession.spreadsheetId = spreadsheetId.trim();
    const config = readJSON(configFile) || {};
    config.spreadsheetId = spreadsheetId.trim();
    writeJSON(configFile, config);
  }
  if (userEmail) activeGoogleSession.userEmail = userEmail;
  console.log(`[Google Sheets Session] Connected for user: ${activeGoogleSession.userEmail || 'OAuth User'}, sheet: ${activeGoogleSession.spreadsheetId}`);
  res.json({
    success: true,
    connected: !!activeGoogleSession.accessToken,
    spreadsheetId: activeGoogleSession.spreadsheetId,
    message: 'Google Sheets session active.'
  });
});

// Endpoint to mark bookings as synced from client-side direct Google Sheets API calls
app.post('/api/consultations/mark-synced', (req, res) => {
  const { referenceCodes } = req.body;
  if (!Array.isArray(referenceCodes) || referenceCodes.length === 0) {
    return res.status(400).json({ success: false, error: 'referenceCodes array required' });
  }

  const bookings = readJSON(consultationsFile);
  let updatedCount = 0;
  for (const code of referenceCodes) {
    const item = bookings.find(b => b.referenceCode === code);
    if (item) {
      item.syncedToGoogleSheets = true;
      item.syncedAt = new Date().toISOString();
      item.syncResponse = 'Client-side Google Sheets API v4 (Confirmed)';
      updatedCount++;
    }
  }

  writeJSON(consultationsFile, bookings);
  console.log(`[Mark Synced] Updated ${updatedCount} bookings as synced to Google Sheets.`);
  res.json({ success: true, updatedCount });
});

// Manual Sync Consultation(s) to Google Sheets
app.post('/api/sync-consultation', async (req, res) => {
  const { referenceCode } = req.body;
  const bookings = readJSON(consultationsFile);

  if (referenceCode) {
    const booking = bookings.find(b => b.referenceCode === referenceCode);
    if (!booking) {
      return res.status(404).json({ success: false, error: `Consultation with reference ${referenceCode} not found.` });
    }
    const result = await mirrorToGoogleSheets(booking);
    return res.json({ success: result.success, result, referenceCode });
  }

  // If no referenceCode, sync all un-synced bookings
  const unSynced = bookings.filter(b => !b.syncedToGoogleSheets);
  const syncResults = [];
  for (const b of unSynced) {
    const r = await mirrorToGoogleSheets(b);
    syncResults.push({ referenceCode: b.referenceCode, ...r });
  }

  res.json({
    success: true,
    syncedCount: syncResults.filter(r => r.success).length,
    totalAttempted: unSynced.length,
    results: syncResults
  });
});

// Export Consultations as CSV formatted for Microsoft Excel & Google Sheets
const handleExportCSV = (req, res) => {
  const bookings = readJSON(consultationsFile);
  const headers = [
    'Reference Code',
    'Date Received',
    'Full Name',
    'Email',
    'Phone',
    'Organization',
    'Industry Sector',
    'Service Area',
    'Consultation Format',
    'Preferred Date',
    'Time Window',
    'Scope Description',
    'Status',
    'Google Sheets Synced'
  ];

  const escapeCSV = (field) => {
    if (field === null || field === undefined) return '""';
    const str = String(field).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = bookings.map(b => [
    escapeCSV(b.referenceCode),
    escapeCSV(b.receivedAt),
    escapeCSV(b.fullName || b.name || ''),
    escapeCSV(b.email || ''),
    escapeCSV(b.phone || ''),
    escapeCSV(b.organization || 'Not specified'),
    escapeCSV(b.sector || 'General'),
    escapeCSV(b.serviceArea || b.service || ''),
    escapeCSV(b.consultationMode || 'In-Person (Vision Plaza, Nairobi)'),
    escapeCSV(b.preferredDate || b.date || ''),
    escapeCSV(b.preferredTimeWindow || b.time || ''),
    escapeCSV(b.message || ''),
    escapeCSV(b.status || 'Received'),
    escapeCSV(b.syncedToGoogleSheets ? 'Yes' : 'No')
  ].join(','));

  const csvContent = '\uFEFF' + [headers.map(h => `"${h}"`).join(','), ...rows].join('\r\n');
  const filename = `MWA_Consultations_Excel_${new Date().toISOString().split('T')[0]}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(csvContent);
};

app.get('/api/consultations/export.csv', handleExportCSV);
app.get('/api/consultations/export.xlsx', handleExportCSV);
app.get('/api/consultations/export.excel', handleExportCSV);

// Google Apps Script template endpoint for quick deployment
app.get('/api/google-sheets-script', (req, res) => {
  const script = `// ============================================================================
// MWANGI WANGONDU & ASSOCIATES - GOOGLE SHEETS WEB APP RECEIVER
// 1. Open your Google Sheet
// 2. Click Extensions > Apps Script
// 3. Paste this code into Code.gs and click Save
// 4. Click Deploy > New deployment > Select type: Web app
// 5. Execute as: 'Me', Who has access: 'Anyone'
// 6. Copy the Web App URL and paste it into the Practice Portal settings
// ============================================================================

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var data = JSON.parse(e.postData.contents);
    
    // Add header row automatically if sheet is brand new
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "Reference Code",
        "Timestamp",
        "Full Name",
        "Email",
        "Phone / WhatsApp",
        "Organization",
        "Industry Sector",
        "Primary Service Area",
        "Format / Mode",
        "Preferred Date",
        "Time Window",
        "Scope Description",
        "Source"
      ]);
      var headerRange = sheet.getRange(1, 1, 1, 13);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#001f3f");
      headerRange.setFontColor("#ffffff");
    }

    sheet.appendRow([
      data.referenceCode || "",
      data.timestamp || new Date().toISOString(),
      data.fullName || "",
      data.email || "",
      data.phone || "",
      data.organization || "",
      data.sector || "",
      data.serviceArea || "",
      data.consultationMode || "",
      data.preferredDate || "",
      data.preferredTimeWindow || "",
      data.message || "",
      data.source || "MWA Website"
    ]);

    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      referenceCode: data.referenceCode,
      message: "Consultation appended to Google Sheet"
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}`;
  res.type('text/javascript').send(script);
});

// Health & Submissions count inspection endpoint
app.get('/api/status', (req, res) => {
  const consultations = readJSON(consultationsFile);
  const contacts = readJSON(contactsFile);
  const config = readJSON(configFile) || {};
  res.json({
    status: 'online',
    firm: 'Mwangi Wangondu & Associates',
    consultationsCount: consultations.length,
    contactsCount: contacts.length,
    googleSheetsSyncConfigured: !!(getWebhookUrl()),
    autoSyncEnabled: config.autoSyncEnabled !== false,
    lastConsultation: consultations[0] ? {
      reference: consultations[0].referenceCode,
      client: consultations[0].fullName,
      service: consultations[0].serviceArea,
      date: consultations[0].receivedAt,
      syncedToGoogleSheets: !!consultations[0].syncedToGoogleSheets
    } : null
  });
});

// Serve static assets and HTML pages with no-cache headers to prevent stale browser scripts
app.use(express.static(__dirname, {
  extensions: ['html', 'htm'],
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Route fallback for client navigation to index.html if no file matches
app.get('*', (req, res) => {
  if (!path.extname(req.path)) {
    return res.sendFile(path.join(__dirname, 'index.html'));
  }
  res.status(404).send('Not Found');
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
