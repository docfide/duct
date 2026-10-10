# Signing the desktop installers

Until the installers are signed, macOS says it "could not verify" Duct and Windows SmartScreen warns before it runs.
Both go away with signing. This is what to buy and set up; once the secrets below exist, the release workflow
(`.github/workflows/installers.yml`) signs on every release.

Prices and rules were checked in October 2026 and change; confirm them on the vendors' pages before paying.

## macOS: Apple Developer Program (about $99 a year)

1. **D-U-N-S Number for Tensflare Ltd.** Apple requires one for organisations. Look it up first (the company may
   already have one) with Apple's D-U-N-S lookup during enrolment; requesting one is free but can take up to about 30
   business days (Dun & Bradstreet sells faster processing).
2. **Enrol as an organisation** at developer.apple.com/programs/enroll with an Apple ID that has two-factor
   authentication, a work email on the company's domain (tensflare.com) and a public website. The person enrolling must
   be able to sign contracts for the company. Apple phones to verify.
3. **Create a "Developer ID Application" certificate** (Certificates, Identifiers & Profiles), export it with its
   private key as a `.p12`, and **create an App Store Connect API key** (Users and Access › Integrations) for
   notarization: you get a `.p8` file, a key ID and an issuer ID.
4. **Add GitHub secrets** to docfide/duct: `CSC_LINK` (the `.p12`, base64), `CSC_KEY_PASSWORD`, `APPLE_API_KEY`
   (the `.p8` contents), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

Then the Mac builds are signed with the hardened runtime and notarized by Apple, and open without a warning.

## Windows: an OV code-signing certificate with cloud signing (about $130 a year plus $15 a month)

Since June 2023, code-signing keys must live in a hardware token or a cloud HSM, so a certificate file alone won't do,
and a USB token can't be used by GitHub's build machines. Microsoft's own low-cost service (Azure Artifact Signing,
about $10 a month) is only open to organisations in the US, Canada, the EU and the UK, and Tensflare Ltd is registered
in Nigeria.

Recommended: **SSL.com OV code signing with eSigner cloud signing.**

1. Buy an **OV code-signing certificate** for Tensflare Ltd (organisation validation: company documents and a phone
   check) and the **eSigner** plan for code (Tier 1: 240 signatures a month is plenty; each release signs a handful of
   files). New certificates include 30 days of eSigner free, so we can test before paying monthly.
2. **Add GitHub secrets:** `ES_USERNAME`, `ES_PASSWORD`, `ES_CREDENTIAL_ID`, `ES_TOTP_SECRET` (from the eSigner
   enrolment).
3. Tell the engineering team; the release workflow then signs the Windows installer and app through eSigner (a small
   signing script, since electron-builder has no built-in eSigner support).

An EV certificate costs more and no longer gives instant SmartScreen trust (Microsoft changed this in 2024): with OV,
warnings fade as people download and run each release. DigiCert (KeyLocker) is the premium alternative.

## Linux

Nothing to buy. AppImage and .deb don't need signing to run; we can publish checksums with each release.
