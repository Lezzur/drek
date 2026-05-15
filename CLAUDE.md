# DREK

AI video director — pre-production planning and scene scripting.

## Service

- **URL:** http://localhost:3003/
- **Process manager:** NSSM (Windows service)
- **Commands:** `nssm start DREK` / `nssm stop DREK` / `nssm restart DREK`
- **Logs:** `F:\claude-code\claude_projects\drek\logs\service.log`

## Firebase / Firestore

- **Display name:** DREK
- **Project ID:** `red-tool-8193c` (permanent GCP ID — was originally "red tool", repurposed for DREK)
- **Service account key:** `gcp-key.json` (gitignored)
- **Indexes:** defined in `firestore.indexes.json`, deploy with `firebase deploy --only firestore:indexes`
