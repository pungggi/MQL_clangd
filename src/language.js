'use strict';
const vscode = require('vscode');

const language = vscode.env.language;

let lg;
try {
    lg = require(`../landes.${language}.json`);
}
catch (error) {
    lg = require('../landes.json');
}

module.exports = lg;

