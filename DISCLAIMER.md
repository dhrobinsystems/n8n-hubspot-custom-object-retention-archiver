# Disclaimer & Limitation of Liability

**Project:** `n8n-hubspot-custom-object-retention-archiver`
**Publisher:** DH Robin (dhRobin Systems)
**Applies to:** every file in this repository, including the n8n workflow JSON, the Node.js source in `src/`, the build script, the tests, the fixtures and the documentation.

## 1. Purpose

This repository is an educational and architectural reference. It shows one way to apply a data-retention rule to HubSpot custom object records: back them up to cold storage, then archive them in HubSpot. It is not a managed service, a records-management system, legal advice or a substitute for your own engineering, security, legal and data-protection review.

## 2. "As is", without warranty

The software is provided **"AS IS" and "AS AVAILABLE", without warranty of any kind**, express or implied. This includes, without limitation, warranties of merchantability, fitness for a particular purpose, title, non-infringement, accuracy, completeness, data integrity and uninterrupted or error-free operation. No advice or information, written or spoken, from the author or dhRobin Systems creates any warranty.

## 3. This software archives CRM data

When `DRY_RUN=false`, the software calls `DELETE /crm/v3/objects/{objectType}/{objectId}` on HubSpot records. HubSpot treats this as an archive: records move to the recycle bin and, under HubSpot's policy at the time of writing, can be restored for a limited period (about 90 days). After that period HubSpot may delete them permanently. Associations, engagement history, attachments and other data that are not object properties may not be part of the cold-storage export and may not be recoverable from it. HubSpot's behaviour, retention periods and APIs may change without notice.

## 4. Safeguards reduce risk; they do not remove it

`DRY_RUN=true`, `SANDBOX_MODE=true`, the sandbox account check, `MAX_ARCHIVE_PER_RUN`, the minimum `RETENTION_DAYS`, the custom-object-only rule, backup-before-archive verification, overwrite-protected S3 writes and secret masking are risk-reduction measures. A wrong retention property, a misconfigured legal-hold property, clock or timezone errors, changes to third-party APIs, n8n version differences, or changes to the code can still archive records you meant to keep. You must test in an isolated environment before every production rollout and after every upgrade or configuration change.

## 5. Cold storage is your responsibility

A backup being "verified" means the storage service confirmed it received the exact bytes sent at that moment. It does not guarantee that the backup will remain available, complete, readable, secure or restorable later. You are responsible for bucket and spreadsheet permissions, encryption, versioning, object lock, lifecycle rules, retention periods, access logging, regional data residency, and for regularly testing restores.

## 6. Data protection and compliance

Retention and deletion of personal data are regulated in many jurisdictions (for example GDPR, UK GDPR and CCPA/CPRA). Archiving a record in HubSpot while keeping a copy in S3 or Google Sheets does **not** erase personal data: the cold-storage copy is still personal data that you control. You alone are responsible for:

- defining a lawful retention schedule and lawful basis for keeping, archiving and deleting each category of record;
- making sure the cold-storage copies are covered by your records of processing, data processing agreements and transfer mechanisms;
- honouring data-subject requests, including access and erasure requests that must also reach the cold-storage copies;
- honouring legal holds, litigation holds, audit and regulatory retention obligations, and configuring `LEGAL_HOLD_PROPERTY` accordingly;
- complying with the terms of service, acceptable-use policies and rate limits of HubSpot, AWS, Google, n8n and any other connected service.

## 7. Limitation of liability

To the maximum extent permitted by applicable law, in no event shall the author, DH Robin, dhRobin Systems or any contributor be liable for any direct, indirect, incidental, special, exemplary, punitive or consequential damages, or for any loss or corruption of data, records, revenue, profit, business or goodwill, regulatory fines or penalties, or the cost of substitute services or data recovery, however caused and on any theory of liability, whether in contract, strict liability or tort (including negligence), arising in any way out of the use, misuse, inability to use or deployment of this software, even if advised of the possibility of such damage.

## 8. No affiliation

HubSpot, Amazon Web Services, Amazon S3, Google Sheets and n8n are trademarks of their respective owners. This project is independent and is not affiliated with, endorsed by or sponsored by any of them. All object types, company names, domains, identifiers and credentials in this repository are fictional or published documentation examples.

## 9. License

The software is licensed under the MIT License (see [LICENSE](LICENSE)). If anything in this disclaimer conflicts with the MIT License, the MIT License governs; this document adds explanation and does not grant or remove rights.

---

## ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-hubspot-custom-object-retention-archiver`) are for educational and architectural demonstration purposes.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts.
* **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement.
* **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Treat every archive as irreversible once HubSpot's recycle-bin window has passed, and prove you can restore from cold storage before going live.
* **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot, AWS, Google and any connected services. That includes confirming a lawful retention schedule for every record, honouring legal holds and data-subject requests (including erasure requests that must also reach cold-storage copies), and reviewing every automated archive.

The full disclaimer is also available in [DISCLAIMER.md](https://github.com/dhrobinsystems/n8n-hubspot-custom-object-retention-archiver/blob/main/DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](https://github.com/dhrobinsystems/n8n-hubspot-custom-object-retention-archiver/blob/main/LICENSE).
