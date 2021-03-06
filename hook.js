var EventEmitter = require('eventemitter2').EventEmitter2;
var util = require('util');
var net = require('net');
var child_process = require("child_process");
var async  = require('async');
var path = require('path');
var fs = require('fs');
var BufferConverter = require("./lib/BufferConverter.js");
var existsSync = fs.existsSync || path.existsSync;

exports.Hook = Hook;

var TINY_MESSAGES = Object.freeze({
	HELLO: 1,
	ON: 2,
	ECHO: 3,
	OFF: 4,
	BYE: 5,
	EMIT: 6,
	PUSH_EMIT: 7
});

var roots = [];

function Hook(options) {
	if (!options) options = {};

	// some options, name conversion close to hook.io
	this.name = this.name || options.name || options['hook-name'] || 'no-name';
	this.silent = JSON.parse(this.silent || options.silent || true);
	this.local = JSON.parse(this.local || options.local || false);
	this._hookMode = options.mode || options['hook-mode'] || "netsocket";
	this['hook-host'] = this['hook-host'] || options.host || options['hook-host'] || '127.0.0.1';
	this['hook-port'] = this['hook-port'] || options.port || options['hook-port'] || 1976;

	// some hookio flags that we support
	this.listening = false;
	this.ready = false;

	// default eventemitter options
	this.eventEmitter_Props = {
		delimiter: "::",
		wildcard: true,
		maxListeners: 100
		// wildcardCache: true
	};

	EventEmitter.call(this, this.eventEmitter_Props);

	// semi-private props
	this._client = null;
	this._eventTypes = {};
	this._server = null;
	this._remoteEvents = null;
	this._gcId = null;
	this._connectCount = 0;
	this.children = null;
	this.childrenSpawn = null;
	this.on("*::hook::fork", hookFork);

}
util.inherits(Hook, EventEmitter);

Hook.prototype.listen = listen;
Hook.prototype.connect = connect;
Hook.prototype.start = start;
Hook.prototype.stop = stop;
Hook.prototype.emit = emit;
Hook.prototype.on = on;
Hook.prototype.onFilter = onFilter;
Hook.prototype.spawn = spawn;
Hook.prototype._clientStart = _clientStart;
Hook.prototype._serve = _serve;

function hookFork (fork) {
	var self = this;
	// only master (listening hook) is allowed to fork
	if (!this.listening) return;

	// initialize childeren registry and take control on it
	if (!this.children) {
		this.children = {};
		// we taking care on our childeren and stop them when we exit
		process.on('exit', function () {
			for (var pid in self.children) {
				self.children[pid].kill();
			}
		});
	}
	ForkAndBind.call(self, fork);
}

function ForkAndBind(fork) {
	var self = this;
	var start = new Date().valueOf();
	var restartCount = 0;
	var child = child_process.fork(fork.script, fork.params);
	var clients = {};

	this.emit('hook::fork-start', {name:fork.name, pid:child.pid} );
	this.children[child.pid] = child;
	child.on("message", onMessage);
	child.on("exit", onExit);

	function onExit (exitcode) {
		delete self.children[child.pid];
		// when process die all hooks have to say goodbye
		async.each(clients, function (client, cb) {
			child = null;
			client({message: TINY_MESSAGES.BYE});
			cb();
		}, function () {
			self.emit('hook::fork-exit', {name:fork.name, exitcode:exitcode} );
			// abnormal termination
			if (exitcode!==0) {
				var lifet = 0.0001*(new Date().valueOf() - start);
				// looks like recoverable error, lets restart
				setTimeout(function () {
					ForkAndBind.call(self, fork);
				}, Math.round(restartCount/lifet));
			}
		});
	}

	function onMessage (msg) {
		var client = clients[msg.name];
		if (client) {
			client(msg.msg,msg.data);
		} else if (msg.message === "tinyhook") {
			if (msg.msg.message === TINY_MESSAGES.HELLO) {
				client = new Client(msg.name);
				clients[msg.name] = self._serve(client);
			}
		}
	}

	function Client(name) {
		this.name = name;
		this._mtpl = {
			message: "tinyhook",
			name:name,
			msg: undefined,
			data: undefined
		};
	}

	Client.prototype = {
		send: clientSend
	};

	function clientSend (msg,data) {
		this._mtpl.msg = msg;
		this._mtpl.data = data;
		if (child) child.send(this._mtpl);
	}
}

