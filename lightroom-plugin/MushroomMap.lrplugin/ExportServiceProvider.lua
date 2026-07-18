--[[
  ExportServiceProvider.lua

  Uploads each rendered photo to the Mushroom Map API and archives a copy to a
  local "sent" folder.

  Uploads use `POST /api/mushrooms/raw`: metadata in the query string, the
  rendered JPEG as the raw request body. LrHttp.postMultipart declares a
  Content-Length shorter than it actually writes, and the surplus bytes corrupt
  the keep-alive connection so only the first photo of a batch succeeds.

  Field mapping:
    name   <- the mushroom Latin name (collection name by default)
    lat    <- catalog GPS latitude   (if present and "Send GPS" is on)
    lng    <- catalog GPS longitude
    notes  <- the photo's Caption    (if present)
    body   <- the rendered JPEG

  The capture timestamp is not sent explicitly: the API reads it from the
  rendered JPEG's EXIF, provided Lightroom's export keeps metadata (do not tick
  "Remove Location Info" if you also want GPS embedded).
]]

local LrHttp = import 'LrHttp'
local LrPathUtils = import 'LrPathUtils'
local LrFileUtils = import 'LrFileUtils'
local LrDialogs = import 'LrDialogs'
local LrStringUtils = import 'LrStringUtils'
local LrView = import 'LrView'
local LrErrors = import 'LrErrors'
local LrLogger = import 'LrLogger'
local LrApplication = import 'LrApplication'

local Common = require 'MushroomMapCommon'

local logger = LrLogger('MushroomMap')
logger:enable('logfile') -- writes to Documents/LrClassicLogs/MushroomMap.log

-- Forward declarations so the dialog's buttons can call helpers defined below.
local collectionNameFor, folderNameFor, resolveName, previewNames

--============================================================================
local exportServiceProvider = {}

-- We render to a temp folder ourselves and copy to the "sent" folder, so the
-- standard export-destination section is unnecessary.
exportServiceProvider.hideSections = { 'exportLocation' }

-- Keep output web-friendly.
exportServiceProvider.allowFileFormats = { 'JPEG' }
exportServiceProvider.allowColorSpaces = { 'sRGB' }
exportServiceProvider.canExportVideo = false

exportServiceProvider.exportPresetFields = {
	{ key = 'apiUrl',        default = 'https://your-mushroom-map.example.com' },
	{ key = 'authUser',      default = '' },
	{ key = 'authPass',      default = '' },
	{ key = 'defaultName',   default = '' },
	-- Where the mushroom Latin name comes from: 'collection' | 'title' | 'caption' | 'default'
	{ key = 'nameSource',    default = 'collection' },
	{ key = 'sendGps',       default = true },
	{ key = 'sentFolder',    default = [[C:\Users\macre\OneDrive\Dokumenty\lightroom ext\sent]] },
}

--============================================================================
-- Export dialog UI
--============================================================================

-- Seed this export preset from the plugin-wide settings (Plug-in Manager), and
-- mirror any edits back so both stay in sync.
function exportServiceProvider.startDialog(propertyTable)
	local prefs = Common.prefs()

	local function seed(key)
		local current = propertyTable[key]
		local isUnset = current == nil or current == ''
			or current == Common.DEFAULT_URL
		if isUnset and prefs[key] ~= nil and prefs[key] ~= '' then
			propertyTable[key] = prefs[key]
		end
	end

	for _, key in ipairs { 'apiUrl', 'authUser', 'authPass', 'sentFolder' } do
		seed(key)
		propertyTable:addObserver(key, function()
			prefs[key] = propertyTable[key]
		end)
	end
end

