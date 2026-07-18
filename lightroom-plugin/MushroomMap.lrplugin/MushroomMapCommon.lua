--[[
  MushroomMapCommon.lua

  Shared helpers for the Mushroom Map plugin: connection settings stored in
  plugin preferences (so they are configured once, in the Plug-in Manager, and
  reused by every export preset), request headers, and a connection test.
]]

local LrHttp = import 'LrHttp'
local LrPrefs = import 'LrPrefs'
local LrDialogs = import 'LrDialogs'
local LrStringUtils = import 'LrStringUtils'
local LrTasks = import 'LrTasks'

local Common = {}

Common.DEFAULT_URL = 'https://your-mushroom-map.example.com'
Common.DEFAULT_SENT_FOLDER = [[C:\Users\macre\OneDrive\Dokumenty\lightroom ext\sent]]

--- Plugin-wide preferences (shared across all export presets).
function Common.prefs()
	local prefs = LrPrefs.prefsForPlugin()
	if prefs.apiUrl == nil then prefs.apiUrl = Common.DEFAULT_URL end
	if prefs.authUser == nil then prefs.authUser = '' end
	if prefs.authPass == nil then prefs.authPass = '' end
	if prefs.sentFolder == nil then prefs.sentFolder = Common.DEFAULT_SENT_FOLDER end
	return prefs
end

--- Strip trailing slashes so we can append '/api/...' safely.
function Common.normalizeUrl(url)
	return (tostring(url or ''):gsub('%s+', ''):gsub('/+$', ''))
end

--- Build request headers, including Basic Auth when a username is set.
function Common.buildHeaders(user, pass)
	local headers = {
		-- Harmless when not behind ngrok; skips ngrok's browser interstitial.
		{ field = 'ngrok-skip-browser-warning', value = '1' },
		-- NOTE: do not send "Connection: close" here. Lightroom's LrHttp keeps
		-- writing on a socket it has declared closed, so Node rejects the
		-- request with HPE_CLOSED_CONNECTION ("Data after `Connection: close`")
		-- and every upload fails with an empty HTTP 400.
	}
	if user and user ~= '' then
		local cred = LrStringUtils.encodeBase64(user .. ':' .. (pass or ''))
		table.insert(headers, { field = 'Authorization', value = 'Basic ' .. cred })
	end
	return headers
end

--- Ping the API and report the outcome in a dialog. Safe to call from a UI
--- button: it runs the HTTP request on its own async task.
function Common.testConnection(url, user, pass)
	LrTasks.startAsyncTask(function()
		local base = Common.normalizeUrl(url)
		if base == '' then
			LrDialogs.message('Mushroom Map', 'Please enter the API base URL first.', 'warning')
			return
		end

		local endpoint = base .. '/api/names'
		local body, respHeaders = LrHttp.get(endpoint, Common.buildHeaders(user, pass))
		local status = respHeaders and respHeaders.status
		local netError = respHeaders and respHeaders.error

		if netError then
			LrDialogs.message('Mushroom Map — connection failed',
				string.format('Could not reach %s\n\n%s', endpoint,
					tostring(netError.name or netError.errorCode or 'network error')),
				'critical')
		elseif status == 401 then
			LrDialogs.message('Mushroom Map — authentication failed',
				'The server rejected the username/password (HTTP 401).\n\n' ..
				'Check the credentials, or clear both fields if the server has no Basic Auth.',
				'critical')
		elseif status and status >= 200 and status < 300 then
			LrDialogs.message('Mushroom Map — connection OK',
				string.format('Connected to %s\n\nKnown mushroom names: %s',
					base, tostring(body or ''):sub(1, 300)),
				'info')
		else
			LrDialogs.message('Mushroom Map — unexpected response',
				string.format('%s returned HTTP %s\n\n%s', endpoint, tostring(status or '?'),
					tostring(body or ''):sub(1, 300)),
				'critical')
		end
	end)
end

return Common
