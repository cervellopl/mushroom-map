--[[
  Mushroom Map Uploader — Lightroom Classic export plugin.
  Registers an Export Service Provider that uploads rendered photos to the
  Mushroom Map API (POST /api/mushrooms) and archives them to a local folder.
]]

return {
	LrSdkVersion = 13.0,
	LrSdkMinimumVersion = 10.0, -- Lightroom Classic 10+ (2020) and newer

	LrToolkitIdentifier = 'pl.cervello.mushroommap',
	LrPluginName = 'Mushroom Map Uploader',

	LrExportServiceProvider = {
		title = 'Mushroom Map',
		file = 'ExportServiceProvider.lua',
	},

	-- Adds a settings panel to File > Plug-in Manager.
	LrPluginInfoProvider = 'PluginInfoProvider.lua',

	VERSION = { major = 1, minor = 0, revision = 0, build = 0 },
}
