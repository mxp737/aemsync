#!/usr/bin/env node
/*global console, require, process, setInterval, Buffer */
(function () {
	"use strict";

	var os = require("os");
	var fs = require("fs");
	var path = require('path');
	var parseUrl = require('url').parse;
	var watch = require("node-watch");
	var minimist = require('minimist');
	var AdmZip = require("adm-zip");
	var FormData = require('form-data');

	var HELP = "Usage: aemsync -t targets [-i interval] path_to_watch\nWebsite: https://github.com/gavoja/aemsync";
	var SEPARATOR = ":";

	var syncerInterval = 500;
	var queue = [];
	var lock = 0;

	function Syncer(targets, queue) {
		targets = targets.split(",");

		var uploadFile = function(pack, localPath, repoPath, filter, includeExclude) {
			if (fs.lstatSync(localPath).isFile()) {
				// TODO: Add support for java classes.
				console.log("Upload: " + repoPath);
				pack.zip.addLocalFile(localPath, path.dirname(repoPath));
				pack.filters += '<filter root="' + filter + '">' + includeExclude + '</filter>\n';
			}
		};

		var deleteFile = function(pack, localPath, repoPath, filter) {
			console.log("Delete: " + repoPath);
			pack.filters += '<filter mode="replace" root="' + filter + '"/>\n';
		};

		var createPackage = function() {
			var zip = new AdmZip();
			zip.addLocalFolder(__dirname + "/package_content");
			return {zip: zip, filters: "" } ;
		};

		var formSubmitCallback = function(err, res) {
			var msg = res ? "  " + res.req._headers.host + " -> " + res.statusCode : "  " + this._headers.host + " -> " + err.code;
			console.log(msg);
			lock -= 1;
		};

		var installPackage = function(pack) {
			if (!pack.filters) {
				return;
			}
			pack.filters = '<?xml version="1.0" encoding="UTF-8"?>\n<workspaceFilter version="1.0">\n' + pack.filters + '</workspaceFilter>';
			pack.zip.addFile("META-INF/vault/filter.xml", new Buffer(pack.filters));
			var zipPath = os.tmpdir() + "/aemsync.zip";
			// TODO: Make in-memory zip.
			pack.zip.writeZip(zipPath);

			for (var i=0; i<targets.length; ++i) {
				var params = parseUrl(targets[i]);
				var options = {};
				options.path = "/crx/packmgr/service.jsp";
				options.port = params.port;
				options.host = params.hostname;
				options.headers = {"Authorization":"Basic " + new Buffer(params.auth).toString('base64')};

				var form = new FormData();
				form.append('file', fs.createReadStream(zipPath));
				form.append('name', 'aemsync');
				form.append('force', 'true');
				form.append('install', 'true');
				form.submit(options, formSubmitCallback);
			}
		};

		this.process = function() {
			var i, list = [];

			// Lock.
			if (lock > 0 || queue.length === 0) {
				return;
			}
			lock = targets.length;

			// Enqueue items.
			while((i = queue.pop())) {
				list.push(i);
			}

			// Remove duplicates.
			list = list.filter(function(elem, pos, self) {
				return self.indexOf(elem) == pos;
			});

			var pack = createPackage();

			for (i=0; i<list.length; ++i) {
				var entry = list[i].split(SEPARATOR);
				var action = entry[0];
				var localPath = entry[1];
				var repoPath = localPath.substring(localPath.indexOf("jcr_root"));

				// TODO: Clean up filter handling.
				// TODO: Fix ".content.xml" deletion.
				var filter = repoPath.substring(8).replace(/(\.xml$)|(.dir)/g, "");
				var includeExclude = "";
				if (/\/\.content$/.test(filter)) {
					filter = filter.substring(0, filter.length - 9);
					includeExclude = '<exclude pattern="' + filter + '/.*" /><include pattern="' + filter + '/jcr:content" />';
				}
//				console.log("fi: ", filter);
//				console.log("ix: ", includeExclude);
				switch(action) {
					case "U": uploadFile(pack, localPath, repoPath, filter, includeExclude); break;
					case "D": deleteFile(pack, localPath, repoPath, filter, includeExclude); break;
				}
			}

			installPackage(pack);
		};

		setInterval(this.process, syncerInterval);
	}

	function Watcher(pathToWatch, queue) {
		if (!fs.existsSync(pathToWatch)) {
			console.error("Invalid path: " + pathToWatch);
			return;
		}

		console.log("Watching: " + pathToWatch + ". Update interval: " + syncerInterval + " ms.");
		watch(pathToWatch, function(localPath) {
			// Unify path.
			localPath = localPath.replace("/\\/g", "/");

			// Path must contain "jcr_root" and must not be in a hidden folder.
			if (/^((?!\/\.).)*\/jcr_root\/.*$/.test(localPath)) {
				var action = fs.existsSync(localPath) ? "U" : "D";
				queue.push(action + SEPARATOR + localPath);
			}
		});
	}

	function main() {
		var args = minimist(process.argv.slice(2));
		if (!args.t || !args._[0]) {
			console.log(HELP);
			return;
		}
		syncerInterval = args.i || syncerInterval;
		new Watcher(args._[0], queue);
		new Syncer(args.t, queue);
	}

	main();
}());