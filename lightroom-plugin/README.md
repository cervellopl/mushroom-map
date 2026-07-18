# Mushroom Map — Lightroom Classic plugin

An Export plugin for **Adobe Lightroom Classic** that uploads selected photos to
the Mushroom Map API and archives each sent file to a local folder.

For each exported photo it sends `POST /api/mushrooms` (multipart) with:

| API field   | Comes from                                                        |
| ----------- | ----------------------------------------------------------------- |
| `name`      | the mushroom **Latin name** — the photo's **Title**, else the *Default name* |
| `lat`,`lng` | the photo's **GPS** from the catalog (optional)                   |
| `notes`     | the photo's **Caption** (optional)                                |
| `image`     | the rendered JPEG                                                  |

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
   - *Use each photo's Title as the mushroom Latin name* (recommended)
   - *Default name* — used for photos with no Title
   - *Send GPS coordinates from the catalog*
4. Click **Export**. A summary dialog reports how many uploaded / failed.

### Recommended workflow

- Put the mushroom's **Latin name in the photo's Title** (Metadata panel) so a
  mixed batch uploads each species under its own category.
- Add a **Caption** for habitat notes — it becomes the sighting's notes.
- Set GPS in Lightroom's **Map** module if the camera didn't geotag; those
  coordinates are sent directly, independent of the exported EXIF.

---

## Troubleshooting

| Symptom | Likely cause |
| ------- | ------------ |
| *Connection failed* on your LAN | The server's port isn't open in its firewall, or the URL/IP is wrong. |
| *Authentication failed* (401) | Username/password mismatch — or the server has auth enabled and the fields are blank. |
| Uploads succeed but nothing is archived | The *sent folder* path doesn't exist and couldn't be created — check permissions. |
| Photos land with the wrong name | The photo has no **Title**, so the *Default name* was used. |

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
  MushroomMapCommon.lua       shared settings, auth headers, connection test
  PluginInfoProvider.lua      Plug-in Manager settings panel
  ExportServiceProvider.lua   export dialog UI + upload/archive logic
```
