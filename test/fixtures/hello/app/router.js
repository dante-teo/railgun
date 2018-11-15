module.exports = function(app) {
	const { router, controller } = app
	router.get('/', controller.home.index)
}