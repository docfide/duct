# Cloud sources (connectors)

Duct can read Google Drive, OneDrive, SharePoint and S3 buckets directly, without a synced laptop. Connectors are part of the Team plan.

- **Connect** in Settings › Library › Cloud sources: "Connect Google Drive", "Connect OneDrive", or a SharePoint site's address (`https://yourcompany.sharepoint.com/sites/Legal`). Sign-in happens in your browser (OAuth with PKCE); Duct asks for read-only access (`drive.readonly`; `Files.Read.All` and `Sites.Read.All`).
- **S3:** "Connect an S3 bucket" takes the bucket, an optional folder (prefix), the region and an access key. It works with Amazon S3 and S3-compatible stores (MinIO, Cloudflare R2, Wasabi, Backblaze B2) through their endpoint. Requests are signed with AWS Signature Version 4, and the key is checked with one listing before it's saved. Give Duct a key that can only `s3:ListBucket` and `s3:GetObject` on that bucket.
- **What's read:** every file of a type Duct reads, from My Drive and shared drives (Google) or the drive or site library (Microsoft). Google Docs, Sheets and Slides are exported as Word, Excel and PowerPoint. Files over 100 MB are skipped.
- **Where it goes:** Duct keeps a private local copy of each file under its data folder (`connectors/<id>/files`) and indexes it like any other document, with its web address, so results can open it in the browser. Nothing passes through Tensflare.
- **Staying current:** Duct fetches only what changed (Drive's changes feed, Microsoft Graph delta queries; for S3, a listing compared by ETag) every 15 minutes, or when you press "Sync now". Files deleted or moved out of reach in the cloud leave Duct.
- **Disconnecting** removes the documents, the local copies and the tokens. Nothing changes in the cloud.
- **Tokens and keys** are kept in the system keychain in the desktop app, and in `connector-tokens.json` (readable only by you) for `duct serve`.
- **On a server** started with `--public-url`, sign-ins come back to `<public-url>/connectors/callback`, so they work from any browser. Register your own OAuth apps with that redirect URI; see [deploy.md](deploy.md#cloud-sources).

On a shared Duct server, everyone with access to the server can search what its connectors read. Connect sources whose contents the whole team may see.

## Setting up the apps (Tensflare)

The builds need OAuth client ids: a Google Cloud "Desktop app" client (`DUCT_GOOGLE_CLIENT_ID`, `DUCT_GOOGLE_CLIENT_SECRET`; Google treats a desktop client's secret as public) with the Drive API enabled and the `drive.readonly` scope verified; and a Microsoft Entra app registration for "Accounts in any organizational directory and personal Microsoft accounts" with the "Mobile and desktop" platform and redirect `http://127.0.0.1` (`DUCT_MICROSOFT_CLIENT_ID`), with the delegated permissions above.
