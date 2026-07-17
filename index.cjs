// The explicit import lets Vercel's Express framework detector recognize
// this monorepo entrypoint; createApp owns the actual Express instance.
require('express');
const { createApp } = require('./track-b-relay/src/app');

module.exports = createApp();
