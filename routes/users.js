var User = require('../models/user');
var Task = require('../models/task');
var utils = require('./utils');

var ApiError = utils.ApiError;
var NOT_FOUND = 'User not found';

// Check a POST/PUT body and return the fields to store. Nothing is written here.
async function validateUser(req, userId) {
    var body = req.body || {};
    var isForm = Boolean(req.is('urlencoded'));

    var name = utils.requireString(body.name, 'name');
    var email = utils.requireString(body.email, 'email');
    if (!/^\S+@\S+$/.test(email)) {
        throw new ApiError(400, 'The email is not a valid email address');
    }
    var pendingTasks = utils.optionalIdList(body.pendingTasks, 'pendingTasks', isForm);

    var emailFilter = { email: email };
    if (userId) emailFilter._id = { $ne: userId };
    if (await User.exists(emailFilter)) {
        throw new ApiError(400, 'A user with this email already exists');
    }

    var tasks = await Task.find({ _id: { $in: pendingTasks } });
    if (tasks.length !== pendingTasks.length) {
        var found = tasks.map(function (task) { return String(task._id); });
        var missing = pendingTasks.filter(function (id) { return found.indexOf(id) === -1; });
        throw new ApiError(404, 'Task not found: ' + missing.join(', '));
    }
    var completed = tasks.filter(function (task) { return task.completed; });
    if (completed.length > 0) {
        throw new ApiError(400, 'Completed tasks cannot be pending: ' +
            completed.map(function (task) { return String(task._id); }).join(', '));
    }

    return { name: name, email: email, pendingTasks: pendingTasks };
}

// Make the tasks agree with the user's (already saved) pendingTasks
async function syncTasks(user) {
    var userId = String(user._id);

    // Pending tasks this user no longer lists become unassigned
    await Task.updateMany(
        { assignedUser: userId, completed: false, _id: { $nin: user.pendingTasks } },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
    );
    // Tasks this user now lists leave whichever user had them before
    await User.updateMany(
        { _id: { $ne: user._id }, pendingTasks: { $in: user.pendingTasks } },
        { $pull: { pendingTasks: { $in: user.pendingTasks } } }
    );
    await Task.updateMany(
        { _id: { $in: user.pendingTasks } },
        { $set: { assignedUser: userId } }
    );
    // Keep the name current on all of the user's tasks, completed ones too
    await Task.updateMany(
        { assignedUser: userId },
        { $set: { assignedUserName: user.name } }
    );
}

module.exports = function (router) {

    var usersRoute = router.route('/users');
    var userRoute = router.route('/users/:id');

    usersRoute.get(utils.handle(async function (req, res) {
        var params = utils.parseListQuery(req.query);
        var result = await utils.runListQuery(User, params);
        utils.send(res, 200, 'OK', result);
    }));

    usersRoute.post(utils.handle(async function (req, res) {
        var fields = await validateUser(req, null);
        var user = new User(fields);
        await user.save();
        await syncTasks(user);
        utils.send(res, 201, 'User created', user);
    }));

    userRoute.get(utils.handle(async function (req, res) {
        var user = await utils.findOneById(User, req, NOT_FOUND);
        utils.send(res, 200, 'OK', user);
    }));

    userRoute.put(utils.handle(async function (req, res) {
        var user = await utils.findByIdOr404(User, req.params.id, NOT_FOUND);
        var fields = await validateUser(req, user._id);
        user.name = fields.name;
        user.email = fields.email;
        user.pendingTasks = fields.pendingTasks;
        await user.save();
        await syncTasks(user);
        utils.send(res, 200, 'User updated', user);
    }));

    userRoute.delete(utils.handle(async function (req, res) {
        var user = await utils.findByIdOr404(User, req.params.id, NOT_FOUND);
        await user.deleteOne();
        await Task.updateMany(
            { assignedUser: String(user._id) },
            { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
        );
        utils.send(res, 200, 'User deleted', user);
    }));

    return router;
}
