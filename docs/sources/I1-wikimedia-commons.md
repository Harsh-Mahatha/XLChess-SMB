# I1 — Wikimedia Commons (with Wikidata)

Status: **approved** (verified 2026-11-13). The only image source live in V1. I2 Flickr, I3 Unsplash and I4 Pexels stay `pending_verification`; see the end of this note.

## Access

- API: `https://commons.wikimedia.org/w/api.php` (MediaWiki Action API). No key or account.
- Wikidata is used only to find the right person: `https://www.wikidata.org/w/api.php` (`wbgetentities`, `wbsearchentities` is **not** used). It is part of the I1 lookup and has no entry of its own in the registry.
- Wikimedia asks for a descriptive `User-Agent` with a way to contact the operator, serial requests and a pause after HTTP 429 / `maxlag`. The shared source HTTP client already does this (`minIntervalMs` 500, one request at a time, 60 s backoff on 429).

## Finding a photo

| Subject | How |
|---|---|
| Player | The FIDE id is matched to a Wikidata item with `P1440` (FIDE ID, via `haswbstatement:P1440=<id>` on Wikidata search). The item's image (`P18`) is the best match (`wikidata_image`); the item's Commons category (`P373`) gives more (`category`). **A name search alone never selects a photo of a person.** |
| Event, venue | Keyword search in the File namespace (`search`). |
| Generic | Keyword search in the File namespace. |

## Licence data

From `prop=imageinfo&iiprop=url|size|mime|sha1|extmetadata`:

| Field | Used for |
|---|---|
| `LicenseShortName`, `LicenseUrl`, `UsageTerms` | licence type and version, licence URL |
| `Artist`, `Credit`, `Attribution` | author and attribution (HTML is converted to plain text) |
| `AttributionRequired` | provider flag, treated as "credit required" |
| `Restrictions` | `personality`, `trademarked`, ... — personality rights and any other restriction reject the photo |
| `NonFree` | fair-use file, rejected |
| `DateTimeOriginal` | date taken (ranking only) |

The raw `extmetadata` JSON is saved with every photo as the licence evidence.

## Policy

Accepted: CC0, public domain, CC BY, CC BY-SA (share-alike accepted, decision of 2026-11-13).
Rejected: any NC or ND licence, GFDL-only, unknown or mismatched licences, non-free files, personality rights or other restrictions, and CC BY or CC BY-SA photos with no recorded author.

## Other image sources (not live)

- **I2 Flickr:** API key needed; commercial use of the API needs Flickr's approval.
- **I3 Unsplash:** the API rules expect images to be loaded from Unsplash and each download to be reported, which conflicts with keeping our own verified copy.
- **I4 Pexels:** API key and a visible credit to Pexels.

These need a decision from the manager before any adapter is written.