function listen (options, cb) {
	// not sure which options can be passed, but lets
	// keep this for compatibility with original hook.io
	if (!cb && options && options instanceof Function)
		cb = options;
	cb = cb || function() {};

	var self = this;
	var server = self._server = net.createServer();
	self._remoteEvents = new EventEmitter(self.eventEmitter_Props)

	server.on("connection", serverConnection);
	server.on('error', serverError);
	server.on('close', serverClose);
	server.on('listening', serverListening);
	server.listen(self['hook-port'],self['hook-host']);

	function serverConnection (socket) {
		var bufferConverter = new BufferConverter();
		var client = {
			name: "hook",
			socket: socket,
			send : function (message,data) {
				socket.write(bufferConverter.serializeNormal(message,data));
			}
		};

		// ignore errors, close will happens in anyway
		socket.on('error', function(err) {});

		// properly shutdown connection
		var servefn = self._serve(client);

		// clean context on client lost
		socket.on('close', function() {
			servefn({message: TINY_MESSAGES.BYE});
		});

		bufferConverter.onDone = servefn;
		socket.on('data', function(chunk) {
			bufferConverter.takeChunk(chunk);
		});
	}

	function serverError (e) {
		server = self._server = null;
		// here cb can be null, if we start listening and error happens after that
		if (cb)
			cb(e);
	}

	function serverClose () {
		server = self._server = null;
		self.listening = false;
		self.ready = false;
	}

	function serverListening () {
		self.listening = true;
		self.ready = true;
		roots[self['hook-port']] = self;
		cb();
		// set callback to null, so we wan't ping it one more time in error handler
		cb = null;
		EventEmitter.prototype.emit.call(self, 'hook::ready');
	}
}

