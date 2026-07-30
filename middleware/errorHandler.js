const { sendApiError, sendInternalError } = require('../utils/apiError');

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  if (err && err.type === 'entity.parse.failed') {
    return sendApiError(req, res, {
      status: 400,
      error: 'The request body is not valid JSON.',
      code: 'INVALID_REQUEST',
    });
  }

  return sendInternalError(req, res, err, 'Unhandled route error');
}

module.exports = errorHandler;
