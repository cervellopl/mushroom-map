# Mushroom Map — Lightroom Classic plugin

An Export plugin for **Adobe Lightroom Classic** that uploads selected photos to
the Mushroom Map API and archives each sent file to a local folder.

For each exported photo it sends `POST /api/mushrooms` (multipart) with:

| API field   | Comes from                                                        |
| ----------- | ----------------------------------------------------------------- |
| `name`      | the mushroom **Latin name** — by default the photo's **collection name** (configurable) |
| `lat`,`lng` | the photo's **GPS** from the catalog (optional)                   |
| `notes`     | the photo's **Caption** (optional)                                |
| `image`     | the rendered JPEG                                                  |

### Where the Latin name comes from

The **Latin name from:** dropdown in the export dialog selects the source:

| Option | Uses |
| ------ | ---- |
| **Collection name** (default) | the name of the collection containing the photo — organise photos into one collection per species |
| Title | the photo's Title metadata field |
| Caption | the photo's Caption metadata field |
| Always use the default name | the *Default name* value for every photo |

If the chosen source is empty for a photo, it falls back to *Default name*, then
to `Unknown`.

The **capture timestamp** is not sent as a field — the API reads it from the
rendered JPEG's EXIF (keep metadata enabled in the export).

After a successful upload the rendered JPEG is copied to the **sent folder**.

---

## 1. Install

1. Copy the folder **`MushroomMap.lrplugin`** to your PC, e.g. into
   `C:\Users\macre\OneDrive\Dokumenty\lightroom ext\`.
2. Lightroom Classic ▸ **File ▸ Plug-in Manager… ▸ Add**, select the
   `MushroomMap.lrplugin` folder, then **Done**.

## 2. Configure the connection (once)

In **File ▸ Plug-in Manager ▸ Mushroom Map**, fill in the
**Mushroom Map — Connection** panel:

| Setting          | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| **API base URL** | `http://192.168.1.10:3000` on your LAN, or your `https://…` tunnel URL |
| **Username**     | your API user (e.g. `forager`) — blank if the server has no auth |
| **Password**     | your API password — blank if the server has no auth              |
| **Sent folder**  | where sent photos are archived (**Choose…** to browse)          |

Click **Test connection**. You'll get one of:

- ✅ *Connection OK* — plus the list of mushroom names already on the server.
- 🔒 *Authentication failed* (HTTP 401) — wrong username/password.
- ❌ *Connection failed* — wrong URL, server down, or a firewall blocking the port.

These settings are plugin-wide: every export preset inherits them, and editing
them in the Export dialog updates them here too.

## 3. Upload photos

1. Select one or more photos in the Library.
2. **File ▸ Export…** and set **Export To: Mushroom Map** (top dropdown).
3. Check the **Mushroom Map — Sighting** section:
   - *Latin name from* — Collection name (default), Title, Caption, or the default name
   - *Default name* — fallback when the chosen source is empty
   - *Send GPS coordinates from the catalog*
4. Click **Export**. A summary dialog reports how many uploaded / failed.

### Recommended workflow

- Organise photos into **one collection per species**, named with the Latin name
  (e.g. `Amanita citrina`) — the default *Collection name* source then labels
  every sighting correctly, including multi-photo batches.
- Add a **Caption** for habitat notes — it becomes the sighting's notes.
- Set GPS in Lightroom's **Map** module if the camera didn't geotag; those
  coordinates are sent directly, independent of the exported EXIF.

---

## Syncing whole collections

**Library ▸ Plug-in Extras ▸ Sync collections to Mushroom Map…**

Organise photos into one collection per species (named with the Latin name),
then sync them in bulk instead of exporting by hand:

1. The dialog lists every collection with its photo count and how many are new.
2. Tick the collections you want (**Select all** / **Select none** help).
3. Click **Sync**. Each sighting is named after **its own collection**, so a
   multi-collection sync labels everything correctly in one pass.

Photos uploaded by an earlier sync are **skipped**, so re-running only sends
what's new and never creates duplicates. The history is stored in the plugin's
preferences (by catalog photo id), so it is per-machine. **Reset sync history**
clears it and makes the next sync re-upload everything.

Notes:
- A photo in several selected collections is uploaded **once**, named after
  whichever of those collections is synced first (alphabetically by path).
- Only photos that upload successfully are recorded as synced, so a failed
  photo is retried on the next run.
- GPS comes from the catalog and the Caption becomes the sighting's notes,
  exactly as in the export path.

## Troubleshooting

| Symptom | Likely cause |
| ------- | ------------ |
| *Connection failed* on your LAN | The server's port isn't open in its firewall, or the URL/IP is wrong. |
| *Authentication failed* (401) | Username/password mismatch — or the server has auth enabled and the fields are blank. |
| Uploads succeed but nothing is archived | The *sent folder* path doesn't exist and couldn't be created — check permissions. |
| Photos land as `Unknown` | The chosen *Latin name from* source is empty for that photo — e.g. the photo isn't in a collection, or has no Title/Caption. |
| Only the first photo of a batch uploads | Fixed in v1.1. Older builds called `renditionIsDone()` after `waitForRender()`, which broke the export session after the first photo. |

Runtime errors are logged to `Documents\LrClassicLogs\MushroomMap.log`.

## Notes & limitations

- **Not yet run inside Lightroom.** All Lua passes a syntax check and the API
  request contract is verified against a live server, but the plugin has not
  been loaded in Lightroom Classic — expect to iterate on first run.
- The password is stored in Lightroom's plugin preferences in clear text
  (standard for simple LR credential fields). Use a dedicated account if that
  matters.
- Requires Lightroom Classic **10+** (2020). Identifier: `pl.cervello.mushroommap`.

## Files

```
MushroomMap.lrplugin/
  Info.lua                    plugin manifest
  MushroomMapCommon.lua       shared settings, auth headers, upload, connection test
  PluginInfoProvider.lua      Plug-in Manager settings panel
  ExportServiceProvider.lua   export dialog UI + upload/archive logic
  SyncCollections.lua         bulk collection sync with duplicate skipping
```
