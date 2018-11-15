const path = require('path')
const egg = require('egg')
const { parseComponentName } = require('./util')
const EGG_PATH = Symbol.for('egg#eggPath')
const EGG_LOADER = Symbol.for('egg#loader')

class RailgunAppWorkerLoader extends egg.AppWorkerLoader {
	loadController() {
		super.loadController({
			directory: path.join(this.options.baseDir, 'app'),
			match: '**/*.controller.js',
			caseStyle: (file) => { return [parseComponentName(file, 'controller')] }
		})
	}

	loadService() {
		super.loadService({
			directory: path.join(this.options.baseDir, 'app'),
			match: '**/*.service.js',
			caseStyle: (file) => { return [parseComponentName(file, 'service')] }
		})
	}
}

class RailgunAgentWorkLoader extends egg.AgentWorkerLoader {
	loadController() {
		console.log('Aloha')
		super.loadController({
			directory: path.join(this.options.baseDir, 'app'),
			match: '**/*.controller.js',
			caseStyle: (file) => { return [parseComponentName(file, 'controller')] }
		})
	}

	loadService() {
		super.loadService({
			directory: path.join(this.options.baseDir, 'app'),
			match: '**/*.service.js',
			caseStyle: (file) => { return [parseComponentName(file, 'service')] }
		})
	}
}

class Application extends egg.Application {
	get [EGG_PATH]() {
		return path.dirname(__dirname)
	}

	get [EGG_LOADER]() {
		return RailgunAppWorkerLoader
	}
}

class Agent extends egg.Agent {
	get [EGG_PATH]() {
		return path.dirname(__dirname)
	}

	get [EGG_LOADER]() {
		return RailgunAgentWorkLoader
	}
}

module.exports = Object.assign(egg, {
	Application,
	Agent
})
