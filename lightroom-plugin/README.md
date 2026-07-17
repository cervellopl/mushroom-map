# Mushroom Map — Lightroom Classic plugin

An Export plugin for **Adobe Lightroom Classic** that uploads selected photos to
the Mushroom Map API and archives each sent file to a local folder.

For each exported photo it sends `POST /api/mushrooms` (multipart) with:

| API field | Comes from                                                        |
| --------- | ----------------------------------------------------------------- |
| `name`    | the mushroom **Latin name** — the photo's **Title**, else the dialog's *Default name* |
| `lat`,`lng` | the photo's **GPS** from the catalog (optional)                 |
| `notes`   | the photo's **Caption** (optional)                                |
| `image`   | the rendered JPEG                                                  |

The **capture timestamp** is not sent as a field — the API reads it from the
rendered JPEG's EXIF (keep metadata enabled in the export).

After a successful upload the rendered JPEG is copied to the **sent folder**
(default `C:\Users\macre\OneDrive\Dokumenty\lightroom ext\sent`).

## Install

1. Copy the folder **`MushroomMap.lrplugin`** to your Windows machine, e.g. into
   `C:\Users\macre\OneDrive\Dokumenty\lightroom ext\`.
2. In Lightroom Classic: **File ▸ Plug-in Manager… ▸ Add**, select the
   `MushroomMap.lrplugin` folder, then **Done**.

## Use

1. Select one or more photos in the Library.
2. **File ▸ Export…** and set **Export To: Mushroom Map** (top dropdown).
3. Fill in the plugin's sections:
   - **Server** — API base URL and (if enabled) Basic Auth username/password.
     - Example URL over the tunnel: `https://<your-tunnel>.ngrok-free.dev`
     - On the same LAN as the server: `http://192.168.1.10:3000`
   - **Sighting** — whether to use each photo's Title as the Latin name, a
     default name for untitled photos, and whether to send GPS.
   - **Local archive** — the *sent* folder (defaults to the path above; use
     **Choose…** to change it).
4. Click **Export**. A summary dialog reports how many uploaded / failed.

### Recommended workflow

- Put the mushroom's **Latin name in the photo's Title** (Metadata panel) so a
  mixed batch uploads each species under its own category.
- Set GPS in Lightroom (Map module) if your camera didn't geotag — those
  coordinates are sent directly, independent of the exported EXIF.

## Notes & limitations

- **Untested on a live Lightroom.** The Lua passes a syntax check and the API
  request contract is verified against the server, but it has not yet been run
  inside Lightroom Classic — expect to iterate on first load. Errors are logged
  to `Documents\LrClassicLogs\MushroomMap.log`.
- The password is stored in the export preset in clear text (Lightroom
  limitation for simple `edit_field` credentials). Use a dedicated account/token
  if that matters to you.
- Requires Lightroom Classic **10+** (2020). SDK identifier:
  `pl.cervello.mushroommap`.

## Files

```
MushroomMap.lrplugin/
  Info.lua                    plugin manifest
  ExportServiceProvider.lua   dialog UI + upload/archive logic
```
