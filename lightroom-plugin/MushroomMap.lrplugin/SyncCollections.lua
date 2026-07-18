--[[
  SyncCollections.lua

  "Sync collections to Mushroom Map" — pick any number of collections and
  upload every photo in them, each sighting named after its own collection.

  Photos already uploaded by a previous sync are skipped, so re-running only
  sends what is new. The record of what has been sent lives in this plugin's
  preferences (keyed by catalog photo id), so it is per-machine.
]]

local LrApplication = import 'LrApplication'
local LrDialogs = import 'LrDialogs'
local LrView = import 'LrView'
local LrBinding = import 'LrBinding'
local LrTasks = import 'LrTasks'
local LrFunctionContext = import 'LrFunctionContext'
local LrExportSession = import 'LrExportSession'
local LrPathUtils = import 'LrPathUtils'
local LrFileUtils = import 'LrFileUtils'
local LrProgressScope = import 'LrProgressScope'
local LrLogger = import 'LrLogger'

local Common = require 'MushroomMapCommon'

local logger = LrLogger('MushroomMap')
logger:enable('logfile')

--============================================================================
-- Sync history (which photos have already been uploaded)
--============================================================================

local function loadSynced()
	local prefs = Common.prefs()
	local stored = prefs.syncedPhotos
	local copy = {}
	if type(stored) == 'table' then
		for k, v in pairs(stored) do copy[k] = v end
	end
	return copy
end

-- LrPrefs does not notice mutations inside a nested table, so always assign
-- the whole table back.
local function saveSynced(tbl)
	Common.prefs().syncedPhotos = tbl
end

--============================================================================
-- Collection discovery
--============================================================================

local function gatherCollections(node, prefix, out)
	for _, collection in ipairs(node:getChildCollections()) do
		out[#out + 1] = {
			collection = collection,
			path = prefix .. collection:getName(),
		}
	end
	for _, set in ipairs(node:getChildCollectionSets()) do
		gatherCollections(set, prefix .. set:getName() .. ' / ', out)
	end
end

--============================================================================
-- Rendering + upload
--============================================================================

--- Renders go to a scratch folder we own; each file is deleted after upload.
-- Lightroom requires LR_export_destinationPathPrefix even when exporting to a
-- temporary location, so point it at an explicit directory.
local function scratchFolder()
	local dir = LrPathUtils.child(
		LrPathUtils.getStandardFilePath('temp'), 'MushroomMapSync')
	LrFileUtils.createAllDirectories(dir)
	return dir
end

local function exportSettings()
	return {
		LR_format = 'JPEG',
		LR_jpeg_quality = 0.8,
		LR_export_colorSpace = 'sRGB',
		LR_export_destinationType = 'specificFolder',
		LR_export_destinationPathPrefix = scratchFolder(),
		LR_export_useSubfolder = false,
		LR_collisionHandling = 'rename',
		LR_size_doConstrain = true,
		LR_size_resizeType = 'longEdge',
		LR_size_units = 'pixels',
		LR_size_maxWidth = 2400,
		LR_size_maxHeight = 2400,
		LR_outputSharpeningOn = false,
		LR_outputSharpeningMedia = 'screen',
		LR_outputSharpeningLevel = 2,
		LR_removeLocationMetadata = false, -- keep GPS in the exported JPEG
		LR_minimizeEmbeddedMetadata = false,
		LR_embeddedMetadataOption = 'all',
		LR_metadata_keywordOptions = 'lightroomHierarchical',
		LR_includeVideoFiles = false,
		LR_includeFaceTagsInIptc = false,
		LR_renamingTokensOn = false,
		LR_tokens = '{{image_name}}',
		LR_tokenCustomString = '',
		LR_initialSequenceNumber = 1,
		LR_useWatermark = false,
		LR_jpeg_useLimitSize = false,
		LR_reimportExportedPhoto = false,
		LR_reimport_stackWithOriginal = false,
		LR_export_bitDepth = 8,
	}
end

