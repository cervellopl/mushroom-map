--[[
  ExportServiceProvider.lua

  Uploads each rendered photo to the Mushroom Map API and archives a copy to a
  local "sent" folder.

  Field mapping (Mushroom Map API `POST /api/mushrooms`, multipart/form-data):
    name   <- the mushroom Latin name (the photo's Title, else the dialog default)
    lat    <- catalog GPS latitude   (if present and "Send GPS" is on)
    lng    <- catalog GPS longitude
    notes  <- the photo's Caption    (if present)
    image  <- the rendered JPEG

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

local Common = require 'MushroomMapCommon'

local logger = LrLogger('MushroomMap')
logger:enable('logfile') -- writes to Documents/LrClassicLogs/MushroomMap.log

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
-- Smart collections are included; Lightroom returns them from the same call.
local function collectionNameFor(photo)
	local ok, collections = pcall(function() return photo:getContainedCollections() end)
	if not ok or not collections then return '' end
	for _, collection in ipairs(collections) do
		local gotName, name = pcall(function() return collection:getName() end)
		if gotName and name and name ~= '' then return name end
	end
	return ''
end

--- Resolve the mushroom Latin name for a photo, per the configured source.
local function resolveName(photo, settings)
	local source = settings.nameSource or 'collection'
	local value = ''

	if source == 'collection' then
		value = collectionNameFor(photo)
	elseif source == 'title' then
		value = photo:getFormattedMetadata('title') or ''
	elseif source == 'caption' then
		value = photo:getFormattedMetadata('caption') or ''
	end

	if value == nil or value == '' then value = settings.defaultName or '' end
	if value == '' then value = 'Unknown' end
	return value
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

	local apiUrl = (exportSettings.apiUrl or ''):gsub('/+$', '') -- trim trailing slash
	local endpoint = apiUrl .. '/api/mushrooms'

	-- Shared request headers.
	local headers = {
		{ field = 'ngrok-skip-browser-warning', value = '1' }, -- harmless if not using ngrok
	}
	if exportSettings.authUser and exportSettings.authUser ~= '' then
		local cred = LrStringUtils.encodeBase64(exportSettings.authUser .. ':' .. (exportSettings.authPass or ''))
		table.insert(headers, { field = 'Authorization', value = 'Basic ' .. cred })
	end

	local uploaded, failed = 0, 0
	local failures = {}

	for _i, rendition in exportContext:renditions { stopIfCanceled = true } do
		-- waitForRender() completes the rendition; do NOT also call
		-- renditionIsDone() afterwards, or the export session breaks and every
		-- photo after the first fails to render.
		local success, pathOrMessage = rendition:waitForRender()

		if progressScope:isCanceled() then break end

		if success then
			local photo = rendition.photo
			local name = resolveName(photo, exportSettings)

			-- multipart body
			local mimeChunks = {
				{ name = 'name', value = name },
			}

			if exportSettings.sendGps then
				local gps = photo:getRawMetadata('gps')
				if gps and gps.latitude and gps.longitude then
					table.insert(mimeChunks, { name = 'lat', value = tostring(gps.latitude) })
					table.insert(mimeChunks, { name = 'lng', value = tostring(gps.longitude) })
				end
			end

			local caption = photo:getFormattedMetadata('caption')
			if caption and caption ~= '' then
				table.insert(mimeChunks, { name = 'notes', value = caption })
			end

			table.insert(mimeChunks, {
				name = 'image',
				fileName = LrPathUtils.leafName(pathOrMessage),
				filePath = pathOrMessage,
				contentType = 'image/jpeg',
			})

			-- send
			local body, respHeaders = LrHttp.postMultipart(endpoint, mimeChunks, headers)
			local status = respHeaders and respHeaders.status
			local netError = respHeaders and respHeaders.error

			if netError then
				failed = failed + 1
				failures[#failures + 1] = string.format('%s: network error (%s)',
					name, tostring(netError.name or netError.errorCode or 'unknown'))
				logger:error('Network error uploading ' .. name .. ': ' .. tostring(netError.name))
			elseif status and status >= 200 and status < 300 then
				uploaded = uploaded + 1

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
	if failed == 0 then
		LrDialogs.message('Mushroom Map',
			string.format('Uploaded %d photo%s successfully.', uploaded, uploaded == 1 and '' or 's'),
			'info')
	else
		LrDialogs.message('Mushroom Map',
			string.format('Uploaded %d, failed %d.', uploaded, failed),
			'warning')
		LrDialogs.message('Mushroom Map — details', table.concat(failures, '\n'), 'warning')
	end
end

return exportServiceProvider
