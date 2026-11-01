var User = require('../models/user');
var Task = require('../models/task');
var utils = require('./utils');

var ApiError = utils.ApiError;
var NOT_FOUND = 'Task not found';
var DEFAULT_LIMIT = 100;

// Check a POST/PUT body and return the fields to store. Nothing is written here.
async function validateTask(req) {
    var body = req.body || {};

    var name = utils.requireString(body.name, 'name');
    var deadline = utils.requireDate(body.deadline, 'deadline');
    var description = utils.optionalString(body.description, 'description', '');
    var completed = utils.optionalBoolean(body.completed, 'completed');

    var assignedUser = utils.optionalString(body.assignedUser, 'assignedUser', '');
    if (assignedUser !== '' && !utils.isObjectId(assignedUser)) {
        throw new ApiError(400, 'The assignedUser is not a valid user id');
    }
    var assignedUserName = utils.optionalString(body.assignedUserName, 'assignedUserName', '');
    if (assignedUser === '' && assignedUserName !== '' && assignedUserName !== 'unassigned') {
        throw new ApiError(400, 'The assignedUserName must be "unassigned" when no user is assigned');
    }

    if (assignedUser === '') {
        assignedUserName = 'unassigned';
    } else {
        var user = await User.findById(assignedUser);
        if (!user) {
            throw new ApiError(404, 'Assigned user not found');
        }
        if (assignedUserName !== '' && assignedUserName !== user.name) {
            throw new ApiError(400, 'The assignedUserName does not match the name of the assigned user');
        }
        assignedUserName = user.name;
    }

    return {
        name: name,
        description: description,
        deadline: deadline,
        completed: completed,
        assignedUser: assignedUser,
        assignedUserName: assignedUserName
    };
}

// Make the users' pendingTasks agree with the (already saved) task
async function syncUsers(task) {
    var taskId = String(task._id);

    // Any other user that lists this task loses it
    var others = { pendingTasks: taskId };
    if (task.assignedUser) others._id = { $ne: task.assignedUser };
    await User.updateMany(others, { $pull: { pendingTasks: taskId } });

    // The assigned user lists it only while it is pending
    if (task.assignedUser) {
        var update = task.completed
            ? { $pull: { pendingTasks: taskId } }
            : { $addToSet: { pendingTasks: taskId } };
        await User.updateOne({ _id: task.assignedUser }, update);
    }
}

module.exports = function (router) {

    var tasksRoute = router.route('/tasks');
    var taskRoute = router.route('/tasks/:id');

    tasksRoute.get(utils.handle(async function (req, res) {
        var params = utils.parseListQuery(req.query);
        var result = await utils.runListQuery(Task, params, DEFAULT_LIMIT);
        utils.send(res, 200, 'OK', result);
    }));

    tasksRoute.post(utils.handle(async function (req, res) {
        var fields = await validateTask(req);
        var task = new Task(fields);
        await task.save();
        await syncUsers(task);
        utils.send(res, 201, 'Task created', task);
    }));

    taskRoute.get(utils.handle(async function (req, res) {
        var task = await utils.findOneById(Task, req, NOT_FOUND);
        utils.send(res, 200, 'OK', task);
    }));

    taskRoute.put(utils.handle(async function (req, res) {
        var task = await utils.findByIdOr404(Task, req.params.id, NOT_FOUND);
        var fields = await validateTask(req);
        task.set(fields);
        await task.save();
        await syncUsers(task);
        utils.send(res, 200, 'Task updated', task);
    }));

    taskRoute.delete(utils.handle(async function (req, res) {
        var task = await utils.findByIdOr404(Task, req.params.id, NOT_FOUND);
        await task.deleteOne();
        await User.updateMany(
            { pendingTasks: String(task._id) },
            { $pull: { pendingTasks: String(task._id) } }
        );
        res.status(204).end();
    }));

    return router;
}
