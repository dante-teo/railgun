const path = require('path')

function parseComponentName(file, name) {
	const basename = path.basename(file.toLowerCase()).split(`.${name}.js`)
	if (basename.length > 0) {
		return basename[0]
	} else {
		throw new Error(`Unable to parse component name from file ${file}.`)
	}
}

module.exports = {
	parseComponentName
}