function connect (options, cb) {
	// not sure which options can be passed, but lets
	// keep this for compatibility with original hook.io
	if (!cb && options && options instanceof Function)
		cb = options;
	cb = cb || function() {};
	options = options || {
		reconnect: true
	};
	var self = this;

	// since we using reconnect, will callback rightaway
	cb();

	var client;

	var rootHook = roots[self['hook-port']];
	if (rootHook && (self.local || self._hookMode === "direct" || self._hookMode === "fork")) {
		self._hookMode = "direct";
		var lclient = {
			name: "hook",
			send: function (msg,data) {
				process.nextTick(function () {
					EventEmitter.prototype.emit.call(self, msg.type, data);
				});
			}
		};

		var servefn = rootHook._serve(lclient);
		this._client = client = new EventEmitter(self.eventEmitter_Props);
		client.send = function (msg,data) {
			servefn(msg,data);
		};
		client.end = function () {
			this.emit("close");
		};
		client.destroy = function () {
			this.removeAllListeners();
		};

		// purge known event types
		process.nextTick(function () {
			self._clientStart(client);
			self._hookMode = "direct";
		});
	}
	// fork mode is only possible if hook is launched using child_process.fork
	else if (self._hookMode === "fork" && process.send) {
		this._client = client = new EventEmitter(self.eventEmitter_Props);

		client._mtpl = {
			message: "tinyhook",
			name:self.name,
			msg:undefined,
			data:undefined
		};

		client.send = function (msg,data) {
			this._mtpl.msg = msg;
			this._mtpl.data = data;
			process.send(this._mtpl);
		};
		client.end = function () {
			this.emit("close");
		};
		client.destroy = function () {
			this.removeAllListeners();
		};

		process.on('message',function(msg) {
			if (msg.message === "tinyhook" && msg.name === self.name) {
				EventEmitter.prototype.emit.call(self, msg.msg.type, msg.data);
			}
		});

		self._clientStart(client);

	} else {
		self._hookMode = "netsocket";

		var bufferConverter = new BufferConverter();

		client = this._client = net.connect(self['hook-port'],self['hook-host']);
		client.send = function (message,data) {
			client.write(bufferConverter.serializeNormal(message,data));
		};

		// when connection started we sayng hello and push
		// all known event types we have
		client.on('connect', function() {
			self._clientStart(client);
		});

		// any error will terminate connection
		client.on('error', function() {
			client.end();
		});

		// tranlate pushed emit to local one
		bufferConverter.onDone = function (message,data) {
			EventEmitter.prototype.emit.call(self, message.type, data?JSON.parse(data.toString()):undefined);
		};
		client.on('data', function (chunk) {
			bufferConverter.takeChunk(chunk)
		});
	}

	self._client.on('close', function() {
		client.destroy();
		client = self._client = null;
		if (options.reconnect) {
			self.connectCount++;
			var reconnectFn = function () {
				if (!self.ready)
					return;
				self.connect(options, function (err) {
					if (err) {
						setTimeout(reconnectFn,10*self.connectCount*self.connectCount);
					} else {
						self.connectCount = 1;
					}
				})
			}();
		} else {
			self.ready = false;
		}
	});

	// every XX seconds do garbage collect and notify server about
	// event we longer not listening. Realtime notification is not necessary
	// Its ok if for some period we receive events that are not listened
	self._gcId = setInterval(function() {
		Object.keys(self._eventTypes).forEach(function(type) {
			var listeners = self.listeners(type);
			if (!listeners || !listeners.length) {
				// no more listener for this event
				// push this to server
				client.send({
					message: TINY_MESSAGES.OFF,
					type: type
				});
				delete self._eventTypes[type];
			}
		});
	}, 60000);
}

// Function will attempt to start server, if it fails we assume that server already available
// then it start in client mode. So first hook will became super hook, overs its clients
function start (options, cb) {
	// not sure which options can be passed, but lets
	// keep this for compatibility with original hook.io
	if (!cb && options && options instanceof Function)
		cb = options;
	cb = cb || function() {};
	options = options || {};

	var self = this;

	this.listen(function(e) {
		if (e && (e.code === 'EADDRINUSE' || e.code === 'EADDRNOTAVAIL')) {
			// if server start fails we attempt to start in client mode
			self.connect(options, cb);
		} else {
			cb(e);
		}
	});
}

function stop (cb) {
	cb = cb || function() {};
	this.ready = false;
	if (this._server) {
		this._server.on('close', cb);
		this._server.close();
	} else if (this._client) {
		if (this._gcId) {
			clearInterval(this._gcId);
			this._gcId = null;
		}
		this._client.once('close', cb);
		this._client.end();
	} else {
		cb();
	}
}

// hook into core events to dispatch events as required
var bufferConverter = new BufferConverter();

function _chieldEmit(self, type, data) {
	// pass to ourselves
	EventEmitter.prototype.emit.call(self, type, data);

	// pass to remoteListeners
	var cachedBuffer = null;
	self._remoteEvents.emit(type, function () {
		if (!cachedBuffer) {
			cachedBuffer = bufferConverter.serializeNormal({
				message: TINY_MESSAGES.PUSH_EMIT,
				type: type,
			},data);
		}
		return cachedBuffer;
	})
}

function emit (event, data, cb) {
	// on client send event to master
	if (this._client) {
		this._client.send({
			message: TINY_MESSAGES.EMIT,
			type: event
		}, data);
	} else if (this._server) {
		// send to clients event emitted on server (master)
		_chieldEmit(this,this.name + "::" + event,data);
	}

	// still preserve local processing
	EventEmitter.prototype.emit.call(this, event, data, cb);
}

