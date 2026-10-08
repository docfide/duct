# Cloud sources (connectors)

Duct can read Google Drive, OneDrive and SharePoint directly, without a synced laptop. Connectors are part of the Team plan.

- **Connect** in Settings › Library › Cloud sources: "Connect Google Drive", "Connect OneDrive", or a SharePoint site's address (`https://yourcompany.sharepoint.com/sites/Legal`). Sign-in happens in your browser (OAuth with PKCE); Duct asks for read-only access (`drive.readonly`; `Files.Read.All` and `Sites.Read.All`).
- **What's read:** every file of a type Duct reads, from My Drive and shared drives (Google) or the drive or site library (Microsoft). Google Docs, Sheets and Slides are exported as Word, Excel and PowerPoint. Files over 100 MB are skipped.
- **Where it goes:** Duct keeps a private local copy of each file under its data folder (`connectors/<id>/files`) and indexes it like any other document, with its web address, so results can open it in the browser. Nothing passes through Tensflare.
- **Staying current:** Duct fetches only what changed (Drive's changes feed, Microsoft Graph delta queries) every 15 minutes, or when you press "Sync now". Files deleted or moved out of reach in the cloud leave Duct.
- **Disconnecting** removes the documents, the local copies and the tokens. Nothing changes in the cloud.
- **Tokens** are kept in the system keychain in the desktop app, and in `connector-tokens.json` (readable only by you) for `duct serve`.

On a shared Duct server, everyone with access to the server can search what its connectors read. Connect sources whose contents the whole team may see.

## Setting up the apps (Tensflare)

The builds need OAuth client ids: a Google Cloud "Desktop app" client (`DUCT_GOOGLE_CLIENT_ID`, `DUCT_GOOGLE_CLIENT_SECRET`; Google treats a desktop client's secret as public) with the Drive API enabled and the `drive.readonly` scope verified; and a Microsoft Entra app registration for "Accounts in any organizational directory and personal Microsoft accounts" with the "Mobile and desktop" platform and redirect `http://127.0.0.1` (`DUCT_MICROSOFT_CLIENT_ID`), with the delegated permissions above.