--- Upload every not-yet-synced photo of one collection.
local function syncOneCollection(entry, settings, synced, progress, stats)
	local catalog = LrApplication.activeCatalog()
	local name = entry.collection:getName()

	local photos = {}
	local ok, err = LrTasks.pcall(function()
		catalog:withReadAccessDo(function()
			for _, photo in ipairs(entry.collection:getPhotos()) do
				local id = tostring(photo.localIdentifier)
				if not synced[id] then photos[#photos + 1] = photo end
			end
		end, { timeout = 15 })
	end)
	if not ok then
		stats.failures[#stats.failures + 1] = entry.path .. ': ' .. tostring(err)
		return
	end

	stats.skipped = stats.skipped + (entry.total - #photos)
	if #photos == 0 then return end

	local session = LrExportSession {
		photosToExport = photos,
		exportSettings = exportSettings(),
	}

	for _, rendition in session:renditions { stopIfCanceled = true } do
		if progress:isCanceled() then return end

		local rendered, pathOrMessage = rendition:waitForRender()
		if not rendered then
			stats.failed = stats.failed + 1
			stats.failures[#stats.failures + 1] =
				name .. ': render failed (' .. tostring(pathOrMessage) .. ')'
		else
			local photo = rendition.photo
			local lat, lng, notes

			LrTasks.pcall(function()
				catalog:withReadAccessDo(function()
					if settings.sendGps then
						local gps = photo:getRawMetadata('gps')
						if gps and gps.latitude and gps.longitude then
							lat, lng = gps.latitude, gps.longitude
						end
					end
					notes = photo:getFormattedMetadata('caption')
				end, { timeout = 15 })
			end)

			local uploaded, message = Common.uploadImage {
				apiUrl = settings.apiUrl,
				user = settings.authUser,
				pass = settings.authPass,
				name = name, -- the collection name is the Latin name
				lat = lat,
				lng = lng,
				notes = notes,
				filePath = pathOrMessage,
			}

			if uploaded then
				stats.uploaded = stats.uploaded + 1
				synced[tostring(photo.localIdentifier)] = true

				local sent = settings.sentFolder
				if sent and sent ~= '' then
					LrTasks.pcall(function()
						LrFileUtils.createAllDirectories(sent)
						local dest = LrPathUtils.child(sent, LrPathUtils.leafName(pathOrMessage))
						if not LrFileUtils.exists(dest) then
							LrFileUtils.copy(pathOrMessage, dest)
						end
					end)
				end
			else
				stats.failed = stats.failed + 1
				stats.failures[#stats.failures + 1] = name .. ': ' .. tostring(message)
				logger:error('sync upload failed for ' .. name .. ': ' .. tostring(message))
			end

			LrTasks.pcall(function() LrFileUtils.delete(pathOrMessage) end)
		end
	end
end

--============================================================================
-- Main
--============================================================================

LrTasks.startAsyncTask(function()
	LrFunctionContext.callWithContext('mushroomMapSync', function(context)
		local catalog = LrApplication.activeCatalog()
		local settings = Common.prefs()

		if Common.normalizeUrl(settings.apiUrl) == '' or
			settings.apiUrl == Common.DEFAULT_URL then
			LrDialogs.message('Mushroom Map',
				'Set the API base URL first, in File ▸ Plug-in Manager ▸ Mushroom Map.',
				'warning')
			return
		end

		-- Find every collection, with its photo count.
		local entries = {}
		local ok, err = LrTasks.pcall(function()
			catalog:withReadAccessDo(function()
				gatherCollections(catalog, '', entries)
				for _, entry in ipairs(entries) do
					entry.total = #entry.collection:getPhotos()
				end
			end, { timeout = 30 })
		end)
		if not ok then
			LrDialogs.message('Mushroom Map', 'Could not read collections:\n' .. tostring(err), 'critical')
			return
		end
		if #entries == 0 then
			LrDialogs.message('Mushroom Map',
				'This catalogue has no collections. Create one per species, then sync.', 'info')
			return
		end

		table.sort(entries, function(a, b) return a.path < b.path end)

		-- Selection dialog
		local synced = loadSynced()
		local f = LrView.osFactory()
		local props = LrBinding.makePropertyTable(context)

		local rows = {}
		for i, entry in ipairs(entries) do
			props['sel_' .. i] = false
			local pending = 0
			LrTasks.pcall(function()
				catalog:withReadAccessDo(function()
					for _, photo in ipairs(entry.collection:getPhotos()) do
						if not synced[tostring(photo.localIdentifier)] then pending = pending + 1 end
					end
				end, { timeout = 15 })
			end)
			entry.pending = pending
			rows[#rows + 1] = f:row {
				f:checkbox {
					title = string.format('%s  —  %d photo%s, %d new',
						entry.path, entry.total, entry.total == 1 and '' or 's', pending),
					value = LrView.bind('sel_' .. i),
				},
			}
		end

		local contents = f:column {
			bind_to_object = props,
			spacing = f:control_spacing(),
			f:static_text {
				title = 'Each sighting is named after its collection.\n' ..
					'Photos uploaded by an earlier sync are skipped.',
			},
			f:separator { fill_horizontal = 1 },
			f:scrolled_view { width = 560, height = 320, unpack(rows) },
			f:row {
				f:push_button {
					title = 'Select all',
					action = function()
						for i = 1, #entries do props['sel_' .. i] = true end
					end,
				},
				f:push_button {
					title = 'Select none',
					action = function()
						for i = 1, #entries do props['sel_' .. i] = false end
					end,
				},
				f:push_button {
					title = 'Mark selected as synced',
					action = function()
						LrTasks.startAsyncTask(function()
							local marked = 0
							local history = loadSynced()
							for i, entry in ipairs(entries) do
								if props['sel_' .. i] then
									LrTasks.pcall(function()
										catalog:withReadAccessDo(function()
											for _, photo in ipairs(entry.collection:getPhotos()) do
												local id = tostring(photo.localIdentifier)
												if not history[id] then
													history[id] = true
													marked = marked + 1
												end
											end
										end, { timeout = 15 })
									end)
								end
							end
							saveSynced(history)
							LrDialogs.message('Mushroom Map',
								string.format(
									'Marked %d photo%s as already uploaded, without sending them.\n\n' ..
									'Use this for photos you uploaded before, so the next sync only ' ..
									'sends new ones. Reopen this dialog to see the updated counts.',
									marked, marked == 1 and '' or 's'),
								'info')
						end)
					end,
				},
				f:push_button {
					title = 'Reset sync history',
					action = function()
						saveSynced({})
						LrDialogs.message('Mushroom Map',
							'Sync history cleared — the next sync re-uploads everything.', 'info')
					end,
				},
			},
		}

		local result = LrDialogs.presentModalDialog {
			title = 'Sync collections to Mushroom Map',
			contents = contents,
			actionVerb = 'Sync',
		}
		if result ~= 'ok' then return end

		local selected = {}
		for i, entry in ipairs(entries) do
			if props['sel_' .. i] then selected[#selected + 1] = entry end
		end
		if #selected == 0 then
			LrDialogs.message('Mushroom Map', 'No collections selected.', 'info')
			return
		end

		-- Upload
		local stats = { uploaded = 0, failed = 0, skipped = 0, failures = {} }
		local progress = LrProgressScope {
			title = string.format('Syncing %d collection%s to Mushroom Map',
				#selected, #selected == 1 and '' or 's'),
			functionContext = context,
		}

		for i, entry in ipairs(selected) do
			if progress:isCanceled() then break end
			progress:setCaption(entry.path)
			progress:setPortionComplete(i - 1, #selected)
			syncOneCollection(entry, settings, synced, progress, stats)
		end

		progress:done()
		saveSynced(synced)

		local summary = string.format(
			'Uploaded %d photo%s.\nSkipped %d already synced.\nFailed %d.',
			stats.uploaded, stats.uploaded == 1 and '' or 's', stats.skipped, stats.failed)

		if stats.failed > 0 then
			LrDialogs.message('Mushroom Map — sync finished', summary, 'warning')
			LrDialogs.message('Mushroom Map — failures',
				table.concat(stats.failures, '\n'):sub(1, 2000), 'warning')
		else
			LrDialogs.message('Mushroom Map — sync finished', summary, 'info')
		end
	end)
end)
