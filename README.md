# ZeptoNow · Vehicle Check-In App

A mobile-friendly, fully-automated PO check-in system for vehicles arriving at ZeptoNow Mother Hubs.

---

## How it Works

1. **Vendor** packs boxes against POs and prints the barcoded PO sheet.
2. **Delivery person** opens the app on their phone when the vehicle is near the hub.
3. App **verifies GPS location** — check-in is only allowed within **1 km** of a Mother Hub.
4. Delivery person **scans the barcode** on the PO sheet using their phone camera.
5. App looks up the PO in the open-PO Google Sheet and shows the details.
6. Delivery person taps **Confirm Check-In** → a timestamped row is written to the check-in log.

---

## Google Sheets Used

| Sheet | Purpose | ID |
|---|---|---|
| MH Locations | `mh_name, mh_id, city, state, latitude, longitude` | `1Yo8J8Nf71fKdsFCORm427bsSQWvlNr1XRxe7z8ZDeAk` |
| Open POs | `PO_number, manufacturer_name, vendor_name, scheduled_date, bar_code` | `1TTnIsxj6ANXPrI--GRbNE6D-o4OO6Fl8_sSNginUQ9w` |
| Check-In Log | `PO_number, manufacturer_name, vendor_name, scheduled_date, check_in_date, check_in_time` | `132LL21tI-fncrR5kQYRglVRMGjvNlgO0CeY4SwQxTSo` |

---

## Setup

### 1 · Clone & install

```bash
git clone <repo-url>
cd scanner_checkin
npm install
```

### 2 · Google Sheets API Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project → **Enable** the **Google Sheets API**.
3. Go to **IAM & Admin → Service Accounts** → **Create Service Account**.
4. Grant it no specific roles (it only needs Sheets access via sharing).
5. Click the service account → **Keys** tab → **Add Key → JSON**.
6. Download the JSON key file.

### 3 · Share each Google Sheet

Open each of the three sheets and share them with the service account email
(e.g. `my-sa@my-project.iam.gserviceaccount.com`):

| Sheet | Required Access |
|---|---|
| MH Locations | Viewer |
| Open POs | Viewer |
| Check-In Log | Editor |

### 4 · Configure environment

```bash
cp .env.example .env
```

Edit `.env` and paste the **entire contents** of your service account JSON as a single line:

```
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"my-project",...}
PORT=3000
```

### 5 · Start the server

```bash
npm start
```

The app runs at **http://localhost:3000**.

To access from a phone on the same Wi-Fi, open `http://<your-machine-ip>:3000`.

> **Camera needs HTTPS on real phones.**
> For local-network testing use [localtunnel](https://localtunnel.me/):
> ```bash
> npx localtunnel --port 3000
> ```
> This gives you a public HTTPS URL instantly.

---

## Project Structure

```
scanner_checkin/
├── server.js            # Express backend + Google Sheets API
├── public/
│   ├── index.html       # Mobile SPA shell
│   ├── style.css        # ZeptoNow-branded responsive styles
│   └── app.js           # Geolocation · Barcode scanner · API calls
├── .env                 # Your secrets (not committed)
├── .env.example         # Template
└── package.json
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/mh-locations` | All Mother Hub co-ordinates |
| `GET` | `/api/po?barcode=X&lat=Y&lng=Z` | Proximity check + PO lookup |
| `POST` | `/api/checkin` | Write timestamped row to Check-In Log |

---

## Production Deployment (optional)

```bash
npm install -g pm2
pm2 start server.js --name zepto-checkin
pm2 save && pm2 startup
```

Add Nginx + Let's Encrypt for HTTPS so device cameras work without ngrok.
