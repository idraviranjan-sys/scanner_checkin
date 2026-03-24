/* ── ZeptoNow Vehicle Check-In – Frontend Logic ─────────────── */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  let userLat = null;
  let userLng = null;
  let currentPO = null;
  let html5QrCodeScanner = null;
  let scannerRunning = false;

  // ── DOM helpers ────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  function showStep(stepId) {
    document.querySelectorAll('.step').forEach((el) => el.classList.remove('active'));
    $(stepId).classList.add('active');
  }

  function setStatus(el, type, msg) {
    el.className = `status-msg ${type}`;
    el.textContent = msg;
  }

  function showSpinner(text) {
    $('spinner-text').textContent = text || 'Please wait…';
    $('spinner-overlay').classList.remove('hidden');
  }

  function hideSpinner() {
    $('spinner-overlay').classList.add('hidden');
  }

  // ── API calls ──────────────────────────────────────────────
  async function apiFetch(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || 'Unknown error'), { status: res.status, data });
    return data;
  }

  // ── Step 1: Location ───────────────────────────────────────
  $('btn-get-location').addEventListener('click', handleGetLocation);

  function handleGetLocation() {
    const statusEl = $('location-status');
    setStatus(statusEl, 'info', '📡 Detecting your location…');
    $('btn-get-location').disabled = true;

    if (!navigator.geolocation) {
      setStatus(statusEl, 'error', 'Geolocation is not supported by your browser.');
      $('btn-get-location').disabled = false;
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        userLat = pos.coords.latitude;
        userLng = pos.coords.longitude;
        setStatus(statusEl, 'info', `📍 Location detected (±${Math.round(pos.coords.accuracy)}m). Checking proximity…`);

        try {
          showSpinner('Checking proximity to Mother Hub…');
          // Hit /api/mh-locations to compute nearest MH on the frontend
          const mhList = await apiFetch('/api/mh-locations');
          hideSpinner();

          if (!mhList.length) {
            setStatus(statusEl, 'error', 'No Mother Hubs configured. Please contact admin.');
            $('btn-get-location').disabled = false;
            return;
          }

          const nearest = findNearest(mhList, userLat, userLng);

          if (nearest.distanceKm > 1) {
            setStatus(
              statusEl,
              'error',
              `You are ${nearest.distanceKm.toFixed(2)} km from the nearest Mother Hub (${nearest.mh_name}, ${nearest.city}). Check-in requires being within 1 km.`
            );
            $('btn-get-location').disabled = false;
            return;
          }

          // Proximity OK → advance to scanner step
          setStatus(statusEl, 'success', `✓ You are ${nearest.distanceKm.toFixed(2)} km from ${nearest.mh_name}.`);
          setTimeout(() => {
            showStep('step-scan');
            // Show MH info badge
            const mhInfo = $('mh-info');
            mhInfo.textContent = `📍 ${nearest.mh_name} · ${nearest.city}, ${nearest.state}  (${nearest.distanceKm.toFixed(2)} km away)`;
            mhInfo.classList.add('visible');
            startScanner();
          }, 800);
        } catch (err) {
          hideSpinner();
          setStatus(statusEl, 'error', err.message || 'Failed to verify proximity. Try again.');
          $('btn-get-location').disabled = false;
        }
      },
      (err) => {
        hideSpinner();
        const msgs = {
          1: 'Location permission denied. Please allow location access and reload.',
          2: 'Location unavailable. Ensure GPS is enabled.',
          3: 'Location request timed out. Please try again.',
        };
        setStatus(statusEl, 'error', msgs[err.code] || 'Failed to get location.');
        $('btn-get-location').disabled = false;
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  // Haversine on the frontend too (for the initial MH check)
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

  function findNearest(mhList, lat, lng) {
    let nearest = null;
    let minDist = Infinity;
    for (const mh of mhList) {
      const d = haversineKm(lat, lng, mh.latitude, mh.longitude);
      if (d < minDist) { minDist = d; nearest = { ...mh, distanceKm: d }; }
    }
    return nearest;
  }

  // ── Step 2: Scanner ────────────────────────────────────────
  function startScanner() {
    if (scannerRunning) return;

    html5QrCodeScanner = new Html5QrcodeScanner(
      'qr-reader',
      {
        fps: 10,
        qrbox: { width: 260, height: 120 },
        rememberLastUsedCamera: true,
        aspectRatio: 1.5,
        supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA],
        formatsToSupport: [
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.ITF,
          Html5QrcodeSupportedFormats.PDF_417,
          Html5QrcodeSupportedFormats.DATA_MATRIX,
        ],
      },
      /* verbose= */ false
    );

    html5QrCodeScanner.render(onScanSuccess, onScanError);
    scannerRunning = true;
  }

  function stopScanner() {
    if (html5QrCodeScanner && scannerRunning) {
      html5QrCodeScanner.clear().catch(() => {});
      scannerRunning = false;
    }
  }

  function onScanSuccess(decodedText) {
    stopScanner();
    fetchPO(decodedText.trim());
  }

  function onScanError() { /* silent */ }

  // Manual barcode entry
  $('btn-manual-submit').addEventListener('click', () => {
    const val = $('manual-barcode').value.trim();
    if (!val) {
      const el = $('scan-status');
      setStatus(el, 'error', 'Please enter a barcode or PO number.');
      el.classList.remove('hidden'); // already removed above but ensure visible
      return;
    }
    stopScanner();
    fetchPO(val);
  });

  $('manual-barcode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-manual-submit').click();
  });

  // ── Step 3: PO Lookup ──────────────────────────────────────
  async function fetchPO(barcode) {
    const statusEl = $('scan-status');
    statusEl.classList.remove('hidden');
    setStatus(statusEl, 'info', `🔍 Looking up PO for barcode: ${barcode}…`);
    showSpinner('Fetching PO details…');

    try {
      const data = await apiFetch(
        `/api/po?barcode=${encodeURIComponent(barcode)}&lat=${userLat}&lng=${userLng}`
      );
      hideSpinner();
      currentPO = data;

      // Render PO details
      renderPODetails(data);
      showStep('step-checkin');
    } catch (err) {
      hideSpinner();
      statusEl.classList.remove('hidden');
      setStatus(statusEl, 'error', err.message || 'Failed to fetch PO. Please try again.');
      // Re-start scanner after short delay
      setTimeout(() => startScanner(), 1500);
    }
  }

  function renderPODetails(po) {
    $('po-details').innerHTML = `
      <div class="po-field">
        <label>PO Number</label>
        <span>${esc(po.po_number)}</span>
      </div>
      <div class="po-field">
        <label>Scheduled Date</label>
        <span>${esc(po.scheduled_date)}</span>
      </div>
      <div class="po-field full">
        <label>Vendor</label>
        <span>${esc(po.vendor_name)}</span>
      </div>
      <div class="po-field full">
        <label>Manufacturer</label>
        <span>${esc(po.manufacturer_name)}</span>
      </div>
      <div class="po-field full">
        <label>Barcode</label>
        <span>${esc(po.bar_code)}</span>
      </div>
      <div class="po-field full">
        <label>Mother Hub</label>
        <span>${esc(po.nearestMH?.mh_name || '—')} · ${esc(po.nearestMH?.city || '')} (${(po.nearestMH?.distanceKm || 0).toFixed(2)} km)</span>
      </div>
    `;
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Step 4: Check-In ───────────────────────────────────────
  $('btn-checkin').addEventListener('click', async () => {
    if (!currentPO) return;

    const statusEl = $('checkin-status');
    statusEl.classList.remove('hidden');
    $('btn-checkin').disabled = true;
    showSpinner('Submitting check-in…');

    try {
      const result = await apiFetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          po_number: currentPO.po_number,
          manufacturer_name: currentPO.manufacturer_name,
          vendor_name: currentPO.vendor_name,
          scheduled_date: currentPO.scheduled_date,
          bar_code: currentPO.bar_code,
          lat: userLat,
          lng: userLng,
        }),
      });

      hideSpinner();

      // Show success screen
      $('success-details').innerHTML = `
        <strong>PO Number:</strong> ${esc(currentPO.po_number)}<br>
        <strong>Vendor:</strong> ${esc(currentPO.vendor_name)}<br>
        <strong>Manufacturer:</strong> ${esc(currentPO.manufacturer_name)}<br>
        <strong>Check-In Date:</strong> ${esc(result.check_in_date)}<br>
        <strong>Check-In Time:</strong> ${esc(result.check_in_time)}<br>
      `;
      showStep('step-success');
    } catch (err) {
      hideSpinner();
      statusEl.classList.remove('hidden');
      setStatus(statusEl, 'error', err.message || 'Check-in failed. Please try again.');
      $('btn-checkin').disabled = false;
    }
  });

  // ── Back / Reset buttons ───────────────────────────────────
  $('btn-scan-another').addEventListener('click', () => {
    currentPO = null;
    $('scan-status').classList.add('hidden');
    $('manual-barcode').value = '';
    showStep('step-scan');
    startScanner();
  });

  $('btn-new-checkin').addEventListener('click', () => {
    currentPO = null;
    userLat = null;
    userLng = null;
    $('btn-get-location').disabled = false;
    $('location-status').className = 'status-msg hidden';
    $('scan-status').className = 'status-msg hidden';
    $('checkin-status').className = 'status-msg hidden';
    $('manual-barcode').value = '';
    $('mh-info').classList.remove('visible');
    stopScanner();
    showStep('step-location');
  });

})();