function exportServiceProvider.sectionsForTopOfDialog(f, propertyTable)
	local bind = LrView.bind
	local share = LrView.share

	return {
		{
			title = 'Mushroom Map — Server',
			bind_to_object = propertyTable,

			f:row {
				f:static_text { title = 'API base URL:', alignment = 'right', width = share 'label_width' },
				f:edit_field {
					value = bind 'apiUrl',
					width_in_chars = 40,
					immediate = true,
					tooltip = 'e.g. https://your-tunnel.ngrok-free.dev or http://192.168.1.10:3000',
				},
			},
			f:row {
				f:static_text { title = 'Username:', alignment = 'right', width = share 'label_width' },
				f:edit_field { value = bind 'authUser', width_in_chars = 20, immediate = true },
				f:static_text { title = 'Password:' },
				f:edit_field { value = bind 'authPass', width_in_chars = 20, immediate = true },
			},
			f:row {
				f:static_text {
					title = 'Leave username/password blank if the server has no Basic Auth.',
					text_color = import('LrColor')(0.5, 0.5, 0.5),
				},
			},
			f:row {
				f:push_button {
					title = 'Test connection',
					action = function()
						Common.testConnection(propertyTable.apiUrl, propertyTable.authUser, propertyTable.authPass)
					end,
				},
				f:static_text {
					title = 'These settings are shared with File ▸ Plug-in Manager.',
					text_color = import('LrColor')(0.5, 0.5, 0.5),
				},
			},
		},

		{
			title = 'Mushroom Map — Sighting',
			bind_to_object = propertyTable,

			f:row {
				f:static_text { title = 'Latin name from:', alignment = 'right', width = share 'label_width' },
				f:popup_menu {
					value = bind 'nameSource',
					items = {
						{ title = "Collection name (the photo's collection)", value = 'collection' },
						{ title = 'Folder name (the folder on disk)', value = 'folder' },
						{ title = 'Title metadata field', value = 'title' },
						{ title = 'Caption metadata field', value = 'caption' },
						{ title = 'Always use the default name below', value = 'default' },
					},
					width_in_chars = 34,
				},
			},
			f:row {
				f:static_text { title = 'Default name:', alignment = 'right', width = share 'label_width' },
				f:edit_field {
					value = bind 'defaultName',
					width_in_chars = 30,
					immediate = true,
					tooltip = 'Fallback when the chosen source is empty for a photo.',
				},
			},
			f:row {
				f:checkbox {
					title = 'Send GPS coordinates from the catalog',
					value = bind 'sendGps',
				},
			},
			f:row {
				f:push_button {
					title = 'Preview names',
					action = function() previewNames(propertyTable) end,
				},
				f:static_text {
					title = 'Shows what the plugin reads from the selected photos.',
					text_color = import('LrColor')(0.5, 0.5, 0.5),
				},
			},
		},

		{
			title = 'Mushroom Map — Local archive',
			bind_to_object = propertyTable,

			f:row {
				f:static_text { title = 'Sent folder:', alignment = 'right', width = share 'label_width' },
				f:edit_field { value = bind 'sentFolder', width_in_chars = 45, immediate = true },
			},
			f:row {
				f:push_button {
					title = 'Choose…',
					action = function()
						local chosen = LrDialogs.runOpenPanel {
							title = 'Choose the "sent" folder',
							canChooseFiles = false,
							canChooseDirectories = true,
							canCreateDirectories = true,
							allowsMultipleSelection = false,
						}
						if chosen and chosen[1] then
							propertyTable.sentFolder = chosen[1]
						end
					end,
				},
				f:static_text {
					title = 'Each successfully sent photo is copied here.',
					text_color = import('LrColor')(0.5, 0.5, 0.5),
				},
			},
		},
	}
end

--============================================================================
-- Helpers
--============================================================================

--- Name of the first collection containing this photo ('' if none).
-- getContainedCollections() reads the catalog, so it must run inside
-- withReadAccessDo() — otherwise it throws and we silently end up with no name.
function collectionNameFor(photo)
	local result = ''
	local ok, err = pcall(function()
		LrApplication.activeCatalog():withReadAccessDo(function()
			local collections = photo:getContainedCollections()
			if collections then
				for _, collection in ipairs(collections) do
					local name = collection:getName()
					if name and name ~= '' then
						result = name
						return
					end
				end
			end
		end, { timeout = 10 })
	end)
	if not ok then
		logger:warn('collection lookup failed: ' .. tostring(err))
	end
	return result
end

--- Name of the folder the photo file lives in ('' if unavailable).
function folderNameFor(photo)
	local ok, name = pcall(function()
		local filePath = photo:getRawMetadata('path')
		if not filePath or filePath == '' then return '' end
		return LrPathUtils.leafName(LrPathUtils.parent(filePath))
	end)
	return (ok and name) or ''
end

