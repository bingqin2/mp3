/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    // Every module adds its routes to the same router
    require('./home.js')(router);
    require('./users.js')(router);
    require('./tasks.js')(router);
    app.use('/api', router);
};