function on (type, listener) {
	if (!this._eventTypes[type] && this._client) {
		this._client.send({
				message: TINY_MESSAGES.ON,
				type: type
			}
		);
	}
	if (this._eventTypes) {
		this._eventTypes[type] = 1;
	}
	EventEmitter.prototype.on.call(this, type, listener);
}

/**
 * This function allows to listen on specific event and with additional
 * filtering support. This can be useful for load ballancing when two
 * hooks will process same data but each need to process its own portion
 *
 * @param {String} type Event type
 * @param {String} selValue Ballance selector value
 * @param {String} filterId Globally unique id for this filter
 * @param {Object} fnFilter Ballance selector emmiter function
 * @param type - should be clear cmd without ::
 */
function onFilter (type, selValue, filterId, fnFilter, listener) {
	if (this._client) {
		var btype = type+filterId+selValue;
		if (this._eventTypes[btype])
			throw new Error("Only one listener per unique (filterId+setValue) is allowed")
			this._client.send({
					message: TINY_MESSAGES.ON,
					type: btype,
					ballancer: {
						origType:type,
						filterId:filterId,
						selValue:selValue,
						fnFilter:fnFilter.toString().match(/function[^{]+\{([\s\S]*)\}$/)[1]
					}
				}
			);
			EventEmitter.prototype.on.call(this, btype, listener);
	}
	function proxy (obj) {
		if (selValue == fnFilter(obj))
			listener(obj)
	}
	proxy._origin = listener;
	EventEmitter.prototype.on.call(this, type, proxy);
}

function _clientStart (client) {
	var self=this;
	client.send({
		message: TINY_MESSAGES.HELLO,
		protoVersion: 3,
		name: self.name
	});

	// purge known event types
	Object.keys(self._eventTypes).forEach(function(type) {
		client.send({
			message: TINY_MESSAGES.ON,
			type: type
		});
	});

	// lets use echo to get ready status when all the above is processed
	self.once("hook::ready-internal", function () {
		var readyevent = self.ready?"hook::reconnected":"hook::ready";
		self.ready = true;
		self.emit(readyevent);
	});

	client.send({
		message: TINY_MESSAGES.ECHO,
		type: 'hook::ready-internal'
	});
}

function _serve (client) {
	var self = this;
	var lhook = this;
	var handler = null;
	var serviceEvents = {};

	function handlerLegacy(data) {
		client.send({
			message: TINY_MESSAGES.PUSH_EMIT,
			type: this.event,
		},data);
	}

	function handlerSocket (bufferFn) {
		client.socket.write(bufferFn());
	}

	if (client.socket) {
		lhook = self._remoteEvents
		handler = handlerSocket
	} else {
		lhook = self;
		handler = handlerLegacy
	}

	return function  (msg,data) {
		switch (msg.message) {
			case TINY_MESSAGES.HELLO:
				client.name = msg.name;
				break;
			case TINY_MESSAGES.ON:
				lhook.on(msg.type, handler);
				if (msg.ballancer) {
					var fnFilter = new Function ("obj", msg.ballancer.fnFilter);
					fnFilter._origin = handler;
					function serviceHanlder(obj) {
						// send ballanced event only if main event is not sending already
						if (lhook.listeners(msg.type).length==0) {
							if (fnFilter(obj)==msg.ballancer.selValue) {
								_chieldEmit(self, msg.type, obj);
							}
						}
					}
					serviceEvents[msg.type]={handler:serviceHanlder,type:msg.ballancer.origType};
					self.on(msg.ballancer.origType, serviceHanlder)
				}
				self.emit('hook::newListener', {
					type: msg.type,
					hook: client.name
				});
				break;
			case TINY_MESSAGES.ECHO:
				client.send({
					message: TINY_MESSAGES.PUSH_EMIT,
					type: msg.type
				});
				break
			case TINY_MESSAGES.OFF:
				lhook.off(msg.type, handler);
				if (serviceEvents[msg.type]) {
					self.off(serviceEvents[type].type,serviceEvents[type].handler)
					delete serviceEvents[type];
				}
				break;
			case TINY_MESSAGES.BYE:
				lhook.off('**', handler);
				// need to cleanup service events (if any)
				for (var serviceEvent in serviceEvents) {
					self.off(serviceEvent.type,serviceEvent.handler)
				}
				serviceEvent = null;
				break;
			case TINY_MESSAGES.EMIT:
				var t = client.name + "::" + msg.type;

				if (client.socket) {
					// emit locally only if there are listeners, this is to no deserialize if this is not required
					if (self.listeners(t).length || self.listenersAny().length)
						EventEmitter.prototype.emit.call(self, t, data?JSON.parse(data.toString()):undefined);

					// translate / pass this to child hooks
					var cachedBuffer = null;
					self._remoteEvents.emit(t, function () {
						if (!cachedBuffer) {
							cachedBuffer = bufferConverter.serializeFast({
			 					message: TINY_MESSAGES.PUSH_EMIT,
			 					type: t,
			 				},data);
						}
						return cachedBuffer;
					})
				} else {
					_chieldEmit(self, t, data);
				}

				break;
		}
	}
}

function spawn (hooks, cb) {
	var self = this;
	var	connections = 0;
	var	local;

	cb = cb || function () {};

	if (!self.childrenSpawn)
		self.childrenSpawn={};

	if (!this.ready)
		return cb(new Error('Cannot spawn child hooks without being ready'));

	if (typeof hooks === "string")
		hooks = new Array(hooks);

	local = self.local || false;

	function cliOptions(options) {
		var cli = [];

		var reserved_cli = ['port', 'host', 'name', 'type'];

		Object.keys(options).forEach(function (key) {
			var value = options[key];

			if (typeof value === 'object') {
				value = JSON.stringify(value);
			}

			//
			// TODO: Some type inspection to ensure that only
			// literal values are accepted here.
			//
			if (reserved_cli.indexOf(key) === -1) {
				cli.push('--' + key, value);
			} else {
				cli.push('--hook-' + key, value);
			}
		});

		return cli;
	}


	function spawnHook (hook, next) {
		var hookPath,
			hookBin = __dirname + '/bin/forever-shim',
			keys;

		hook.host = hook.host || self['hook-host'];
		hook.port = hook.port || self['hook-port'];

		if (hook.src) {
			// 1'st guess, this is path to file or module, i.e. just existent path
			hookPath = path.resolve(hook.src);
			if (!existsSync(hookPath)) {
				// 2'nd guess, process module?
				hookPath = process.cwd() + '/node_modules/' + hook.src;
				if (!existsSync(hookPath)) {
					// 3'nd guess, no idea, let require to resoolve it
					hookPath = hook.src;
				}
			}
		}

		self.emit('hook::spawning', hook.name);

		if (local) {
			self.childrenSpawn[hook.name] = {
				module: require(hookPath)
			};

			//
			// Here we assume that the `module.exports` of any given `hook.io-*` module
			// has **exactly** one key. We extract this Hook prototype and instantiate it.
			//
			keys = Object.keys(self.childrenSpawn[hook.name].module);
			var mysun = self.childrenSpawn[hook.name];
			mysun.Hook  = mysun.module[keys[0]];
			mysun._hook = new (mysun.Hook)(hook);
			mysun._hook.start();

			//
			// When the hook has fired the `hook::ready` event then continue.
			//
			mysun._hook.once('hook::ready', next.bind(null, null));
		} else {
			self.emit("hook::fork",{script:hookBin, name: hook.name, params:cliOptions(hook)});
		}
		self.once(hook.name+'::hook::ready', function () {
			connections++;
			if (connections === hooks.length) {
				self.emit('hook::children-ready', hooks);
			}
		});
	}

	async.forEach(hooks, spawnHook, function (err) {
		if (!err)
			self.emit('hook::children-spawned', hooks);
		cb(err);
	});

	return this;
}
