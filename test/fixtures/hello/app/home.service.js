const Service = require('egg').Service
class HomeService extends Service {
	async index() {
		return 'Hello'
	}
}

module.exports = HomeService