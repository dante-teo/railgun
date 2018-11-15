const mock = require('egg-mock')

describe('test/framework.test.js', () => {
	let app
	before(() => {
		app = mock.app({
			baseDir: 'hello',
			framework: true
		})

		return app.ready()
	})

	after(() => app.close())
	afterEach(mock.restore)

	it('Should get "Hello" on the index path of service', () => {
		return app.httpRequest()
			.get('/')
			.expect(200)
			.expect({
				success: true,
				message: 'Hello'
			})
	})
})
