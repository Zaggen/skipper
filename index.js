/**
 * Module dependencies
 */

var _ = require('lodash');
var toParseMultipartHTTPRequest = require('./lib/multipart');
var bodyParser = require('body-parser');
var Upstream = require('./standalone/Upstream');

// Double-check that a valid Node version with support for streams2
// is being used
if (!require('semver').satisfies(process.version, '>=0.10.0')) {
  console.error('`skipper` (bodyParser) requires node version >= 0.10.0.');
  console.error('Please upgrade Node at http://nodejs.org/ or with `nvm`');
  throw new Error('Invalid Node.js version');
}

/**
 * Skipper
 *
 * @param  {Object} options [description]
 * @return {Function}
 */

module.exports = function toParseHTTPBody(options) {
  options = options || {};

  // Configure body parser components

  // For URLEncoded, default the "extended" option to true for backwards compatibility,
  // and to avoid a deprecation warning (see https://github.com/expressjs/body-parser#options-3)
  // Also default request limit for JSON and URL-encoded parsers to 1mb for backwards compatibility.
  var URLEncodedBodyParser = bodyParser.urlencoded(_.extend({extended: true, limit: '1mb'}, options));
  var JSONBodyParser = bodyParser.json(_.extend({limit: '1mb'}, options));
  var MultipartBodyParser = toParseMultipartHTTPRequest(options);


  /**
   * Connet/Express/Sails-compatible middleware.
   *
   * @param  {Request}   req  [description]
   * @param  {Response}   res  [description]
   * @param  {Function} next [description]
   */

  return function _parseHTTPBody(req, res, next) {

    // Use custom body parser error handler if provided, otherwise
    // just forward the error to the next Express error-handling middleware.
    var handleError = function (err) {
      if (options.onBodyParserError) {
        return options.onBodyParserError(err, req, res, next);
      }
      return next(err);
    };

    // Optimization: skip bodyParser for GET, OPTIONS, or body-less requests.
    if (req.method.toLowerCase() === 'get' || req.method.toLowerCase() === 'options' || req.method.toLowerCase() === 'head') {

      // But stub out a `req.file()` method with a usage error:
      req.file = function() {
        throw new Error('`req.file()` cannot be used with an HTTP GET, OPTIONS, or HEAD request.');
      };

      return next();
    }

    // TODO: Optimization: only run bodyParser if this is a known route

    // log.verbose('Running request ('+req.method+' ' + req.url + ') through bodyParser...');

    // Mock up a req.file handler that returns a noop upstream, so that user code
    // can use `req.file` without having to check for it first.  This is useful in cases
    // where there may or may not be file params coming in.  The Multipart parser will
    // replace this with an actual upstream-acquiring function if the request isn't successfully
    // handled by one of the other parsers first.
    req.file = function(fieldName) {
      var noopUpstream = new Upstream({
        noop: true
      });
      noopUpstream.fieldName = 'NOOP_'+fieldName;
      return noopUpstream;
    };

    if (
      // If we have a content-length header...
      !_.isUndefined(req.headers['content-length']) &&
      // And the content length is declared to be zero...
      (req.headers['content-length'] === 0 || req.headers['content-length'] === '0')) {
      // Then we set the body to any empty object
      // and skip all this body-parsing mishegoss.
      req.body = {};
      return next();
    }

    // Try to parse a request that has application/json content type
    JSONBodyParser(req, res, function(err) {
      if (err) return handleError(err);
      // If parsing was successful, exit
      if (!_.isEqual(req.body, {})) {return next();}
      // Otherwise try the URL-encoded parser (application/x-www-form-urlencoded type)
      URLEncodedBodyParser(req, res, function(err) {
        if (err) return handleError(err);
        // If parsing was successful, exit
        if (!_.isEqual(req.body, {})) {return next();}
        // Otherwise try the multipart parser
        MultipartBodyParser(req, res, function(err) {
          if (err) return handleError(err);

          /**
           * OK, here's how the re-run of the JSON bodyparser works:
           * ========================================================
           * If the original pass of the bodyParser failed to parse anything, rerun it,
           * but with an artificial `application/json` content-type header,
           * forcing it to try and parse the request body as JSON.  This is just in case
           * the user sent a JSON request body, but forgot to set the appropriate header
           * (which is pretty much every time, I think.)
           */

          // If we were able to parse something at this point (req.body isn't empty)
          // or files are/were being uploaded/ignored (req._fileparser.upstreams isn't empty)
          // or the content-type is JSON,
          var reqBodyNotEmpty = !_.isEqual(req.body, {});
          var hasUpstreams = req._fileparser && req._fileparser.upstreams.length;
          var contentTypeIsJSON = (backupContentType === 'application/json');
          // ...then the original parsing must have worked.
          // In that case, we'll skip the JSON retry stuff.
          if (contentTypeIsJSON || reqBodyNotEmpty || hasUpstreams) {
            return next();
          }

          // TODO: consider adding some basic support for this instead of relying on a peer dependency.
          // Chances are, if `req.is()` doesn't exist, we really really don't want to rerun the JSON bodyparser.
          if (!req.is) return next();

          // If the content type is explicitly set to "multipart/form-data",
          // we should not try to rerun the JSON bodyparser- it may hang forever.
          if (req.is('multipart/form-data')) return next();

          // Otherwise, set an explicit JSON content-type
          // and try parsing the request body again.
          var backupContentType = req.headers['content-type'];
          req.headers['content-type'] = 'application/json';
          JSONBodyParser(req, res, function(err) {

            // Revert content-type to what it originally was.
            // This is so we don't inadvertently corrupt `req.headers`--
            // our apps' actions might be looking for 'em.
            req.headers['content-type'] = backupContentType;

            // If an error occurred in the retry, it's not actually an error
            // (we can't assume EVERY requeset was intended to be JSON)
            if (err) {
              // log.verbose('Attempted to retry bodyParse as JSON.  But no luck.', err);
            }

            // Proceed, whether or not the body was parsed.
            next();
          });
        });
      });
    });
  };
};
