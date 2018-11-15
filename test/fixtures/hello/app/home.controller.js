const Controller = require('egg').Controller
class HomeController extends Controller {
	async index() {
		this.ctx.status = 200
		this.ctx.body = {
			success: true,
			message: await this.service.home.index()
		}
	}
}

module.exports = HomeController