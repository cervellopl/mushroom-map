# 🍄 Mushroom Map

A small full-stack app for logging mushroom sightings. Send a photo, a name, and
a GPS location to the API; browse everything on a **dark-themed map** and filter by
mushroom name.

## Run

```bash
npm install
npm start          # -> http://localhost:3000
```

Open <http://localhost:3000>. Images are stored in `uploads/`, metadata in
`data/mushrooms.json` (both created automatically). Set `PORT` to change the port.

### Authentication (optional)

Set both `AUTH_USER` and `AUTH_PASS` to require HTTP Basic Auth on every route
(API, static files, and uploaded images). If either is unset, auth is disabled —
handy for local development, but set them before exposing the app publicly.

```bash
AUTH_USER=forager AUTH_PASS='a-strong-password' npm start
```

The startup log reports whether auth is `ENABLED` or `disabled`.

> The map uses Leaflet + CartoDB dark tiles loaded from a CDN, so the **browser**
> needs internet access.

## Frontend

- Dark UI with a full-screen map (CartoDB `dark_matter` tiles).
- **Base map switch** — dark cartography or **satellite imagery** (Esri World Imagery).
- **Hideable side panel** — collapse it for a full-width map, restore with the `››` button.
- **Species markers** — each species gets a colour **and a shape** (circle, square,
  triangle, diamond, hexagon). 14 colours x 5 shapes keeps species distinguishable
  well past the point where colour alone would repeat.
- **Save JPG** — exports the current view as a JPEG with the markers and a species
  legend drawn in. Tiles are re-fetched with CORS and composited onto a canvas, so
  no screenshot tooling or external library is needed.
- Each sighting is a 🍄 marker; click it for the photo, notes, coordinates, and a delete button.
- **Filter** box (with autocomplete of known names) narrows the markers live.
- **Delete buttons** — hover a row to reveal `✕`: on a **sightings list** row it removes
  that one sighting; on a **legend** row it removes the whole species group. Both ask
  for confirmation and state how many records will go.
- **Add a sighting** form:
  - Pick a **geotagged photo** and the coordinates auto-fill from its EXIF GPS (a pin drops on the map instantly).
  - No GPS in the photo? Click the map to drop a pin, or type coordinates manually.

## EXIF auto-location & capture time

The app reads a photo's EXIF metadata so you don't have to enter details by hand:

- **Location** — GPS coordinates fill the form (and the API) when `lat`/`lng` aren't supplied.
- **Capture time** — `DateTimeOriginal` (falling back to `CreateDate` / `DateTimeDigitized`) is stored as `takenAt`. Popups show "📸 Taken …" using it, or fall back to when the sighting was logged.

How it flows:

- **Live** — selecting a photo calls `POST /api/exif`, which returns `{ hasLocation, lat, lng, takenAt }` for the form to auto-fill.
- **Server-side fallback** — `POST /api/mushrooms` reads the same EXIF, so the API works even without the browser.
- Manually entered coordinates always take precedence. Each record notes its location origin via `locationSource` (`"manual"` or `"exif"`); `takenAt` is `null` when the photo has no date.

> EXIF dates carry no timezone, so `takenAt` is normalized to UTC and rendered in the viewer's local time.

## API

| Method | Path                 | Description                                         |
| ------ | -------------------- | --------------------------------------------------- |
| POST   | `/api/mushrooms`     | Create a sighting (`multipart/form-data`); EXIF fills missing coords |
| GET    | `/api/mushrooms`     | List sightings; `?name=` filters by substring       |
| GET    | `/api/names`         | Distinct mushroom names (for the filter dropdown)   |
| POST   | `/api/exif`          | Read GPS from an uploaded photo without saving it   |
| DELETE | `/api/mushrooms/:id` | Delete a sighting and its image                      |
| DELETE | `/api/species/:name` | Delete **every** sighting of one species (exact, case-insensitive name) |

### Create fields (`multipart/form-data`)

| Field   | Required        | Notes                                            |
| ------- | --------------- | ------------------------------------------------ |
| `name`  | yes             | Mushroom name                                    |
| `lat`   | see note        | Latitude, `-90..90`                              |
| `lng`   | see note        | Longitude, `-180..180`                           |
| `image` | no              | Photo (`image/*`, max 15 MB)                     |
| `notes` | no              | Free text                                        |

> `lat`/`lng` are required **unless** the uploaded photo has GPS EXIF, in which
> case they're taken from the photo. Supplying them manually overrides EXIF.

### Example

```bash
curl -X POST http://localhost:3000/api/mushrooms \
  -F name="Chanterelle" -F lat=50.061 -F lng=19.937 \
  -F notes="Under oak" -F image=@photo.jpg

curl "http://localhost:3000/api/mushrooms?name=chan"
```

## Layout

```
server.js            Express API + static hosting
public/index.html    Frontend markup
public/styles.css    Dark theme
public/app.js        Map, filter, upload logic
data/mushrooms.json  Metadata store (auto-created)
uploads/             Uploaded images (auto-created)
```
