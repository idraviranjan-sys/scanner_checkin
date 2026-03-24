const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Google Sheet IDs from URLs
const MH_SHEET_ID = '1Yo8J8Nf71fKdsFCORm427bsSQWvlNr1XRxe7z8ZDeAk';   // MH locations
const PO_SHEET_ID = '1TTnIsxj6ANXPrI--GRbNE6D-o4OO6Fl8_sSNginUQ9w';   // Open POs
const CHECKIN_SHEET_ID = '132LL21tI-fncrR5kQYRglVRMGjvNlgO0CeY4SwQxTSo'; // Checkin log

// Initialise Google Sheets auth
function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthClient() });
}

// Haversine distance in km
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── GET /api/mh-locations ────────────────────────────────────────────────────
// Returns all MH locations so the browser can do proximity checks.
app.get('/api/mh-locations', async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: MH_SHEET_ID,
      range: 'Sheet1!A:F',
    });
    const rows = response.data.values || [];
    if (rows.length <= 1) return res.json([]);

    const [header, ...data] = rows;
    const mhList = data.map((row) => ({
      mh_name: row[0] || '',
      mh_id: row[1] || '',
      city: row[2] || '',
      state: row[3] || '',
      latitude: parseFloat(row[4]) || 0,
      longitude: parseFloat(row[5]) || 0,
    }));
    res.json(mhList);
  } catch (err) {
    console.error('Error fetching MH locations:', err.message);
    res.status(500).json({ error: 'Failed to fetch MH locations' });
  }
});

// ─── GET /api/po?barcode=XXXXX&lat=YY.YY&lng=ZZ.ZZ ───────────────────────────
// Validates proximity then looks up PO by barcode.
app.get('/api/po', async (req, res) => {
  const { barcode, lat, lng } = req.query;

  if (!barcode) return res.status(400).json({ error: 'barcode is required' });
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng are required for proximity check' });

  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  try {
    // 1. Check proximity to any MH
    const sheets = getSheetsClient();
    const mhResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: MH_SHEET_ID,
      range: 'Sheet1!A:F',
    });
    const mhRows = mhResponse.data.values || [];
    if (mhRows.length <= 1) {
      return res.status(503).json({ error: 'No mother hubs found in the system' });
    }

    const [, ...mhData] = mhRows;
    let nearestMH = null;
    let nearestDist = Infinity;

    for (const row of mhData) {
      const mhLat = parseFloat(row[4]);
      const mhLng = parseFloat(row[5]);
      if (isNaN(mhLat) || isNaN(mhLng)) continue;
      const dist = haversineKm(userLat, userLng, mhLat, mhLng);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestMH = {
          mh_name: row[0],
          mh_id: row[1],
          city: row[2],
          state: row[3],
          latitude: mhLat,
          longitude: mhLng,
          distanceKm: Math.round(dist * 100) / 100,
        };
      }
    }

    if (!nearestMH || nearestDist > 1) {
      return res.status(403).json({
        error: `You are ${nearestMH ? nearestMH.distanceKm + ' km' : 'too far'} from the nearest Mother Hub. Check-in is only allowed within 1 km.`,
        nearestMH: nearestMH || null,
      });
    }

    // 2. Look up PO by barcode
    const poResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: PO_SHEET_ID,
      range: 'Sheet1!A:E',
    });
    const poRows = poResponse.data.values || [];
    if (poRows.length <= 1) {
      return res.status(404).json({ error: 'No open POs found' });
    }

    const [, ...poData] = poRows;
    // headers: PO_number, manufacturer_name, vendor_name, scheduled_date, bar_code
    const matchedPO = poData.find(
      (row) => (row[4] || '').trim().toLowerCase() === barcode.trim().toLowerCase()
    );

    if (!matchedPO) {
      return res.status(404).json({ error: `PO with barcode "${barcode}" not found in open PO list` });
    }

    res.json({
      po_number: matchedPO[0],
      manufacturer_name: matchedPO[1],
      vendor_name: matchedPO[2],
      scheduled_date: matchedPO[3],
      bar_code: matchedPO[4],
      nearestMH,
    });
  } catch (err) {
    console.error('Error looking up PO:', err.message);
    res.status(500).json({ error: 'Failed to look up PO' });
  }
});

// ─── POST /api/checkin ────────────────────────────────────────────────────────
// Appends a row to the check-in log sheet.
app.post('/api/checkin', async (req, res) => {
  const { po_number, manufacturer_name, vendor_name, scheduled_date, bar_code, lat, lng } = req.body;

  if (!po_number || !lat || !lng) {
    return res.status(400).json({ error: 'po_number, lat, and lng are required' });
  }

  try {
    const sheets = getSheetsClient();

    // Re-verify proximity before writing
    const mhResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: MH_SHEET_ID,
      range: 'Sheet1!A:F',
    });
    const mhRows = mhResponse.data.values || [];
    const [, ...mhData] = mhRows;
    let nearestDist = Infinity;
    for (const row of mhData) {
      const mhLat = parseFloat(row[4]);
      const mhLng = parseFloat(row[5]);
      if (isNaN(mhLat) || isNaN(mhLng)) continue;
      const dist = haversineKm(parseFloat(lat), parseFloat(lng), mhLat, mhLng);
      if (dist < nearestDist) nearestDist = dist;
    }
    if (nearestDist > 1) {
      return res.status(403).json({ error: 'Location check failed. You must be within 1 km of the Mother Hub.' });
    }

    // Build date/time in IST
    const now = new Date();
    const istOptions = { timeZone: 'Asia/Kolkata' };
    const checkInDate = now.toLocaleDateString('en-IN', { ...istOptions, day: '2-digit', month: '2-digit', year: 'numeric' });
    const checkInTime = now.toLocaleTimeString('en-IN', { ...istOptions, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    // Check if PO already checked in
    const existingResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: CHECKIN_SHEET_ID,
      range: 'Sheet1!A:F',
    });
    const existingRows = existingResponse.data.values || [];
    const alreadyCheckedIn = existingRows.slice(1).some(
      (row) => (row[0] || '').trim() === po_number.trim()
    );
    if (alreadyCheckedIn) {
      return res.status(409).json({ error: `PO ${po_number} has already been checked in.` });
    }

    // Append row: PO_number, manufacturer_name, vendor_name, scheduled_date, check_in_date, check_in_time
    await sheets.spreadsheets.values.append({
      spreadsheetId: CHECKIN_SHEET_ID,
      range: 'Sheet1!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[po_number, manufacturer_name || '', vendor_name || '', scheduled_date || '', checkInDate, checkInTime]],
      },
    });

    res.json({
      success: true,
      message: `PO ${po_number} checked in successfully at ${checkInTime} on ${checkInDate}`,
      check_in_date: checkInDate,
      check_in_time: checkInTime,
    });
  } catch (err) {
    console.error('Error during check-in:', err.message);
    res.status(500).json({ error: 'Check-in failed. Please try again.' });
  }
});

// Serve frontend for all other routes
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Vehicle Check-In App running at http://localhost:${PORT}\n`);
});