--- Resolve the mushroom Latin name for a photo, per the configured source.
-- Falls back to the default name, then 'Unknown'. Each resolution is logged so
-- an unexpected 'Unknown' can be traced in MushroomMap.log.
function resolveName(photo, settings)
	local source = settings.nameSource or 'collection'
	local value = ''

	if source == 'collection' then
		value = collectionNameFor(photo)
	elseif source == 'folder' then
		value = folderNameFor(photo)
	elseif source == 'title' then
		value = photo:getFormattedMetadata('title') or ''
	elseif source == 'caption' then
		value = photo:getFormattedMetadata('caption') or ''
	end

	local resolvedFrom = source
	if value == nil or value == '' then
		value = settings.defaultName or ''
		resolvedFrom = 'default name'
	end
	if value == '' then
		value = 'Unknown'
		resolvedFrom = 'fallback (source and default both empty)'
	end

	logger:info(string.format('name "%s" resolved from %s', value, resolvedFrom))
	return value
end

--- Diagnostic: report what the plugin actually reads from the selected photos.
-- Answers "why did this upload as Unknown?" without guesswork.
function previewNames(settings)
	local LrTasks = import 'LrTasks'
	LrTasks.startAsyncTask(function()
		local catalog = LrApplication.activeCatalog()
		local photos = catalog:getTargetPhotos()

		if not photos or #photos == 0 then
			LrDialogs.message('Mushroom Map — name preview',
				'No photos are selected. Select some in the Library and try again.', 'warning')
			return
		end

		local lines = {}
		local limit = math.min(#photos, 10)

		for i = 1, limit do
			local photo = photos[i]
			local filename = photo:getFormattedMetadata('fileName') or '(unnamed)'

			-- Collect every candidate, so we can see which are actually populated.
			local collections = collectionNameFor(photo)
			local folder = folderNameFor(photo)
			local title = photo:getFormattedMetadata('title') or ''
			local caption = photo:getFormattedMetadata('caption') or ''
			local resolved = resolveName(photo, settings)

			local function show(v) return (v ~= nil and v ~= '') and v or '(empty)' end

			lines[#lines + 1] = string.format(
				'%s\n    collection: %s\n    folder: %s\n    title: %s\n    caption: %s\n    -> would upload as: %s',
				filename, show(collections), show(folder), show(title), show(caption), resolved)
		end

		if #photos > limit then
			lines[#lines + 1] = string.format('... and %d more', #photos - limit)
		end

		LrDialogs.message(
			string.format('Mushroom Map — name preview (source: %s)',
				tostring(settings.nameSource or 'collection')),
			table.concat(lines, '\n\n'), 'info')
	end)
end

-- Avoid clobbering an existing file in the sent folder.
local function uniqueDestination(folder, leafName)
	local dest = LrPathUtils.child(folder, leafName)
	if not LrFileUtils.exists(dest) then return dest end

	local base = LrPathUtils.removeExtension(leafName)
	local ext = LrPathUtils.extension(leafName)
	local n = 1
	repeat
		local candidate = LrPathUtils.child(folder, string.format('%s-%d.%s', base, n, ext))
		if not LrFileUtils.exists(candidate) then return candidate end
		n = n + 1
	until n > 9999
	return dest -- give up gracefully; caller will overwrite
end

--============================================================================
-- The actual upload
--============================================================================

function exportServiceProvider.processRenderedPhotos(functionContext, exportContext)
	local exportSettings = exportContext.propertyTable
	local nPhotos = exportContext.exportSession:countRenditions()

	local progressScope = exportContext:configureProgress {
		title = nPhotos > 1
			and string.format('Uploading %d photos to Mushroom Map', nPhotos)
			or 'Uploading one photo to Mushroom Map',
	}

	local endpoint = Common.normalizeUrl(exportSettings.apiUrl) .. '/api/mushrooms/raw'

	-- Same headers as the connection test: ngrok bypass, Basic Auth, and
	-- Connection: close so each upload uses a fresh socket.
	local headers = Common.buildHeaders(exportSettings.authUser, exportSettings.authPass)

	local uploaded, failed, unnamed = 0, 0, 0
	local failures = {}

	local SOURCE_LABEL = {
		collection = 'Collection name',
		folder = 'Folder name',
		title = 'Title',
		caption = 'Caption',
		default = 'the default name',
	}

	for _i, rendition in exportContext:renditions { stopIfCanceled = true } do
		-- waitForRender() completes the rendition; do NOT also call
		-- renditionIsDone() afterwards, or the export session breaks and every
		-- photo after the first fails to render.
		local success, pathOrMessage = rendition:waitForRender()

		if progressScope:isCanceled() then break end

		if success then
			local photo = rendition.photo
			local name = resolveName(photo, exportSettings)

			-- Metadata travels in the query string; the body is the raw JPEG.
			-- (LrHttp.postMultipart under-declares Content-Length, which
			-- corrupts the connection and breaks every photo after the first.)
			local query = { 'name=' .. Common.urlEncode(name) }

			if exportSettings.sendGps then
				local gps = photo:getRawMetadata('gps')
				if gps and gps.latitude and gps.longitude then
					query[#query + 1] = 'lat=' .. Common.urlEncode(tostring(gps.latitude))
					query[#query + 1] = 'lng=' .. Common.urlEncode(tostring(gps.longitude))
				end
			end

			local caption = photo:getFormattedMetadata('caption')
			if caption and caption ~= '' then
				query[#query + 1] = 'notes=' .. Common.urlEncode(caption)
			end

			local imageData = LrFileUtils.readFile(pathOrMessage)
			local body, respHeaders

			if not imageData or #imageData == 0 then
				respHeaders = { error = { name = 'could not read rendered file' } }
			else
				local url = endpoint .. '?' .. table.concat(query, '&')
				local postHeaders = {}
				for _, h in ipairs(headers) do postHeaders[#postHeaders + 1] = h end
				postHeaders[#postHeaders + 1] = { field = 'Content-Type', value = 'image/jpeg' }
				body, respHeaders = LrHttp.post(url, imageData, postHeaders)
			end

			local status = respHeaders and respHeaders.status
			local netError = respHeaders and respHeaders.error

			if netError then
				failed = failed + 1
				failures[#failures + 1] = string.format('%s: network error (%s)',
					name, tostring(netError.name or netError.errorCode or 'unknown'))
				logger:error('Network error uploading ' .. name .. ': ' .. tostring(netError.name))
			elseif status and status >= 200 and status < 300 then
				uploaded = uploaded + 1
				if name == 'Unknown' then unnamed = unnamed + 1 end

				-- Archive to the local "sent" folder.
				local sent = exportSettings.sentFolder
				if sent and sent ~= '' then
					local ok, err = pcall(function()
						LrFileUtils.createAllDirectories(sent)
						local dest = uniqueDestination(sent, LrPathUtils.leafName(pathOrMessage))
						LrFileUtils.copy(pathOrMessage, dest)
					end)
					if not ok then
						logger:warn('Uploaded but failed to archive ' .. name .. ': ' .. tostring(err))
						failures[#failures + 1] = string.format('%s: uploaded, but archiving to "%s" failed', name, sent)
					end
				end
			else
				failed = failed + 1
				failures[#failures + 1] = string.format('%s: HTTP %s — %s',
					name, tostring(status or '?'), tostring(body or ''):sub(1, 120))
				logger:error('HTTP ' .. tostring(status) .. ' uploading ' .. name)
			end
		else
			failed = failed + 1
			failures[#failures + 1] = 'Render failed: ' .. tostring(pathOrMessage)
		end

		-- Clean up the temporary rendition (we keep our own copy in the sent
		-- folder). Guarded so a locked file can't abort the whole batch.
		if success and pathOrMessage then
			pcall(function() LrFileUtils.delete(pathOrMessage) end)
		end
	end

	-- Summary
	local nameHint = ''
	if unnamed > 0 then
		nameHint = string.format(
			'\n\n%d photo%s had no name and was uploaded as "Unknown".\n' ..
			'"Latin name from" is set to %s, which is empty for %s.\n' ..
			'Pick a different source in the export dialog, or set a Default name.',
			unnamed, unnamed == 1 and '' or 's',
			SOURCE_LABEL[exportSettings.nameSource or 'collection'] or tostring(exportSettings.nameSource),
			unnamed == 1 and 'that photo' or 'those photos')
	end

	if failed == 0 then
		LrDialogs.message('Mushroom Map',
			string.format('Uploaded %d photo%s successfully.', uploaded, uploaded == 1 and '' or 's')
				.. nameHint,
			unnamed > 0 and 'warning' or 'info')
	else
		LrDialogs.message('Mushroom Map',
			string.format('Uploaded %d, failed %d.', uploaded, failed),
			'warning')
		LrDialogs.message('Mushroom Map — details', table.concat(failures, '\n'), 'warning')
	end
end

return exportServiceProvider
