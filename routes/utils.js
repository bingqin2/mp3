/*
 * Helpers shared by the users and tasks routes: response format, error
 * handling, query string parsing and request body validation.
 */

// An error we want to show to the client as-is, with a given status code
function ApiError(status, message) {
    this.status = status;
    this.message = message;
}

function send(res, status, message, data) {
    res.status(status).json({ message: message, data: data === undefined ? {} : data });
}

// Wrap an async route handler so every failure becomes a { message, data } response
function handle(fn) {
    return function (req, res) {
        Promise.resolve()
            .then(function () { return fn(req, res); })
            .catch(function (err) {
                if (err instanceof ApiError) {
                    return send(res, err.status, err.message);
                }
                if (err && err.code === 11000) {
                    // Unique index on email (two requests racing with the same email)
                    return send(res, 400, 'A user with this email already exists');
                }
                console.error(err);
                send(res, 500, 'Something went wrong on the server, please try again later');
            });
    };
}

function isObjectId(value) {
    return typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isConnectionError(err) {
    return Boolean(err && /Network|ServerSelection|Timeout|NotConnected/.test(err.name || ''));
}

/*
 * Query string parameters
 */

function parseJSONParam(query, name) {
    var raw = query[name];
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string') {
        throw new ApiError(400, 'The "' + name + '" parameter must be given only once');
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new ApiError(400, 'The "' + name + '" parameter is not valid JSON');
    }
}

function parseObjectParam(query, name) {
    var value = parseJSONParam(query, name);
    if (value !== undefined && !isPlainObject(value)) {
        throw new ApiError(400, 'The "' + name + '" parameter must be a JSON object');
    }
    return value;
}

function parseIntegerParam(query, name) {
    var value = parseJSONParam(query, name);
    if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
        throw new ApiError(400, 'The "' + name + '" parameter must be a non-negative integer');
    }
    return value;
}

function parseBooleanParam(query, name) {
    var value = parseJSONParam(query, name);
    if (value !== undefined && typeof value !== 'boolean') {
        throw new ApiError(400, 'The "' + name + '" parameter must be true or false');
    }
    return value === true;
}

// Parameters for GET on a collection (/users, /tasks)
function parseListQuery(query) {
    return {
        where: parseObjectParam(query, 'where') || {},
        sort: parseObjectParam(query, 'sort'),
        select: parseObjectParam(query, 'select'),
        skip: parseIntegerParam(query, 'skip'),
        limit: parseIntegerParam(query, 'limit'),
        count: parseBooleanParam(query, 'count')
    };
}

// Run a parsed list query with Mongoose. defaultLimit applies to the list, not to count.
async function runListQuery(Model, params, defaultLimit) {
    try {
        if (params.count) {
            var countQuery = Model.countDocuments(params.where);
            if (params.skip !== undefined) countQuery.skip(params.skip);
            if (params.limit !== undefined) countQuery.limit(params.limit);
            return await countQuery;
        }
        var query = Model.find(params.where);
        if (params.sort) query.sort(params.sort);
        if (params.select) query.select(params.select);
        if (params.skip !== undefined) query.skip(params.skip);
        var limit = params.limit !== undefined ? params.limit : defaultLimit;
        if (limit !== undefined) query.limit(limit);
        return await query;
    } catch (err) {
        if (isConnectionError(err)) throw err;
        // Bad filter values, unknown operators, mixed include/exclude select, ...
        throw new ApiError(400, 'The query parameters are not valid');
    }
}

// GET on a single resource (/users/:id, /tasks/:id): only "select" applies
async function findOneById(Model, req, notFoundMessage) {
    if (!isObjectId(req.params.id)) {
        throw new ApiError(404, notFoundMessage);
    }
    var select = parseObjectParam(req.query, 'select');
    var doc;
    try {
        doc = await Model.findById(req.params.id).select(select || {});
    } catch (err) {
        if (isConnectionError(err)) throw err;
        throw new ApiError(400, 'The "select" parameter is not valid');
    }
    if (!doc) {
        throw new ApiError(404, notFoundMessage);
    }
    return doc;
}

// Look up the document named by :id for PUT / DELETE, or fail with 404
async function findByIdOr404(Model, id, notFoundMessage) {
    var doc = isObjectId(id) ? await Model.findById(id) : null;
    if (!doc) {
        throw new ApiError(404, notFoundMessage);
    }
    return doc;
}

/*
 * Request body fields. Form-encoded bodies carry everything as strings,
 * so a few conversions below only apply to them.
 */

function requireString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ApiError(400, 'A ' + name + ' is required');
    }
    return value.trim();
}

function optionalString(value, name, defaultValue) {
    if (value === undefined || value === null) {
        return defaultValue;
    }
    if (typeof value !== 'string') {
        throw new ApiError(400, 'The ' + name + ' must be a string');
    }
    return value;
}

function requireDate(value, name) {
    var date;
    if (typeof value === 'number') {
        date = new Date(value);
    } else if (typeof value === 'string' && value.trim() !== '') {
        date = /^-?\d+$/.test(value.trim()) ? new Date(Number(value)) : new Date(value);
    } else {
        throw new ApiError(400, 'A ' + name + ' is required');
    }
    if (isNaN(date.getTime())) {
        throw new ApiError(400, 'The ' + name + ' is not a valid date');
    }
    return date;
}

function optionalBoolean(value, name) {
    if (value === undefined || value === null || value === '') return false;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new ApiError(400, 'The ' + name + ' field must be true or false');
}

function optionalIdList(value, name, isForm) {
    if (value === undefined || value === null) {
        return [];
    }
    if (isForm && typeof value === 'string') {
        value = value === '' ? [] : [value];
    }
    if (!Array.isArray(value)) {
        throw new ApiError(400, 'The ' + name + ' field must be a list of ids');
    }
    value.forEach(function (id) {
        if (!isObjectId(id)) {
            throw new ApiError(400, 'The ' + name + ' field contains an invalid id: ' + JSON.stringify(id));
        }
    });
    // Ignore duplicates
    return Array.from(new Set(value));
}

module.exports = {
    ApiError: ApiError,
    send: send,
    handle: handle,
    isObjectId: isObjectId,
    parseListQuery: parseListQuery,
    runListQuery: runListQuery,
    findOneById: findOneById,
    findByIdOr404: findByIdOr404,
    requireString: requireString,
    optionalString: optionalString,
    requireDate: requireDate,
    optionalBoolean: optionalBoolean,
    optionalIdList: optionalIdList
};
