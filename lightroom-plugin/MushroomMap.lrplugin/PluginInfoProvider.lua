--[[
  PluginInfoProvider.lua

  Adds a "Mushroom Map" settings panel to Lightroom's Plug-in Manager, so the
  server endpoint and credentials are configured once and reused by every
  export preset.
]]

local LrView = import 'LrView'
local LrColor = import 'LrColor'
local LrDialogs = import 'LrDialogs'

local Common = require 'MushroomMapCommon'

local pluginInfoProvider = {}

function pluginInfoProvider.sectionsForTopOfDialog(f, _propertyTable)
	local prefs = Common.prefs()
	local bind = LrView.bind
	local share = LrView.share

	return {
		{
			title = 'Mushroom Map — Connection',
			bind_to_object = prefs,

			f:row {
				f:static_text { title = 'API base URL:', alignment = 'right', width = share 'mm_label' },
				f:edit_field {
					value = bind 'apiUrl',
					width_in_chars = 42,
					immediate = true,
					tooltip = 'e.g. http://192.168.1.10:3000 on your LAN, or an https:// tunnel URL',
				},
			},

			f:row {
				f:static_text { title = 'Username:', alignment = 'right', width = share 'mm_label' },
				f:edit_field { value = bind 'authUser', width_in_chars = 22, immediate = true },
				f:static_text { title = 'Password:' },
				f:edit_field { value = bind 'authPass', width_in_chars = 22, immediate = true },
			},

			f:row {
				f:static_text { title = '', width = share 'mm_label' },
				f:static_text {
					title = 'Leave both blank if the server has no Basic Auth.',
					text_color = LrColor(0.5, 0.5, 0.5),
				},
			},

			f:row {
				f:static_text { title = '', width = share 'mm_label' },
				f:push_button {
					title = 'Test connection',
					action = function()
						Common.testConnection(prefs.apiUrl, prefs.authUser, prefs.authPass)
					end,
				},
			},
		},

		{
			title = 'Mushroom Map — Local archive',
			bind_to_object = prefs,

			f:row {
				f:static_text { title = 'Sent folder:', alignment = 'right', width = share 'mm_label' },
				f:edit_field { value = bind 'sentFolder', width_in_chars = 46, immediate = true },
			},
			f:row {
				f:static_text { title = '', width = share 'mm_label' },
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
							prefs.sentFolder = chosen[1]
						end
					end,
				},
				f:static_text {
					title = 'Each successfully uploaded photo is copied here.',
					text_color = LrColor(0.5, 0.5, 0.5),
				},
			},
		},
	}
end

return pluginInfoProvider
